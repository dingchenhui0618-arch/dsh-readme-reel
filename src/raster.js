// Software raster: the compositor's only drawing surface.
//
// The reel is built as a transparent canvas per still: a card with a soft
// shadow, the screenshot, window chrome and a progress indicator. Everything
// below is straight-alpha "source over", which matches what the PNG encoder
// expects and what ffmpeg's yuva420p encoder wants — no premultiplied detour.
//
// No text rendering on purpose. The screenshots already carry the product's
// type; burning extra glyphs into a 6-second loop makes it look like an ad, and
// a bundled 5x7 bitmap font cannot render the Chinese captions this project's
// own README needs. The reel is punctuation for the first screen, not a poster.

export function createCanvas(width, height) {
  return { width: width, height: height, data: new Uint8ClampedArray(width * height * 4) }
}

export function cloneCanvas(source) {
  return { width: source.width, height: source.height, data: new Uint8ClampedArray(source.data) }
}

/** Parse '#rrggbb' (or '#rgb') plus a 0..1 alpha into {r,g,b,a(0..255)}. */
export function color(hex, alpha = 1) {
  if (typeof hex !== 'string') throw new Error('[dsh-readme-reel] colour must be a hex string, got ' + typeof hex)
  let text = hex.trim().replace(/^#/, '')
  if (text.length === 3) text = text[0] + text[0] + text[1] + text[1] + text[2] + text[2]
  if (!/^[0-9a-fA-F]{6}$/.test(text)) throw new Error('[dsh-readme-reel] invalid colour "' + hex + '"')
  return {
    r: parseInt(text.slice(0, 2), 16),
    g: parseInt(text.slice(2, 4), 16),
    b: parseInt(text.slice(4, 6), 16),
    a: Math.max(0, Math.min(255, Math.round(alpha * 255))),
  }
}

/** Source-over one straight-alpha pixel into `data` at byte offset `i`. */
export function blendPixel(data, i, r, g, b, a) {
  if (a <= 0) return
  if (a >= 255) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
    return
  }
  const sa = a / 255
  const da = data[i + 3] / 255
  const outA = sa + da * (1 - sa)
  if (outA <= 0) {
    data[i] = 0
    data[i + 1] = 0
    data[i + 2] = 0
    data[i + 3] = 0
    return
  }
  const inv = da * (1 - sa)
  data[i] = Math.round((r * sa + data[i] * inv) / outA)
  data[i + 1] = Math.round((g * sa + data[i + 1] * inv) / outA)
  data[i + 2] = Math.round((b * sa + data[i + 2] * inv) / outA)
  data[i + 3] = Math.round(outA * 255)
}

export function fillRect(canvas, x, y, width, height, col) {
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(canvas.width, Math.round(x + width))
  const y1 = Math.min(canvas.height, Math.round(y + height))
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      blendPixel(canvas.data, (py * canvas.width + px) * 4, col.r, col.g, col.b, col.a)
    }
  }
}

/** Signed distance from a point to a rounded rectangle (negative inside). */
export function roundedRectSdf(px, py, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  const cx = x + width / 2
  const cy = y + height / 2
  const qx = Math.abs(px - cx) - (width / 2 - r)
  const qy = Math.abs(py - cy) - (height / 2 - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function coverage(distance) {
  return Math.max(0, Math.min(1, 0.5 - distance))
}

export function fillRoundedRect(canvas, x, y, width, height, radius, col) {
  const x0 = Math.max(0, Math.floor(x - 1))
  const y0 = Math.max(0, Math.floor(y - 1))
  const x1 = Math.min(canvas.width, Math.ceil(x + width + 1))
  const y1 = Math.min(canvas.height, Math.ceil(y + height + 1))
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const cov = coverage(roundedRectSdf(px + 0.5, py + 0.5, x, y, width, height, radius))
      if (cov <= 0) continue
      blendPixel(canvas.data, (py * canvas.width + px) * 4, col.r, col.g, col.b, Math.round(col.a * cov))
    }
  }
}

/** Antialiased 1px-ish outline: outer coverage minus inner coverage. */
export function strokeRoundedRect(canvas, x, y, width, height, radius, col, strokeWidth = 1) {
  const x0 = Math.max(0, Math.floor(x - 2))
  const y0 = Math.max(0, Math.floor(y - 2))
  const x1 = Math.min(canvas.width, Math.ceil(x + width + 2))
  const y1 = Math.min(canvas.height, Math.ceil(y + height + 2))
  const inner = strokeWidth
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const cx = px + 0.5
      const cy = py + 0.5
      const outer = coverage(roundedRectSdf(cx, cy, x, y, width, height, radius))
      const inset = coverage(roundedRectSdf(cx, cy, x + inner, y + inner, width - inner * 2, height - inner * 2, Math.max(0, radius - inner)))
      const cov = Math.max(0, outer - inset)
      if (cov <= 0.004) continue
      blendPixel(canvas.data, (py * canvas.width + px) * 4, col.r, col.g, col.b, Math.round(col.a * cov))
    }
  }
}

