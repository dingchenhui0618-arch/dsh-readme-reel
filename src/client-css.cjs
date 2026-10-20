// Stylesheet for the 首屏短片 panel.
//
// Exported as one plain CSS string; scripts/build.mjs inlines it into the client
// bundle, so the shipped client carries no relative require of its own.
//
// House rules (same as dsh-warden): every colour comes from a DSH theme token
// (--dsw-alias-*) or from color-mix() against currentColor / a token. No
// hard-coded background or text hex anywhere, so the panel inherits light and
// dark themes instead of fighting them. 13px base, 8px radii, hairline borders.

module.exports = [
  // shell ------------------------------------------------------------------
  '.rr-root{display:flex;flex-direction:column;gap:14px;padding:16px;height:100%;overflow:auto;color:inherit;font-size:13px;line-height:1.5}',
  '.rr-body{display:flex;flex-direction:column;gap:14px}',
  '.rr-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.rr-heading{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}',
  '.rr-title{font-size:15px;font-weight:600}',
  '.rr-sub{opacity:.6;font-size:12px}',
  '.rr-spacer{flex:1}',
  // buttons ----------------------------------------------------------------
  '.rr-btn{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1.6;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}',
  '.rr-btn:hover:enabled{background:color-mix(in srgb,currentColor 8%,transparent)}',
  '.rr-btn:disabled{opacity:.45;cursor:default}',
  '.rr-btn-primary{background:var(--dsw-alias-brand-primary,color-mix(in srgb,currentColor 88%,transparent));border-color:transparent;color:var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base,currentColor));font-weight:600;padding:3px 14px}',
  '.rr-btn-primary:hover:enabled{background:color-mix(in srgb,var(--dsw-alias-brand-primary,currentColor) 88%,currentColor)}',
  // messages ---------------------------------------------------------------
  '.rr-err{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,currentColor) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,currentColor) 8%,transparent);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
  '.rr-warn{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,currentColor) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,currentColor) 8%,transparent);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:3px}',
  '.rr-warn-title{font-size:12px;font-weight:600;color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,currentColor) 88%,currentColor)}',
  '.rr-warn-text{font-size:11px;opacity:.7;line-height:1.55}',
  '.rr-loading{opacity:.6;font-size:12px;border:1px dashed color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;padding:14px}',
  '.rr-ok-note{display:flex;align-items:center;gap:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,currentColor) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,currentColor) 8%,transparent);border-radius:8px;padding:7px 10px;font-size:12px}',
  '.rr-check{color:var(--dsw-alias-state-success-primary,currentColor);font-weight:700}',
  // build progress ---------------------------------------------------------
  '.rr-note{border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 14%,transparent));border-radius:8px;padding:8px 10px;font-size:12px}',
  '.rr-note-line{display:flex;align-items:center;gap:8px;font-weight:600;font-size:12px}',
  '.rr-note-line::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,currentColor);animation:rr-pulse 1.2s ease-in-out infinite}',
  '.rr-note-sub{font-size:11px;opacity:.55;margin-top:5px}',
  '.rr-progress{position:relative;height:3px;margin:8px 0 2px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,currentColor 10%,transparent)}',
  '.rr-progress::after{content:"";position:absolute;top:0;bottom:0;left:0;width:36%;border-radius:999px;background:color-mix(in srgb,currentColor 55%,transparent);animation:rr-slide 1.15s ease-in-out infinite}',
  // status strip -----------------------------------------------------------
  '.rr-status{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}',
  '.rr-stat{min-width:0;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 14%,transparent));border-radius:8px;padding:8px 10px}',
  '.rr-stat b{display:block;font-size:14px;font-weight:600;line-height:1.35;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.rr-stat span{display:block;margin-top:1px;font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.rr-stat.rr-bad b{color:var(--dsw-alias-state-error-primary,currentColor)}',
  '.rr-paths{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:4px 16px}',
  '.rr-path{display:flex;align-items:baseline;gap:8px;min-width:0}',
  '.rr-path-k{flex:none;font-size:11px;opacity:.5}',
  '.rr-mono{min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  // sections ---------------------------------------------------------------
  '.rr-sec{display:flex;flex-direction:column;gap:8px}',
  '.rr-sec-head{display:flex;align-items:baseline;gap:8px}',
  '.rr-sec-title{margin:0;font-size:12px;font-weight:600;opacity:.75;letter-spacing:.02em}',
  '.rr-sec-count{font-size:11px;opacity:.5;font-variant-numeric:tabular-nums}',
  '.rr-empty{display:flex;flex-direction:column;gap:4px;border:1px dashed var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));border-radius:8px;padding:12px;font-size:12px}',
  '.rr-empty b{font-weight:600;font-size:12px;opacity:.8}',
  '.rr-empty span{opacity:.55}',
  '.rr-empty .rr-mono{opacity:.7;font-size:11px;white-space:normal;word-break:break-all}',
  // shot grid --------------------------------------------------------------
  '.rr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}',
  '.rr-shot{display:flex;flex-direction:column;gap:7px;min-width:0;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 14%,transparent));border-radius:8px;padding:7px}',
  '.rr-thumb{position:relative;overflow:hidden;aspect-ratio:16/10;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 8%,transparent);background:color-mix(in srgb,currentColor 5%,transparent)}',
  '.rr-thumb-img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}',
  '.rr-shot.rr-off .rr-thumb-img{opacity:.4}',
  '.rr-shot.rr-off .rr-name{opacity:.5}',
  '.rr-idx{position:absolute;left:6px;top:6px;min-width:18px;padding:1px 5px;border-radius:5px;text-align:center;font-size:10px;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-overlay,color-mix(in srgb,var(--dsw-alias-bg-base,currentColor) 82%,transparent));color:var(--dsw-alias-label-secondary,inherit);border:1px solid var(--dsw-alias-border-l1,transparent)}',
  '.rr-pick{display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer;font-size:12px}',
  '.rr-pick input{margin:0;flex:none;accent-color:var(--dsw-alias-brand-primary,currentColor)}',
  '.rr-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.85}',
  '.rr-shot-foot{display:flex;align-items:center;justify-content:space-between;gap:6px}',
  '.rr-size{font-size:10px;opacity:.5;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.rr-order-btns{display:flex;gap:3px}',
  '.rr-mini{display:inline-flex;align-items:center;justify-content:center;width:22px;height:20px;padding:0;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:1;cursor:pointer}',
  '.rr-mini:hover:enabled{background:color-mix(in srgb,currentColor 8%,transparent)}',
  '.rr-mini:disabled{opacity:.3;cursor:default}',
  // outputs ----------------------------------------------------------------
  '.rr-out{display:flex;flex-wrap:wrap;align-items:stretch;gap:12px}',
  '.rr-stage{position:relative;flex:1 1 320px;min-width:0;min-height:150px;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 14%,transparent));border-radius:8px;padding:10px;background-image:conic-gradient(color-mix(in srgb,currentColor 6%,transparent) 25%,transparent 0 50%,color-mix(in srgb,currentColor 6%,transparent) 0 75%,transparent 0);background-size:16px 16px}',
  '.rr-video{display:block;width:100%;max-height:300px;object-fit:contain;border-radius:4px}',
  '.rr-gif{display:block;max-width:100%;max-height:300px;border-radius:4px}',
  '.rr-stage-tag{position:absolute;right:8px;bottom:8px;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-overlay,color-mix(in srgb,var(--dsw-alias-bg-base,currentColor) 82%,transparent));color:var(--dsw-alias-label-secondary,inherit);border:1px solid var(--dsw-alias-border-l1,transparent)}',
  '.rr-out-side{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:10px}',
  '.rr-files{display:flex;flex-direction:column;gap:6px}',
  '.rr-file{display:flex;align-items:baseline;gap:8px;min-width:0;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:6px;padding:5px 8px;font-size:11px}',
  '.rr-file-k{flex:none;opacity:.5}',
  '.rr-file-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.8}',
  '.rr-file-v{flex:none;font-variant-numeric:tabular-nums;opacity:.7}',
  '.rr-file-missing .rr-file-v{opacity:.4}',
  '.rr-cover-row{display:flex;align-items:center;gap:10px;min-width:0;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;padding:8px}',
  '.rr-cover{display:block;height:52px;width:auto;max-width:45%;border-radius:4px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,currentColor 5%,transparent);object-fit:contain}',
  '.rr-cover-missing{display:flex;align-items:center;justify-content:center;width:88px;height:52px;opacity:.45;font-size:11px}',
  '.rr-cover-meta{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.rr-cover-meta .rr-mono{opacity:.8}',
  '.rr-copy{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}',
  '.rr-copy-fail{font-size:11px;color:var(--dsw-alias-state-error-primary,currentColor)}',
  '.rr-snippet{box-sizing:border-box;width:100%;margin:0;padding:6px 8px;max-height:86px;overflow:auto;border:1px solid color-mix(in srgb,currentColor 10%,transparent);border-radius:6px;background:color-mix(in srgb,currentColor 4%,transparent);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:1.5;opacity:.7;white-space:pre-wrap;word-break:break-all;user-select:text;cursor:text}',
  // motion -----------------------------------------------------------------
  '@keyframes rr-slide{0%{left:-36%}100%{left:100%}}',
  '@keyframes rr-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
  '@media (prefers-reduced-motion:reduce){.rr-progress::after{animation:none;width:100%;opacity:.4}.rr-note-line::before{animation:none;opacity:.6}}',
].join('\n')
