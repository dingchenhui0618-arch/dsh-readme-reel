// Compositor: one transparent RGBA canvas per storyboard still, and the
// transition math that turns consecutive stills into a frame at time t.
//
// Layout is deliberately one card, not a collage: a plugin's first screen has
// to read at 320px wide in a marketplace list, so the fewer elements competing
// for attention the better. The card is a soft-shadowed, gently rounded window
// with a neutral chrome bar and a story-progress pill underneath (that pill is
// the only "it is a video" signal, and it works on both light and dark pages
// because it has its own dark backing).
//
// The stills are precomputed once; per-frame work is only blending. That keeps
// a 6-second 30fps render at roughly a second of CPU instead of re-laying-out
// every frame.

import {
  blit,
  color,
  createCanvas,
  cropCanvas,
  crossfade,
  drawSoftShadow,
  easeInOutCubic,
  fillCircle,
  fillRect,
  fillRoundedRect,
  maskRoundedCorners,
  resample,
  strokeRoundedRect,
} from './raster.js'
import { sampleAt } from './storyboard.js'

export const CARD_RADIUS = 14
const CHROME_RATIO = 0.052
const BOTTOM_RESERVE = 34
const DOT_RADIUS = 4
const PILL_HEIGHT = 14
const SEGMENT_WIDTH = 16
const SEGMENT_HEIGHT = 3
const SEGMENT_GAP = 6

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Pure geometry for one still: where the card sits, how big the content is.
 * Exported so tests can pin the layout without touching pixels.
 */
export function layoutCard(storyboard, sourceWidth, sourceHeight, layout) {
  const width = storyboard.size.width
  const height = storyboard.size.height
  const effectiveLayout = layout || storyboard.layout
  const gutter = clamp(Math.round(width * 0.045), 18, 56)
  const chromeH = effectiveLayout === 'window' ? clamp(Math.round(height * CHROME_RATIO), 22, 42) : 0
  const availableWidth = width - gutter * 2
  const availableHeight = height - gutter * 2 - BOTTOM_RESERVE
  const scale = Math.min(
    availableWidth / sourceWidth,
    (availableHeight - chromeH) / sourceHeight,
    1,
  )
  const contentWidth = Math.max(2, Math.round(sourceWidth * scale))
  const contentHeight = Math.max(2, Math.round(sourceHeight * scale))
  const cardWidth = contentWidth
  const cardHeight = contentHeight + chromeH
  const cardX = Math.round((width - cardWidth) / 2)
  const cardY = Math.round((height - BOTTOM_RESERVE - cardHeight) / 2)
  return {
    gutter: gutter,
    chromeH: chromeH,
    scale: scale,
    contentWidth: contentWidth,
    contentHeight: contentHeight,
    cardWidth: cardWidth,
    cardHeight: cardHeight,
    cardX: cardX,
    cardY: cardY,
    radius: CARD_RADIUS,
  }
}

function sourceFor(scene, source) {
  if (!scene.focus) return source
  const x = Math.round(scene.focus.x * source.width)
  const y = Math.round(scene.focus.y * source.height)
  const w = Math.max(2, Math.round(scene.focus.w * source.width))
  const h = Math.max(2, Math.round(scene.focus.h * source.height))
  return cropCanvas(source, x, y, w, h)
}

function drawChrome(card, storyboard, geometry) {
  const { cardWidth, chromeH } = geometry
  const theme = storyboard.theme
  if (chromeH <= 0) return
  fillRect(card, 0, 0, cardWidth, chromeH, color(theme.chrome, 1))
  // A hairline instead of a heavy border: at 320px a 2px line is already loud.
  fillRect(card, 0, chromeH - 1, cardWidth, 1, color(theme.border, 0.09))
  const cy = chromeH / 2
  const dot = color(theme.border, 0.28)
  fillCircle(card, 18, cy, DOT_RADIUS, dot)
  fillCircle(card, 34, cy, DOT_RADIUS, dot)
  fillCircle(card, 50, cy, DOT_RADIUS, dot)
}

