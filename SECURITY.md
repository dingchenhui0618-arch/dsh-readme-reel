# 安全模型 / Security model

这份文档说明 **dsh-readme-reel** 信任什么、读哪些文件、把什么命令跑起来、产物写到哪里。
内容从实现（`src/reel.js`、`src/encode.js`、`src/host.js`、`src/cli.js`）读出来；
**文档与代码不一致时以代码为准，那说明这份文档需要更新。**

> 一句话：它是一个**本地文件 → ffmpeg → 本地文件**的转换器。边界不在「谁能调用它」，
> 而在「它只读被指向的项目目录里的 PNG、只往输出目录的四个固定文件名写」。
> 它不联网、不收集遥测，也没有自己的鉴权。

## 信任边界

插件跑在 DSH 宿主进程里（`src/host.js` 的 `apply(ctx)`），另有一个独立 CLI（`bin/reel.mjs`）；
两者共用同一条管线（`buildReel`）。对外表面只有一块：

| 表面 | 谁连进来 | 鉴权 |
| --- | --- | --- |
| DSH web server 上的 `/dsh-readme-reel` 前缀路由 | 本机打开 DSH Web GUI 的浏览器；以及任何能访问该 web server 的人 | **无。** 没有 token、没有 CSRF 校验；边界完全依赖 DSH web server 自己的监听范围 |

**视为不可信输入**：

- `POST /dsh-readme-reel/build` 的 JSON 请求体（`sources`、`durationMs`、`title`）；
- `GET /dsh-readme-reel/shot?path=` 的查询参数；
- 项目里的 `docs/storyboard.json`、`docs/shots/*.png` 与 `--sources` 指向的 PNG；
- `ffmpeg` 可执行文件本身（它按路径被发现并执行，见下）。

## 读什么

- **截图**：storyboard 里的每个 `src`，或 `docs/shots/*.png`（只认 `.png`，按文件名排序）。
  `decodeSource()` 先做一次 `isInside(projectDir, path)` 检查，不在项目目录内直接拒绝。
- **storyboard**：默认 `<project>/docs/storyboard.json`；解析失败、schema 不合法都以
  `ReelError` 报错，不会带着半个 storyboard 继续跑。
- **插件自己的 `package.json`**：只读 `version` 用于写清单。
- **不读**：`node_modules`、用户主目录、环境变量里的其他内容（除下面列出的 ffmpeg 路径）、
  网络。`src/` 里没有任何 HTTP 客户端。

## 符号链接：检查是「字面路径」的，不是真实路径

`isInside()`（`src/reel.js`）只比较 `resolve()` 之后的字符串前缀，**没有 `realpath`**。
后果照实说：

1. 项目目录里一个指向外部的**符号链接 PNG**会被 `readFile` 跟随并读出来——
   也就是说「只读项目目录」防的是手滑写错路径，不防有人故意在仓库里放链接；
2. 输出目录如果本身是指向别处的符号链接，产物会写到链接目标里；
3. Windows 上的路径比较是大小写敏感的（`toPosix(resolve())` 后逐字符比较），
   这只会让合法路径被误拒，不会放宽边界。

## 写什么、覆盖什么

默认输出目录 `<project>/docs/reel`（`--out` / 插件配置可改）。会写：

| 路径 | 行为 |
| --- | --- |
| `reel.webm` / `reel.gif` / `cover.png` | ffmpeg 带 `-y`，**直接覆盖同名文件，不备份、不询问** |
| `reel.json` | `writeFile` 覆盖 |
| `.frames/`（输出目录下） | 先 `rm -rf` 再重建帧序列；成功或失败后默认删除，`--keep-frames` 保留 |
| `%TEMP%/dsh-readme-reel-*` | ffmpeg 的 concat 列表；`finally` 里删除 |

**它从不删除输出目录里的其他文件**，也不会写到输出目录之外（除非输出目录是符号链接）。
出错的构建会留下最后一次成功产物不动——清单里的 sha256 是写完后重新读文件算的，
所以不会出现「清单说写成功、文件其实没变」的静默错配。

