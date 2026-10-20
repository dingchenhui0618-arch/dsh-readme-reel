// Client half, loaded the way the web GUI loads it.
//
// src/client.cjs is CommonJS (the build inlines its stylesheet and wraps it in
// window.__ModuleLoader__.load()), so it is compiled with `new Function` and
// receives React, fetch, timers and document as parameters. That keeps the
// smoke test hermetic: no jsdom, no network, no real timers, and no dependence
// on the host half existing.
//
// React is faked as a plain object builder. Hooks are stubbed:
//   - useState runs a lazy initializer once and returns [value, noop], which is
//     exactly what the component needs when rendered directly;
//   - useEffect runs its callback as a mount and records the cleanup, so the
//     shared poller can be started and stopped exactly as a mount/unmount would.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const CLIENT_SOURCE = readFileSync(join(ROOT, 'src', 'client.cjs'), 'utf8')
const CSS_SOURCE = readFileSync(join(ROOT, 'src', 'client-css.cjs'), 'utf8')

// client-css.cjs runs as CommonJS in the build; load it the same way so the
// stylesheet assertions test the real exported string.
function loadStylesheet() {
  const mod = { exports: {} }
  new Function('module', 'exports', CSS_SOURCE)(mod, mod.exports)
  return mod.exports
}

const CSS = loadStylesheet()

// ---------------------------------------------------------------------------
// fixtures — the exact shape docs/CONTRACT.md promises for GET /state
// ---------------------------------------------------------------------------

const SHOT_A = { path: 'docs/shots/a-home.png', url: '/dsh-readme-reel/shot?path=docs%2Fshots%2Fa-home.png', bytes: 12000 }
const SHOT_B = { path: 'docs/shots/b-panel.png', url: '/dsh-readme-reel/shot?path=docs%2Fshots%2Fb-panel.png', bytes: 24000 }
const SHOT_C = { path: 'docs/shots/c-diff.png', url: '/dsh-readme-reel/shot?path=docs%2Fshots%2Fc-diff.png', bytes: 36000 }

function baseState(overrides) {
  const state = {
    ok: true,
    projectDir: 'D:\\Projects\\demo',
    outDir: 'D:\\Projects\\demo\\docs\\reel',
    ffmpeg: { found: true, version: 'ffmpeg version 7.0.2', source: 'path' },
    storyboard: {
      source: 'file',
      path: 'docs/storyboard.json',
      title: 'demo',
      durationMs: 6000,
      fps: 30,
      size: { width: 640, height: 320 },
      scenes: [
        { src: 'a-home.png', hold: null, layout: 'auto' },
        { src: 'b-panel.png', hold: null, layout: 'auto' },
        { src: 'c-diff.png', hold: null, layout: 'auto' },
      ],
    },
    shots: [SHOT_A, SHOT_B, SHOT_C],
    outputs: {
      webm: { path: 'D:\\Projects\\demo\\docs\\reel\\reel.webm', url: '/dsh-readme-reel/asset?name=reel.webm', bytes: 1234567, sha256: 'a'.repeat(64) },
      gif: { path: 'D:\\Projects\\demo\\docs\\reel\\reel.gif', url: '/dsh-readme-reel/asset?name=reel.gif', bytes: 2345678, sha256: 'b'.repeat(64) },
      cover: { path: 'D:\\Projects\\demo\\docs\\reel\\cover.png', url: '/dsh-readme-reel/asset?name=cover.png', bytes: 45678, sha256: 'c'.repeat(64) },
    },
    lastBuild: { at: 1758530000000, ms: 3210, ok: true, error: null },
  }
  return Object.assign(state, overrides || {})
}

// ---------------------------------------------------------------------------
// hermetic environment: module + fake React + fake document/timers/fetch
// ---------------------------------------------------------------------------

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  })
}

