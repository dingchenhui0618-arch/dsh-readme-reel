// Storyboard normalisation and the 6-second timeline.
//
// The headline feature is "it fits six seconds without me doing arithmetic".
// That lives here: scenes carry an optional relative `hold` weight, and
// buildTimeline() water-fills the available time so the holds always sum to
// exactly durationMs - transitions, with integer milliseconds. A reel whose
// promised duration is "6s" and whose file is 5.94s is a bug, not a rounding
// detail, so the sum is exact by construction.
//
// Loop safety is the other half: with loop: true the sequence ends on a
// transition back into the FIRST scene, and that transition completes exactly
// at durationMs. t=0 and t=duration therefore show the same frame, which is
// what makes `<video loop>` and looping GIFs invisible at the seam.

import { ReelError } from './errors.js'

export const DEFAULTS = {
  version: 1,
  title: '',
  durationMs: 6000,
  fps: 30,
  width: 960,
  height: 600,
  loop: true,
  layout: 'window',
  transition: 'fade',
  transitionMs: 320,
  theme: {
    accent: '#7aa2ff',
    chrome: '#171b24',
    content: '#0f1319',
    border: '#ffffff',
    shadow: '#000000',
  },
}

export const LAYOUTS = ['window', 'plain']
export const TRANSITIONS = ['fade', 'slide-left', 'cut']
const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

function fail(message) {
  throw new ReelError(message)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function even(value) {
  return value % 2 === 0 ? value : value + 1
}

function integer(name, value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) fail(name + ' 必须是数字，收到 ' + JSON.stringify(value))
  const rounded = Math.round(number)
  if (rounded < min || rounded > max) fail(name + ' 必须在 ' + min + ' 到 ' + max + ' 之间，收到 ' + rounded)
  return rounded
}

function hexColor(name, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !HEX.test(value.trim())) fail(name + ' 必须是 #rrggbb 形式的颜色，收到 ' + JSON.stringify(value))
  return value.trim()
}

function normalizeFocus(focus) {
  if (focus === undefined || focus === null) return null
  if (typeof focus !== 'object') fail('scene.focus 必须是 {x,y,w,h} 对象')
  const numbers = ['x', 'y', 'w', 'h'].map(function (key) {
    const value = Number(focus[key])
    if (!Number.isFinite(value)) fail('scene.focus.' + key + ' 必须是 0..1 的小数')
    return value
  })
  let [x, y, w, h] = numbers
  if (w > 1) w = 1
  if (h > 1) h = 1
  if (w <= 0.02 || h <= 0.02) fail('scene.focus 的宽高太小，至少 0.02')
  x = clamp(x, 0, 1 - w)
  y = clamp(y, 0, 1 - h)
  return { x: x, y: y, w: w, h: h }
}

/**
 * Normalise an arbitrary storyboard-shaped object into the canonical shape.
 * Unknown keys are dropped; wrong types throw. `fallbackTitle` is used when the
 * storyboard has no title (auto-derived storyboards get the repo folder name).
 */
