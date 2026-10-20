// Storyboard + timeline tests: the contract is "6.000 seconds, exactly, and
// the loop seam is invisible", so these assertions are about arithmetic and
// coverage rather than pixels.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  buildTimeline,
  DEFAULTS,
  distributeHolds,
  normalizeStoryboard,
  sampleAt,
} from '../src/storyboard.js'

function board(scenes, extra) {
  return normalizeStoryboard(Object.assign({ scenes: scenes || [{ src: 'a.png' }] }, extra || {}))
}

test('defaults describe a 6 second 30fps 960x600 transparent loop', () => {
  const storyboard = board()
  assert.equal(storyboard.durationMs, 6000)
  assert.equal(storyboard.fps, 30)
  assert.deepEqual(storyboard.size, { width: 960, height: 600 })
  assert.equal(storyboard.loop, true)
  assert.equal(storyboard.transition, 'fade')
  assert.equal(storyboard.transitionMs, DEFAULTS.transitionMs)
  assert.equal(storyboard.scenes[0].layout, 'window')
})

test('odd widths are rounded up to even so codecs never see odd dimensions', () => {
  const storyboard = board([{ src: 'a.png' }], { size: { width: 961, height: 601 } })
  assert.deepEqual(storyboard.size, { width: 962, height: 602 })
})

test('timeline covers exactly [0, durationMs) with no gaps for 1..12 scenes', () => {
  for (const count of [1, 2, 3, 5, 12]) {
    const scenes = []
    for (let i = 0; i < count; i += 1) scenes.push({ src: 'shot-' + i + '.png' })
    const storyboard = board(scenes)
    const timeline = buildTimeline(storyboard)
    assert.equal(timeline.segments[0].fromMs, 0, count + ' scenes start at 0')
    assert.equal(timeline.segments.at(-1).toMs, 6000, count + ' scenes end at 6000')
    for (let i = 1; i < timeline.segments.length; i += 1) {
      assert.equal(timeline.segments[i].fromMs, timeline.segments[i - 1].toMs, 'segment ' + i + ' is contiguous')
    }
    assert.equal(timeline.frameCount, Math.round((6000 * 30) / 1000))
    const holds = timeline.holds.reduce((acc, hold) => acc + (hold.toMs - hold.fromMs), 0)
    const transitions = timeline.segments.filter((segment) => segment.kind === 'transition').length
    assert.equal(holds + transitions * timeline.transitionMs, 6000, 'duration is exactly 6000ms')
    assert.equal(transitions, count, 'a loop has one transition per scene')
  }
})

test('loop:false drops the closing transition', () => {
  const timeline = buildTimeline(board([{ src: 'a.png' }, { src: 'b.png' }, { src: 'c.png' }], { loop: false }))
  assert.equal(timeline.segments.filter((segment) => segment.kind === 'transition').length, 2)
  assert.equal(timeline.segments.at(-1).kind, 'hold')
  assert.equal(timeline.segments.at(-1).toMs, 6000)
})

test('hold weights are relative: 2000/1000/1000 renders as roughly 2:1:1', () => {
  const timeline = buildTimeline(board([
    { src: 'a.png', hold: 2000 },
    { src: 'b.png', hold: 1000 },
    { src: 'c.png', hold: 1000 },
  ]))
  const [a, b, c] = timeline.holds.map((hold) => hold.toMs - hold.fromMs)
  assert.ok(a > b * 1.8 && a < b * 2.2, 'first hold is about twice the second: ' + a + ' vs ' + b)
  assert.equal(b, c)
})

test('unspecified holds get a neutral 1000ms weight, so a 2000ms scene lingers', () => {
  const timeline = buildTimeline(board([
    { src: 'a.png', hold: 2000 },
    { src: 'b.png' },
    { src: 'c.png' },
  ]))
  const holds = timeline.holds.map((hold) => hold.toMs - hold.fromMs)
  assert.equal(holds[1], holds[2], 'both unspecified scenes get the same share')
  assert.ok(holds[0] > holds[1] * 1.7, 'the specified scene is visibly longer: ' + holds.join('/'))
})

