// Host half of dsh-readme-reel.
//
// It owns two things:
//   1. a tiny HTTP surface under /dsh-readme-reel (state, scan, build, asset,
//      shot) that the Web GUI panel drives;
//   2. the build itself, through src/reel.js, using the ffmpeg found on this
//      machine.
//
// Failure containment follows dsh-warden's rule: the panel is the disposable
// half. If webServer.register throws — different host, changed contract, no web
// server at all — the plugin still loads cleanly and the CLI still works. A
// failed build is a message in the panel, never an exception that escapes into
// the loader.
//
// Media is served from exactly four whitelisted names, and screenshots are
// served only from inside projectDir. A local web server that will hand back
// arbitrary files because a query string asked nicely is how a README helper
// becomes a file-exfiltration hole.

import { readFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { ReelError } from './errors.js'
import { locateFfmpeg } from './encode.js'
import {
  buildReel,
  isInside,
  listShots,
  OUTPUT_NAMES,
  readManifest,
  readPluginVersion,
  resolveStoryboard,
  SHOT_EXTENSIONS,
} from './reel.js'

export const name = 'dsh-readme-reel'
export const inject = ['webServer']

const API = '/dsh-readme-reel'
const MIME = {
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error: String((error && error.message) || error) })
}

function readBody(req) {
  return new Promise(function (resolveBody) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > 1048576) req.destroy()
    })
    req.on('end', function () {
      try {
        resolveBody(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolveBody({})
      }
    })
    req.on('error', function () {
      resolveBody({})
    })
  })
}

function splitUrl(url) {
  const text = String(url || '')
  const queryIndex = text.indexOf('?')
  const path = queryIndex >= 0 ? text.slice(0, queryIndex) : text
  const query = queryIndex >= 0 ? text.slice(queryIndex + 1) : ''
  const rest = path.replace(/^\/dsh-readme-reel\/?/, '').replace(/\/$/, '')
  return { method: rest || 'state', query: query }
}

function queryValue(query, key) {
  return new URLSearchParams(query).get(key)
}

function toPosix(path) {
  return path.split('\\').join('/')
}

function relativeFrom(root, path) {
  return toPosix(relative(root, path))
}

function assetUrl(filename) {
  return API + '/asset?name=' + encodeURIComponent(filename)
}

function shotUrl(relativePath) {
  return API + '/shot?path=' + encodeURIComponent(relativePath)
}

/**
 * Markdown block a README can paste as-is. GitHub does not render a relative
 * <video> (it strips the tag for repo files), so the GIF is the line that
 * actually works there; the webm line is for marketplaces and self-hosted docs.
 */
export function snippetFor(manifest) {
  if (!manifest || !manifest.outputs) return ''
  const title = String(manifest.title || 'readme reel').replace(/[[\]]/g, '')
  const outputs = manifest.outputs
  const lines = []
  if (outputs.cover && outputs.cover.path) lines.push('![' + title + '](' + outputs.cover.path + ')')
  if (outputs.gif && outputs.gif.path) lines.push('<img src="' + outputs.gif.path + '" alt="' + title + '" width="720" />')
  if (outputs.webm && outputs.webm.path) lines.push('<video src="' + outputs.webm.path + '" width="720" autoplay loop muted playsinline></video>')
  return lines.join('\n\n')
}

/**
 * Everything the panel renders, built from disk each time. Stateless apart
 * from the last-build record: the manifest is the truth, so a reload after a
 * CLI build shows the same thing as one after a panel build.
 */
export async function buildState(options) {
  const projectDir = options.projectDir
  const outDir = options.outDir
  const shotsDir = options.shotsDir
  const storyboardPath = options.storyboardPath
  const state = {
    ok: true,
    plugin: { name: name, version: await readPluginVersion() },
    projectDir: toPosix(projectDir),
    outDir: toPosix(outDir),
    shotsDir: toPosix(shotsDir),
    storyboardPath: storyboardPath === null ? null : toPosix(storyboardPath),
    ffmpeg: { found: false, version: null, source: null },
    storyboard: null,
    storyboardError: null,
    shots: [],
    outputs: null,
    manifest: null,
    snippet: '',
    lastBuild: options.lastBuild || null,
  }

  const ffmpeg = await locateFfmpeg({ explicit: options.ffmpegPath })
  if (ffmpeg) state.ffmpeg = { found: true, version: ffmpeg.version, source: ffmpeg.source }

  try {
    const resolved = await resolveStoryboard({
      projectDir: projectDir,
      shotsDir: shotsDir,
      storyboardPath: storyboardPath,
    })
    state.storyboard = {
      source: resolved.source,
      path: resolved.path === null ? null : toPosix(resolved.path),
      title: resolved.storyboard.title,
      durationMs: resolved.storyboard.durationMs,
      fps: resolved.storyboard.fps,
      size: resolved.storyboard.size,
      loop: resolved.storyboard.loop,
      scenes: resolved.storyboard.scenes.map(function (scene, index) {
        return { index: index, src: scene.src, hold: scene.hold, layout: scene.layout }
      }),
    }
  } catch (error) {
    state.storyboardError = String((error && error.message) || error)
  }

  const shots = await listShots(shotsDir)
  state.shots = shots.map(function (shot) {
    const relativePath = relativeFrom(projectDir, shot.path)
    return { path: relativePath, name: shot.name, bytes: shot.bytes, url: shotUrl(relativePath) }
  })

  const manifest = await readManifest(outDir)
  if (manifest && manifest.outputs) {
    state.manifest = manifest
    state.outputs = {}
    for (const key of ['webm', 'gif', 'cover']) {
      const output = manifest.outputs[key]
      if (!output) {
        state.outputs[key] = null
        continue
      }
      const filename = output.file || (key === 'cover' ? 'cover.png' : 'reel.' + key)
      state.outputs[key] = {
        file: filename,
        path: output.path,
        bytes: output.bytes,
        sha256: output.sha256 || null,
        url: assetUrl(filename),
      }
    }
    state.snippet = snippetFor(manifest)
  }

  return state
}

