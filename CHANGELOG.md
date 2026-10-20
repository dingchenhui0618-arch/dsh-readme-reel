# Changelog

## 0.1.0

首个版本：把插件仓库的截图排成一条 6 秒无声循环短片。

- **三件产物**：`reel.webm`（VP9 + `yuva420p` 真透明、无音轨、循环）、`reel.gif`（alpha 压平到可配垫底色、640 宽、无限循环）、`cover.png`（停留最长那一幕的原始帧，不重编码），外加 `reel.json` 清单（每幕停留、时间轴、sha256、ffmpeg 版本、耗时）。
- **精确 6 秒**：每幕停留是整数毫秒，`Σ停留 + 转场数 × 转场时长 === durationMs` 由水位分配保证；`loop: true` 时最后一幕转场回第一幕、在 `durationMs` 处正好结束，首尾同帧。
- **零运行时依赖**：PNG 编解码自写（`node:zlib`），排版/合成/时间轴全部自己实现；唯一外部依赖是 ffmpeg，运行时按 `DSH_README_REEL_FFMPEG` → PATH 的顺序发现，找不到就明确报错。
- **storyboard.json**：时长/帧率/画幅/循环/转场/垫底色/主题色/每幕停留权重与 `focus` 裁切；不给文件时按 `docs/shots/*.png` 文件名顺序自动排版。
- **对话视图「首屏短片」面板**：ffmpeg 状态、分镜来源、素材缩略图与排序、一键生成、webm 预览 + gif + 封面 + 「复制 Markdown」；主题 token 取色，浅色/深色都跟随宿主。
- **CLI**：`dsh-readme-reel [storyboard.json]`，支持 `--sources`、`--json`、`--ffmpeg-check`、`--keep-frames`，退出码 0/1/2。
- **推送前三查脚本**：`node scripts/audit.mjs` 扫密钥样式、核对 `.gitignore`、找临时/大文件。
- 110 个测试（`node --test`）：有 ffmpeg 全绿；没有 ffmpeg 时 16 个编码用例 skip、其余 94 个全绿。
