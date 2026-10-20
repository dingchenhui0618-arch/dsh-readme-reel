// Client half of dsh-readme-reel: the 首屏短片 Tab in the conversation view.
//
// Must stay CommonJS — scripts/build.mjs wraps this in
// window.__ModuleLoader__.load() and React is supplied by the harness. The one
// relative require below (the stylesheet) is replaced by the stylesheet's
// contents at build time, so the shipped bundle carries no relative require.
//
// Teardown discipline mirrors dsh-warden: every registration has a disposer, the
// shared poll lives at module scope (so unmounting a view is not enough), and a
// failed slot registration costs this one panel, not the whole client boot.
//
// This half never owns the truth. It renders GET /dsh-readme-reel/state and asks
// the host to act through POST /scan and POST /build.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const NAME = 'dsh-readme-reel'
const API = '/dsh-readme-reel'
const POLL_MS = 1000

// ---------------------------------------------------------------------------
// shared poller
// ---------------------------------------------------------------------------

// One module-level poller serves every mounted view. The host half is the single
// source of truth; this side only ever renders what /state reports.
let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function errorText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message) return error.message
  try {
    return String(error)
  } catch (inner) {
    return '未知错误'
  }
}

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      // One bad subscriber must not stop the poll.
      if (typeof console !== 'undefined' && console.warn) console.warn('[' + NAME + '] listener failed', error)
    }
  })
}

// Read a response defensively: fetch can resolve to something that is not JSON
// (a proxy error page, a 404 body), and the panel must show that as a message
// rather than as an unhandled rejection.
function readJson(res) {
  if (!res) return Promise.reject(new Error('host 没有响应'))
  if (res.ok === false) return Promise.reject(new Error('HTTP ' + (res.status || '?')))
  var read = typeof res.text === 'function' ? res.text() : Promise.resolve('')
  return Promise.resolve(read).then(function (text) {
    if (text === null || text === undefined || text === '') throw new Error('host 返回了空响应')
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new Error('host 返回的不是 JSON')
    }
  })
}

function request(path, init) {
  // Promise.resolve().then keeps a synchronous throw from fetch in the rejection
  // path as well, so every caller has exactly one error channel.
  return Promise.resolve()
    .then(function () { return fetch(API + path, init) })
    .then(readJson)
}

function load() {
  return request('/state', { headers: { accept: 'application/json' } })
    .then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.error) || 'host 返回了无效状态')
      snap = { data: data, error: '', at: Date.now() }
      emit()
      return data
    })
    .catch(function (error) {
      snap = { data: snap.data, error: errorText(error), at: Date.now() }
      emit()
      return null
    })
}

function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

