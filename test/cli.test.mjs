// CLI tests. The argument grammar and the flag-to-build precedence are exported
// on purpose, so most of this runs without spawning anything. One real build
// proves the exit code, the files and the human summary line.

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  formatBytes,
  formatSeconds,
  main,
  parseArgs,
  resolveOptions,
  USAGE,
} from '../src/cli.js'
import { locateFfmpeg } from '../src/encode.js'
import { encodePng } from '../src/png.js'
import { color, createCanvas, fillRect } from '../src/raster.js'

const ffmpeg = await locateFfmpeg()

async function shotBytes(hex) {
  const canvas = createCanvas(320, 200)
  fillRect(canvas, 0, 0, 320, 200, color(hex, 1))
  return encodePng(canvas)
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'reel-cli-'))
  const shotsDir = join(root, 'docs', 'shots')
  await mkdir(shotsDir, { recursive: true })
  await writeFile(join(shotsDir, 'shot-1.png'), await shotBytes('#101820'))
  await writeFile(join(shotsDir, 'shot-2.png'), await shotBytes('#301810'))
  return { root, shotsDir }
}

function scanner() {
  const lines = []
  const push = function (line) { lines.push(String(line)) }
  return { lines: lines, stdout: push, stderr: push, text: () => lines.join('\n') }
}

test('parseArgs handles values, inline equals, booleans and positionals', () => {
  const parsed = parseArgs(['docs/storyboard.json', '--duration=1200', '--fps', '12', '--keep-frames', '--json', '--title', 'demo'])
  assert.deepEqual(parsed.positional, ['docs/storyboard.json'])
  assert.equal(parsed.flags.duration, '1200')
  assert.equal(parsed.flags.fps, '12')
  assert.equal(parsed.flags.keepFrames, true)
  assert.equal(parsed.flags.json, true)
  assert.equal(parsed.flags.title, 'demo')
  assert.throws(() => parseArgs(['--duration']), /缺少参数值/)
})

test('resolveOptions encodes the precedence the CLI documents', async () => {
  const project = await makeProject()
  const cwd = project.root

  const explicit = await resolveOptions({ project: project.root }, [], cwd)
  assert.equal(explicit.projectDir, project.root)
  assert.equal(explicit.outDir, join(project.root, 'docs', 'reel'))
  assert.equal(explicit.shotsDir, join(project.root, 'docs', 'shots'))
  assert.equal(explicit.storyboardPath, join(project.root, 'docs', 'storyboard.json'))

  const fromPositional = await resolveOptions({}, [join(project.root, 'docs', 'storyboard.json')], cwd)
  assert.equal(fromPositional.projectDir, project.root, 'the project root is discovered from the storyboard path')

  const withSources = await resolveOptions({
    project: project.root,
    sources: 'docs/shots/shot-2.png, docs/shots/shot-1.png',
    width: '320',
    'gif-width': '240',
    crf: '40',
  }, [], cwd)
  assert.deepEqual(withSources.sources, ['docs/shots/shot-2.png', 'docs/shots/shot-1.png'])
  assert.deepEqual(withSources.size, { width: 320, height: 600 })
  assert.deepEqual(withSources.gif, { width: 240 })
  assert.deepEqual(withSources.webm, { crf: 40 })
  assert.equal(withSources.keepFrames, false)

  await assert.rejects(resolveOptions({ duration: 'soon' }, [], cwd), /需要数字/)
})

test('main --help prints the usage block and succeeds', async () => {
  const io = scanner()
  assert.equal(await main(['--help'], io), 0)
  assert.ok(io.text().includes(USAGE.split('\n')[0]))
  assert.ok(io.text().includes('--keep-frames'))
})

test('main returns 2 for an argument error and 1 for a build error', async () => {
  const args = scanner()
  assert.equal(await main(['--duration'], args), 2)
  assert.match(args.text(), /缺少参数值/)

  const missing = scanner()
  const empty = await mkdtemp(join(tmpdir(), 'reel-cli-empty-'))
  assert.equal(await main(['--project', empty], missing), 1)
  assert.match(missing.text(), /没有找到截图/)
})

test('main --ffmpeg-check reports the binary it would use', { skip: ffmpeg === null ? 'ffmpeg not available' : false }, async () => {
  const io = scanner()
  assert.equal(await main(['--ffmpeg-check'], io), 0)
  const info = JSON.parse(io.text())
  assert.ok(info.path.length > 0)
  assert.equal(info.source, 'env')
  assert.match(info.version, /^\d+\.\d+/)
})

test('main --ffmpeg-check fails with a clear message when ffmpeg is absent', async () => {
  const savedEnv = process.env.DSH_README_REEL_FFMPEG
  const savedPath = process.env.PATH
  delete process.env.DSH_README_REEL_FFMPEG
  process.env.PATH = join(tmpdir(), 'not-a-path')
  try {
    const io = scanner()
    assert.equal(await main(['--ffmpeg-check'], io), 1)
    assert.match(io.text(), /没有找到可用的 ffmpeg/)
  } finally {
    if (savedEnv === undefined) delete process.env.DSH_README_REEL_FFMPEG
    else process.env.DSH_README_REEL_FFMPEG = savedEnv
    process.env.PATH = savedPath
  }
})

test('main builds a reel and prints file sizes (needs ffmpeg)', { skip: ffmpeg === null ? 'ffmpeg not available' : false }, async () => {
  const project = await makeProject()
  const io = scanner()
  const code = await main([
    '--project', project.root,
    '--sources', 'docs/shots/shot-1.png,docs/shots/shot-2.png',
    '--duration', '1000',
    '--fps', '10',
    '--width', '320',
    '--height', '200',
  ], Object.assign({ cwd: project.root }, io))
  assert.equal(code, 0, io.text())
  assert.ok(existsSync(join(project.root, 'docs', 'reel', 'reel.webm')))
  assert.ok(existsSync(join(project.root, 'docs', 'reel', 'reel.gif')))
  assert.ok(existsSync(join(project.root, 'docs', 'reel', 'cover.png')))
  assert.match(io.text(), /reel\.webm/)
  assert.match(io.text(), /cover\.png/)
  assert.match(io.text(), /1\.00s/)
})

test('main --json prints only the manifest (needs ffmpeg)', { skip: ffmpeg === null ? 'ffmpeg not available' : false }, async () => {
  const project = await makeProject()
  const io = scanner()
  const code = await main([
    '--project', project.root,
    '--sources', 'docs/shots/shot-1.png',
    '--duration', '1000',
    '--fps', '10',
    '--width', '320',
    '--height', '200',
    '--json',
  ], Object.assign({ cwd: project.root }, io))
  assert.equal(code, 0, io.text())
  const manifest = JSON.parse(io.text())
  assert.equal(manifest.durationMs, 1000)
  assert.equal(manifest.outputs.cover.path, 'docs/reel/cover.png')
  assert.equal(manifest.scenes.length, 1)
})

test('format helpers stay readable', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB')
  assert.equal(formatBytes(Number.NaN), '?')
  assert.equal(formatSeconds(6000), '6.00s')
})
