// Internal interface contract for dsh-readme-reel.
//
// This file is the seam between the three halves of the plugin. It is the
// source of truth for shapes that cross a file boundary (pipeline -> encoder,
// host -> client), and it is intentionally written before the code so the
// halves can be built in parallel without inventing incompatible shapes.
//
// It is not user documentation and it is not part of the npm package.

# dsh-readme-reel — internal contract

## What the plugin does

Input: a folder of screenshots (or a storyboard JSON) taken from a plugin
repository. Output: three files, always the same three:

    <outDir>/reel.webm    6s, silent, VP9 + alpha (pix_fmt yuva420p), loops
    <outDir>/reel.gif     same timeline, matted, loops
    <outDir>/cover.png    one frame, transparency kept
    <outDir>/reel.json    manifest: sizes, sha256, timeline, ffmpeg version

The pipeline is split at one seam:

    src/reel.js   builds the timeline, renders frames (PNG files) with
    src/compose.js / src/raster.js, then calls src/encode.js to encode those
    frames into the three outputs with ffmpeg.

## Frame rendering seam (owner: Lead)

`src/reel.js` exports `buildReel(options) -> manifest`. It writes
`frame-0000.png ... frame-(n-1).png` into a temporary frames directory (unless
`keepFrames`), hands their absolute paths in play order to the encoder, and
removes the directory afterwards. Frames are 8-bit RGBA PNG, non-interlaced,
straight alpha (NOT premultiplied). Fully transparent pixels are `[0,0,0,0]`.

`src/compose.js` exports `renderStills(storyboard, sources)` (one composed
canvas per scene) and `renderFrame(storyboard, timeline, stills, tMs)` (the
canvas at a given millisecond), so the layout is testable without ffmpeg.

## Encoder seam (owner: reel-encode)

`src/encode.js` exports exactly these two functions.

### locateFfmpeg

    locateFfmpeg(options) -> Promise<{ path: string, version: string, source: 'explicit'|'env'|'path' } | null>

- `options.explicit`: a path to an ffmpeg binary, or to a directory that
  contains one, or a bare command name. Authoritative when usable.
- `options.env`: environment object, defaults to `process.env`. The variable
  is `DSH_README_REEL_FFMPEG`.
- fallback: `ffmpeg` resolved through `options.env.PATH`.
- Verification is always "run it and parse `-version`", never `existsSync`.
  Anything that fails to run or does not print `ffmpeg version X` is not
  ffmpeg and must be skipped, not thrown.
- Never throws. Returns null when nothing usable was found.

### encodeReel

    encodeReel(options) -> Promise<{
      webm:  { path: string, bytes: number },
      gif:   { path: string, bytes: number },
      cover: { path: string, bytes: number },
      ffmpegVersion: string,
    }>

Options:

- `frames: string[]` — absolute PNG paths, play order, length >= 2.
- `outDir: string` — created if missing.
- `width, height: number` — frame size in pixels.
- `fps: number` — frame rate of the input sequence, e.g. 30.
- `ffmpegPath: string` — from locateFfmpeg.
- `gif`: `{ enabled?: boolean, width?: number, matte?: string, fps?: number }`
  defaults `{ enabled: true, width: 640, matte: '#0b0e14', fps: 20 }`.
  The gif is matted: alpha is flattened onto `matte` so the 1-bit transparency
  of GIF does not eat the antialiased edges. Height is derived from `width`
  and the frame aspect ratio (rounded to even).
- `webm`: `{ crf?: number }` default `{ crf: 34 }`.
- `coverFrame`: index into `frames`, default `Math.floor(frames.length * 0.4)`.
  `buildReel` passes the first frame of the longest hold instead, so a reel's
  cover shows the scene that stays on screen longest.
- `log`: `(line: string) => void`, optional.

Outputs land at `<outDir>/reel.webm`, `<outDir>/reel.gif`, `<outDir>/cover.png`.
`cover.png` is byte-identical to the selected input frame.

The webm command must produce transparent VP9:

    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf <crf> -row-mt 1 -an