export function normalizeStoryboard(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('storyboard 必须是一个对象')
  const scenes = input.scenes
  if (!Array.isArray(scenes) || scenes.length === 0) fail('storyboard.scenes 至少要有一个画面')
  if (scenes.length > 12) fail('storyboard.scenes 最多 12 个画面，收到 ' + scenes.length)

  const durationMs = integer('durationMs', input.durationMs === undefined ? DEFAULTS.durationMs : input.durationMs, 1000, 20000)
  const fps = integer('fps', input.fps === undefined ? DEFAULTS.fps : input.fps, 10, 60)
  const size = input.size && typeof input.size === 'object' ? input.size : {}
  const width = even(integer('size.width', size.width === undefined ? DEFAULTS.width : size.width, 320, 1920))
  const height = even(integer('size.height', size.height === undefined ? DEFAULTS.height : size.height, 200, 1200))
  const loop = input.loop === undefined ? DEFAULTS.loop : Boolean(input.loop)
  const layout = input.layout === undefined ? DEFAULTS.layout : String(input.layout)
  if (!LAYOUTS.includes(layout)) fail('layout 只能是 ' + LAYOUTS.join(' / ') + '，收到 ' + JSON.stringify(layout))
  const transition = input.transition === undefined ? DEFAULTS.transition : String(input.transition)
  if (!TRANSITIONS.includes(transition)) fail('transition 只能是 ' + TRANSITIONS.join(' / ') + '，收到 ' + JSON.stringify(transition))
  const transitionMs = integer('transitionMs', input.transitionMs === undefined ? DEFAULTS.transitionMs : input.transitionMs, 80, 1200)
  if (transitionMs * scenes.length >= durationMs) {
    fail('transitionMs 太大：' + scenes.length + ' 个画面 × ' + transitionMs + 'ms 已经占满 ' + durationMs + 'ms')
  }

  const themeInput = input.theme && typeof input.theme === 'object' ? input.theme : {}
  const theme = {
    accent: hexColor('theme.accent', themeInput.accent, DEFAULTS.theme.accent),
    chrome: hexColor('theme.chrome', themeInput.chrome, DEFAULTS.theme.chrome),
    content: hexColor('theme.content', themeInput.content, DEFAULTS.theme.content),
    border: hexColor('theme.border', themeInput.border, DEFAULTS.theme.border),
    shadow: hexColor('theme.shadow', themeInput.shadow, DEFAULTS.theme.shadow),
  }

  const normalizedScenes = scenes.map(function (scene, index) {
    if (!scene || typeof scene !== 'object') fail('scenes[' + index + '] 必须是对象')
    const src = scene.src
    if (typeof src !== 'string' || src.trim().length === 0) fail('scenes[' + index + '].src 必须是非空字符串')
    const sceneLayout = scene.layout === undefined ? layout : String(scene.layout)
    if (!LAYOUTS.includes(sceneLayout)) fail('scenes[' + index + '].layout 只能是 ' + LAYOUTS.join(' / '))
    let hold = null
    if (scene.hold !== undefined && scene.hold !== null) {
      hold = integer('scenes[' + index + '].hold', scene.hold, 100, 20000)
    }
    return {
      src: src.trim(),
      hold: hold,
      layout: sceneLayout,
      focus: normalizeFocus(scene.focus),
      title: typeof scene.title === 'string' ? scene.title : '',
    }
  })

  const title = typeof input.title === 'string' && input.title.trim().length > 0
    ? input.title.trim()
    : String(options.fallbackTitle || '')

  return {
    version: 1,
    title: title,
    durationMs: durationMs,
    fps: fps,
    size: { width: width, height: height },
    loop: loop,
    layout: layout,
    transition: transition,
    transitionMs: transitionMs,
    theme: theme,
    scenes: normalizedScenes,
  }
}

/**
 * Split `total` integer milliseconds across `weights` so that
 * sum(result) === total exactly, every share is >= floor, and any leftover
 * milliseconds go to the largest fractional parts (earlier index wins ties).
 *
 * Water-filling: raise everyone to `floor` first, then distribute the rest in
 * proportion to weight. This is the part that makes "just fits 6 seconds" true
 * rather than approximately true.
 */
export function distributeHolds(total, weights, floor) {
  const n = weights.length
  if (n === 0) return []
  const budget = Math.round(Number(total))
  if (!Number.isFinite(budget) || budget < 0) throw new ReelError('分配时长时收到非法总时长 ' + total)
  const normalized = weights.map(function (value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : 0
  })
  let weightSum = normalized.reduce(function (acc, value) { return acc + value }, 0)
  if (weightSum <= 0) {
    for (let i = 0; i < n; i += 1) normalized[i] = 1
    weightSum = n
  }
  const minimum = Math.max(0, Math.min(Math.floor(floor), Math.floor(budget / n)))

  // Water-fill the minimum: any proportional share below the floor is pinned
  // to the floor and the rest is redistributed among the unpinned slots.
  const pinned = new Array(n).fill(false)
  let remaining = budget
  let remainingWeight = weightSum
  for (let round = 0; round < n; round += 1) {
    let changed = false
    for (let i = 0; i < n; i += 1) {
      if (pinned[i]) continue
      const share = (remaining * normalized[i]) / remainingWeight
      if (share < minimum) {
        pinned[i] = true
        remaining -= minimum
        remainingWeight -= normalized[i]
        changed = true
      }
    }
    if (!changed) break
  }

  if (remainingWeight <= 0) {
    // The floor consumed the whole budget (only possible for tiny durations).
    const even = new Array(n).fill(minimum)
    let left = budget - minimum * n
    for (let i = 0; left > 0; i = (i + 1) % n) {
      even[i] += 1
      left -= 1
    }
    return even
  }

  const shares = new Array(n).fill(0)
  const fractions = []
  let assigned = 0
  for (let i = 0; i < n; i += 1) {
    if (pinned[i]) {
      shares[i] = minimum
      assigned += minimum
      continue
    }
    const exact = (remaining * normalized[i]) / remainingWeight
    const base = Math.floor(exact)
    shares[i] = base
    assigned += base
    fractions.push({ index: i, fraction: exact - base })
  }

  let leftover = Math.round(budget - assigned)
  fractions.sort(function (a, b) {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction
    return a.index - b.index
  })
  for (let k = 0; k < fractions.length && leftover > 0; k += 1) {
    shares[fractions[k].index] += 1
    leftover -= 1
  }
  // Floating-point dust must not break the exact-sum guarantee.
  let guard = 0
  while (leftover > 0 && guard < n * 2) {
    shares[guard % n] += 1
    leftover -= 1
    guard += 1
  }
  guard = 0
  while (leftover < 0 && guard < n * 2) {
    const index = shares.findIndex(function (value) { return value > minimum })
    if (index < 0) break
    shares[index] -= 1
    leftover += 1
    guard += 1
  }
  return shares
}

