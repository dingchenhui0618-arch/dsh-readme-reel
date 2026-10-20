// Encoder half of dsh-readme-reel.
//
// Turns the PNG frame sequence rendered by src/reel.js into the three files
// this plugin exists to produce:
//
//   reel.webm   VP9 + alpha (yuva420p), silent
//   reel.gif    the same timeline, alpha flattened onto a matte colour
//   cover.png   one frame, byte-identical to the chosen input frame
//
// ffmpeg is the only external tool. It is located by *running* it, never by
// looking for a file: a path that exists but does not print "ffmpeg version X"
// is not ffmpeg and must be skipped instead of failing the whole plugin.
//
// Frames arrive as an ordered array of arbitrary PNG paths, so the sequence is
// fed to ffmpeg through the concat demuxer instead of an image2 pattern. That
// keeps play order authoritative and costs no copies of the frames.

import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const PREFIX = '[dsh-readme-reel]'
const ENV_VAR = 'DSH_README_REEL_FFMPEG'
const VERSION_RE = /ffmpeg version\s+(\S+)/
const VERSION_TIMEOUT_MS = 10000
const STDERR_KEEP = 256 * 1024
const STDERR_TAIL = 400

const GIF_DEFAULTS = {
  enabled: true,
  width: 640,
  matte: '#0b0e14',
  fps: 20,
}

const WEBM_DEFAULTS = { crf: 34 }

// ---------------------------------------------------------------------------
// locateFfmpeg
// ---------------------------------------------------------------------------

/**
 * Find an ffmpeg that actually runs.
 *
 * Candidates, in order: options.explicit, DSH_README_REEL_FFMPEG, "ffmpeg" on
 * options.env.PATH. Each candidate may be a binary path, a directory holding
 * ffmpeg(.exe), or a bare command name.
 *
 * @param {{ explicit?: string, env?: Record<string, string|undefined>, platform?: string }} [options]
 * @returns {Promise<{ path: string, version: string, source: 'explicit'|'env'|'path' } | null>}
 */
export async function locateFfmpeg(options = {}) {
  try {
    const env = options && typeof options.env === 'object' && options.env ? options.env : process.env
    const platform = typeof (options && options.platform) === 'string' ? options.platform : process.platform
    const explicit = options && typeof options.explicit === 'string' ? options.explicit : ''
    const fromEnv = typeof env[ENV_VAR] === 'string' ? env[ENV_VAR] : ''
    const groups = [
      { spec: explicit, source: 'explicit' },
      { spec: fromEnv, source: 'env' },
      { spec: 'ffmpeg', source: 'path' },
    ]
    for (const group of groups) {
      let candidates = []
      try {
        candidates = expandCandidate(group.spec, env, platform)
      } catch {
        candidates = []
      }
      for (const candidate of candidates) {
        const found = verifyFfmpeg(candidate, env, group.source)
        if (found) return found
      }
    }
    return null
  } catch {
    // The contract is explicit: locating ffmpeg never throws.
    return null
  }
}

function expandCandidate(spec, env, platform) {
  if (typeof spec !== 'string') return []
  const raw = spec.trim()
  if (!raw) return []
  const candidate = raw.replace(/^"(.*)"$/, '$1')
  const bare = !/[\\/]/.test(candidate) && !/^[A-Za-z]:/.test(candidate)
  if (!bare) {
    const info = statSafe(candidate)
    if (info && info.isDirectory()) return binaryNames('ffmpeg', platform).map((name) => join(candidate, name))
    return [candidate]
  }
  // A bare command name can live on options.env.PATH. Resolve it there first so
  // we hand later spawns an absolute path, then fall back to letting the OS
  // search (current directory, real process PATH).
  const resolved = pathCandidates(candidate, env, platform)
  resolved.push(...binaryNames(candidate, platform).filter((name) => name !== candidate && platform === 'win32'))
  resolved.push(candidate)
  return resolved
}

function binaryNames(base, platform) {
  if (platform !== 'win32') return [base]
  if (/\.exe$/i.test(base)) return [base]
  return [`${base}.exe`, base]
}

