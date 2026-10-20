// CLI half. Same pipeline as the panel, no server: this is what a repo puts in
// package.json ("reel": "dsh-readme-reel docs/storyboard.json") or a CI job.
//
// Parsing is hand-rolled because the whole project is dependency-free, and it
// is exported so test/cli.test.mjs can pin the argument grammar without
// spawning a process.

import { dirname, resolve } from 'node:path'
import { locateFfmpeg } from './encode.js'
import { buildReel, defaultLayout, discoverProjectDir, listShots, resolveStoryboard } from './reel.js'

export const USAGE = [
  '用法: dsh-readme-reel [storyboard.json] [选项]',
  '',
  '从截图生成 6 秒静音循环短片：reel.webm（VP9 + 透明）、reel.gif、cover.png。',
  '',
  '选项:',
  '  --project <dir>      项目根目录（默认自动向上发现，找不到用 cwd）',
  '  --out <dir>          产物目录（默认 <project>/docs/reel）',
  '  --shots <dir>        截图目录（默认 <project>/docs/shots）',
  '  --storyboard <file>  storyboard 路径（默认 <project>/docs/storyboard.json）',
  '  --sources <a,b,c>    只用这些截图，按给定顺序（替代 storyboard 文件）',
  '  --title <text>       清单里的标题',
  '  --duration <ms>      总时长（默认 6000）',
  '  --fps <n>            帧率（默认 30）',
  '  --width/--height <n> 画布尺寸（默认 960x600）',
  '  --ffmpeg <path>      ffmpeg 路径（默认 PATH / DSH_README_REEL_FFMPEG）',
  '  --gif-width <n>      gif 宽度（默认 640）',
  '  --gif-fps <n>        gif 帧率（默认 20）',
  '  --matte <#rrggbb>    gif 垫底色（默认 #0b0e14）',
  '  --crf <n>            VP9 CRF（默认 34，越大越小越糊）',
  '  --keep-frames        保留中间 PNG 帧（排错用）',
  '  --json               只输出 manifest JSON',
  '  --ffmpeg-check       只探测 ffmpeg 并打印结果',
  '  -h, --help           显示本帮助',
].join('\n')

const NUMBER_FLAGS = {
  duration: 'durationMs',
  fps: 'fps',
  width: 'width',
  height: 'height',
  'gif-width': 'gifWidth',
  'gif-fps': 'gifFps',
  crf: 'crf',
}

export function parseArgs(argv) {
  const options = { flags: {}, positional: [] }
  const args = Array.from(argv)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      options.flags.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      options.positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const flag = equals >= 0 ? arg.slice(2, equals) : arg.slice(2)
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined
    if (flag === 'keep-frames') {
      options.flags.keepFrames = true
      continue
    }
    if (flag === 'json') {
      options.flags.json = true
      continue
    }
    if (flag === 'ffmpeg-check') {
      options.flags.ffmpegCheck = true
      continue
    }
    let value = inline
    if (value === undefined) {
      index += 1
      value = args[index]
    }
    if (value === undefined) throw new Error('[dsh-readme-reel] --' + flag + ' 缺少参数值')
    options.flags[flag] = value
  }
  return options
}

function numberFlag(flags, name) {
  if (flags[name] === undefined) return undefined
  const value = Number(flags[name])
  if (!Number.isFinite(value)) throw new Error('[dsh-readme-reel] --' + name + ' 需要数字，收到 ' + JSON.stringify(flags[name]))
  return value
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

export function formatSeconds(ms) {
  return (ms / 1000).toFixed(2) + 's'
}

/**
 * Options -> buildReel() arguments. Exported because it encodes precedence the
 * CLI shares with tests (explicit --project beats discovery, --sources beats a
 * storyboard file, and so on).
 */
export async function resolveOptions(flags, positional, cwd) {
  const storyboardArg = positional.length > 0 ? resolve(cwd, positional[0]) : undefined
  const projectDir = flags.project
    ? resolve(flags.project)
    : discoverProjectDir(storyboardArg === undefined ? cwd : dirname(storyboardArg))
  const layout = defaultLayout({ projectDir: projectDir, outDir: flags.out, shotsDir: flags.shots })
  const storyboardPath = flags.storyboard === undefined
    ? (storyboardArg === undefined ? layout.storyboardPath : storyboardArg)
    : resolve(flags.storyboard)

  const width = numberFlag(flags, 'width')
  const height = numberFlag(flags, 'height')
  const sources = typeof flags.sources === 'string' && flags.sources.length > 0
    ? flags.sources.split(',').map(function (value) { return value.trim() }).filter(Boolean)
    : undefined

  const gif = cleanObject({
    width: numberFlag(flags, 'gif-width'),
    fps: numberFlag(flags, 'gif-fps'),
    matte: flags.matte,
  })
  const webm = cleanObject({ crf: numberFlag(flags, 'crf') })

  return {
    projectDir: projectDir,
    outDir: layout.outDir,
    shotsDir: layout.shotsDir,
    storyboardPath: storyboardPath,
    sources: sources,
    title: flags.title,
    durationMs: numberFlag(flags, 'duration'),
    fps: numberFlag(flags, 'fps'),
    size: width !== undefined || height !== undefined
      ? { width: width === undefined ? 960 : width, height: height === undefined ? 600 : height }
      : undefined,
    ffmpegPath: flags.ffmpeg,
    gif: Object.keys(gif).length > 0 ? gif : undefined,
    webm: Object.keys(webm).length > 0 ? webm : undefined,
    keepFrames: flags.keepFrames === true,
  }
}

function cleanObject(value) {
  const out = {}
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, stdout?: (text: string) => void, stderr?: (text: string) => void }} io
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || function (text) { process.stdout.write(text + '\n') }
  const stderr = io.stderr || function (text) { process.stderr.write(text + '\n') }
  const cwd = resolve(io.cwd || process.cwd())

  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    stderr(String(error.message))
    return 2
  }
  const flags = parsed.flags
  if (flags.help) {
    stdout(USAGE)
    return 0
  }

  if (flags.ffmpegCheck) {
    const ffmpeg = await locateFfmpeg({ explicit: flags.ffmpeg })
    if (!ffmpeg) {
      stderr('[dsh-readme-reel] 没有找到可用的 ffmpeg')
      return 1
    }
    stdout(JSON.stringify(ffmpeg, null, 2))
    return 0
  }

  try {
    const options = await resolveOptions(flags, parsed.positional, cwd)
    const result = await buildReel(Object.assign(cleanObject(options), {
      log: flags.json ? undefined : function (line) { stderr(line) },
    }))
    if (flags.json) {
      stdout(JSON.stringify(result, null, 2))
      return 0
    }
    stdout('')
    stdout('dsh-readme-reel  ' + result.title + '  ' + formatSeconds(result.durationMs) + '  ' + result.fps + 'fps  ' + result.frameCount + ' 帧')
    for (const key of ['webm', 'gif', 'cover']) {
      const output = result.outputs[key]
      if (output) stdout('  ' + output.file.padEnd(10) + formatBytes(output.bytes).padStart(9) + '  ' + output.path)
    }
    stdout('  manifest   ' + 'reel.json')
    stdout('  ffmpeg     ' + result.ffmpeg.version)
    return 0
  } catch (error) {
    stderr(String((error && error.message) || error))
    return 1
  }
}

export { buildReel, listShots, resolveStoryboard }
