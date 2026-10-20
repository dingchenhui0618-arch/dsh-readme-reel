// Tests for the encoder seam of dsh-readme-reel.
//
// Integration tests need a working ffmpeg. They find one exactly the way the
// host does (locateFfmpeg), so on a machine without ffmpeg every encoding test
// skips and the suite still reports 0 failures. Fixtures are generated with
// ffmpeg itself so this file depends on no other teammate's output.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { encodeReel, locateFfmpeg, probe } from '../src/encode.js'

const located = await locateFfmpeg({ env: process.env })
const ffmpegPath = located ? located.path : null
const skip = ffmpegPath ? false : 'ffmpeg not found: set DSH_README_REEL_FFMPEG to run encoding tests'

// Locating must be run-verified, so an empty PATH means "nothing on the system
// is allowed to answer" for the negative tests.
const NO_PATH_ENV = Object.freeze({ PATH: '' })
const transientDirs = []

after(async () => {
  for (const dir of transientDirs.reverse()) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeTemp(prefix = 'dsh-readme-reel-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  transientDirs.push(dir)
  return dir
}

function run(command, args) {
  return new Promise((settle) => {
    const child = spawn(command, args, { env: process.env, windowsHide: true })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => settle({ code: null, stdout: Buffer.alloc(0), stderr: '', spawnError: error }))
    child.on('close', (code) => settle({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }))
  })
}

// --- fixtures --------------------------------------------------------------

const FIXTURE = { width: 320, height: 200, fps: 20, count: 12, transparentUntilX: 80 }

let fixturesPromise = null

function fixtures() {
  if (!fixturesPromise) fixturesPromise = buildFixtures()
  return fixturesPromise
}

async function buildFixtures() {
  const dir = await makeTemp('dsh-readme-reel-frames-')
  const filter = [
    'format=rgba',
    "geq=r='if(lt(X,80),0,31+8*N)':g='if(lt(X,80),0,111)':b='if(lt(X,80),0,235)':a='if(lt(X,80),0,255)'",
  ].join(',')
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=${FIXTURE.width}x${FIXTURE.height}:r=${FIXTURE.fps}:d=${FIXTURE.count / FIXTURE.fps}`,
    '-vf',
    filter,
    '-frames:v',
    String(FIXTURE.count),
    '-pix_fmt',
    'rgba',
    join(dir, 'frame-%04d.png'),
  ]
  const generated = await run(ffmpegPath, args)
  assert.equal(generated.code, 0, `could not generate fixture frames: ${generated.stderr}`)

  const names = (await readdir(dir)).filter((name) => /^frame-\d+\.png$/.test(name)).sort()
  const frames = names.map((name) => join(dir, name))
  assert.equal(frames.length, FIXTURE.count, 'fixture frame count')

  // The fixtures must really carry alpha and differ frame to frame, otherwise
  // the transparency and cover assertions below would prove nothing.
  const first = await decodeRgba(frames[0], FIXTURE.width, FIXTURE.height)
  assert.equal(pixelAt(first, 10, 50, FIXTURE.width)[3], 0, 'fixture left band must be transparent')
  assert.equal(pixelAt(first, 160, 50, FIXTURE.width)[3], 255, 'fixture body must be opaque')
  const sixth = await decodeRgba(frames[5], FIXTURE.width, FIXTURE.height)
  assert.notDeepEqual(pixelAt(first, 160, 50, FIXTURE.width), pixelAt(sixth, 160, 50, FIXTURE.width), 'fixture frames must differ')

  return { dir, frames }
}

function pixelAt(buffer, x, y, width) {
  const offset = (y * width + x) * 4
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]]
}

async function decodeRgba(file, width, height, decoderArgs = []) {
  const decoded = await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    ...decoderArgs,
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1',
  ])
  assert.equal(decoded.code, 0, `could not decode ${file}: ${decoded.stderr}`)
  assert.equal(decoded.stdout.length, width * height * 4, `unexpected raw frame size for ${file}`)
  return decoded.stdout
}

async function hasAudioStream(file) {
  const probed = await run(ffmpegPath, ['-hide_banner', '-i', file])
  return /Stream #\d+:\d+[^\n]*: Audio:/.test(probed.stderr)
}

function assertAbsolute(file) {
  assert.ok(resolve(file) === file, `${file} should be an absolute path`)
}

// --- locateFfmpeg: negative cases (run with or without ffmpeg) --------------

test('locateFfmpeg returns null when no candidate runs ffmpeg', async () => {
  const missing = join(await makeTemp(), 'definitely-not-ffmpeg.exe')
  assert.equal(await locateFfmpeg({ explicit: missing, env: NO_PATH_ENV }), null)
})

test('locateFfmpeg skips a program that is not ffmpeg instead of throwing', async () => {
  // node runs fine but prints no "ffmpeg version", so it must be skipped.
  assert.equal(await locateFfmpeg({ explicit: process.execPath, env: NO_PATH_ENV }), null)
})

test('locateFfmpeg skips a directory that holds no ffmpeg binary', async () => {
  const empty = await makeTemp()
  assert.equal(await locateFfmpeg({ explicit: empty, env: NO_PATH_ENV }), null)
})

test('locateFfmpeg never throws on unusable options', async () => {
  assert.equal(await locateFfmpeg({ explicit: 42, env: NO_PATH_ENV }), null)
  assert.equal(await locateFfmpeg({ explicit: '', env: NO_PATH_ENV, platform: 'win32' }), null)
  assert.equal(await locateFfmpeg({ explicit: 'ffmpeg-does-not-exist-xyz', env: NO_PATH_ENV }), null)
})

// --- encodeReel: validation (no ffmpeg needed) -----------------------------

test('encodeReel rejects malformed options with the contract prefix', async () => {
  const outDir = await makeTemp()
  const base = { outDir, width: 320, height: 200, fps: 20, ffmpegPath: 'ffmpeg' }
  const prefix = (error) => {
    assert.match(error.message, /^\[dsh-readme-reel\]/)
    return true
  }
  await assert.rejects(encodeReel({ ...base, frames: [] }), prefix)
  await assert.rejects(encodeReel({ ...base, frames: ['only-one.png'] }), prefix)
  await assert.rejects(encodeReel({ ...base, frames: ['a.png', 'b.png'], ffmpegPath: '' }), prefix)
  await assert.rejects(encodeReel({ ...base, frames: ['a.png', 'b.png'], width: 0 }), prefix)
})

// --- locateFfmpeg: positive cases ------------------------------------------

test('locateFfmpeg honors DSH_README_REEL_FFMPEG', { skip }, async () => {
  const found = await locateFfmpeg({ env: { DSH_README_REEL_FFMPEG: ffmpegPath, PATH: '' } })
  assert.ok(found, 'expected the env var to yield ffmpeg')
  assert.equal(found.source, 'env')
  assert.match(found.version, /^\d+\.\d+/)
})

test('locateFfmpeg accepts a directory containing ffmpeg', { skip }, async () => {
  const found = await locateFfmpeg({ explicit: dirname(ffmpegPath), env: NO_PATH_ENV })
  assert.ok(found, 'expected the directory to yield ffmpeg')
  assert.equal(found.source, 'explicit')
  assert.match(found.version, /^\d+\.\d+/)
})

test('locateFfmpeg falls back to ffmpeg on PATH', { skip }, async () => {
  const found = await locateFfmpeg({ env: { PATH: dirname(ffmpegPath) } })
  assert.ok(found, 'expected ffmpeg on the synthetic PATH')
  assert.equal(found.source, 'path')
})

test('locateFfmpeg prefers explicit over env and PATH', { skip }, async () => {
  const found = await locateFfmpeg({
    explicit: ffmpegPath,
    env: { DSH_README_REEL_FFMPEG: join(await makeTemp(), 'nope.exe'), PATH: '' },
  })
  assert.ok(found)
  assert.equal(found.source, 'explicit')
})

// --- probe -----------------------------------------------------------------

test('probe rejects a missing file with the contract prefix and ffmpeg detail', { skip }, async () => {
  const missing = join(await makeTemp(), 'missing.png')
  await assert.rejects(probe(missing, ffmpegPath), (error) => {
    assert.match(error.message, /^\[dsh-readme-reel\]/)
    assert.match(error.message, /No such file|Invalid argument|could not open|Error opening/i)
    return true
  })
})

// --- encodeReel: integration ----------------------------------------------

test('encodeReel writes a transparent webm, a matted opaque gif and a byte-identical cover', { skip }, async () => {
  const { frames } = await fixtures()
  const outDir = await makeTemp('dsh-readme-reel-out-')
  const result = await encodeReel({
    frames,
    outDir,
    width: FIXTURE.width,
    height: FIXTURE.height,
    fps: FIXTURE.fps,
    ffmpegPath,
  })

  assert.match(result.ffmpegVersion, /^\d+\.\d+/)
  assert.equal(result.webm.path, resolve(outDir, 'reel.webm'))
  assert.equal(result.gif.path, resolve(outDir, 'reel.gif'))
  assert.equal(result.cover.path, resolve(outDir, 'cover.png'))
  assertAbsolute(result.webm.path)
  assertAbsolute(result.gif.path)
  assertAbsolute(result.cover.path)
  assert.equal((await stat(result.webm.path)).size, result.webm.bytes)
  assert.equal((await stat(result.gif.path)).size, result.gif.bytes)
  assert.equal((await stat(result.cover.path)).size, result.cover.bytes)
  assert.ok(result.webm.bytes > 0 && result.gif.bytes > 0 && result.cover.bytes > 0)

  // Cover defaults to floor(12 * 0.4) = frame 4 and is a byte copy, not a
  // re-encode: the whole point of the seam is that pixels survive untouched.
  assert.deepEqual(await readFile(result.cover.path), await readFile(frames[4]), 'cover must be byte-identical to frames[4]')
  const coverInfo = await probe(result.cover.path, ffmpegPath)
  assert.equal(coverInfo.width, FIXTURE.width)
  assert.equal(coverInfo.height, FIXTURE.height)
  assert.equal(coverInfo.pixFmt, 'rgba')

  // webm: VP9 with a real alpha channel, silent, right duration.
  const webmInfo = await probe(result.webm.path, ffmpegPath)
  assert.equal(webmInfo.width, FIXTURE.width)
  assert.equal(webmInfo.height, FIXTURE.height)
  assert.equal(webmInfo.codec, 'vp9')
  assert.equal(webmInfo.pixFmt, 'yuva420p', 'webm must keep VP9 alpha')
  assert.ok(Math.abs(webmInfo.durationMs - 600) <= 80, `unexpected webm duration: ${webmInfo.durationMs}ms`)
  assert.ok(Math.abs(webmInfo.frames - FIXTURE.count) <= 1, `unexpected webm frame count: ${webmInfo.frames}`)
  assert.equal(await hasAudioStream(result.webm.path), false, 'webm must be silent')

  const webmFrame = await decodeRgba(result.webm.path, FIXTURE.width, FIXTURE.height, ['-c:v', 'libvpx-vp9'])
  assert.ok(pixelAt(webmFrame, 10, 50, FIXTURE.width)[3] < 32, 'transparent band must decode as transparent')
  assert.ok(pixelAt(webmFrame, 160, 50, FIXTURE.width)[3] > 200, 'opaque body must decode as opaque')

  // gif: scaled to the default width, aspect preserved with an even height,
  // and opaque everywhere because alpha was flattened onto the matte.
  const gifInfo = await probe(result.gif.path, ffmpegPath)
  assert.equal(gifInfo.width, 640)
  assert.equal(gifInfo.height, 400)
  assert.equal(gifInfo.codec, 'gif')
  assert.ok(gifInfo.frames === null || Math.abs(gifInfo.frames - FIXTURE.count) <= 1, `unexpected gif frame count: ${gifInfo.frames}`)
  const expectedGifMs = Math.round((FIXTURE.count / FIXTURE.fps) * 1000)
  assert.ok(Math.abs(gifInfo.durationMs - expectedGifMs) <= 60, `gif must cover the whole reel: ${gifInfo.durationMs}ms vs ${expectedGifMs}ms`)
  const gifFrame = await decodeRgba(result.gif.path, 640, 400)
  let opaqueEverywhere = true
  for (let offset = 3; offset < gifFrame.length; offset += 4) {
    if (gifFrame[offset] !== 255) {
      opaqueEverywhere = false
      break
    }
  }
  assert.ok(opaqueEverywhere, 'gif must be fully opaque (no 1-bit alpha fringing)')
  const mattePixel = pixelAt(gifFrame, 20, 100, 640)
  assert.ok(Math.abs(mattePixel[0] - 11) <= 12, `matte red: ${mattePixel[0]}`)
  assert.ok(Math.abs(mattePixel[1] - 14) <= 12, `matte green: ${mattePixel[1]}`)
  assert.ok(Math.abs(mattePixel[2] - 20) <= 12, `matte blue: ${mattePixel[2]}`)
})

test('encodeReel honors coverFrame, gif and webm options and calls log per stage', { skip }, async () => {
  const { frames } = await fixtures()
  const outDir = await makeTemp('dsh-readme-reel-options-')
  const lines = []
  const result = await encodeReel({
    frames,
    outDir,
    width: FIXTURE.width,
    height: FIXTURE.height,
    fps: FIXTURE.fps,
    ffmpegPath,
    coverFrame: 7,
    webm: { crf: 40 },
    gif: { width: 320, matte: '#112233', fps: 20 },
    log: (line) => lines.push(line),
  })

  assert.deepEqual(await readFile(result.cover.path), await readFile(frames[7]), 'cover must follow coverFrame')

  const webmInfo = await probe(result.webm.path, ffmpegPath)
  assert.equal(webmInfo.pixFmt, 'yuva420p')

  const gifInfo = await probe(result.gif.path, ffmpegPath)
  assert.equal(gifInfo.width, 320)
  assert.equal(gifInfo.height, 200)
  const gifFrame = await decodeRgba(result.gif.path, 320, 200)
  const mattePixel = pixelAt(gifFrame, 10, 50, 320)
  assert.equal(mattePixel[3], 255)
  assert.ok(Math.abs(mattePixel[0] - 0x11) <= 12, `custom matte red: ${mattePixel[0]}`)
  assert.ok(Math.abs(mattePixel[1] - 0x22) <= 12, `custom matte green: ${mattePixel[1]}`)
  assert.ok(Math.abs(mattePixel[2] - 0x33) <= 12, `custom matte blue: ${mattePixel[2]}`)

  assert.ok(lines.length >= 4, `expected at least 4 log lines, got ${JSON.stringify(lines)}`)
  const logged = lines.join('\n')
  for (const stage of ['webm', 'gif', 'cover']) assert.match(logged, new RegExp(stage))
  assert.match(logged, /ffmpeg:/)
})

test('encodeReel skips the gif when gif.enabled is false', { skip }, async () => {
  const { frames } = await fixtures()
  const outDir = await makeTemp('dsh-readme-reel-nogif-')
  const result = await encodeReel({
    frames,
    outDir,
    width: FIXTURE.width,
    height: FIXTURE.height,
    fps: FIXTURE.fps,
    ffmpegPath,
    gif: { enabled: false },
  })

  assert.ok(result.webm.bytes > 0)
  assert.ok(result.cover.bytes > 0)
  // When the gif is disabled there is no file; the seam reports that as a null
  // path with zero bytes instead of inventing a path that does not exist.
  assert.equal(result.gif.path, null)
  assert.equal(result.gif.bytes, 0)
  await assert.rejects(stat(resolve(outDir, 'reel.gif')))
})

test('encodeReel rejects with the contract prefix when a frame is missing', { skip, timeout: 30000 }, async () => {
  const { frames } = await fixtures()
  const outDir = await makeTemp('dsh-readme-reel-failure-')
  const missing = join(await makeTemp(), 'missing-0000.png')
  await assert.rejects(
    encodeReel({
      frames: [missing, ...frames.slice(1)],
      outDir,
      width: FIXTURE.width,
      height: FIXTURE.height,
      fps: FIXTURE.fps,
      ffmpegPath,
    }),
    (error) => {
      assert.match(error.message, /^\[dsh-readme-reel\]/)
      assert.match(error.message, /webm encode failed/)
      assert.match(error.message, /No such file|Invalid argument|could not open|Error opening/i)
      assert.match(error.message, /ffmpeg|libvpx-vp9/, 'message must show the failing ffmpeg command')
      return true
    },
  )
  await assert.rejects(stat(resolve(outDir, 'reel.webm')), 'a failed encode must not leave a webm behind')
})