function pathCandidates(name, env, platform) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  const names = binaryNames(name, platform)
  const found = []
  for (const dir of String(pathValue).split(delimiter)) {
    const clean = dir.trim().replace(/^"(.*)"$/, '$1')
    if (!clean) continue
    for (const entry of names) found.push(join(clean, entry))
  }
  return found
}

function verifyFfmpeg(candidate, env, source) {
  let result
  try {
    result = spawnSync(candidate, ['-version'], {
      encoding: 'utf8',
      env,
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch {
    return null
  }
  if (!result || result.error || result.status !== 0) return null
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  const match = VERSION_RE.exec(text)
  if (!match) return null
  return { path: candidate, version: match[1], source }
}

function statSafe(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// encodeReel
// ---------------------------------------------------------------------------

/**
 * Encode a PNG frame sequence into reel.webm + reel.gif + cover.png.
 *
 * @param {{
 *   frames: string[], outDir: string, width: number, height: number, fps: number,
 *   ffmpegPath: string, gif?: { enabled?: boolean, width?: number, matte?: string, fps?: number },
 *   webm?: { crf?: number }, coverFrame?: number, log?: (line: string) => void,
 *   ffmpegVersion?: string,
 * }} options
 * @returns {Promise<{
 *   webm: { path: string, bytes: number }, gif: { path: string, bytes: number },
 *   cover: { path: string, bytes: number }, ffmpegVersion: string,
 * }>}
 */
export async function encodeReel(options = {}) {
  const frames = options.frames
  if (!Array.isArray(frames) || frames.length < 2) {
    throw contractError(`encodeReel needs at least 2 frame paths (got ${Array.isArray(frames) ? frames.length : typeof frames})`)
  }
  for (let index = 0; index < frames.length; index += 1) {
    if (typeof frames[index] !== 'string' || frames[index].length === 0) {
      throw contractError(`encodeReel: frames[${index}] is not a file path`)
    }
  }
  const ffmpegPath = typeof options.ffmpegPath === 'string' ? options.ffmpegPath.trim() : ''
  if (!ffmpegPath) {
    throw contractError('encodeReel needs ffmpegPath (run locateFfmpeg first)')
  }
  if (typeof options.outDir !== 'string' || options.outDir.length === 0) {
    throw contractError('encodeReel needs outDir')
  }
  const width = positiveInteger(options.width)
  const height = positiveInteger(options.height)
  if (!width || !height) throw contractError('encodeReel needs positive integer width and height')
  const fps = positiveNumber(options.fps)
  if (!fps) throw contractError('encodeReel needs a positive fps')

  const outDir = resolve(options.outDir)
  const log = typeof options.log === 'function' ? safeLogger(options.log) : () => {}

  const webmOptions = objectOption(options.webm)
  const crf = integerOr(webmOptions.crf, WEBM_DEFAULTS.crf)
  const gifOptions = objectOption(options.gif)
  const gifEnabled = gifOptions.enabled !== false
  const gifWidth = positiveInteger(integerOr(gifOptions.width, GIF_DEFAULTS.width)) || GIF_DEFAULTS.width
  const gifFps = positiveNumber(gifOptions.fps) || GIF_DEFAULTS.fps
  const matte = typeof gifOptions.matte === 'string' && gifOptions.matte.trim() ? gifOptions.matte.trim() : GIF_DEFAULTS.matte
  const gifHeight = derivedEvenHeight(gifWidth, width, height)

  let coverFrame = options.coverFrame
  if (coverFrame === undefined || coverFrame === null) coverFrame = Math.floor(frames.length * 0.4)
  if (!Number.isInteger(coverFrame) || coverFrame < 0 || coverFrame >= frames.length) {
    throw contractError(`encodeReel: coverFrame ${String(options.coverFrame)} is outside 0..${frames.length - 1}`)
  }

  await mkdir(outDir, { recursive: true })
  const webmPath = join(outDir, 'reel.webm')
  const gifPath = join(outDir, 'reel.gif')
  const coverPath = join(outDir, 'cover.png')

  const ffmpegVersion = await readFfmpegVersion(ffmpegPath, options.ffmpegVersion)
  log(`ffmpeg: ${ffmpegVersion}`)

  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-readme-reel-'))
  try {
    const listPath = join(tempDir, 'frames.ffconcat')
    try {
      await writeFile(listPath, buildConcatList(frames), 'utf8')
    } catch (error) {
      throw contractError(`could not write the frame list to ${listPath}: ${error.message}`)
    }

    // --- webm -------------------------------------------------------------
    const webmArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-r',
      String(fps),
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-b:v',
      '0',
      '-crf',
      String(crf),
      '-row-mt',
      '1',
      '-an',
      webmPath,
    ]
    log(`webm: encoding ${frames.length} frames, ${width}x${height} @ ${fps}fps, crf ${crf}`)
    await runChecked('webm encode', ffmpegPath, webmArgs)
    const webmBytes = await outputBytes(webmPath, 'webm')
    log(`webm: wrote ${webmPath} (${webmBytes} bytes)`)

    // --- gif --------------------------------------------------------------
    let gif = { path: null, bytes: 0, skipped: true }
    if (gifEnabled) {
      const gifArgs = [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-r',
        String(fps),
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-filter_complex',
        gifFilterGraph({ width, height, gifWidth, gifHeight, gifFps, matte }),
        '-loop',
        '0',
        '-an',
        gifPath,
      ]
      log(`gif: flattening alpha onto ${matte}, scaling to ${gifWidth}x${gifHeight} @ ${gifFps}fps`)
      await runChecked('gif encode', ffmpegPath, gifArgs)
      const gifBytes = await outputBytes(gifPath, 'gif')
      log(`gif: wrote ${gifPath} (${gifBytes} bytes)`)
      gif = { path: gifPath, bytes: gifBytes }
    } else {
      log('gif: disabled')
    }

    // --- cover ------------------------------------------------------------
    try {
      await copyFile(frames[coverFrame], coverPath)
    } catch (error) {
      throw contractError(`cover: could not copy frame ${coverFrame} (${frames[coverFrame]}) to ${coverPath}: ${error.message}`)
    }
    const coverBytes = await outputBytes(coverPath, 'cover')
    log(`cover: frame ${coverFrame} -> ${coverPath} (${coverBytes} bytes)`)

    return {
      webm: { path: webmPath, bytes: webmBytes },
      gif,
      cover: { path: coverPath, bytes: coverBytes },
      ffmpegVersion,
    }
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // A leftover temp dir is not worth failing an otherwise good encode.
    }
  }
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

/**
 * Read the stream facts ffmpeg prints for a file. ffprobe is not required: the
 * text comes from `ffmpeg -hide_banner -i <file>` (which exits non-zero because
 * there is no output file, so the exit code is ignored on purpose).
 *
 * VP9 alpha lives in WebM's BlockAdditional side channel, and ffmpeg's native
 * vp9 decoder ignores it, reporting a plain yuv420p. When the probe sees a vp9
 * stream carrying alpha_mode, it asks again with the libvpx decoder so the
 * reported pix_fmt is the truth the muxer stored (yuva420p).
 *
 * @param {string} file
 * @param {string} ffmpegPath
 * @returns {Promise<{ width: number|null, height: number|null, durationMs: number|null,
 *   codec: string|null, pixFmt: string|null, frames: number|null }>}
 */
export async function probe(file, ffmpegPath) {
  if (typeof file !== 'string' || file.length === 0) throw contractError('probe needs a file path')
  if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) throw contractError('probe needs ffmpegPath')

  const firstArgs = ['-hide_banner', '-i', file]
  const first = await runFfmpeg(ffmpegPath, firstArgs)
  if (first.spawnError) throw ffmpegFailure('probe', ffmpegPath, firstArgs, first)
  const stderr = first.stderr || ''
  let info = parseProbeText(stderr)

  if (info.codec === 'vp9' && /\balpha_mode\b/.test(stderr)) {
    const alphaArgs = ['-hide_banner', '-c:v', 'libvpx-vp9', '-i', file]
    const alphaRun = await runFfmpeg(ffmpegPath, alphaArgs)
    if (!alphaRun.spawnError) {
      const alphaInfo = parseProbeText(alphaRun.stderr || '')
      if (alphaInfo.pixFmt && alphaInfo.width && alphaInfo.height) {
        info = { ...info, ...alphaInfo, frames: alphaInfo.frames ?? info.frames }
      } else if (alphaInfo.pixFmt) {
        info.pixFmt = alphaInfo.pixFmt
      }
    }
  }

  if (info.width === null || info.height === null) {
    throw new Error(
      `${PREFIX} probe: ffmpeg could not read ${file}\n  command: ${formatCommand(ffmpegPath, firstArgs)}\n  ffmpeg stderr (last ${STDERR_TAIL} chars):\n${indent(tail(stderr))}`,
    )
  }
  return info
}

function parseProbeText(stderr) {
  const text = String(stderr || '')
  const info = { width: null, height: null, durationMs: null, codec: null, pixFmt: null, frames: null }

  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (duration) {
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    info.durationMs = Math.round(seconds * 1000)
  }

  const stream = /Stream #\d+:\d+[^\n]*?: Video: ([^\n]*)/.exec(text)
  if (!stream) return info
  const rest = stream[1]
  const codecMatch = /^([A-Za-z0-9_-]+)/.exec(rest)
  if (codecMatch) info.codec = codecMatch[1]
  const afterCodec = rest.slice(codecMatch ? codecMatch[0].length : 0)

  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(afterCodec)
  if (size) {
    info.width = Number(size[1])
    info.height = Number(size[2])
  }

  for (const rawToken of afterCodec.split(',')) {
    const token = rawToken.trim().replace(/\(.*$/, '').trim()
    if (!token || /^\d+x\d+/.test(token) || /^[\d.]+$/.test(token)) continue
    if (/^(SAR|DAR|tbr|tbn|fps|progressive)$/i.test(token)) continue
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) {
      info.pixFmt = token
      break
    }
  }

  let frameRate = null
  const fpsMatch = /\b(\d+(?:\.\d+)?)\s+fps\b/.exec(rest)
  if (fpsMatch) frameRate = Number(fpsMatch[1])
  if (!frameRate) {
    const tbrMatch = /\b(\d+(?:\.\d+)?)\s+tbr\b/.exec(rest)
    if (tbrMatch) frameRate = Number(tbrMatch[1])
  }

  const nbFrames = /nb_frames=(\d+)/.exec(text)
  if (nbFrames) info.frames = Number(nbFrames[1])
  else if (info.durationMs !== null && frameRate) info.frames = Math.round((info.durationMs / 1000) * frameRate)

  return info
}

// ---------------------------------------------------------------------------
// ffmpeg plumbing
// ---------------------------------------------------------------------------

function runFfmpeg(ffmpegPath, args, env = process.env) {
  return new Promise((settle) => {
    let child
    try {
      child = spawn(ffmpegPath, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      settle({ code: null, stdout: '', stderr: '', spawnError: describeSpawnError(error) })
      return
    }

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      settle(value)
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= STDERR_KEEP) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk)
      stderrBytes += chunk.length
      if (stderrBytes > STDERR_KEEP) {
        const joined = Buffer.concat(stderr)
        const kept = joined.subarray(joined.length - STDERR_KEEP)
        stderr.length = 0
        stderr.push(kept)
        stderrBytes = kept.length
      }
    })
    child.on('error', (error) => {
      finish({ code: null, stdout: '', stderr: '', spawnError: describeSpawnError(error) })
    })
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        spawnError: null,
      })
    })
  })
}

