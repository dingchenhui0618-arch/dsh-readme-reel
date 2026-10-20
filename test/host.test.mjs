// Host half tests. The HTTP surface is exercised through fake req/res objects:
// same handler, no server, no port, no browser.

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodePng } from '../src/png.js'
import { color, createCanvas, fillRect } from '../src/raster.js'
import { locateFfmpeg } from '../src/encode.js'
import {
  apply,
  buildState,
  inject,
  name,
  snippetFor,
} from '../src/host.js'

const ffmpeg = await locateFfmpeg()

async function shotBytes(hex) {
  const canvas = createCanvas(320, 200)
  fillRect(canvas, 0, 0, 320, 200, color(hex, 1))
  return encodePng(canvas)
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'reel-host-'))
  const shotsDir = join(root, 'docs', 'shots')
  await mkdir(shotsDir, { recursive: true })
  await writeFile(join(shotsDir, 'shot-1.png'), await shotBytes('#101820'))
  await writeFile(join(shotsDir, 'shot-2.png'), await shotBytes('#301810'))
  return { root, shotsDir, outDir: join(root, 'docs', 'reel') }
}

function setup(config) {
  const routes = []
  const ctx = {
    webServer: {
      register: function (route) {
        routes.push(route)
        return function () { route.disposed = true }
      },
    },
    effect: function (fn) { fn() },
  }
  apply(ctx, config)
  assert.equal(routes.length, 1, 'apply registers exactly one route')
  return routes[0]
}

function request(route, method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = function () {}
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader: function (key, value) { this.headers[key.toLowerCase()] = value },
    end: function (chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.done = true
    },
  }
  res.body = function () { return Buffer.concat(this.chunks) }
  res.text = function () { return this.body().toString('utf8') }
  res.json = function () { return JSON.parse(this.text()) }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(res)
    }
    const timer = setInterval(() => {
      if (res.done) {
        clearInterval(timer)
        finish()
      }
    }, 1)
    setInterval(() => {}, 0).unref()
    setTimeout(() => {
      if (body !== undefined) {
        req.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
      }
      req.emit('end')
    }, 0)
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((error) => {
        clearInterval(timer)
        reject(error)
      })
    setTimeout(() => {
      clearInterval(timer)
      if (!res.done) reject(new Error('handler never answered'))
    }, 20000)
  })
}

test('host exposes the plugin contract', () => {
  assert.equal(name, 'dsh-readme-reel')
  assert.deepEqual(inject, ['webServer'])
})

test('GET state reports the project, shots and a missing output set', async () => {
  const project = await makeProject()
  const route = setup({ projectDir: project.root })
  const state = (await request(route, 'GET', '/dsh-readme-reel/state')).json()
  assert.equal(state.ok, true)
  assert.equal(state.plugin.name, 'dsh-readme-reel')
  assert.match(state.plugin.version, /^\d+\.\d+\.\d+/)
  assert.equal(state.projectDir.includes('\\'), false, 'paths are reported with forward slashes')
  assert.equal(state.storyboard.source, 'auto')
  assert.equal(state.storyboard.durationMs, 6000)
  assert.equal(state.storyboard.scenes.length, 2)
  assert.equal(state.shots.length, 2)
  assert.equal(state.shots[0].path, 'docs/shots/shot-1.png')
  assert.equal(state.shots[0].url, '/dsh-readme-reel/shot?path=docs%2Fshots%2Fshot-1.png')
  assert.equal(state.outputs, null)
  assert.equal(state.snippet, '')
  assert.equal(state.ffmpeg.found, ffmpeg !== null)
})

test('POST scan answers with the same state shape', async () => {
  const project = await makeProject()
  const route = setup({ projectDir: project.root })
  const response = await request(route, 'POST', '/dsh-readme-reel/scan', {})
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().shots.length, 2)
  assert.match(response.headers['content-type'], /application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('shots are served as PNG bytes and nothing else leaves the project', async () => {
  const project = await makeProject()
  const route = setup({ projectDir: project.root })
  const ok = await request(route, 'GET', '/dsh-readme-reel/shot?path=docs%2Fshots%2Fshot-1.png')
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.headers['content-type'], 'image/png')
  assert.equal(ok.body().subarray(1, 4).toString('latin1'), 'PNG')

  const outside = await request(route, 'GET', '/dsh-readme-reel/shot?path=..%2F..%2Fsecret.png')
  assert.equal(outside.statusCode, 403)

  const json = await request(route, 'GET', '/dsh-readme-reel/shot?path=docs%2Fshots%2Fnotes.txt')
  assert.equal(json.statusCode, 403)

  const missing = await request(route, 'GET', '/dsh-readme-reel/shot?path=docs%2Fshots%2Fnope.png')
  assert.equal(missing.statusCode, 404)

  const noPath = await request(route, 'GET', '/dsh-readme-reel/shot')
  assert.equal(noPath.statusCode, 400)
})

test('assets are whitelisted by name, not by path', async () => {
  const project = await makeProject()
  const route = setup({ projectDir: project.root })
  const unknown = await request(route, 'GET', '/dsh-readme-reel/asset?name=..%2F..%2Fsecret.txt')
  assert.equal(unknown.statusCode, 404)
  const missing = await request(route, 'GET', '/dsh-readme-reel/asset?name=reel.webm')
  assert.equal(missing.statusCode, 404)
})

test('build failure is a JSON message, not an exception', async () => {
  const project = await makeProject()
  const route = setup({ projectDir: project.root })
  const response = await request(route, 'POST', '/dsh-readme-reel/build', { sources: ['docs/shots/missing.png'] })
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /读不了截图|文件不存在/)
  assert.equal(body.state.lastBuild.ok, false)
  assert.ok(body.state.lastBuild.ms >= 0)
})