function mediaFile(outDir, filename) {
  if (!OUTPUT_NAMES.includes(filename)) return null
  return join(outDir, filename)
}

async function serveFile(res, path, contentType, headers = {}) {
  let buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    sendError(res, 404, new ReelError('文件不存在：' + path))
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', contentType)
  res.setHeader('content-length', String(buffer.length))
  res.setHeader('cache-control', 'no-store')
  for (const key of Object.keys(headers)) res.setHeader(key, headers[key])
  res.end(buffer)
}

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const projectDir = resolve(settings.projectDir || process.cwd())
  const outDir = resolve(settings.outDir || join(projectDir, 'docs', 'reel'))
  const shotsDir = resolve(settings.shotsDir || join(projectDir, 'docs', 'shots'))
  const storyboardPath = settings.storyboardPath === null
    ? null
    : resolve(settings.storyboardPath || join(projectDir, 'docs', 'storyboard.json'))
  const ffmpegPath = settings.ffmpegPath
  const options = {
    projectDir: projectDir,
    outDir: outDir,
    shotsDir: shotsDir,
    storyboardPath: storyboardPath,
    ffmpegPath: ffmpegPath,
  }

  let lastBuild = null
  let inflight = null

  async function state() {
    return buildState(Object.assign({ lastBuild: lastBuild }, options))
  }

  async function runBuild(body) {
    const started = Date.now()
    try {
      const manifest = await buildReel({
        projectDir: projectDir,
        outDir: outDir,
        shotsDir: shotsDir,
        storyboardPath: storyboardPath,
        ffmpegPath: ffmpegPath,
        sources: Array.isArray(body.sources) && body.sources.length > 0 ? body.sources.map(String) : undefined,
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
        title: typeof body.title === 'string' && body.title.length > 0 ? body.title : undefined,
      })
      lastBuild = {
        at: Date.now(),
        ms: Date.now() - started,
        ok: true,
        error: null,
        durationMs: manifest.durationMs,
        frameCount: manifest.frameCount,
      }
      return { ok: true, manifest: manifest, state: await state() }
    } catch (error) {
      const message = String((error && error.message) || error)
      lastBuild = { at: Date.now(), ms: Date.now() - started, ok: false, error: message }
      return { ok: false, error: message, state: await state() }
    }
  }

  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: API,
        handler: async function (req, res) {
          try {
            const parsed = splitUrl(req.url)
            const method = parsed.method

            if (method === 'asset') {
              if (req.method !== 'GET') return sendError(res, 405, 'method not allowed')
              const filename = String(queryValue(parsed.query, 'name') || '')
              const path = mediaFile(outDir, filename)
              if (path === null) return sendError(res, 404, new ReelError('未知产物：' + filename))
              return serveFile(res, path, MIME[extname(path).toLowerCase()] || 'application/octet-stream')
            }

            if (method === 'shot') {
              if (req.method !== 'GET') return sendError(res, 405, 'method not allowed')
              const relativePath = queryValue(parsed.query, 'path')
              if (!relativePath) return sendError(res, 400, new ReelError('缺少 path 参数'))
              let decoded
              try {
                decoded = decodeURIComponent(relativePath)
              } catch (error) {
                return sendError(res, 400, new ReelError('path 参数不是合法的 URI 编码'))
              }
              const absolutePath = resolve(projectDir, decoded)
              if (!isInside(projectDir, absolutePath)) return sendError(res, 403, new ReelError('拒绝访问项目目录之外的文件'))
              const extension = extname(absolutePath).toLowerCase()
              if (!SHOT_EXTENSIONS.includes(extension)) return sendError(res, 403, new ReelError('只提供 PNG 截图：' + extension))
              return serveFile(res, absolutePath, MIME['.png'])
            }

            if (method === 'state') {
              return sendJson(res, 200, await state())
            }
            if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')

            if (method === 'scan') {
              await readBody(req)
              return sendJson(res, 200, await state())
            }
            if (method === 'build') {
              const body = await readBody(req)
              if (inflight === null) {
                inflight = runBuild(body)
                inflight.then(
                  function () { inflight = null },
                  function () { inflight = null },
                )
              }
              const result = await inflight
              return sendJson(res, 200, result)
            }
            return sendError(res, 404, new ReelError('未知接口：' + method))
          } catch (error) {
            sendError(res, 500, error)
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}
