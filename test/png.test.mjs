// PNG codec tests. The encoder is only half the story: the decoder has to
// survive the PNGs real tools produce, so the filter and palette paths are
// pinned here with hand-built files rather than only our own round-trip.

import { strict as assert } from 'node:assert'
import { deflateSync } from 'node:zlib'
import test from 'node:test'
import { decodePng, encodePng, isPng, PngError } from '../src/png.js'

function chunk(type, data) {
  const head = Buffer.allocUnsafe(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const table = (() => {
    const values = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      values[n] = c
    }
    return values
  })()
  let crc = -1
  const body = Buffer.concat([head.subarray(4), data])
  for (let i = 0; i < body.length; i += 1) crc = table[(crc ^ body[i]) & 0xff] ^ (crc >>> 8)
  const trailer = Buffer.allocUnsafe(4)
  trailer.writeUInt32BE((crc ^ -1) >>> 0, 0)
  return Buffer.concat([head, data, trailer])
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function pngFromChunks(ihdr, extra, raw) {
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function ihdr(width, height, bitDepth, colorType) {
  const data = Buffer.allocUnsafe(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data[8] = bitDepth
  data[9] = colorType
  data[10] = 0
  data[11] = 0
  data[12] = 0
  return data
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

test('encode -> decode round-trips RGBA including partial alpha', () => {
  const width = 7
  const height = 5
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (i * 37) % 256
    data[i * 4 + 1] = (i * 91) % 256
    data[i * 4 + 2] = (i * 13) % 256
    data[i * 4 + 3] = i % 3 === 0 ? 0 : i % 5 === 0 ? 128 : 255
  }
  const buffer = encodePng({ width, height, data })
  assert.ok(isPng(buffer))
  const decoded = decodePng(buffer)
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assert.deepEqual(Array.from(decoded.data), Array.from(data))
})

test('encode refuses a buffer that does not match its dimensions', () => {
  assert.throws(
    () => encodePng({ width: 4, height: 4, data: new Uint8ClampedArray(10) }),
    (error) => error instanceof PngError && /expected 64/.test(error.message),
  )
})

test('decode refuses a file that is not a PNG', () => {
  assert.throws(() => decodePng(Buffer.from('GIF89a....')), /bad signature/)
})

test('decode refuses 16-bit and interlaced PNGs with a clear message', () => {
  const deep = pngFromChunks(ihdr(1, 1, 16, 6), [], [0])
  assert.throws(() => decodePng(deep), /bit depth 16/)
  const interlaced = ihdr(1, 1, 8, 6)
  interlaced[12] = 1
  assert.throws(() => decodePng(pngFromChunks(interlaced, [], [0, 0, 0, 0, 0])), /interlaced/)
})

test('decode handles every PNG row filter, not just the one our encoder writes', () => {
  const width = 3
  const height = 5
  const channels = 3
  const stride = width * channels
  const raw = []
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(stride)
    for (let x = 0; x < stride; x += 1) row[x] = (y * 40 + x * 17) % 256
    raw.push(row)
  }
  const scanlines = []
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5
    const row = raw[y]
    const filtered = new Uint8Array(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let predictor = 0
      if (filter === 0) predictor = 0
      else if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else predictor = paeth(a, b, c)
      filtered[x] = (row[x] - predictor) & 0xff
    }
    scanlines.push(filter, ...filtered)
    prev = row
  }
  const buffer = pngFromChunks(ihdr(width, height, 8, 2), [], scanlines)
  const decoded = decodePng(buffer)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      assert.equal(decoded.data[at], raw[y][x * 3], 'red at ' + x + ',' + y)
      assert.equal(decoded.data[at + 1], raw[y][x * 3 + 1])
      assert.equal(decoded.data[at + 2], raw[y][x * 3 + 2])
      assert.equal(decoded.data[at + 3], 255)
    }
  }
})

test('decode expands palette PNGs and their tRNS alpha', () => {
  const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])
  const trns = Buffer.from([255, 128, 0])
  const raw = [0, 0, 1, 0, 2, 2]
  const buffer = pngFromChunks(ihdr(2, 2, 8, 3), [chunk('PLTE', palette), chunk('tRNS', trns)], raw)
  const decoded = decodePng(buffer)
  assert.deepEqual(Array.from(decoded.data.slice(0, 4)), [255, 0, 0, 255])
  assert.deepEqual(Array.from(decoded.data.slice(4, 8)), [0, 255, 0, 128])
  assert.deepEqual(Array.from(decoded.data.slice(8, 12)), [0, 0, 255, 0])
})

test('decode expands grey PNGs to opaque RGBA', () => {
  const buffer = pngFromChunks(ihdr(2, 1, 8, 0), [], [0, 40, 200])
  const decoded = decodePng(buffer)
  assert.deepEqual(Array.from(decoded.data), [40, 40, 40, 255, 200, 200, 200, 255])
})
