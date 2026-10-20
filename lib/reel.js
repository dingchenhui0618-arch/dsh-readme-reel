// The reel pipeline: storyboard in, three published artefacts out.
//
// Stage boundaries are explicit because they are what the tests pin:
//
//   resolveStoryboard -> decode sources -> render stills -> timeline
//   -> spool PNG frames -> encodeReel (ffmpeg) -> manifest
//
// Frames are spooled as PNGs in <outDir>/.frames instead of streaming rawvideo
// into ffmpeg: a 960x600x30fps raw stream is ~415 MB, and keeping the frames on
// disk makes a failed encode debuggable ("look at frame 83") instead of a black
// box. The directory is removed after a successful build unless keepFrames.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeReel, locateFfmpeg } from './encode.js'
import { ReelError } from './errors.js'
import { decodePng, encodePng } from './png.js'
import { buildTimeline, normalizeStoryboard, sampleAt } from './storyboard.js'
import { renderFrame, renderStills } from './compose.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
export const OUTPUT_NAMES = ['reel.webm', 'reel.gif', 'cover.png', 'reel.json']
export const SHOT_EXTENSIONS = ['.png']

export async function readPluginVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch (error) {
    return '0.0.0'
  }
}

function toPosix(path) {
  return path.split(sep).join('/')
}

function relativeTo(from, to) {
  return toPosix(relative(from, to)) || '.'
}

/** Absolute path for a storyboard `src`, resolved against the project dir. */
export function resolveSource(projectDir, src) {
  return isAbsolute(src) ? resolve(src) : resolve(projectDir, src)
}

/** Screenshot candidates for a shots folder, in stable name order. */
export async function listShots(shotsDir) {
  let entries
  try {
    entries = await readdir(shotsDir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const shots = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (!SHOT_EXTENSIONS.some(function (ext) { return lower.endsWith(ext) })) continue
    const path = join(shotsDir, entry.name)
    let bytes = 0
    try {
      bytes = (await stat(path)).size
    } catch (error) {
      bytes = 0
    }
    shots.push({ path: path, name: entry.name, title: entry.name.replace(/\.[^.]+$/, ''), bytes: bytes })
  }
  shots.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) })
  return shots
}

/** True when `child` is inside `parent` (both absolute, resolved here). */
export function isInside(parent, child) {
  const root = toPosix(resolve(parent))
  const target = toPosix(resolve(child))
  if (target === root) return true
  return target.startsWith(root.endsWith('/') ? root : root + '/')
}

/**
 * Build a storyboard-shaped object from a list of screenshot paths. Holds are
 * omitted on purpose: when you just point the tool at a folder, "spread these
 * evenly across the six seconds" is the only defensible default.
 */
export function autoStoryboard(shots, options = {}) {
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new ReelError('没有可用于合成的截图')
  }
  return {
    version: 1,
    title: options.title === undefined ? '' : options.title,
    durationMs: options.durationMs,
    fps: options.fps,
    size: options.size,
    loop: true,
    layout: 'window',
    transition: options.transition,
    transitionMs: options.transitionMs,
    theme: options.theme,
    scenes: shots.map(function (shot) {
      const path = typeof shot === 'string' ? shot : shot.path
      return { src: path, layout: 'window' }
    }),
  }
}

/**
 * Decide which storyboard is in force. Precedence:
 *   1. an explicit sources list from the panel/CLI  (auto storyboard)
 *   2. docs/storyboard.json when it exists         (file storyboard)
 *   3. every screenshot in the shots folder         (auto storyboard)
 */
/**
 * Rewrite storyboard `src` values to project-relative paths so the manifest
 * that gets committed never contains a machine-specific absolute path.
 */
function portableStoryboard(projectDir, storyboard) {
  storyboard.scenes = storyboard.scenes.map(function (scene) {
    const absolute = resolveSource(projectDir, scene.src)
    return Object.assign({}, scene, { src: relativeTo(projectDir, absolute) })
  })
  return storyboard
}