function createEnv(options) {
  const opts = options || {}
  const effects = []
  const ctxEffects = []
  const styles = []
  const timers = { started: [], cleared: [] }
  const fetchCalls = []
  const clipboard = []
  const execCommands = []
  const bodyCalls = { appended: 0, removed: 0 }
  const warnings = []
  const slots = { injections: [], registrations: [], disposals: 0 }

  const document = {
    head: { appendChild(node) { styles.push(node) } },
    body: {
      appendChild() { bodyCalls.appended += 1 },
      removeChild() { bodyCalls.removed += 1 },
    },
    createElement(tag) {
      const node = {
        tagName: tag,
        dataset: {},
        textContent: '',
        value: '',
        style: {},
        setAttribute(name, value) { node[name] = value },
        select() { node.selected = true },
        remove() { node.removed = true },
      }
      return node
    },
    execCommand(command) {
      execCommands.push(command)
      return opts.execCommand === true
    },
  }

  const navigator = opts.noClipboard
    ? {}
    : {
        clipboard: {
          writeText(value) {
            clipboard.push(value)
            if (opts.clipboardRejects) return Promise.reject(new Error('clipboard denied'))
            return Promise.resolve()
          },
        },
      }

  const fetchImpl = function (url, init) {
    fetchCalls.push({ url: String(url), init: init || {} })
    if (typeof opts.fetch === 'function') return opts.fetch(String(url), init)
    const state = opts.state || baseState()
    if (String(url).indexOf('/build') >= 0) return jsonResponse({ ok: true, manifest: {}, state: state })
    return jsonResponse(state)
  }

  const react = {
    createElement(type, props, ...children) {
      return { type: type, props: props || {}, children: children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, function () {}]
    },
    useEffect(fn) {
      const cleanup = typeof fn === 'function' ? fn() : undefined
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    useRef(initial) {
      return { current: initial }
    },
    useMemo(fn) {
      return fn()
    },
  }

  const ctx = {
    effect(fn) {
      const dispose = fn()
      ctxEffects.push(typeof dispose === 'function' ? dispose : function () {})
      return dispose
    },
    slots: {
      inject(name, fn) {
        slots.injections.push(name)
        const dispose = fn()
        return function () {
          slots.disposals += 1
          if (typeof dispose === 'function') dispose()
        }
      },
      register(descriptor, component) {
        if (opts.registerThrows) throw new Error('slot contract changed')
        slots.registrations.push({ descriptor: descriptor, component: component })
        return function () { slots.disposals += 1 }
      },
    },
  }

  const sandboxConsole = {
    warn(...args) { warnings.push(args) },
    log() {},
    error() {},
  }

  const mod = { exports: {} }
  const params = [
    'document', 'navigator', 'fetch', 'setInterval', 'clearInterval',
    'setTimeout', 'clearTimeout', 'console', 'require', 'module', 'exports',
  ]
  const args = [
    document,
    navigator,
    fetchImpl,
    function (fn, ms) {
      const id = timers.started.length + 1
      timers.started.push({ id: id, ms: ms })
      return id
    },
    function (id) { timers.cleared.push(id) },
    function () { return 0 },
    function () {},
    sandboxConsole,
    function (id) {
      if (id === 'react') return react
      if (id === './client-css.cjs') return CSS
      throw new Error('unexpected require: ' + id)
    },
    mod,
    mod.exports,
  ]
  try {
    new Function(...params, CLIENT_SOURCE)(...args)
  } catch (error) {
    throw new Error('src/client.cjs failed to compile as a CommonJS module: ' + error.message)
  }

  const plugin = mod.exports

  function mount() {
    const registration = slots.registrations[0] || null
    assert.ok(registration, 'a conversation.view component was registered')
    const before = effects.length
    const tree = registration.component({})
    const cleanups = effects.slice(before)
    let unmounted = false
    return {
      tree: tree,
      unmount() {
        if (unmounted) return
        unmounted = true
        cleanups.forEach(function (fn) { fn() })
      },
    }
  }

  return {
    plugin: plugin,
    ctx: ctx,
    document: document,
    react: react,
    slots: slots,
    styles: styles,
    ctxEffects: ctxEffects,
    effects: effects,
    timers: timers,
    fetchCalls: fetchCalls,
    clipboard: clipboard,
    execCommands: execCommands,
    bodyCalls: bodyCalls,
    warnings: warnings,
    mount: mount,
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function flush() {
  return new Promise(function (resolve) { setImmediate(resolve) })
}

async function settle() {
  await flush()
  await flush()
}

function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props || {}))
  return {
    type: node.type,
    props: node.props || {},
    children: (node.children || []).map(expand),
  }
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

function flatText(tree) {
  return textOf(expand(tree)).replace(/\s+/g, ' ')
}

function findAll(node, predicate) {
  const expanded = expand(node)
  const hits = []
  function walk(current) {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }
    if (typeof current !== 'object') return
    if (predicate(current)) hits.push(current)
    walk(current.children)
  }
  walk(expanded)
  return hits
}

