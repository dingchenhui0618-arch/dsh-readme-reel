// Pipeline tests: storyboard resolution, shot discovery, and one real
// end-to-end build through ffmpeg. The integration test skips (cleanly) on a
// machine without ffmpeg, which is the same contract the CLI has.

import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { locateFfmpeg, probe } from '../src/encode.js'
import { encodePng } from '../src/png.js'
import { color, createCanvas, fillRect } from '../src/raster.js'
import {
  autoStoryboard,
  buildReel,
  discoverProjectDir,
  isInside,
  listShots,
  pickCoverFrame,
  readManifest,
  resolveStoryboard,
} from '../src/reel.js'
import { buildTimeline, normalizeStoryboard } from '../src/storyboard.js'

async function shot(width, height, hex) {
  const canvas = createCanvas(width, height)
  fillRect(canvas, 0, 0, width, height, color(hex, 1))
  fillRect(canvas, 20, 20, Math.floor(width / 2), 40, color('#ffffff', 1))
  return encodePng(canvas)
}

async function makeProject(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reel-project-'))
  const shotsDir = join(root, 'docs', 'shots')
  await mkdir(shotsDir, { recursive: true })
  const count = options.count === undefined ? 2 : options.count
  const names = []
  const colors = ['#101820', '#201810', '#182010', '#101820']
  for (let i = 0; i < count; i += 1) {
    const name = 'shot-' + (i + 1) + '.png'
    names.push(name)
    await writeFile(join(shotsDir, name), await shot(600, 400, colors[i % colors.length]))
  }
  return { root, shotsDir, shots: names.map((name) => join(shotsDir, name)) }
}

const ffmpeg = await locateFfmpeg()

test('listShots returns PNGs in natural name order and ignores everything else', async () => {
  const project = await makeProject({ count: 3 })
  await writeFile(join(project.shotsDir, 'notes.txt'), 'not a shot')
  await writeFile(join(project.shotsDir, '10-shot.png'), await shot(100, 80, '#333333'))
  const shots = await listShots(project.shotsDir)
  assert.deepEqual(shots.map((entry) => entry.name), ['10-shot.png', 'shot-1.png', 'shot-2.png', 'shot-3.png'])
  for (const entry of shots) {
    assert.ok(entry.bytes > 0)
    assert.equal(entry.title, entry.name.replace('.png', ''))
  }
  assert.deepEqual(await listShots(join(project.root, 'nope')), [])
})

test('resolveStoryboard prefers sources, then the storyboard file, then shots', async () => {
  const project = await makeProject({ count: 2 })
  const base = { projectDir: project.root, shotsDir: project.shotsDir }

  const auto = await resolveStoryboard(base)
  assert.equal(auto.source, 'auto')
  assert.equal(auto.storyboard.scenes.length, 2)

  const overridden = await resolveStoryboard(Object.assign({}, base, { sources: ['docs/shots/shot-2.png'] }))
  assert.equal(overridden.source, 'auto')
  assert.equal(overridden.storyboard.scenes.length, 1)
  assert.equal(overridden.storyboard.scenes[0].src, 'docs/shots/shot-2.png')

  const storyboardPath = join(project.root, 'docs', 'storyboard.json')
  await writeFile(storyboardPath, JSON.stringify({
    title: 'from file',
    durationMs: 4000,
    transitionMs: 200,
    scenes: [{ src: 'docs/shots/shot-1.png' }],
  }))
  const fromFile = await resolveStoryboard(base)
  assert.equal(fromFile.source, 'file')
  assert.equal(fromFile.storyboard.title, 'from file')
  assert.equal(fromFile.storyboard.durationMs, 4000)
})

test('resolveStoryboard explains what to do when there is nothing to build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reel-empty-'))
  await assert.rejects(
    resolveStoryboard({ projectDir: root, shotsDir: join(root, 'docs', 'shots') }),
    (error) => /没有找到截图/.test(error.message) && /^\[dsh-readme-reel\]/.test(error.message),
  )
})

test('autoStoryboard keeps the given order and spreads the time evenly', () => {
  const storyboard = normalizeStoryboard(autoStoryboard([{ path: 'a.png' }, { path: 'b.png' }], { title: 'x' }))
  assert.equal(storyboard.scenes[0].src, 'a.png')
  assert.equal(storyboard.scenes[1].src, 'b.png')
  const timeline = buildTimeline(storyboard)
  assert.equal(timeline.holds[0].toMs - timeline.holds[0].fromMs, timeline.holds[1].toMs - timeline.holds[1].fromMs)
  assert.equal(timeline.segments.at(-1).toMs, 6000)
})

test('isInside refuses path escapes and discoverProjectDir walks up', async () => {
  assert.equal(isInside('D:/Projects/app', 'D:/Projects/app/docs/shots/a.png'), true)
  assert.equal(isInside('D:/Projects/app', 'D:/Projects/app-other/a.png'), false)
  assert.equal(isInside('D:/Projects/app', 'D:/Projects/secret.png'), false)
  const project = await makeProject({ count: 1 })
  assert.equal(discoverProjectDir(project.root), resolve(project.root))
  assert.equal(discoverProjectDir(join(project.root, 'docs')), resolve(project.root))
})

