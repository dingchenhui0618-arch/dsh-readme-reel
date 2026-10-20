// Raster primitives tests. These are the pieces that make transparency,
// antialiasing and transitions correct, and they are cheap to pin exactly.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  blit,
  blendPixel,
  color,
  createCanvas,
  cropCanvas,
  crossfade,
  drawSoftShadow,
  easeInOutCubic,
  fillRect,
  fillRoundedRect,
  maskRoundedCorners,
  resample,
  roundedRectSdf,
} from '../src/raster.js'

function pixel(canvas, x, y) {
  const i = (y * canvas.width + x) * 4
  return Array.from(canvas.data.slice(i, i + 4))
}

test('colour parsing accepts short and long hex and rejects garbage', () => {
  assert.deepEqual(color('#fff', 1), { r: 255, g: 255, b: 255, a: 255 })
  assert.deepEqual(color('#7aa2ff', 0.5), { r: 122, g: 162, b: 255, a: 128 })
  assert.throws(() => color('rebeccapurple'), /invalid colour/)
  assert.throws(() => color(123), /hex string/)
})

test('source-over blending matches the straight-alpha formula', () => {
  const data = new Uint8ClampedArray([10, 20, 30, 255])
  blendPixel(data, 0, 200, 100, 0, 128)
  assert.ok(Math.abs(data[0] - 105) <= 1, 'red mixed: ' + data[0])
  assert.ok(Math.abs(data[1] - 60) <= 1, 'green mixed: ' + data[1])
  assert.equal(data[3], 255)

  const clear = new Uint8ClampedArray([0, 0, 0, 0])
  blendPixel(clear, 0, 10, 20, 30, 128)
  assert.deepEqual(Array.from(clear), [10, 20, 30, 128], 'blending over nothing keeps the straight colour')
})

test('fillRoundedRect antialiases its corners and fills its centre', () => {
  const canvas = createCanvas(24, 24)
  fillRoundedRect(canvas, 0, 0, 24, 24, 8, color('#ffffff', 1))
  assert.equal(pixel(canvas, 0, 0)[3], 0, 'corner stays transparent')
  assert.equal(pixel(canvas, 23, 23)[3], 0, 'opposite corner stays transparent')
  assert.equal(pixel(canvas, 12, 12)[3], 255, 'centre is opaque')
  assert.ok(pixel(canvas, 2, 2)[3] > 0 && pixel(canvas, 2, 2)[3] < 255, 'corner pixel is partially covered')
})

test('maskRoundedCorners punches transparent corners out of a filled canvas', () => {
  const canvas = createCanvas(20, 20)
  fillRect(canvas, 0, 0, 20, 20, color('#112233', 1))
  maskRoundedCorners(canvas, 6)
  assert.equal(pixel(canvas, 0, 0)[3], 0)
  assert.equal(pixel(canvas, 10, 10)[3], 255)
})

test('roundedRectSdf is negative inside, zero on the edge and positive outside', () => {
  assert.ok(roundedRectSdf(10, 10, 0, 0, 20, 20, 4) < 0)
  assert.ok(Math.abs(roundedRectSdf(20, 10, 0, 0, 20, 20, 4)) < 0.001)
  assert.ok(roundedRectSdf(25, 10, 0, 0, 20, 20, 4) > 0)
})

test('resample averages 2x2 blocks when shrinking', () => {
  const src = createCanvas(2, 2)
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      const i = (y * 2 + x) * 4
      const value = x === 0 && y === 0 ? 0 : 200
      src.data[i] = value
      src.data[i + 1] = value
      src.data[i + 2] = value
      src.data[i + 3] = 255
    }
  }
  const out = resample(src, 1, 1)
  assert.equal(out.width, 1)
  const value = out.data[0]
  assert.ok(Math.abs(value - 150) <= 2, 'average of 0,200,200,200 is 150: ' + value)
})

test('resample enlarges with bilinear sampling and keeps alpha', () => {
  const src = createCanvas(2, 1)
  src.data.set([0, 0, 0, 255, 255, 255, 255, 255])
  const out = resample(src, 4, 2)
  assert.equal(out.width, 4)
  assert.equal(out.height, 2)
  assert.equal(pixel(out, 0, 0)[3], 255)
  assert.equal(pixel(out, 3, 1)[3], 255)
})

test('blit respects offsets, clipping and alpha scaling', () => {
  const dst = createCanvas(4, 4)
  const src = createCanvas(2, 2)
  fillRect(src, 0, 0, 2, 2, color('#ffffff', 1))
  blit(dst, src, -1, 1)
  assert.equal(pixel(dst, 0, 1)[3], 255, 'clipped blit still lands')
  assert.equal(pixel(dst, 3, 3)[3], 0)
  const faded = createCanvas(4, 4)
  blit(faded, src, 0, 0, 0.5)
  assert.equal(pixel(faded, 0, 0)[3], 128)
})

test('crossfade hits its endpoints exactly and blends alpha in between', () => {
  const a = createCanvas(2, 1)
  const b = createCanvas(2, 1)
  a.data.set([255, 0, 0, 255, 0, 0, 0, 0])
  b.data.set([0, 0, 255, 255, 0, 0, 0, 0])
  assert.deepEqual(Array.from(crossfade(a, b, 0).data), Array.from(a.data))
  assert.deepEqual(Array.from(crossfade(a, b, 1).data), Array.from(b.data))
  const mid = crossfade(a, b, 0.5)
  const [r, g, bl, al] = Array.from(mid.data.slice(0, 4))
  assert.ok(r > 120 && r < 135, 'red half: ' + r)
  assert.ok(bl > 120 && bl < 135, 'blue half: ' + bl)
  assert.equal(al, 255)
  assert.equal(mid.data[7], 0, 'transparent stays transparent')
})

test('easings hit 0 and 1 and stay monotonic', () => {
  assert.equal(easeInOutCubic(0), 0)
  assert.equal(easeInOutCubic(1), 1)
  assert.equal(easeInOutCubic(0.5), 0.5)
  let previous = -1
  for (let i = 0; i <= 20; i += 1) {
    const value = easeInOutCubic(i / 20)
    assert.ok(value >= previous)
    previous = value
  }
})

test('soft shadow fades with distance and does not tint far pixels', () => {
  const canvas = createCanvas(120, 90)
  drawSoftShadow(canvas, { x: 40, y: 20, width: 40, height: 30, radius: 6 }, { alpha: 0.5, blur: 10, offsetY: 4 })
  assert.ok(pixel(canvas, 60, 40)[3] > 100, 'shadow under the rect is visible')
  assert.ok(pixel(canvas, 60, 40)[3] < pixel(canvas, 60, 45)[3] + 200)
  assert.equal(pixel(canvas, 119, 0)[3], 0, 'far corner untouched')
})

test('cropCanvas copies the requested rectangle', () => {
  const src = createCanvas(4, 4)
  fillRect(src, 2, 2, 2, 2, color('#00ff00', 1))
  const out = cropCanvas(src, 2, 2, 2, 2)
  assert.equal(out.width, 2)
  assert.deepEqual(pixel(out, 0, 0), [0, 255, 0, 255])
})