/**
 * Build the exact segment list for a normalised storyboard.
 *
 * loop: hold0, trans(0->1), hold1, ... hold(n-1), trans(n-1->0)   — n transitions
 * once: hold0, trans(0->1), ... hold(n-1)                          — n-1 transitions
 */
export function buildTimeline(storyboard) {
  const scenes = storyboard.scenes
  const n = scenes.length
  const transitionMs = Math.min(
    storyboard.transitionMs,
    Math.floor(storyboard.durationMs / (n * 4)),
  )
  const transitionCount = storyboard.loop ? n : n - 1
  const holdBudget = storyboard.durationMs - transitionCount * transitionMs
  if (holdBudget < n * 60) {
    throw new ReelError('时长太短：' + storyboard.durationMs + 'ms 装不下 ' + n + ' 个画面')
  }

  // `hold` is a relative weight, not a fixed duration: the timeline must sum to
  // durationMs, so a fixed hold would have to be rescaled anyway. Scenes that
  // omit it contribute a neutral 1000ms weight, which makes "this one should
  // linger" work without forcing the author to annotate every scene.
  const DEFAULT_HOLD_WEIGHT = 1000
  const weights = scenes.map(function (scene) {
    return scene.hold === null ? DEFAULT_HOLD_WEIGHT : scene.hold
  })
  const holds = distributeHolds(holdBudget, weights, 350)

  const segments = []
  let cursor = 0
  const holdWindows = []
  const push = function (segment) {
    segments.push(segment)
    cursor = segment.toMs
  }

  for (let i = 0; i < n; i += 1) {
    const segment = { kind: 'hold', scene: i, fromMs: cursor, toMs: cursor + holds[i] }
    holdWindows.push({ scene: i, fromMs: segment.fromMs, toMs: segment.toMs })
    push(segment)
    if (i < n - 1) {
      push({ kind: 'transition', from: i, to: i + 1, type: storyboard.transition, fromMs: cursor, toMs: cursor + transitionMs })
    }
  }
  if (storyboard.loop) {
    push({ kind: 'transition', from: n - 1, to: 0, type: storyboard.transition, fromMs: cursor, toMs: cursor + transitionMs })
  }

  // The segments must cover [0, durationMs) with no gap and no overlap. This
  // invariant is cheap to check and turns a future timing regression into an
  // immediate failure instead of a reel that stutters.
  if (segments.length === 0 || segments[0].fromMs !== 0 || segments[segments.length - 1].toMs !== storyboard.durationMs) {
    throw new ReelError('内部错误：时间轴没有精确覆盖 0..' + storyboard.durationMs + 'ms')
  }
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].fromMs !== segments[i - 1].toMs) throw new ReelError('内部错误：时间轴在 ' + segments[i].fromMs + 'ms 处断开')
  }

  const frameCount = Math.max(1, Math.round((storyboard.durationMs * storyboard.fps) / 1000))
  return {
    durationMs: storyboard.durationMs,
    fps: storyboard.fps,
    frameCount: frameCount,
    transitionMs: transitionMs,
    segments: segments,
    holds: holdWindows,
    scenes: scenes.map(function (scene, index) {
      return { index: index, src: scene.src, holdMs: holds[index], layout: scene.layout }
    }),
  }
}

/** Which still(s) is on screen at tMs, and how far through the transition. */
export function sampleAt(timeline, tMs) {
  const t = Math.max(0, Math.min(timeline.durationMs - 0.0001, tMs))
  let low = 0
  let high = timeline.segments.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (timeline.segments[mid].fromMs <= t) low = mid
    else high = mid - 1
  }
  const segment = timeline.segments[low]
  if (segment.kind === 'hold') return { kind: 'hold', scene: segment.scene, progress: 0, segment: segment }
  const span = segment.toMs - segment.fromMs
  return {
    kind: 'transition',
    from: segment.from,
    to: segment.to,
    type: segment.type,
    progress: span <= 0 ? 1 : (t - segment.fromMs) / span,
    segment: segment,
  }
}
