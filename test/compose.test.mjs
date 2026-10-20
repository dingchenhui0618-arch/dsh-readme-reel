// Compositor tests: geometry, determinism, transparency and the loop seam.
// These are the assertions that stand between "a bunch of PNGs" and "a reel
// that reads as one deliberate object".

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { renderFrame, renderStills, renderStill, layoutCard } from '../src/compose.js'
import { createCanvas, fillRect, color } from '../src/raster.js'
import { buildTimeline, normalizeStoryboard } from '../src/storyboard.js'

function solid(width, height, hex) {
  const canvas = createCanvas(width, height)
  fillRect(canvas, 0, 0, width, height, color(hex, 1))
  return canvas
}

function split(width, height, leftHex, rightHex) {
  const canvas = createCanvas(width, height)
  fillRect(canvas, 0, 0, Math.floor(width / 2), height, color(leftHex, 1))
  fillRect(canvas, Math.floor(width / 2), 0, Math.ceil(width / 2), height, color(rightHex, 1))
  return canvas
}

function pixel(canvas, x, y) {
  const i = (y * canvas.width + x) * 4
  return Array.from(canvas.data.slice(i, i + 4))
}

function storyboardOf(scenes, extra) {
  return normalizeStoryboard(Object.assign({
    title: 'test',
    durationMs: 3000,
    fps: 20,
    size: { width: 480, height: 300 },
    scenes: scenes,
  }, extra || {}))
}

function samePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false
  for (let i = 0; i < a.data.length; i += 1) if (a.data[i] !== b.data[i]) return false
  return true
}

function changedPixels(a, b) {
  let count = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) count += 1
  }
  return count
}

test('layoutCard keeps the card inside the canvas and never upscales', () => {
  const storyboard = storyboardOf([{ src: 'a.png' }])
  const wide = layoutCard(storyboard, 2000, 1200)
  assert.ok(wide.cardX >= 0 && wide.cardY >= 0)
  assert.ok(wide.cardX + wide.cardWidth <= storyboard.size.width)
  assert.ok(wide.cardY + wide.cardHeight <= storyboard.size.height)
  assert.ok(wide.scale <= 1)
  assert.ok(wide.scale > 0)
  const tiny = layoutCard(storyboard, 120, 80)
  assert.equal(tiny.scale, 1, 'a small screenshot is not blown up')
  assert.equal(tiny.cardWidth, 120)
})

test('window layout reserves a chrome bar and plain layout does not', () => {
  const windowed = storyboardOf([{ src: 'a.png' }])
  const plain = storyboardOf([{ src: 'a.png', layout: 'plain' }])
  const win = layoutCard(windowed, 800, 500, 'window')
  const bare = layoutCard(plain, 800, 500, 'plain')
  assert.ok(win.chromeH > 0)
  assert.equal(bare.chromeH, 0)
  assert.ok(win.contentHeight < bare.contentHeight, 'the chrome bar costs content height')
  assert.equal(win.cardHeight, win.contentHeight + win.chromeH)
  assert.equal(bare.cardHeight, bare.contentHeight)
})

test('a still is deterministic and keeps the frame transparent around the card', () => {
  const storyboard = storyboardOf([{ src: 'a.png' }, { src: 'b.png' }])
  const source = solid(1000, 620, '#223344')
  const first = renderStill(storyboard, storyboard.scenes[0], source, 0, 2)
  const second = renderStill(storyboard, storyboard.scenes[0], source, 0, 2)
  assert.ok(samePixels(first, second), 'same input renders identical bytes')

  assert.equal(pixel(first, 0, 0)[3], 0, 'top-left corner is transparent')
  assert.equal(pixel(first, first.width - 1, first.height - 1)[3], 0, 'bottom-right corner is transparent')
  const geometry = layoutCard(storyboard, source.width, source.height)
  const centre = pixel(first, geometry.cardX + Math.round(geometry.cardWidth / 2), geometry.cardY + Math.round(geometry.cardHeight / 2))
  assert.equal(centre[3], 255, 'the card centre is opaque')
})

test('the progress pill is drawn below the card and marks the current scene', () => {
  const storyboard = storyboardOf([{ src: 'a.png' }, { src: 'b.png' }, { src: 'c.png' }])
  const source = solid(1000, 620, '#223344')
  const still = renderStill(storyboard, storyboard.scenes[0], source, 0, 3)
  const geometry = layoutCard(storyboard, source.width, source.height)
  let pillPixels = 0
  let accentPixels = 0
  const accent = color(storyboard.theme.accent, 1)
  for (let y = geometry.cardY + geometry.cardHeight; y < still.height; y += 1) {
    for (let x = 0; x < still.width; x += 1) {
      const [r, g, b, a] = pixel(still, x, y)
      if (a === 0) continue
      pillPixels += 1
      if (a > 200 && Math.abs(r - accent.r) < 12 && Math.abs(g - accent.g) < 12 && Math.abs(b - accent.b) < 12) accentPixels += 1
    }
  }
  assert.ok(pillPixels > 0, 'something is drawn under the card')
  assert.ok(accentPixels > 0, 'the active progress segment uses the accent colour')
})

