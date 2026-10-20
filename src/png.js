// Minimal PNG codec: decode 8-bit non-interlaced PNG into straight-alpha RGBA,
// encode RGBA into an 8-bit RGBA PNG.
//
// Why hand-rolled: the plugin promises zero runtime dependencies and must run
// in a Node process with nothing installed. PNG is zlib + a handful of chunk
// headers, and `node:zlib` already ships the hard part. The encoder is also the
// hot path of the reel build (one PNG per still per frame group), so keeping it
// here means the pipeline has no binary dependency except ffmpeg at the very
// end, where it is unavoidable.
//
// Scope, deliberately narrow: bit depth 8, no interlace, colour types 0/2/3/4/6.
// Anything else throws a named error instead of silently producing wrong
// pixels — a screenshot pipeline that quietly corrupts alpha is worse than one
// that refuses a file.

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

let crcTable = null

function table() {
  if (crcTable !== null) return crcTable
  crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  return crcTable
}

function crc32(buffer) {
  const t = table()
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = t[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

export class PngError extends Error {
  constructor(message) {
    super('[dsh-readme-reel] ' + message)
    this.name = 'PngError'
  }
}

export function isPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false
  for (let i = 0; i < 8; i += 1) if (buffer[i] !== SIGNATURE[i]) return false
  return true
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

/**
 * Decode a PNG buffer into { width, height, data } where data is a
 * Uint8ClampedArray of straight-alpha RGBA pixels.
 */
export function decodePng(buffer) {
  if (!isPng(buffer)) throw new PngError('not a PNG file (bad signature)')

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let transparency = null
  const idat = []

  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) throw new PngError('truncated PNG chunk ' + type)
    const data = buffer.subarray(start, end)

    if (type === 'IHDR') {
      if (length < 13) throw new PngError('short IHDR')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }

  if (width === 0 || height === 0) throw new PngError('PNG has no IHDR dimensions')
  if (bitDepth !== 8) throw new PngError('unsupported PNG bit depth ' + bitDepth + ' (only 8-bit is supported)')
  if (interlace !== 0) throw new PngError('interlaced PNG is not supported; re-export the screenshot non-interlaced')
  const channels = CHANNELS[colorType]
  if (channels === undefined) throw new PngError('unsupported PNG colour type ' + colorType)
  if (colorType === 3 && palette === null) throw new PngError('palette PNG without a PLTE chunk')
  if (idat.length === 0) throw new PngError('PNG has no image data')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const expected = (stride + 1) * height
  if (raw.length < expected) throw new PngError('PNG image data is shorter than its header claims')

  const rows = filterRows(raw, width, height, channels)
  const out = new Uint8ClampedArray(width * height * 4)

  if (colorType === 3) {
    const entries = palette.length / 3
    for (let y = 0; y < height; y += 1) {
      const row = rows[y]
      for (let x = 0; x < width; x += 1) {
        const index = row[x]
        const i = (y * width + x) * 4
        if (index < entries) {
          out[i] = palette[index * 3]
          out[i + 1] = palette[index * 3 + 1]
          out[i + 2] = palette[index * 3 + 2]
          out[i + 3] = transparency !== null && index < transparency.length ? transparency[index] : 255
        }
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const row = rows[y]
      for (let x = 0; x < width; x += 1) {
        const s = x * channels
        const d = (y * width + x) * 4
        if (colorType === 0) {
          out[d] = row[s]
          out[d + 1] = row[s]
          out[d + 2] = row[s]
          out[d + 3] = 255
        } else if (colorType === 2) {
          out[d] = row[s]
          out[d + 1] = row[s + 1]
          out[d + 2] = row[s + 2]
          out[d + 3] = 255
        } else if (colorType === 4) {
          out[d] = row[s]
          out[d + 1] = row[s]
          out[d + 2] = row[s]
          out[d + 3] = row[s + 1]
        } else {
          out[d] = row[s]
          out[d + 1] = row[s + 1]
          out[d + 2] = row[s + 2]
          out[d + 3] = row[s + 3]
        }
      }
    }
  }

  return { width, height, data: out }
}

function filterRows(raw, width, height, channels) {
  const stride = width * channels
  const rows = new Array(height)
  let pos = 0
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const type = raw[pos]
    pos += 1
    const row = new Uint8Array(stride)
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x]
      const a = x >= channels ? row[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (type === 0) row[x] = value
      else if (type === 1) row[x] = (value + a) & 0xff
      else if (type === 2) row[x] = (value + b) & 0xff
      else if (type === 3) row[x] = (value + ((a + b) >> 1)) & 0xff
      else if (type === 4) row[x] = (value + paeth(a, b, c)) & 0xff
      else throw new PngError('unknown PNG filter type ' + type)
    }
    rows[y] = row
    prev = row
    pos += stride
  }
  return rows
}

/**
 * Encode { width, height, data } (RGBA) into a PNG buffer.
 *
 * `level` is the zlib level: UI screenshots are flat and compress well, but
 * the reel build writes many frames, so 6 is a better time/size trade than 9.
 */
export function encodePng(image, options = {}) {
  const { width, height, data } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngError('invalid PNG dimensions ' + width + 'x' + height)
  }
  const expect = width * height * 4
  if (!data || data.length !== expect) {
    throw new PngError('RGBA buffer is ' + (data ? data.length : 0) + ' bytes, expected ' + expect)
  }
  const level = options.level === undefined ? 6 : options.level
  const stride = width * 4
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    const srcStart = y * stride
    for (let x = 0; x < stride; x += 1) raw[rowStart + 1 + x] = data[srcStart + x]
  }

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const chunks = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]
  return Buffer.concat(chunks)
}

function chunk(type, data) {
  const head = Buffer.allocUnsafe(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.allocUnsafe(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