test('a real build through the HTTP surface updates state and serves the webm', { skip: ffmpeg === null ? 'ffmpeg not available' : false }, async () => {
  const project = await makeProject()
  const route = setup({ projectDir: project.root, outDir: project.outDir })
  const response = await request(route, 'POST', '/dsh-readme-reel/build', {
    sources: ['docs/shots/shot-1.png', 'docs/shots/shot-2.png'],
    durationMs: 1000,
  })
  const body = response.json()
  assert.equal(body.ok, true, body.error)
  const state = body.state
  assert.equal(state.outputs.webm.file, 'reel.webm')
  assert.equal(state.outputs.webm.url, '/dsh-readme-reel/asset?name=reel.webm')
  assert.equal(state.outputs.webm.path, 'docs/reel/reel.webm')
  assert.match(state.snippet, /!\[/)
  assert.match(state.snippet, /<video src="docs\/reel\/reel.webm"/)
  assert.equal(state.lastBuild.ok, true)

  const asset = await request(route, 'GET', '/dsh-readme-reel/asset?name=reel.webm')
  assert.equal(asset.statusCode, 200)
  assert.equal(asset.headers['content-type'], 'video/webm')
  assert.ok(asset.body().length > 1000)
  assert.equal(Number(asset.headers['content-length']), asset.body().length)

  const cover = await request(route, 'GET', '/dsh-readme-reel/asset?name=cover.png')
  assert.equal(cover.statusCode, 200)
  assert.equal(cover.headers['content-type'], 'image/png')
})

test('unknown methods and paths answer 404/405 instead of hanging', async () => {
  const project = await makeProject()
  const route = setup({ projectDir: project.root })
  assert.equal((await request(route, 'GET', '/dsh-readme-reel/nope')).statusCode, 405)
  assert.equal((await request(route, 'POST', '/dsh-readme-reel/unknown', {})).statusCode, 404)
  assert.equal((await request(route, 'GET', '/dsh-readme-reel/asset')).statusCode, 404)
})

test('a broken web server degrades to the CLI instead of breaking the plugin', () => {
  const ctx = {
    webServer: { register: function () { throw new Error('no web server here') } },
    effect: function (fn) { fn() },
  }
  assert.doesNotThrow(() => apply(ctx, { projectDir: process.cwd() }))
})

test('disposing the plugin removes the route', () => {
  const routes = []
  const disposers = []
  const ctx = {
    webServer: { register: function (route) { routes.push(route); return function () { route.disposed = true } } },
    effect: function (fn) { disposers.push(fn()) },
  }
  apply(ctx, { projectDir: process.cwd() })
  assert.equal(routes.length, 1)
  assert.equal(typeof disposers[0], 'function')
  disposers[0]()
  assert.equal(routes[0].disposed, true)
})

test('snippetFor emits a usable markdown block and survives brackets in the title', () => {
  const snippet = snippetFor({
    title: 'readme [reel]',
    outputs: {
      cover: { path: 'docs/reel/cover.png' },
      gif: { path: 'docs/reel/reel.gif' },
      webm: { path: 'docs/reel/reel.webm' },
    },
  })
  assert.match(snippet, /^!\[readme reel\]\(docs\/reel\/cover\.png\)/)
  assert.match(snippet, /<img src="docs\/reel\/reel\.gif"/)
  assert.match(snippet, /<video src="docs\/reel\/reel\.webm" width="720" autoplay loop muted playsinline>/)
  assert.equal(snippetFor(null), '')
})

test('buildState tolerates a project without a storyboard file', async () => {
  const project = await makeProject()
  await writeFile(join(project.root, 'docs', 'storyboard.json'), '{ not json')
  const state = await buildState({ projectDir: project.root, outDir: project.outDir, shotsDir: project.shotsDir, storyboardPath: join(project.root, 'docs', 'storyboard.json') })
  assert.equal(state.ok, true)
  assert.ok(state.storyboard === null || state.storyboardError !== null)
})