test('focus crops the screenshot before it is scaled into the card', () => {
  const source = split(1000, 600, '#ff0000', '#0000ff')
  const leftStoryboard = storyboardOf([{ src: 'a.png', focus: { x: 0, y: 0, w: 0.5, h: 1 } }])
  const rightStoryboard = storyboardOf([{ src: 'a.png', focus: { x: 0.5, y: 0, w: 0.5, h: 1 } }])
  const left = renderStill(leftStoryboard, leftStoryboard.scenes[0], source, 0, 1)
  const right = renderStill(rightStoryboard, rightStoryboard.scenes[0], source, 0, 1)
  const leftGeometry = layoutCard(leftStoryboard, 500, 600)
  const probe = function (canvas, geometry) {
    return pixel(canvas, geometry.cardX + Math.round(geometry.cardWidth / 2), geometry.cardY + geometry.chromeH + Math.round(geometry.contentHeight / 2))
  }
  const leftPixel = probe(left, leftGeometry)
  const rightPixel = probe(right, layoutCard(rightStoryboard, 500, 600))
  assert.ok(leftPixel[0] > 200 && leftPixel[2] < 60, 'left crop is red: ' + leftPixel)
  assert.ok(rightPixel[2] > 200 && rightPixel[0] < 60, 'right crop is blue: ' + rightPixel)
})

test('holds reuse the still object and transitions produce new frames', () => {
  const storyboard = storyboardOf([{ src: 'a.png' }, { src: 'b.png' }])
  const sources = [solid(800, 500, '#101010'), solid(800, 500, '#301010')]
  const stills = renderStills(storyboard, sources)
  const timeline = buildTimeline(storyboard)

  const held = renderFrame(storyboard, timeline, stills, 0)
  assert.equal(held, stills[0], 'a hold returns its precomputed still')

  const transition = timeline.segments.find((segment) => segment.kind === 'transition')
  const middle = renderFrame(storyboard, timeline, stills, (transition.fromMs + transition.toMs) / 2)
  assert.notEqual(middle, stills[0])
  assert.notEqual(middle, stills[1])
  assert.ok(changedPixels(middle, stills[0]) > 0)

  const almostDone = renderFrame(storyboard, timeline, stills, transition.toMs - 0.01)
  assert.ok(changedPixels(almostDone, stills[1]) <= 100, 'the transition lands on the next still: ' + changedPixels(almostDone, stills[1]) + ' px off')
  assert.equal(renderFrame(storyboard, timeline, stills, transition.toMs), stills[1], 'exactly at the boundary it is the next hold')
})

test('the loop seam is invisible: frame 0 and the last frame agree', () => {
  const storyboard = storyboardOf([{ src: 'a.png' }, { src: 'b.png' }, { src: 'c.png' }], { durationMs: 6000, fps: 30, size: { width: 960, height: 600 } })
  const sources = [solid(1400, 900, '#101820'), solid(1400, 900, '#182010'), solid(1400, 900, '#201018')]
  const stills = renderStills(storyboard, sources)
  const timeline = buildTimeline(storyboard)
  const first = renderFrame(storyboard, timeline, stills, 0)
  const last = renderFrame(storyboard, timeline, stills, timeline.durationMs - 1)
  const total = first.width * first.height
  const changed = changedPixels(first, last)
  assert.ok(changed / total < 0.01, 'loop seam differs in fewer than 1% of pixels: ' + changed + '/' + total)
})

test('slide-left moves the outgoing still out as the incoming one arrives', () => {
  const storyboard = storyboardOf([{ src: 'a.png' }, { src: 'b.png' }], { transition: 'slide-left', transitionMs: 400, durationMs: 3000 })
  // Full-bleed canvases: the slide math itself is what is under test here, not
  // where the compositor happens to place a card.
  const red = solid(480, 300, '#ff0000')
  const blue = solid(480, 300, '#0000ff')
  const stills = [red, blue]
  const timeline = buildTimeline(storyboard)
  const transition = timeline.segments.find((segment) => segment.kind === 'transition')
  const span = transition.toMs - transition.fromMs
  const early = renderFrame(storyboard, timeline, stills, transition.fromMs + span * 0.2)
  const late = renderFrame(storyboard, timeline, stills, transition.fromMs + span * 0.8)
  const leftEarly = pixel(early, 100, 150)
  const rightEarly = pixel(early, early.width - 3, 150)
  assert.ok(leftEarly[0] > leftEarly[2], 'outgoing red still fills the left early: ' + leftEarly)
  assert.ok(rightEarly[2] > rightEarly[0], 'incoming blue still enters from the right: ' + rightEarly)
  const leftLate = pixel(late, 100, 150)
  const rightLate = pixel(late, late.width - 3, 150)
  assert.ok(leftLate[2] > leftLate[0], 'by the end the blue still has moved left: ' + leftLate)
  assert.ok(rightLate[2] > rightLate[0], 'the blue still covers the right edge at the end')
})

test('frames are reproducible at the same timestamp', () => {
  const storyboard = storyboardOf([{ src: 'a.png' }, { src: 'b.png' }])
  const sources = [solid(800, 500, '#123456'), solid(800, 500, '#654321')]
  const stills = renderStills(storyboard, sources)
  const timeline = buildTimeline(storyboard)
  const a = renderFrame(storyboard, timeline, stills, 1234)
  const b = renderFrame(storyboard, timeline, stills, 1234)
  assert.ok(samePixels(a, b))
})