export async function resolveStoryboard(options) {
  const projectDir = resolve(options.projectDir)
  const shotsDir = resolve(options.shotsDir)
  const storyboardPath = options.storyboardPath === null || options.storyboardPath === undefined
    ? join(projectDir, 'docs', 'storyboard.json')
    : resolve(options.storyboardPath)
  const fallbackTitle = basename(projectDir)
  const runtime = {
    durationMs: options.durationMs,
    fps: options.fps,
    size: options.size,
    transition: options.transition,
    transitionMs: options.transitionMs,
    theme: options.theme,
  }

  if (Array.isArray(options.sources) && options.sources.length > 0) {
    const absolute = options.sources.map(function (source) { return resolveSource(projectDir, String(source)) })
    const storyboard = normalizeStoryboard(
      autoStoryboard(absolute, Object.assign({ title: options.title || fallbackTitle }, runtime)),
      { fallbackTitle: fallbackTitle },
    )
    return { source: 'auto', path: null, storyboard: portableStoryboard(projectDir, storyboard) }
  }

  if (existsSync(storyboardPath)) {
    let raw
    try {
      raw = JSON.parse(await readFile(storyboardPath, 'utf8'))
    } catch (error) {
      throw new ReelError('读不了 storyboard ' + storyboardPath + '：' + (error && error.message ? error.message : error))
    }
    const storyboard = normalizeStoryboard(Object.assign({}, runtime, raw, {
      title: raw.title || options.title || fallbackTitle,
    }), { fallbackTitle: fallbackTitle })
    return { source: 'file', path: storyboardPath, storyboard: portableStoryboard(projectDir, storyboard) }
  }

  const shots = await listShots(shotsDir)
  if (shots.length === 0) {
    throw new ReelError(
      '没有找到截图：把 PNG 放进 ' + shotsDir + '，或写一个 ' + storyboardPath +
      '，或在面板里指定 projectDir',
    )
  }
  const storyboard = normalizeStoryboard(
    autoStoryboard(shots, Object.assign({ title: options.title || fallbackTitle }, runtime)),
    { fallbackTitle: fallbackTitle },
  )
  return { source: 'auto', path: null, storyboard: portableStoryboard(projectDir, storyboard) }
}

async function decodeSource(projectDir, scene) {
  const path = resolveSource(projectDir, scene.src)
  if (!isInside(projectDir, path)) {
    throw new ReelError('截图不在项目目录内，拒绝读取：' + scene.src)
  }
  let buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    throw new ReelError('读不了截图 ' + scene.src + '：' + (error && error.code === 'ENOENT' ? '文件不存在' : String((error && error.message) || error)))
  }
  try {
    return decodePng(buffer)
  } catch (error) {
    throw new ReelError('截图 ' + scene.src + ' 不是可用的 PNG：' + String((error && error.message) || error))
  }
}

/** Pick a cover frame on the longest hold, never mid-transition. */
export function pickCoverFrame(timeline) {
  const holds = timeline.holds
  if (!holds || holds.length === 0) return 0
  let best = holds[0]
  for (const hold of holds) {
    if (hold.toMs - hold.fromMs > best.toMs - best.fromMs) best = hold
  }
  const fps = timeline.fps
  const index = Math.floor((best.fromMs + Math.min(best.toMs - best.fromMs, 200)) / 1000 * fps)
  return Math.max(0, Math.min(timeline.frameCount - 1, index))
}

export function defaultLayout(options) {
  const projectDir = resolve(options.projectDir || process.cwd())
  return {
    projectDir: projectDir,
    shotsDir: resolve(options.shotsDir || join(projectDir, 'docs', 'shots')),
    outDir: resolve(options.outDir || join(projectDir, 'docs', 'reel')),
    storyboardPath: options.storyboardPath === undefined ? join(projectDir, 'docs', 'storyboard.json') : options.storyboardPath,
  }
}

/**
 * Build the reel. Returns the manifest; also writes `<outDir>/reel.json`.
 * Throws ReelError for every user-facing failure (bad storyboard, missing
 * shot, missing ffmpeg, encoder failure) and leaves no half-written outputs.
 */