## 外部命令：只跑 ffmpeg

- 发现顺序：`--ffmpeg` / 配置 → 环境变量 `DSH_README_REEL_FFMPEG` → `PATH` 上的 `ffmpeg`。
- 每个候选都会先 `spawnSync(candidate, ['-version'])`，**只有输出里匹配 `ffmpeg version X`
  才被采用**；一个存在但跑不起来的路径会被跳过，而不是让插件整体失败。
- 真正编码用 `spawn(ffmpegPath, args, { env: process.env })`，**不经 shell**，参数是固定数组；
  路径通过 concat demuxer 文件传入并做单引号转义。
- 这意味着：能给这个插件指定 ffmpeg 路径的人，就能让宿主进程执行那个二进制。
  该路径来自插件配置 / CLI 参数 / 环境变量，**不来自模型或 HTTP 请求体**。

## HTTP 路由做了什么（`src/host.js`）

- 请求体上限 **1 MiB**，超了 `req.destroy()`；不是合法 JSON 就当作 `{}`。
- `GET /state`、`POST /scan` 返回项目路径、截图列表、manifest、上次构建结果。
- `POST /build` 只接受 `sources` / `durationMs` / `title`；`sources` 仍是**项目目录内**的相对
  或绝对路径，越界会被 `decodeSource` 拒绝。同一时刻只允许一个构建在飞（`inflight` 去重）。
- `GET /asset?name=` 只认四个白名单文件名（`OUTPUT_NAMES`），其余 404。
- `GET /shot?path=` 只提供 `projectDir` 内、扩展名为 `.png` 的文件；URI 解码失败返回 400。

**没有鉴权的后果**：任何能访问 DSH web server 的人都能触发一次构建（写上面那四个文件）
或读取项目里的 PNG。这是本机工具的取舍，不是遗漏——但如果你把 DSH 的端口暴露到公网，
它就等于一个「用你的 CPU 跑 ffmpeg」的入口。

## 已知限制

1. **构建是 CPU/磁盘密集的**：请求没有速率限制，同一时刻只排队一个 build，但一个恶意
   请求可以让机器跑满几十秒。
2. **没有真实路径校验**：见「符号链接」一节。
3. **没有子进程沙箱**：ffmpeg 以宿主进程权限运行，传入的路径与编码参数由本插件构造，
   但 ffmpeg 自身的历史漏洞不在本项目的修复范围内。
4. **文件名固定**：不会为已有产物生成 `.bak`，也不检测「这个目录里已经有人手写的
   `reel.gif`」；覆盖是设计。
5. **bundle 依赖宿主能力**：`host` 半区硬 `inject: ['webServer']`；没有 web server 的宿主上
   插件不会加载（CLI 仍可用）。面板不可用不会影响已生成的文件。
6. **无遥测、无外发请求**：没有任何「检查更新」「上报使用量」的代码。

## 明确不算漏洞

- 覆盖输出目录里同名的 `reel.webm` / `reel.gif` / `cover.png` / `reel.json`（这是它的工作方式）；
- 读取项目目录内的截图、把它们编码进产物（产物本来就是给公开 README 用的）；
- 同机能访问 DSH 端口的人触发构建、读取截图（见上，边界依赖宿主监听范围）；
- 用自己的 ffmpeg 路径替换系统 ffmpeg（这是显式配置能力）；
- 在 `reel.json` / 面板里看到本机绝对路径（清单里输出路径已转成项目相对路径，
  但 `/state` 会返回配置的绝对目录）。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-readme-reel/security/advisories/new>

这是个人维护的项目，**不承诺响应时限**；但会读、会修，修完写进 `CHANGELOG.md`。
请不要把仍在生效的问题先发到公开 issue。

## 支持范围

只维护最新发布版（当前 `0.1.0`，见 `package.json`）。旧版本不回补，升级到最新版即可。