function buttonsOf(tree) {
  return findAll(tree, function (node) { return node.type === 'button' }).map(function (node) {
    return { node: node, text: flatText(node).trim(), disabled: node.props.disabled === true }
  })
}

function buttonByText(tree, matcher) {
  const found = buttonsOf(tree).filter(function (button) {
    return typeof matcher === 'string' ? button.text === matcher : matcher.test(button.text)
  })
  assert.equal(found.length, 1, 'exactly one button matches ' + String(matcher))
  return found[0]
}

// Mount, let the first poll answer, then re-mount so the component reads the
// loaded module-level snapshot through its useState initializer.
async function mountLoaded(env) {
  const first = env.mount()
  await settle()
  first.unmount()
  return env.mount()
}

// ---------------------------------------------------------------------------
// stylesheet + module contract
// ---------------------------------------------------------------------------

test('client-css.cjs exports the panel stylesheet as a string', function () {
  assert.equal(typeof CSS, 'string')
  assert.ok(CSS.length > 400, 'the stylesheet is not a placeholder')
  assert.match(CSS, /\.rr-root\{/)
})

test('the stylesheet uses theme tokens and color-mix only, never hard-coded colours', function () {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(CSS), 'no hex colours anywhere in the stylesheet')
  assert.match(CSS, /var\(--dsw-alias-/, 'theme tokens are used')
  assert.match(CSS, /color-mix\(in srgb,/, 'currentColor mixes are used')
})

test('the client module exports the plugin contract', function () {
  const env = createEnv()
  assert.equal(env.plugin.name, 'dsh-readme-reel')
  assert.deepEqual(env.plugin.inject, ['slots'])
  assert.equal(typeof env.plugin.apply, 'function')
})

test('the client requires nothing but the harness React and its inlined stylesheet', function () {
  const requires = Array.from(CLIENT_SOURCE.matchAll(/require\((['"])([^'"]+)\1\)/g)).map(function (match) {
    return match[2]
  })
  assert.deepEqual(requires, ['react', './client-css.cjs'])
})

test('the client source has no DOM injection, eval or absolute URLs', function () {
  assert.ok(!/dangerouslySetInnerHTML/.test(CLIENT_SOURCE))
  assert.ok(!/\beval\s*\(/.test(CLIENT_SOURCE))
  assert.ok(!/https?:\/\//.test(CLIENT_SOURCE))
  assert.ok(!/localhost:\d+/.test(CLIENT_SOURCE), 'no hard-coded localhost URL')
})

// ---------------------------------------------------------------------------
// registration and teardown
// ---------------------------------------------------------------------------

test('apply() injects the stylesheet once and registers the conversation view', function () {
  const env = createEnv()
  env.plugin.apply(env.ctx)

  assert.equal(env.styles.length, 1, 'exactly one <style> is appended')
  assert.equal(env.styles[0].dataset.plugin, 'dsh-readme-reel')
  assert.equal(env.styles[0].textContent, CSS)
  assert.deepEqual(env.slots.injections, ['conversation.view'])
  assert.equal(env.slots.registrations.length, 1)

  const registration = env.slots.registrations[0]
  assert.deepEqual(registration.descriptor, {
    name: 'conversation.view',
    id: 'readme-reel',
    order: 40,
    label: '首屏短片',
  })
  assert.equal(typeof registration.component, 'function', 'the view is a component function')

  assert.equal(env.ctxEffects.length, 2, 'poll teardown and style teardown are both tracked')
  env.ctxEffects.forEach(function (dispose) {
    assert.equal(typeof dispose, 'function')
  })
})

test('disposing the plugin removes its stylesheet and stops the shared poll timer', function () {
  const env = createEnv()
  env.plugin.apply(env.ctx)

  const mounted = env.mount()
  assert.equal(env.timers.started.length, 1, 'rendering the view starts the shared poll')
  assert.equal(env.timers.started[0].ms, 1000)

  env.ctxEffects.forEach(function (dispose) { dispose() })

  assert.equal(env.styles[0].removed, true, 'the <style> element is removed on unload')
  assert.deepEqual(env.timers.cleared, [env.timers.started[0].id], 'the poll timer is cleared on unload')

  // A late React unmount after plugin unload must not throw or clear twice.
  mounted.unmount()
  assert.equal(env.timers.cleared.length, 1)
})

test('a failing slot registration degrades the panel and logs a warning', function () {
  const env = createEnv({ registerThrows: true })
  assert.doesNotThrow(function () { env.plugin.apply(env.ctx) })
  assert.equal(env.styles.length, 1, 'the stylesheet still has a disposer')
  assert.equal(env.warnings.length, 1, 'the failure is reported, not swallowed silently')
  assert.match(String(env.warnings[0][0]), /could not register/)
})

// ---------------------------------------------------------------------------
// render: the three states the panel must survive
// ---------------------------------------------------------------------------

test('renders the loading state before the first poll answers', function () {
  const env = createEnv({ fetch: function () { return new Promise(function () {}) } })
  env.plugin.apply(env.ctx)

  const mounted = env.mount()
  const text = flatText(mounted.tree)
  assert.equal(mounted.tree.type, 'div')
  assert.equal(mounted.tree.props.className, 'rr-root')
  assert.match(text, /首屏短片/)
  assert.match(text, /正在读取 host 状态/)
  assert.match(text, /重扫/)
  assert.match(text, /生成/)

  mounted.unmount()
  assert.equal(env.timers.cleared.length, 1, 'unmounting stops the poll when no view is left')
})

test('renders the loaded state with shot grid, video preview and copy button', async function () {
  const state = baseState()
  const env = createEnv({ state: state })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  const text = flatText(mounted.tree)

  assert.match(text, /ffmpeg/)
  assert.match(text, /7\.0\.2/)
  assert.match(text, /分镜 · 3 幕/)
  assert.match(text, /素材/)
  assert.match(text, /3 \/ 3 张入选/)
  assert.match(text, /产物/)
  assert.match(text, /reel\.webm/)
  assert.match(text, /reel\.gif/)
  assert.match(text, /cover\.png/)
  assert.match(text, /复制 Markdown/)
  assert.match(text, /3\.2 s/, 'last build duration is rendered')
  assert.match(text, /docs\\reel/, 'the out dir is rendered')

  const video = findAll(mounted.tree, function (node) { return node.type === 'video' })
  assert.equal(video.length, 1)
  assert.equal(video[0].props.src, state.outputs.webm.url)
  assert.equal(video[0].props.poster, state.outputs.gif.url, 'the gif is used as the poster/fallback')
  assert.equal(video[0].props.autoPlay, true)
  assert.equal(video[0].props.loop, true)
  assert.equal(video[0].props.muted, true)
  assert.equal(video[0].props.playsInline, true)

  const checkboxes = findAll(mounted.tree, function (node) {
    return node.type === 'input' && node.props.type === 'checkbox'
  })
  assert.equal(checkboxes.length, 3)
  assert.ok(checkboxes.every(function (box) { return box.props.checked === true }))

  const thumbnails = findAll(mounted.tree, function (node) {
    return node.type === 'img' && node.props.className === 'rr-thumb-img'
  })
  assert.equal(thumbnails.length, 3)
  assert.deepEqual(thumbnails.map(function (img) { return img.props.src }), state.shots.map(function (shot) { return shot.url }))

  const covers = findAll(mounted.tree, function (node) {
    return node.type === 'img' && node.props.className === 'rr-cover'
  })
  assert.equal(covers.length, 1)

  // The interactive handlers are wired and harmless when invoked.
  assert.doesNotThrow(function () { checkboxes[0].props.onChange() })
  const reorder = buttonsOf(mounted.tree).filter(function (button) {
    return button.node.props.title === '上移' || button.node.props.title === '下移'
  })
  assert.equal(reorder.length, 6)
  assert.equal(reorder[0].disabled, true, 'the first shot cannot move up')
  assert.equal(reorder[reorder.length - 1].disabled, true, 'the last shot cannot move down')
  reorder[1].node.props.onClick()

  mounted.unmount()
})

test('renders the host transport error state without throwing', async function () {
  const env = createEnv({ fetch: function () { return Promise.reject(new Error('ECONNREFUSED')) } })
  env.plugin.apply(env.ctx)

  const first = env.mount()
  await settle()
  first.unmount()
  const mounted = env.mount()

  const text = flatText(mounted.tree)
  assert.match(text, /与 host 通信失败/)
  assert.match(text, /ECONNREFUSED/)
  assert.ok(!/正在读取 host 状态/.test(text), 'a failed poll replaces the loading placeholder')
  mounted.unmount()
})

test('renders a non-JSON response as a readable error with no unhandled rejection', async function () {
  const unhandled = []
  const onUnhandled = function (reason) { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const env = createEnv({
      fetch: function () {
        return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('<html>proxy error</html>') } })
      },
    })
    env.plugin.apply(env.ctx)
    const first = env.mount()
    await settle()
    first.unmount()
    const mounted = env.mount()
    assert.match(flatText(mounted.tree), /与 host 通信失败/)
    assert.match(flatText(mounted.tree), /不是 JSON/)
    mounted.unmount()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  await settle()
  assert.deepEqual(unhandled, [], 'fetch helpers never leave a rejected promise behind')
})

test('renders an HTTP failure as a readable error', async function () {
  const env = createEnv({
    fetch: function () {
      return Promise.resolve({ ok: false, status: 502, text: function () { return Promise.resolve('bad gateway') } })
    },
  })
  env.plugin.apply(env.ctx)
  const first = env.mount()
  await settle()
  first.unmount()
  const mounted = env.mount()
  assert.match(flatText(mounted.tree), /HTTP 502/)
  mounted.unmount()
})

test('shows the host build error string in an error card', async function () {
  const state = baseState({
    lastBuild: { at: 1758530000000, ms: 800, ok: false, error: '[dsh-readme-reel] ffmpeg exited 1: libvpx-vp9 not found' },
  })
  const env = createEnv({ state: state })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  const text = flatText(mounted.tree)
  assert.match(text, /生成失败/)
  assert.match(text, /libvpx-vp9 not found/)
  mounted.unmount()
})

test('missing ffmpeg renders a warning card and disables 生成', async function () {
  const state = baseState({ ffmpeg: { found: false, version: null, source: null } })
  const env = createEnv({ state: state })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  assert.match(flatText(mounted.tree), /没有找到 ffmpeg/)
  const build = buttonByText(mounted.tree, '生成')
  assert.equal(build.disabled, true)
  mounted.unmount()
})

test('empty shots state explains docs/shots and disables 生成', async function () {
  const state = baseState({ shots: [] })
  const env = createEnv({ state: state })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  const text = flatText(mounted.tree)
  assert.match(text, /还没有截图/)
  assert.match(text, /docs\/shots/)
  assert.equal(buttonByText(mounted.tree, '生成').disabled, true)
  mounted.unmount()
})

// ---------------------------------------------------------------------------
// actions: build payload and clipboard
// ---------------------------------------------------------------------------

test('the build button posts the checked sources in display order', async function () {
  const state = baseState()
  const env = createEnv({ state: state })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  const build = buttonByText(mounted.tree, '生成')
  assert.equal(build.disabled, false)

  build.node.props.onClick()
  await settle()

  const buildCall = env.fetchCalls.filter(function (call) { return call.url.indexOf('/build') >= 0 })[0]
  assert.ok(buildCall, 'POST /build was sent')
  assert.equal(buildCall.init.method, 'POST')
  assert.deepEqual(JSON.parse(buildCall.init.body), {
    sources: [SHOT_A.path, SHOT_B.path, SHOT_C.path],
  })
  mounted.unmount()
})

test('the copy button writes cover + gif markdown with README-relative paths', async function () {
  const state = baseState()
  const env = createEnv({ state: state })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  const copy = buttonByText(mounted.tree, /复制 Markdown/)
  copy.node.props.onClick()
  await settle()

  assert.equal(env.clipboard.length, 1)
  assert.equal(env.clipboard[0], '![demo](docs/reel/cover.png)\n\n![demo](docs/reel/reel.gif)\n')
  mounted.unmount()
})

test('copy falls back to the textarea trick when the clipboard rejects', async function () {
  const env = createEnv({
    state: baseState(),
    clipboardRejects: true,
    execCommand: false,
  })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  assert.doesNotThrow(function () {
    buttonByText(mounted.tree, /复制 Markdown/).node.props.onClick()
  })
  await settle()
  assert.deepEqual(env.execCommands, ['copy'], 'the synchronous fallback was attempted')
  assert.equal(env.bodyCalls.appended, 1, 'a temporary textarea was attached')
  assert.equal(env.bodyCalls.removed, 1, 'and removed again')
  mounted.unmount()
})

test('copy never throws when no clipboard API exists at all', async function () {
  const env = createEnv({ state: baseState(), noClipboard: true })
  env.plugin.apply(env.ctx)

  const mounted = await mountLoaded(env)
  assert.doesNotThrow(function () {
    buttonByText(mounted.tree, /复制 Markdown/).node.props.onClick()
  })
  await settle()
  assert.deepEqual(env.execCommands, ['copy'])
  mounted.unmount()
})