export function fillCircle(canvas, cx, cy, radius, col) {
  const x0 = Math.max(0, Math.floor(cx - radius - 1))
  const y0 = Math.max(0, Math.floor(cy - radius - 1))
  const x1 = Math.min(canvas.width, Math.ceil(cx + radius + 1))
  const y1 = Math.min(canvas.height, Math.ceil(cy + radius + 1))
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const dx = px + 0.5 - cx
      const dy = py + 0.5 - cy
      const cov = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy)))
      if (cov <= 0) continue
      blendPixel(canvas.data, (py * canvas.width + px) * 4, col.r, col.g, col.b, Math.round(col.a * cov))
    }
  }
}

/** Blit `src` over `dst` at an integer offset; alphaScale multiplies the source alpha. */
export function blit(dst, src, dx, dy, alphaScale = 1) {
  const ax = Math.round(dx)
  const ay = Math.round(dy)
  const x0 = Math.max(0, ax)
  const y0 = Math.max(0, ay)
  const x1 = Math.min(dst.width, ax + src.width)
  const y1 = Math.min(dst.height, ay + src.height)
  for (let py = y0; py < y1; py += 1) {
    const sy = py - ay
    for (let px = x0; px < x1; px += 1) {
      const sx = px - ax
      const si = (sy * src.width + sx) * 4
      const a = src.data[si + 3] * alphaScale
      if (a <= 0) continue
      blendPixel(dst.data, (py * dst.width + px) * 4, src.data[si], src.data[si + 1], src.data[si + 2], a)
    }
  }
}

/** Multiply the canvas alpha by a rounded-rectangle mask (transparent corners). */
export function maskRoundedCorners(canvas, radius) {
  const { width, height } = canvas
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const cov = coverage(roundedRectSdf(px + 0.5, py + 0.5, 0, 0, width, height, radius))
      if (cov >= 1) continue
      const i = (py * width + px) * 4 + 3
      canvas.data[i] = Math.round(canvas.data[i] * cov)
    }
  }
}

export function cropCanvas(src, x, y, width, height) {
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const w = Math.max(1, Math.min(src.width - x0, Math.round(width)))
  const h = Math.max(1, Math.min(src.height - y0, Math.round(height)))
  const out = createCanvas(w, h)
  for (let py = 0; py < h; py += 1) {
    const srcStart = ((y0 + py) * src.width + x0) * 4
    out.data.set(src.data.subarray(srcStart, srcStart + w * 4), py * w * 4)
  }
  return out
}

/**
 * Resample with a box filter when shrinking and bilinear when enlarging.
 * Screenshots are usually downscaled by 0.4-0.8, where nearest/bilinear both
 * make UI text shimmer; the box filter keeps hairlines calm.
 */