test('pickCoverFrame lands on a hold rather than mid-transition', () => {
  const timeline = buildTimeline(normalizeStoryboard({
    scenes: [{ src: 'a.png' }, { src: 'b.png' }, { src: 'c.png' }],
  }))
  const index = pickCoverFrame(timeline)
  const timeMs = (index * 1000) / timeline.fps
  assert.ok(timeline.segments.some((segment) => segment.kind === 'hold' && segment.fromMs <= timeMs && timeMs < segment.toMs))
})

test('buildReel produces exactly three artefacts and a manifest (needs ffmpeg)', { skip: ffmpeg === null ? 'ffmpeg not available' : false }, async () => {
  const project = await makeProject({ count: 2 })
  const outDir = join(project.root, 'docs', 'reel')
  const manifest = await buildReel({
    projectDir: project.root,
    outDir: outDir,
    shotsDir: project.shotsDir,
    durationMs: 1200,
    fps: 12,
    size: { width: 480, height: 300 },
  })

  const files = await readdir(outDir)
  assert.ok(files.includes('reel.webm'))
  assert.ok(files.includes('reel.gif'))
  assert.ok(files.includes('cover.png'))
  assert.ok(files.includes('reel.json'))
  assert.ok(!files.includes('.frames'), 'intermediate frames are cleaned up')

  assert.equal(manifest.durationMs, 1200)
  assert.equal(manifest.frameCount, Math.round((1200 * 12) / 1000))
  assert.equal(manifest.ffmpeg.version.length > 0, true)
  for (const key of ['webm', 'gif', 'cover']) {
    const output = manifest.outputs[key]
    assert.ok(output.bytes > 0, key + ' has bytes')
    assert.match(output.sha256, /^[0-9a-f]{64}$/)
    assert.equal(output.path, 'docs/reel/' + output.file)
    assert.ok(existsSync(join(project.root, output.path)))
  }
  assert.ok(!JSON.stringify(manifest).includes(project.root), 'manifest carries no absolute machine path')

  const webm = await probe(join(outDir, 'reel.webm'), ffmpeg.path)
  assert.equal(webm.pixFmt, 'yuva420p', 'the webm keeps an alpha channel')
  assert.ok(Math.abs(webm.durationMs - 1200) <= 50, 'webm is 1.2s, got ' + webm.durationMs)
  const gif = await probe(join(outDir, 'reel.gif'), ffmpeg.path)
  assert.equal(gif.width, 640)
  assert.equal(gif.height, 400)

  const stored = await readManifest(outDir)
  assert.deepEqual(stored.outputs, manifest.outputs)
})

test('keepFrames leaves the PNG sequence behind for debugging', { skip: ffmpeg === null ? 'ffmpeg not available' : false }, async () => {
  const project = await makeProject({ count: 1 })
  const outDir = join(project.root, 'docs', 'reel')
  const manifest = await buildReel({
    projectDir: project.root,
    outDir: outDir,
    shotsDir: project.shotsDir,
    durationMs: 1000,
    fps: 10,
    size: { width: 320, height: 200 },
    keepFrames: true,
  })
  const frames = await readdir(join(outDir, '.frames'))
  assert.equal(frames.length, manifest.frameCount)
  assert.ok(frames.every((name) => /^frame-\d{4}\.png$/.test(name)))
})

test('buildReel refuses sources outside the project and missing screenshots', { skip: ffmpeg === null ? 'ffmpeg not available' : false }, async () => {
  const project = await makeProject({ count: 1 })
  const outDir = join(project.root, 'docs', 'reel')
  await assert.rejects(
    buildReel({
      projectDir: project.root,
      outDir: outDir,
      shotsDir: project.shotsDir,
      sources: ['../outside.png'],
      durationMs: 1000,
      size: { width: 320, height: 200 },
    }),
    /截图不在项目目录内/,
  )
  await assert.rejects(
    buildReel({
      projectDir: project.root,
      outDir: outDir,
      shotsDir: project.shotsDir,
      sources: ['docs/shots/missing.png'],
      durationMs: 1000,
      size: { width: 320, height: 200 },
    }),
    /读不了截图|文件不存在/,
  )
})

test('buildReel reports a missing ffmpeg as one actionable sentence', async () => {
  const project = await makeProject({ count: 1 })
  const savedEnv = process.env.DSH_README_REEL_FFMPEG
  const savedPath = process.env.PATH
  delete process.env.DSH_README_REEL_FFMPEG
  process.env.PATH = join(project.root, 'definitely-not-on-path')
  try {
    await assert.rejects(
      buildReel({
        projectDir: project.root,
        outDir: join(project.root, 'docs', 'reel'),
        shotsDir: project.shotsDir,
        durationMs: 1000,
        size: { width: 320, height: 200 },
      }),
      /没有找到 ffmpeg/,
    )
  } finally {
    if (savedEnv === undefined) delete process.env.DSH_README_REEL_FFMPEG
    else process.env.DSH_README_REEL_FFMPEG = savedEnv
    process.env.PATH = savedPath
  }
})