Everything must be silent (`-an`) and loop cleanly: `-loop 0` for the gif;
webm/mkv loop by consumer, and the timeline itself is loop-safe (Lead's job).

`probe(file, ffmpegPath)` is also exported for tests and the host half:

    probe(file, ffmpegPath) -> Promise<{ width, height, durationMs, codec, pixFmt, frames }>

Implement it with `ffmpeg -hide_banner -i <file>` and parse stderr; do not
require ffprobe to exist.

Failure: throw an `Error` whose message starts with `[dsh-readme-reel]` and
includes the last lines of ffmpeg's stderr. Callers show it to the user.

## HTTP seam (owner: Lead, consumed by reel-ui)

Base path: `/dsh-readme-reel`. Every response is JSON except asset/shot bytes.

### GET /dsh-readme-reel/state

    {
      ok: true,
      projectDir: string,
      outDir: string,
      ffmpeg: { found: boolean, version: string|null, source: string|null },
      storyboard: {
        source: 'file'|'auto',
        path: string|null,
        title: string,
        durationMs: number,
        fps: number,
        size: { width: number, height: number },
        scenes: Array<{ src: string, hold: number|null, layout: string }>
      } | null,
      shots: Array<{ path: string, url: string, bytes: number }>,
      outputs: { webm|null, gif|null, cover|null }  // { path, url, bytes, sha256, width?, height?, durationMs? }
      lastBuild: { at: number, ms: number, ok: boolean, error: string|null } | null
    }

### POST /dsh-readme-reel/scan
Body `{}`. Re-scans the shots folder. Returns the same shape as state.

### POST /dsh-readme-reel/build
Body: `{ sources?: string[], durationMs?: number, title?: string }`.
`{ sources: [] }` means "no build"; a missing `sources` means "all shots in
storyboard order". Returns `{ ok: true, manifest, state }` or
`{ ok: false, error }` with HTTP 200 (the panel renders the message).
A build is serialised: a second concurrent POST joins the in-flight build
instead of starting a second ffmpeg.

### GET /dsh-readme-reel/asset?name=reel.webm|reel.gif|cover.png|reel.json
Serves a file from `outDir`. Only those four names are addressable.

### GET /dsh-readme-reel/shot?path=<relative path under projectDir>
Serves one source PNG for the panel's thumbnails. Must reject any resolved
path that escapes `projectDir`.

## Host plugin shape (owner: Lead)

`src/host.js` exports `name`, `inject = ['webServer']`, `apply(ctx, config)`.
Every registration is unwound on unload (route disposer returned via
`ctx.effect`). If `webServer.register` throws, the plugin still loads and the
panel is simply absent — the same containment rule as dsh-warden.

Config (all optional):
`{ projectDir, outDir, shotsDir, storyboardPath, readmePath, ffmpegPath }`.

Defaults: `projectDir = process.cwd()`, `shotsDir = <projectDir>/docs/shots`,
`outDir = <projectDir>/docs/reel`, `storyboardPath = <projectDir>/docs/storyboard.json`,
`readmePath = <projectDir>/README.md`.

## Client half (owner: reel-ui)

`src/client.cjs` — CommonJS, React provided as `require('react')`, stylesheet
inlined by the build from `src/client-css.cjs`. Registers one
`conversation.view` slot with id `readme-reel`, order 40, label `首屏短片`.
Same teardown discipline as dsh-warden: every registration has a disposer and
a failed slot registration degrades the panel only.

Panel must show: host/ffmpeg status, storyboard scenes, shot thumbnails,
build button, the three outputs (video preview + gif + cover), and the
copy-to-clipboard markdown snippet. No hard-coded colours — theme tokens and
`color-mix(in srgb, currentColor …)` only.

## Rules that are not negotiable

- Zero runtime dependencies. No npm package may be imported except `node:*`.
- `node --test` green on a machine with no ffmpeg (encoder tests skip).
- No secrets, no absolute machine paths, no `~/.dsh` content in the repo.
- Every file this plugin writes stays under the configured `outDir` or a temp
  directory it removes.