export function resample(src, dstWidth, dstHeight) {
  const w = Math.max(1, Math.round(dstWidth))
  const h = Math.max(1, Math.round(dstHeight))
  if (w === src.width && h === src.height) return cloneCanvas(src)
  const out = createCanvas(w, h)
  const scaleX = src.width / w
  const scaleY = src.height / h
  const box = scaleX > 1.02 || scaleY > 1.02
  for (let py = 0; py < h; py += 1) {
    if (box) {
      const sy0 = py * scaleY
      const sy1 = (py + 1) * scaleY
      const yStart = Math.floor(sy0)
      const yEnd = Math.min(src.height, Math.ceil(sy1))
      for (let px = 0; px < w; px += 1) {
        const sx0 = px * scaleX
        const sx1 = (px + 1) * scaleX
        const xStart = Math.floor(sx0)
        const xEnd = Math.min(src.width, Math.ceil(sx1))
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        let weight = 0
        for (let sy = yStart; sy < yEnd; sy += 1) {
          const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
          if (wy <= 0) continue
          for (let sx = xStart; sx < xEnd; sx += 1) {
            const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
            if (wx <= 0) continue
            const wgt = wx * wy
            const si = (sy * src.width + sx) * 4
            r += src.data[si] * wgt
            g += src.data[si + 1] * wgt
            b += src.data[si + 2] * wgt
            a += src.data[si + 3] * wgt
            weight += wgt
          }
        }
        const di = (py * w + px) * 4
        if (weight > 0) {
          out.data[di] = Math.round(r / weight)
          out.data[di + 1] = Math.round(g / weight)
          out.data[di + 2] = Math.round(b / weight)
          out.data[di + 3] = Math.round(a / weight)
        }
      }
    } else {
      const fy = (py + 0.5) * scaleY - 0.5
      const y0 = Math.max(0, Math.floor(fy))
      const y1 = Math.min(src.height - 1, y0 + 1)
      const wy = fy - y0
      for (let px = 0; px < w; px += 1) {
        const fx = (px + 0.5) * scaleX - 0.5
        const x0 = Math.max(0, Math.floor(fx))
        const x1 = Math.min(src.width - 1, x0 + 1)
        const wx = fx - x0
        const di = (py * w + px) * 4
        for (let c = 0; c < 4; c += 1) {
          const p00 = src.data[(y0 * src.width + x0) * 4 + c]
          const p10 = src.data[(y0 * src.width + x1) * 4 + c]
          const p01 = src.data[(y1 * src.width + x0) * 4 + c]
          const p11 = src.data[(y1 * src.width + x1) * 4 + c]
          const top = p00 + (p10 - p00) * wx
          const bottom = p01 + (p11 - p01) * wx
          out.data[di + c] = Math.round(top + (bottom - top) * wy)
        }
      }
    }
  }
  return out
}

/** Draw a soft drop shadow for a rounded rect, offset downward. */
export function drawSoftShadow(canvas, rect, options = {}) {
  const alpha = options.alpha === undefined ? 0.42 : options.alpha
  const blur = options.blur === undefined ? 26 : options.blur
  const offsetY = options.offsetY === undefined ? 12 : options.offsetY
  const offsetX = options.offsetX === undefined ? 0 : options.offsetX
  const col = options.color || { r: 0, g: 0, b: 0, a: 255 }
  const sigma = Math.max(1, blur / 2)
  const x = rect.x + offsetX
  const y = rect.y + offsetY
  const x0 = Math.max(0, Math.floor(x - blur * 2))
  const y0 = Math.max(0, Math.floor(y - blur * 2))
  const x1 = Math.min(canvas.width, Math.ceil(x + rect.width + blur * 2))
  const y1 = Math.min(canvas.height, Math.ceil(y + rect.height + blur * 2))
  const twoSigmaSq = 2 * sigma * sigma
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const d = roundedRectSdf(px + 0.5, py + 0.5, x, y, rect.width, rect.height, rect.radius || 0)
      const outside = Math.max(0, d)
      const falloff = Math.exp(-(outside * outside) / twoSigmaSq)
      const inside = d < 0 ? 1 : 0
      const a = Math.max(0, Math.min(1, falloff)) * alpha
      if (a <= 0.002) continue
      blendPixel(canvas.data, (py * canvas.width + px) * 4, col.r, col.g, col.b, Math.round(255 * a * (inside === 1 ? 1 : 1)))
    }
  }
}

/**
 * Crossfade two straight-alpha canvases at progress t (0 = a, 1 = b).
 * Interpolating in premultiplied space keeps the semi-transparent shadow and
 * antialiased edges from darkening mid-transition.
 */
export function crossfade(a, b, t, width = a.width, height = a.height) {
  const out = createCanvas(width, height)
  const p = Math.max(0, Math.min(1, t))
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const di = (py * width + px) * 4
      const ai = (py * a.width + px) * 4
      const bi = (py * b.width + px) * 4
      const wa = 1 - p
      const aa = a.data[ai + 3] / 255
      const ba = b.data[bi + 3] / 255
      const outA = aa * wa + ba * p
      if (outA <= 0) continue
      out.data[di] = Math.round((a.data[ai] * aa * wa + b.data[bi] * ba * p) / outA)
      out.data[di + 1] = Math.round((a.data[ai + 1] * aa * wa + b.data[bi + 1] * ba * p) / outA)
      out.data[di + 2] = Math.round((a.data[ai + 2] * aa * wa + b.data[bi + 2] * ba * p) / outA)
      out.data[di + 3] = Math.round(outA * 255)
    }
  }
  return out
}

export function easeInOutCubic(t) {
  const p = Math.max(0, Math.min(1, t))
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
}

export function easeOutCubic(t) {
  const p = Math.max(0, Math.min(1, t))
  return 1 - Math.pow(1 - p, 3)
}