// ---------------------------------------------------------------------------
// formatters — all defensive: a missing number renders as a dash, never "NaN"
// ---------------------------------------------------------------------------

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function clock(ms) {
  var n = Number(ms)
  if (!isFinite(n) || n <= 0) return '—'
  var d = new Date(n)
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function fmtBytes(bytes) {
  var n = Number(bytes)
  if (!isFinite(n) || n < 0) return '—'
  if (n < 1024) return Math.round(n) + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

function fmtMs(ms) {
  var n = Number(ms)
  if (!isFinite(n) || n < 0) return '—'
  if (n < 1000) return Math.round(n) + ' ms'
  return (n / 1000).toFixed(1) + ' s'
}

function fmtSeconds(ms) {
  var n = Number(ms)
  if (!isFinite(n) || n < 0) return '—'
  return (n / 1000).toFixed(1) + 's'
}

function baseName(path) {
  var text = String(path === null || path === undefined ? '' : path).replace(/\\/g, '/')
  var cut = text.lastIndexOf('/')
  return cut >= 0 ? text.slice(cut + 1) : text
}

function cleanVersion(version) {
  var text = String(version || '').replace(/^ffmpeg version\s+/i, '').trim()
  // "9.0.1-full_build-www.gyan.dev" is a build stamp, not a version: keep the
  // numeric part for the card and leave the full string in the tooltip.
  var numeric = /^(\d+(?:\.\d+){1,3})/.exec(text)
  if (numeric) return numeric[1]
  var cut = text.search(/\s/)
  return cut > 0 ? text.slice(0, cut) : text
}

// State -> view state. The selection and its order belong to the panel, not to
// the host: they survive polls, drop shots that disappeared, and include shots
// that appeared since the last scan (a fresh screenshot should be on by default).
function deriveView(nextSnap, prev) {
  var data = nextSnap.data
  var shots = data && Array.isArray(data.shots) ? data.shots : []
  var exists = {}
  shots.forEach(function (shot) {
    if (shot && shot.path) exists[shot.path] = true
  })

  var order = prev && prev.order ? prev.order.slice() : null
  var on = prev && prev.on ? Object.assign({}, prev.on) : null

  if (!order) {
    order = []
    on = {}
    shots.forEach(function (shot) {
      if (!shot || !shot.path || on[shot.path] !== undefined) return
      order.push(shot.path)
      on[shot.path] = true
    })
  } else {
    order = order.filter(function (path) { return exists[path] === true })
    shots.forEach(function (shot) {
      if (!shot || !shot.path) return
      if (order.indexOf(shot.path) >= 0) return
      order.push(shot.path)
      on[shot.path] = true
    })
    Object.keys(on).forEach(function (path) {
      if (!exists[path]) delete on[path]
    })
  }

  return {
    snap: nextSnap,
    order: order,
    on: on,
    busy: prev ? prev.busy : '',
    copy: prev ? prev.copy : null,
    build: prev ? prev.build : null,
    scanError: prev ? prev.scanError : '',
  }
}

// Result of POST /scan (same shape as state) or POST /build ({ ok, manifest,
// state }) -> the state object, or null when the host sent something else.
function stateFrom(result) {
  if (!result) return null
  if (result.state && typeof result.state === 'object' && result.state.ok !== false) return result.state
  if (result.ok === true && Array.isArray(result.shots)) return result
  return null
}

// ---------------------------------------------------------------------------
// copy-to-README
// ---------------------------------------------------------------------------

// README-relative path for an asset. state.projectDir is the repo root and the
// README lives there, so the markdown can point at docs/reel/cover.png instead
// of at a localhost URL. Falls back to the output folder's own name when the
// host reports an outDir outside projectDir.
function assetRef(data, name) {
  var out = data && data.outDir
  var root = data && data.projectDir
  var dir = ''
  if (out) {
    var o = String(out).replace(/\\/g, '/').replace(/\/+$/, '')
    var r = root ? String(root).replace(/\\/g, '/').replace(/\/+$/, '') : ''
    if (r && o === r) dir = ''
    else if (r && o.indexOf(r + '/') === 0) dir = o.slice(r.length + 1)
    else dir = baseName(o)
    if (dir) dir += '/'
  }
  return dir + name
}

function markdown(data) {
  var outputs = (data && data.outputs) || {}
  if (!outputs.cover && !outputs.gif) return ''
  var title = (data && data.storyboard && data.storyboard.title) || '首屏短片'
  var lines = []
  if (outputs.cover) lines.push('![' + title + '](' + assetRef(data, 'cover.png') + ')')
  if (outputs.gif) lines.push('![' + title + '](' + assetRef(data, 'reel.gif') + ')')
  return lines.length === 0 ? '' : lines.join('\n\n') + '\n'
}

// Clipboard with a synchronous fallback, and no way to throw or reject: the
// caller only ever learns true/false.
function legacyCopy(text) {
  try {
    if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return false
    var body = document.body
    var area = document.createElement('textarea')
    area.value = text
    if (typeof area.setAttribute === 'function') area.setAttribute('readonly', '')
    if (area.style) {
      area.style.position = 'fixed'
      area.style.top = '-9999px'
      area.style.opacity = '0'
    }
    if (body && typeof body.appendChild === 'function') body.appendChild(area)
    if (typeof area.select === 'function') area.select()
    var ok = typeof document.execCommand === 'function' && document.execCommand('copy')
    if (body && typeof body.removeChild === 'function') body.removeChild(area)
    else if (typeof area.remove === 'function') area.remove()
    return ok === true
  } catch (error) {
    return false
  }
}

function copyText(text) {
  return new Promise(function (resolve) {
    try {
      var clipboard = typeof navigator !== 'undefined' && navigator ? navigator.clipboard : null
      if (clipboard && typeof clipboard.writeText === 'function') {
        Promise.resolve(clipboard.writeText(text)).then(
          function () { resolve(true) },
          function () { resolve(legacyCopy(text)) },
        )
        return
      }
    } catch (error) {
      // Fall through to the legacy path.
    }
    resolve(legacyCopy(text))
  })
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

const FFMPEG_SOURCE = { explicit: '显式配置', env: '环境变量', path: 'PATH' }

function Stat(props) {
  return h('div', { className: 'rr-stat' + (props.tone ? ' ' + props.tone : ''), title: props.title || undefined },
    h('b', null, props.value),
    h('span', null, props.label),
  )
}

function PathRow(props) {
  return h('div', { className: 'rr-path' },
    h('span', { className: 'rr-path-k' }, props.label),
    h('span', { className: 'rr-mono', title: props.value || '' }, props.value || '—'),
  )
}

function StatusStrip(props) {
  var data = props.data
  var ffmpeg = data.ffmpeg || {}
  var storyboard = data.storyboard || null
  var last = data.lastBuild || null
  var scenes = storyboard && Array.isArray(storyboard.scenes) ? storyboard.scenes.length : 0
  var size = storyboard && storyboard.size ? storyboard.size : null
  var found = ffmpeg.found === true

  return h('div', null,
    h('div', { className: 'rr-status' },
      h(Stat, {
        key: 'ffmpeg',
        tone: found ? '' : 'rr-bad',
        value: found ? cleanVersion(ffmpeg.version) : '未找到',
        label: found ? 'ffmpeg · ' + (FFMPEG_SOURCE[ffmpeg.source] || ffmpeg.source || '未知来源') : 'ffmpeg · 无法生成',
        title: found ? 'ffmpeg ' + (ffmpeg.version || '') + '（' + (ffmpeg.source || '') + '）' : '未在显式配置、环境变量或 PATH 中找到可用的 ffmpeg',
      }),
      h(Stat, {
        key: 'storyboard',
        value: storyboard ? (storyboard.source === 'file' ? '文件' : '自动') : '—',
        label: storyboard ? '分镜 · ' + scenes + ' 幕' : '分镜 · 按截图顺序自动排版',
        title: storyboard ? (storyboard.path || '自动生成的分镜') : '还没有分镜',
      }),
      h(Stat, {
        key: 'timeline',
        value: size ? size.width + '×' + size.height : '—',
        label: storyboard ? fmtSeconds(storyboard.durationMs) + ' · ' + (storyboard.fps || '—') + 'fps · ' + (storyboard.loop === false ? '单次' : '循环') : '画幅 —',
        title: storyboard ? '画布 ' + size.width + '×' + size.height + ' · 时长 ' + storyboard.durationMs + 'ms · ' + (storyboard.fps || '?') + 'fps' : '还没有分镜',
      }),
      h(Stat, {
        key: 'build',
        tone: last && last.ok === false ? 'rr-bad' : '',
        value: last ? fmtMs(last.ms) : '—',
        label: last ? '上次生成 ' + clock(last.at) + (last.ok ? '' : ' · 失败') : '上次生成 —',
        title: last ? (last.ok ? '上次生成成功' : '上次生成失败') : '还没有生成记录',
      }),
    ),
    h('div', { className: 'rr-paths', style: { marginTop: '8px' } },
      h(PathRow, { key: 'out', label: '输出', value: data.outDir }),
      storyboard && storyboard.path ? h(PathRow, { key: 'sb', label: '分镜', value: storyboard.path }) : null,
    ),
  )
}

function BuildNote(props) {
  var view = props.view
  if (view.busy === 'build') {
    return h('div', { className: 'rr-note' },
      h('div', { className: 'rr-note-line' }, '正在生成…'),
      h('div', { className: 'rr-progress' }),
      h('div', { className: 'rr-note-sub' }, 'ffmpeg 正在逐帧编码；完成后这里和产物区会自动刷新。'),
    )
  }
  var report = props.report
  if (!report) return null
  if (report.ok === false) return h('div', { className: 'rr-err' }, '生成失败：' + (report.error || '未知错误'))
  return h('div', { className: 'rr-ok-note' },
    h('span', { className: 'rr-check' }, '✓'),
    h('span', null, '已更新' + (report.ms ? ' · ' + fmtMs(report.ms) : '')),
  )
}

function ShotCard(props) {
  var shot = props.shot
  return h('div', { className: 'rr-shot' + (props.included ? '' : ' rr-off') },
    h('div', { className: 'rr-thumb' },
      h('img', {
        className: 'rr-thumb-img',
        src: (shot && shot.url) || '',
        alt: baseName(props.path),
        loading: 'lazy',
      }),
      h('span', { className: 'rr-idx', title: '生成顺序' }, props.index > 0 ? String(props.index) : '—'),
    ),
    h('label', { className: 'rr-pick', title: props.path },
      h('input', { type: 'checkbox', checked: props.included, onChange: props.onToggle }),
      h('span', { className: 'rr-name' }, baseName(props.path)),
    ),
    h('div', { className: 'rr-shot-foot' },
      h('span', { className: 'rr-size' }, fmtBytes(shot && shot.bytes)),
      h('div', { className: 'rr-order-btns' },
        h('button', {
          className: 'rr-mini',
          type: 'button',
          title: '上移',
          'aria-label': '上移 ' + baseName(props.path),
          disabled: !props.canUp,
          onClick: props.onUp,
        }, '↑'),
        h('button', {
          className: 'rr-mini',
          type: 'button',
          title: '下移',
          'aria-label': '下移 ' + baseName(props.path),
          disabled: !props.canDown,
          onClick: props.onDown,
        }, '↓'),
      ),
    ),
  )
}

function ShotsSection(props) {
  var view = props.view
  var order = view.order
  var indexByPath = {}
  var includedCount = 0
  order.forEach(function (path) {
    if (view.on[path] !== false) {
      includedCount += 1
      indexByPath[path] = includedCount
    }
  })

  return h('section', { className: 'rr-sec' },
    h('div', { className: 'rr-sec-head' },
      h('h4', { className: 'rr-sec-title' }, '素材'),
      h('span', { className: 'rr-sec-count' }, order.length === 0 ? '暂无截图' : includedCount + ' / ' + order.length + ' 张入选'),
    ),
    order.length === 0
      ? h('div', { className: 'rr-empty' },
          h('b', null, '还没有截图'),
          h('span', null, '把仓库截图（PNG）放进 docs/shots/，或用插件配置里的 shotsDir 指到别的目录，然后点右上角「重扫」。'),
        )
      : h('div', { className: 'rr-grid' }, order.map(function (path, index) {
          return h(ShotCard, {
            key: path,
            path: path,
            shot: props.byPath[path],
            index: indexByPath[path] || 0,
            included: view.on[path] !== false,
            canUp: index > 0,
            canDown: index < order.length - 1,
            onToggle: function () { props.onToggle(path) },
            onUp: function () { props.onMove(path, -1) },
            onDown: function () { props.onMove(path, 1) },
          })
        })),
  )
}

function FileRow(props) {
  var file = props.file
  var extra = []
  if (file) {
    if (file.width && file.height) extra.push(file.width + '×' + file.height)
    if (file.durationMs) extra.push(fmtSeconds(file.durationMs))
  }
  return h('div', { className: 'rr-file' + (file ? '' : ' rr-file-missing') },
    h('span', { className: 'rr-file-k' }, props.label),
    h('span', { className: 'rr-file-n', title: file ? file.path || '' : '' }, props.name + (extra.length ? ' · ' + extra.join(' · ') : '')),
    h('span', { className: 'rr-file-v' }, file ? fmtBytes(file.bytes) : '缺失'),
  )
}

function OutputsSection(props) {
  var data = props.data
  var outputs = data.outputs || {}
  var webm = outputs.webm || null
  var gif = outputs.gif || null
  var cover = outputs.cover || null
  var any = webm || gif || cover
  var text = markdown(data)

  if (!any) {
    return h('section', { className: 'rr-sec' },
      h('div', { className: 'rr-sec-head' },
        h('h4', { className: 'rr-sec-title' }, '产物'),
      ),
      h('div', { className: 'rr-empty' },
        h('b', null, '还没有短片'),
        h('span', null, '选好素材点「生成」，三份产物会写进输出目录：'),
        h('span', { className: 'rr-mono' }, data.outDir || '—'),
      ),
    )
  }

  var copy = props.view.copy
  var stage = webm
    ? h('video', {
        className: 'rr-video',
        src: webm.url,
        poster: gif ? gif.url : undefined,
        autoPlay: true,
        loop: true,
        muted: true,
        playsInline: true,
      })
    : h('img', {
        className: 'rr-gif',
        src: (gif && gif.url) || (cover && cover.url) || '',
        alt: '短片预览',
      })

  return h('section', { className: 'rr-sec' },
    h('div', { className: 'rr-sec-head' },
      h('h4', { className: 'rr-sec-title' }, '产物'),
      h('span', { className: 'rr-sec-count' }, '透明 webm · gif · 封面'),
    ),
    h('div', { className: 'rr-out' },
      h('div', { className: 'rr-stage' },
        stage,
        h('span', { className: 'rr-stage-tag' }, '6 秒 · 静音 · 循环'),
      ),
      h('div', { className: 'rr-out-side' },
        h('div', { className: 'rr-files' },
          h(FileRow, { key: 'webm', label: '透明 webm', name: 'reel.webm', file: webm }),
          h(FileRow, { key: 'gif', label: 'GIF', name: 'reel.gif', file: gif }),
        ),
        h('div', { className: 'rr-cover-row' },
          cover
            ? h('img', { className: 'rr-cover', src: cover.url, alt: '封面帧 cover.png' })
            : h('div', { className: 'rr-cover rr-cover-missing' }, '—'),
          h('div', { className: 'rr-cover-meta' },
            h('span', { className: 'rr-file-k' }, '封面帧'),
            h('span', { className: 'rr-mono', title: cover ? cover.path || '' : '' }, 'cover.png'),
            h('span', { className: 'rr-file-v' }, fmtBytes(cover && cover.bytes)),
          ),
        ),
        text
          ? h('div', { className: 'rr-copy' },
              h('button', { className: 'rr-btn', type: 'button', onClick: props.onCopy }, copy === 'ok' ? '已复制' : '复制 Markdown'),
              copy === 'fail' ? h('div', { className: 'rr-copy-fail' }, '复制失败：请手动选择下面的内容') : null,
              h('pre', { className: 'rr-snippet', title: '复制到 README 的片段' }, text),
            )
          : null,
      ),
    ),
  )
}

function ReelView() {
  // One state object for the poll snapshot plus the panel's own selection: the
  // two update together, and a poll never resets what the user chose.
  const [view, setView] = React.useState(function () { return deriveView(snap, null) })
  React.useEffect(function () {
    return subscribe(function (next) {
      setView(function (prev) { return deriveView(next, prev) })
    })
  }, [])

  const data = view.snap.data
  const transportError = view.snap.error
  const ffmpeg = (data && data.ffmpeg) || { found: false, version: null, source: null }
  const storyboard = (data && data.storyboard) || null
  const shots = data && Array.isArray(data.shots) ? data.shots : []
  const byPath = {}
  shots.forEach(function (shot) {
    if (shot && shot.path) byPath[shot.path] = shot
  })
  const included = view.order.filter(function (path) { return view.on[path] !== false })
  const busy = view.busy || ''
  const building = busy === 'build'
  const scanning = busy === 'scan'
  const lastBuild = data && data.lastBuild ? data.lastBuild : null

  // Prefer the host's last build when it is newer than the one this panel ran;
  // otherwise keep the local report so "已更新" survives the next poll.
  let report = view.build
  if (lastBuild && (!report || (lastBuild.at && report.at && lastBuild.at > report.at))) {
    report = { ok: lastBuild.ok, ms: lastBuild.ms, error: lastBuild.error, at: lastBuild.at }
  }

  const canBuild = Boolean(data) && busy === '' && included.length > 0 && ffmpeg.found === true
  const buildTitle = building
    ? '正在生成…'
    : !data
      ? '正在读取 host 状态'
      : ffmpeg.found !== true
        ? '先让 host 找到 ffmpeg'
        : included.length === 0
          ? '至少选一张截图'
          : '用选中的截图生成短片'

  function toggleShot(path) {
    setView(function (prev) {
      var next = Object.assign({}, prev)
      next.on = Object.assign({}, prev.on)
      next.on[path] = next.on[path] === false
      return next
    })
  }

  function moveShot(path, delta) {
    setView(function (prev) {
      var from = prev.order.indexOf(path)
      var to = from + delta
      if (from < 0 || to < 0 || to >= prev.order.length) return prev
      var order = prev.order.slice()
      order.splice(from, 1)
      order.splice(to, 0, path)
      var next = Object.assign({}, prev)
      next.order = order
      return next
    })
  }

  function rescan() {
    if (busy !== '') return
    setView(function (prev) {
      var next = Object.assign({}, prev)
      next.busy = 'scan'
      next.scanError = ''
      next.copy = null
      return next
    })
    post('/scan', {}).then(function (result) {
      var state = stateFrom(result)
      setView(function (prev) {
        var next = deriveView(state ? { data: state, error: '', at: Date.now() } : prev.snap, prev)
        next.busy = ''
        return next
      })
      load()
    }).catch(function (error) {
      setView(function (prev) {
        var next = Object.assign({}, prev)
        next.busy = ''
        next.scanError = errorText(error)
        return next
      })
    })
  }

  function buildNow() {
    if (!canBuild) return
    var sources = included.slice()
    setView(function (prev) {
      var next = Object.assign({}, prev)
      next.busy = 'build'
      next.build = null
      next.scanError = ''
      next.copy = null
      return next
    })
    post('/build', { sources: sources }).then(function (result) {
      if (!result || result.ok === false) throw new Error((result && result.error) || 'host 没有返回生成结果')
      var state = stateFrom(result)
      var ms = (state && state.lastBuild && state.lastBuild.ms) || 0
      setView(function (prev) {
        var next = deriveView(state ? { data: state, error: '', at: Date.now() } : prev.snap, prev)
        next.busy = ''
        next.build = { ok: true, ms: ms, at: Date.now() }
        return next
      })
      load()
    }).catch(function (error) {
      setView(function (prev) {
        var next = Object.assign({}, prev)
        next.busy = ''
        next.build = { ok: false, error: errorText(error), at: Date.now() }
        return next
      })
    })
  }

  function copyMarkdown() {
    var text = markdown(data)
    if (!text) return
    copyText(text).then(function (ok) {
      setView(function (prev) {
        var next = Object.assign({}, prev)
        next.copy = ok ? 'ok' : 'fail'
        return next
      })
    })
  }

  return h('div', { className: 'rr-root' },
    h('div', { className: 'rr-head' },
      h('div', { className: 'rr-heading' },
        h('div', { className: 'rr-title' }, '首屏短片'),
        h('div', { className: 'rr-sub' }, '把仓库截图自动合成 6 秒静音循环短片'),
      ),
      h('div', { className: 'rr-spacer' }),
      h('button', {
        className: 'rr-btn',
        type: 'button',
        disabled: busy !== '' || !data,
        title: '重新扫描截图目录',
        onClick: rescan,
      }, scanning ? '扫描中…' : '重扫'),
      h('button', {
        className: 'rr-btn rr-btn-primary',
        type: 'button',
        disabled: !canBuild,
        title: buildTitle,
        onClick: buildNow,
      }, building ? '正在生成…' : '生成'),
    ),
    transportError ? h('div', { className: 'rr-err' }, '与 host 通信失败：' + transportError) : null,
    !data && !transportError ? h('div', { className: 'rr-loading' }, '正在读取 host 状态…') : null,
    data ? h('div', { className: 'rr-body' },
      ffmpeg.found === true
        ? null
        : h('div', { className: 'rr-warn' },
            h('div', { className: 'rr-warn-title' }, '没有找到 ffmpeg'),
            h('div', { className: 'rr-warn-text' }, '生成短片需要带 libvpx-vp9 的 ffmpeg。装好并放进 PATH，或在插件配置里设 ffmpegPath，或设环境变量 DSH_README_REEL_FFMPEG，然后点「重扫」。'),
          ),
      view.scanError ? h('div', { className: 'rr-err' }, '重扫失败：' + view.scanError) : null,
      h(StatusStrip, { data: data }),
      h(BuildNote, { view: view, report: report }),
      h(ShotsSection, {
        view: view,
        byPath: byPath,
        onToggle: toggleShot,
        onMove: moveShot,
      }),
      h(OutputsSection, { view: view, data: data, onCopy: copyMarkdown }),
    ) : null,
  )
}

function apply(ctx) {
  // dsh can unload a plugin at runtime, so every registration here has a
  // matching teardown. The shared poll lives at module scope and therefore
  // outlives one apply(): unmounting the view is not guaranteed on unload, so
  // it needs an explicit disposer of its own.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = NAME
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // Guarded, and normalised to always hand Cordis a disposer: a changed slot
  // contract must degrade this one panel and say so, not abort the client boot
  // for every other plugin in the graph.
  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'readme-reel', order: 40, label: '首屏短片' },
        ReelView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[' + NAME + '] could not register the 首屏短片 view; the host half still builds reels', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: NAME,
  inject: ['slots'],
  apply: apply,
}