async function runChecked(stage, ffmpegPath, args) {
  const result = await runFfmpeg(ffmpegPath, args)
  if (result.spawnError || result.code !== 0) throw ffmpegFailure(stage, ffmpegPath, args, result)
  return result
}

async function readFfmpegVersion(ffmpegPath, supplied) {
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim()
  const args = ['-version']
  const result = await runFfmpeg(ffmpegPath, args)
  if (result.spawnError || result.code !== 0) throw ffmpegFailure('ffmpeg -version', ffmpegPath, args, result)
  const match = VERSION_RE.exec(`${result.stdout || ''}\n${result.stderr || ''}`)
  if (!match) {
    throw contractError(`${ffmpegPath} did not report an ffmpeg version; it is not a usable ffmpeg`)
  }
  return match[1]
}

function ffmpegFailure(stage, ffmpegPath, args, result) {
  const command = formatCommand(ffmpegPath, args)
  if (result.spawnError) {
    return new Error(`${PREFIX} ${stage} failed: could not start ffmpeg (${result.spawnError})\n  command: ${command}`)
  }
  const detail = tail(result.stderr) || '(ffmpeg printed nothing to stderr)'
  return new Error(
    `${PREFIX} ${stage} failed (exit code ${result.code})\n  command: ${command}\n  ffmpeg stderr (last ${STDERR_TAIL} chars):\n${indent(detail)}`,
  )
}