export async function buildReel(options = {}) {
  const started = Date.now()
  const log = typeof options.log === 'function' ? options.log : function () {}
  const layout = defaultLayout(options)
  const projectDir = layout.projectDir
  const outDir = options.outDir ? resolve(options.outDir) : layout.outDir
  const shotsDir = options.shotsDir ? resolve(options.shotsDir) : layout.shotsDir
  const storyboardPath = options.storyboardPath === null ? null : resolve(layout.storyboardPath)

  log('[1/6] 解析 storyboard')
  const resolved = await resolveStoryboard({
    projectDir: projectDir,
    shotsDir: shotsDir,
    storyboardPath: storyboardPath,
    sources: options.sources,
    title: options.title,
    durationMs: options.durationMs,
    fps: options.fps,
    size: options.size,
    transition: options.transition,
    transitionMs: options.transitionMs,
    theme: options.theme,
  })
  const storyboard = resolved.storyboard

  log('[2/6] 读取 ' + storyboard.scenes.length + ' 张截图')
  const sources = []
  for (const scene of storyboard.scenes) sources.push(await decodeSource(projectDir, scene))

  log('[3/6] 合成静帧')
  const stills = renderStills(storyboard, sources)
  const timeline = buildTimeline(storyboard)

  log('[4/6] 生成 ' + timeline.frameCount + ' 帧 PNG')
  const framesDir = join(outDir, '.frames')
  await rm(framesDir, { recursive: true, force: true })
  await mkdir(framesDir, { recursive: true })
  const stillPng = stills.map(function (still) { return encodePng(still) })
  const frames = []
  for (let index = 0; index < timeline.frameCount; index += 1) {
    const t = (index * 1000) / storyboard.fps
    const sample = sampleAt(timeline, t)
    let bytes
    if (sample.kind === 'hold') {
      bytes = stillPng[sample.scene]
    } else {
      bytes = encodePng(renderFrame(storyboard, timeline, stills, t))
    }
    const path = join(framesDir, 'frame-' + String(index).padStart(4, '0') + '.png')
    await writeFile(path, bytes)
    frames.push(path)
  }

  log('[5/6] 编码 webm / gif / cover')
  const ffmpeg = options.ffmpeg || (await locateFfmpeg({ explicit: options.ffmpegPath }))
  if (!ffmpeg) {
    throw new ReelError('没有找到 ffmpeg：装一个 ffmpeg 并放进 PATH，或设置环境变量 DSH_README_REEL_FFMPEG（面板里会显示探测结果）')
  }

  const coverFrame = options.coverFrame === undefined ? pickCoverFrame(timeline) : options.coverFrame
  let encoded
  try {
    encoded = await encodeReel({
      frames: frames,
      outDir: outDir,
      width: storyboard.size.width,
      height: storyboard.size.height,
      fps: storyboard.fps,
      ffmpegPath: ffmpeg.path,
      gif: options.gif,
      webm: options.webm,
      coverFrame: coverFrame,
      log: log,
    })
  } finally {
    if (options.keepFrames !== true) await rm(framesDir, { recursive: true, force: true })
  }

  log('[6/6] 写清单')
  const manifest = {
    name: 'dsh-readme-reel',
    version: await readPluginVersion(),
    createdAt: new Date().toISOString(),
    title: storyboard.title,
    durationMs: storyboard.durationMs,
    frameCount: timeline.frameCount,
    fps: storyboard.fps,
    size: { width: storyboard.size.width, height: storyboard.size.height },
    loop: storyboard.loop,
    transition: storyboard.transition,
    transitionMs: timeline.transitionMs,
    storyboard: {
      source: resolved.source,
      path: resolved.path === null ? null : relativeTo(projectDir, resolved.path),
    },
    scenes: timeline.scenes.map(function (scene, index) {
      return {
        index: index,
        src: scene.src,
        holdMs: scene.holdMs,
        layout: scene.layout,
      }
    }),
    outputs: {
      webm: describeOutput(outDir, encoded.webm, projectDir),
      gif: describeOutput(outDir, encoded.gif, projectDir),
      cover: describeOutput(outDir, encoded.cover, projectDir),
    },
    ffmpeg: { version: encoded.ffmpegVersion },
    elapsedMs: Date.now() - started,
  }
  await writeFile(join(outDir, 'reel.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

function describeOutput(outDir, output, projectDir) {
  return {
    file: basename(output.path),
    path: relativeTo(projectDir, output.path),
    bytes: output.bytes,
    sha256: sha256OfFile(output.path),
  }
}

function sha256OfFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch (error) {
    return null
  }
}

/** Read a previously written manifest, or null. */
export async function readManifest(outDir) {
  try {
    return JSON.parse(await readFile(join(outDir, 'reel.json'), 'utf8'))
  } catch (error) {
    return null
  }
}

/** Nearest project root from a starting directory (host-side convenience). */
export function discoverProjectDir(startDir) {
  const start = resolve(startDir || process.cwd())
  const candidates = [start, resolve(start, '..'), resolve(start, '..', '..')]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'docs', 'shots')) || existsSync(join(candidate, 'docs', 'storyboard.json')) || existsSync(join(candidate, 'readme-reel.json'))) {
      return candidate
    }
  }
  return start
}