function drawProgress(canvas, storyboard, geometry, index, total) {
  if (total < 1) return
  const theme = storyboard.theme
  const count = total
  const segmentsWidth = count * SEGMENT_WIDTH + (count - 1) * SEGMENT_GAP
  const pillWidth = segmentsWidth + 16
  const pillX = Math.round((canvas.width - pillWidth) / 2)
  const pillY = Math.round(geometry.cardY + geometry.cardHeight + 12)
  if (pillY + PILL_HEIGHT > canvas.height) return
  fillRoundedRect(canvas, pillX, pillY, pillWidth, PILL_HEIGHT, PILL_HEIGHT / 2, color(theme.chrome, 0.62))
  const trackY = pillY + (PILL_HEIGHT - SEGMENT_HEIGHT) / 2
  for (let i = 0; i < count; i += 1) {
    const x = pillX + 8 + i * (SEGMENT_WIDTH + SEGMENT_GAP)
    const active = i === index
    fillRoundedRect(
      canvas,
      x,
      trackY,
      SEGMENT_WIDTH,
      SEGMENT_HEIGHT,
      SEGMENT_HEIGHT / 2,
      active ? color(theme.accent, 1) : color(theme.border, 0.3),
    )
  }
}

/**
 * Render one still: `source` is a decoded PNG {width,height,data}. `index`
 * is the scene position, used by the progress pill. Deterministic: identical
 * inputs produce identical bytes, which the tests rely on.
 */
export function renderStill(storyboard, scene, source, index, total) {
  const image = sourceFor(scene, source)
  const geometry = layoutCard(storyboard, image.width, image.height, scene.layout)
  const canvas = createCanvas(storyboard.size.width, storyboard.size.height)

  drawSoftShadow(
    canvas,
    { x: geometry.cardX, y: geometry.cardY, width: geometry.cardWidth, height: geometry.cardHeight, radius: geometry.radius },
    { alpha: 0.4, blur: 30, offsetY: 12, color: color(storyboard.theme.shadow, 1) },
  )

  const card = createCanvas(geometry.cardWidth, geometry.cardHeight)
  fillRect(card, 0, 0, geometry.cardWidth, geometry.cardHeight, color(storyboard.theme.content, 1))
  const content = resample(image, geometry.contentWidth, geometry.contentHeight)
  blit(card, content, 0, geometry.chromeH)
  if (scene.layout === 'window') drawChrome(card, storyboard, geometry)
  // Rounded corners are applied to the assembled card, so the screenshot's own
  // square corners never poke out and the chrome bar shares the same radius.
  maskRoundedCorners(card, geometry.radius)
  strokeRoundedRect(card, 0.5, 0.5, geometry.cardWidth - 1, geometry.cardHeight - 1, geometry.radius, color(storyboard.theme.border, 0.14), 1)
  blit(canvas, card, geometry.cardX, geometry.cardY)

  drawProgress(canvas, storyboard, geometry, index, total)
  return canvas
}

/** Premultiplied-safe horizontal slide used by the 'slide-left' transition. */
function slide(canvasWidth, canvasHeight, from, to, progress) {
  const out = createCanvas(canvasWidth, canvasHeight)
  const eased = easeInOutCubic(progress)
  const offset = Math.round(canvasWidth * eased)
  // Outgoing still slides left and fades slightly; incoming enters from the right.
  blit(out, from, -offset, 0, 1 - eased * 0.35)
  blit(out, to, canvasWidth - offset, 0)
  return out
}

/**
 * Frame at tMs. Holds return their precomputed still unchanged; transitions
 * blend two stills. A t past the last segment clamps to the final still so a
 * looping encoder never needs a special last frame.
 */
export function renderFrame(storyboard, timeline, stills, tMs) {
  const sample = sampleAt(timeline, tMs)
  if (sample.kind === 'hold') return stills[sample.scene]
  if (sample.type === 'cut') return stills[sample.progress < 0.5 ? sample.from : sample.to]
  if (sample.type === 'slide-left') {
    return slide(storyboard.size.width, storyboard.size.height, stills[sample.from], stills[sample.to], sample.progress)
  }
  return crossfade(stills[sample.from], stills[sample.to], easeInOutCubic(sample.progress), storyboard.size.width, storyboard.size.height)
}

/** Renders every still once. `sources[i]` is the decoded image for scene i. */
export function renderStills(storyboard, sources) {
  return storyboard.scenes.map(function (scene, index) {
    return renderStill(storyboard, scene, sources[index], index, storyboard.scenes.length)
  })
}