function formatCommand(ffmpegPath, args) {
  return [ffmpegPath, ...args].map(quoteArgument).join(' ')
}

function quoteArgument(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

function describeSpawnError(error) {
  if (!error) return 'unknown error'
  const code = error.code ? `${error.code}: ` : ''
  return `${code}${error.message || String(error)}`
}

function tail(text, max = STDERR_TAIL) {
  const value = String(text || '').trim()
  if (value.length <= max) return value
  return `...${value.slice(-max)}`
}

function indent(text) {
  return String(text || '')
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// command construction helpers
// ---------------------------------------------------------------------------

function buildConcatList(frames) {
  const lines = ['ffconcat version 1.0']
  for (const frame of frames) lines.push(`file '${escapeConcatPath(resolve(frame))}'`)
  return `${lines.join('\n')}\n`
}

function escapeConcatPath(file) {
  // The concat demuxer quotes paths with single quotes; forward slashes keep
  // Windows paths readable and -safe 0 allows the absolute paths we need.
  return file.replace(/\\/g, '/').replace(/'/g, "'\\''")
}

function gifFilterGraph({ width, height, gifWidth, gifHeight, gifFps, matte }) {
  const matteColor = /^#/.test(matte) ? `0x${matte.slice(1)}` : matte
  return [
    // A solid matte the size of the source frames, then the frames over it:
    // alpha is flattened onto the matte instead of being handed to GIF's 1-bit
    // transparency, which would fringe every antialiased edge.
    `color=c=${matteColor}:s=${gifWidth}x${gifHeight}:r=${gifFps}[matte]`,
    // Resample to the gif rate *before* the overlay. Overlaying at the reel
    // rate and resampling afterwards drops the final frame (5.95s instead of
    // 6.00s), because overlay=shortest=1 ends one frame short of its input.
    `[0:v]fps=${gifFps},scale=${gifWidth}:${gifHeight}:flags=lanczos,format=rgba[frames]`,
    '[matte][frames]overlay=shortest=1:format=rgb[flat]',
    // One palette for the whole flat sequence keeps the background steady.
    '[flat]split[paletteSrc][videoSrc]',
    '[paletteSrc]palettegen=stats_mode=diff[palette]',
    '[videoSrc][palette]paletteuse=dither=bayer:bayer_scale=5',
  ].join(';')
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function contractError(message) {
  return new Error(`${PREFIX} ${message}`)
}

function safeLogger(log) {
  return (line) => {
    try {
      log(String(line))
    } catch {
      // Progress reporting must never break an encode.
    }
  }
}

function positiveInteger(value) {
  if (!Number.isInteger(value) || value < 1) return null
  return value
}

function positiveNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

function integerOr(value, fallback) {
  if (Number.isInteger(value)) return value
  return fallback
}

function objectOption(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function derivedEvenHeight(gifWidth, width, height) {
  const target = (gifWidth * height) / width
  return Math.max(2, Math.round(target / 2) * 2)
}

async function outputBytes(file, stage) {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size <= 0) throw new Error('missing or empty')
    return info.size
  } catch (error) {
    throw contractError(`${stage}: ffmpeg reported success but ${file} is not a usable file (${error.message})`)
  }
}