test('distributeHolds is exact, respects the floor and is deterministic', () => {
  const cases = [
    { total: 6000, weights: [1, 1, 1], floor: 350 },
    { total: 4999, weights: [3, 1], floor: 350 },
    { total: 1000, weights: [1, 1, 1], floor: 350 },
    { total: 4200, weights: [7, 2, 9, 1], floor: 300 },
    { total: 6000, weights: [0, 0, 0], floor: 350 },
    { total: 12345, weights: [1.5, 2.5, 3], floor: 100 },
  ]
  for (const sample of cases) {
    const shares = distributeHolds(sample.total, sample.weights, sample.floor)
    assert.equal(shares.reduce((a, b) => a + b, 0), sample.total, 'exact sum for ' + JSON.stringify(sample))
    for (const share of shares) {
      assert.ok(share >= Math.min(sample.floor, Math.floor(sample.total / shares.length)), 'floor respected: ' + share)
      assert.ok(Number.isInteger(share), 'integer share')
    }
    assert.deepEqual(distributeHolds(sample.total, sample.weights, sample.floor), shares, 'deterministic')
  }
})

test('sampleAt reports holds, transitions and the loop-closing transition', () => {
  const storyboard = board([{ src: 'a.png' }, { src: 'b.png' }])
  const timeline = buildTimeline(storyboard)
  const atZero = sampleAt(timeline, 0)
  assert.equal(atZero.kind, 'hold')
  assert.equal(atZero.scene, 0)

  const transition = timeline.segments.find((segment) => segment.kind === 'transition')
  const during = sampleAt(timeline, transition.fromMs + (transition.toMs - transition.fromMs) / 2)
  assert.equal(during.kind, 'transition')
  assert.equal(during.from, transition.from)
  assert.equal(during.to, transition.to)
  assert.ok(during.progress > 0.4 && during.progress < 0.6)

  const closing = timeline.segments.at(-1)
  assert.equal(closing.kind, 'transition')
  assert.equal(closing.to, 0, 'the last transition returns to the first scene')
  const nearEnd = sampleAt(timeline, timeline.durationMs - 1)
  assert.equal(nearEnd.kind, 'transition')
  assert.ok(nearEnd.progress > 0.99)
})

test('focus crops are clamped into the image', () => {
  const storyboard = board([{ src: 'a.png', focus: { x: 0.9, y: -0.2, w: 0.5, h: 0.25 } }])
  assert.deepEqual(storyboard.scenes[0].focus, { x: 0.5, y: 0, w: 0.5, h: 0.25 })
})

test('invalid storyboards fail loudly with a prefixed message', () => {
  const cases = [
    [() => normalizeStoryboard({}), /scenes 至少要有一个画面/],
    [() => normalizeStoryboard({ scenes: [] }), /scenes 至少要有一个画面/],
    [() => board([{ src: '' }]), /src 必须是非空字符串/],
    [() => board([{ src: 'a.png', layout: 'bogus' }]), /layout 只能是/],
    [() => board([{ src: 'a.png' }], { durationMs: 100 }), /durationMs 必须在/],
    [() => board([{ src: 'a.png' }], { fps: 5 }), /fps 必须在/],
    [() => board([{ src: 'a.png' }], { theme: { accent: 'red' } }), /theme.accent/],
    [() => board([{ src: 'a.png' }], { transition: 'spin' }), /transition 只能是/],
    [() => board([{ src: 'a.png' }, { src: 'b.png' }], { durationMs: 2000, transitionMs: 1200 }), /transitionMs 太大/],
    [() => board([{ src: 'a.png', focus: { x: 0.5, y: 0.5, w: 0.01, h: 0.5 } }]), /focus 的宽高太小/],
    [() => board(new Array(13).fill({ src: 'a.png' })), /最多 12 个画面/],
  ]
  for (const [run, pattern] of cases) {
    assert.throws(run, (error) => /^\[dsh-readme-reel\]/.test(error.message) && pattern.test(error.message))
  }
})
