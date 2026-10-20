#!/usr/bin/env node
// Pre-push audit: the three checks this repo's delivery contract requires,
// automated so they can be re-run instead of remembered.
//
//   1. secret scan        — API keys, tokens, private keys, credentials, DSNs,
//                           machine-specific home paths, and credential-shaped
//                           file names.
//   2. .gitignore check   — the entries without which a push leaks dependencies,
//                           logs or credentials, verified with git check-ignore
//                           when a repository exists.
//   3. stray files        — temp files, editor droppings, debug scripts, build
//                           leftovers and oversized blobs that should never ship.
//
// Any hit exits non-zero: a hit is a stop, not a warning. Only files that would
// actually be pushed are scanned (git ls-files plus untracked, non-ignored
// files), so node_modules and .frames never produce noise.
//
// Usage:
//   node scripts/audit.mjs            human-readable report
//   node scripts/audit.mjs --json     machine-readable report
//   node scripts/audit.mjs --root .   audit another directory

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const BINARY_EXTENSIONS = new Set([
  '.png', '.gif', '.webm', '.jpg', '.jpeg', '.ico', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mp3', '.pdf', '.db', '.sqlite',
])
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt', '.sh', '.ps1', '.html', '.css', '.svg', '.ts', '.tsx', '.jsx', '.gitignore', '.gitattributes', '.env', '.example',
])
const ALLOW_MARKER = 'audit:allow'

export const SECRET_PATTERNS = [
  { id: 'private-key', description: '私钥块', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'github-token', description: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'aws-key', description: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-key', description: 'sk- 风格的 API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', description: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-key', description: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'credential-assignment', description: '明文赋值的密钥/密码', pattern: /\b(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{12,}['"]/i },
  { id: 'connection-string', description: '带密码的连接串', pattern: /\b(?:postgres|postgresql|mysql|mongodb\+srv|mongodb|redis|amqp):\/\/[^\s'"]+:[^\s'"]+@/i },
  { id: 'home-path', description: '本机绝对路径（Windows 用户目录 / Linux home 目录）', pattern: /\b[A-Za-z]:\\+Users\\+[^\\\s'"]+|\/home\/[a-z][a-z0-9_-]+\/|\/Users\/[A-Za-z0-9._-]+\// },
]

const CREDENTIAL_FILES = [
  /^\.env$/i,
  /^\.env\..+/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^credentials(?:\.json|\.ya?ml)?$/i,
]

const STRAY_FILES = [
  /\.(?:tmp|temp|bak|orig|rej|swp|swo|stackdump)$/i,
  /\.log$/i,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^\._/,
  /^_/,
  /^\.?~.+$/,
  /~$/,
  /\.(?:zip|tgz|tar|7z|rar)$/i,
]

export const REQUIRED_GITIGNORE = [
  'node_modules',
  '.env',
  '*.log',
  '.frames',
]

const MAX_FILE_BYTES = 10 * 1024 * 1024

/** Run a command and return stdout, or null when it cannot run. */
function tryExec(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    return null
  }
}

/** Every file that a push would carry, relative to `root` with forward slashes. */
export function listCandidateFiles(root) {
  if (existsSync(join(root, '.git'))) {
    const tracked = tryExec('git', ['ls-files', '-z'], root)
    const untracked = tryExec('git', ['ls-files', '-z', '--others', '--exclude-standard'], root)
    const files = new Set()
    for (const chunk of [tracked, untracked]) {
      if (chunk === null) continue
      for (const entry of chunk.split('\0')) {
        if (entry.length > 0) files.add(entry.split('\\').join('/'))
      }
    }
    return Array.from(files).sort()
  }
  const files = []
  const walk = function (dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(relative(root, path).split('\\').join('/'))
    }
  }
  walk(root)
  return files.sort()
}

function looksBinary(path, sample) {
  const extension = extname(path).toLowerCase()
  if (BINARY_EXTENSIONS.has(extension)) return true
  if (TEXT_EXTENSIONS.has(extension)) return false
  return sample.includes(0)
}

/** Secret hits in one text blob. `file` is only used in the report. */
export function scanText(text, file) {
  const hits = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.includes(ALLOW_MARKER)) continue
    for (const rule of SECRET_PATTERNS) {
      if (rule.pattern.test(line)) {
        hits.push({ file: file, line: index + 1, rule: rule.id, description: rule.description, excerpt: redact(line.trim()) })
      }
    }
  }
  return hits
}

function redact(line) {
  const clipped = line.length > 120 ? line.slice(0, 120) + '…' : line
  return clipped.replace(/[A-Za-z0-9_+/=-]{16,}/g, (match) => match.slice(0, 4) + '…' + match.slice(-2))
}

export function scanFiles(root, files) {
  const hits = []
  for (const file of files) {
    const name = file.split('/').pop()
    for (const pattern of CREDENTIAL_FILES) {
      if (pattern.test(name)) hits.push({ file: file, line: 0, rule: 'credential-file', description: '凭据文件', excerpt: file })
    }
    let info
    try {
      info = statSync(join(root, file))
    } catch (error) {
      continue
    }
    if (!info.isFile()) continue
    if (info.size > MAX_FILE_BYTES) continue
    let buffer
    try {
      buffer = readFileSync(join(root, file))
    } catch (error) {
      continue
    }
    if (looksBinary(file, buffer.subarray(0, 4096))) continue
    hits.push(...scanText(buffer.toString('utf8'), file))
  }
  return hits
}

export function checkGitignore(root) {
  const problems = []
  const path = join(root, '.gitignore')
  const entries = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  const normalized = entries.map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'))
  for (const required of REQUIRED_GITIGNORE) {
    if (!normalized.some((entry) => entry === required || entry.startsWith(required))) {
      problems.push('缺少 .gitignore 条目：' + required)
    }
  }
  if (existsSync(join(root, '.git'))) {
    const samples = ['node_modules/probe.txt', '.env']
    for (const sample of samples) {
      const output = tryExec('git', ['check-ignore', '--no-index', sample], root)
      if (output === null) problems.push('git check-ignore 没有命中 ' + sample)
    }
  }
  return problems
}

export function findStrays(root, files, options = {}) {
  const allowedMedia = options.allowedMedia || /^(docs|examples)\//.test.bind(/^(docs|examples)\//)
  const hits = []
  for (const file of files) {
    const name = file.split('/').pop()
    const matched = STRAY_FILES.find((pattern) => pattern.test(name))
    if (matched !== undefined) {
      hits.push({ file: file, rule: 'stray-name', description: '临时/备份/调试文件', excerpt: file })
      continue
    }
    let info
    try {
      info = statSync(join(root, file))
    } catch (error) {
      continue
    }
    if (info.size > MAX_FILE_BYTES) {
      hits.push({ file: file, rule: 'oversized', description: '超过 10MB 的文件', excerpt: file + ' (' + info.size + ' bytes)' })
    }
    if (!allowedMedia(file) && file.startsWith('docs/') && /\.(?:webm|gif)$/i.test(file) && info.size > 8 * 1024 * 1024) {
      hits.push({ file: file, rule: 'heavy-asset', description: '过大的首屏素材', excerpt: file + ' (' + info.size + ' bytes)' })
    }
  }
  return hits
}

export function audit(options = {}) {
  const root = options.root || process.cwd()
  const files = listCandidateFiles(root)
  const secrets = scanFiles(root, files)
  const gitignore = checkGitignore(root)
  const strays = findStrays(root, files)
  return {
    ok: secrets.length === 0 && gitignore.length === 0 && strays.length === 0,
    root: root,
    filesChecked: files.length,
    steps: {
      secrets: { ok: secrets.length === 0, hits: secrets },
      gitignore: { ok: gitignore.length === 0, problems: gitignore },
      stray: { ok: strays.length === 0, hits: strays },
    },
  }
}

function render(report) {
  const lines = []
  lines.push('dsh-readme-reel 推送前三步检查')
  lines.push('  根目录：' + report.root)
  lines.push('  检查文件数：' + report.filesChecked)
  lines.push('')
  const mark = function (ok) { return ok ? 'PASS' : 'STOP' }
  lines.push('  [' + mark(report.steps.secrets.ok) + '] 1. 密钥/token 扫描  (' + report.steps.secrets.hits.length + ' 条命中)')
  for (const hit of report.steps.secrets.hits) lines.push('      ' + hit.file + ':' + hit.line + '  ' + hit.description + '  ' + hit.excerpt)
  lines.push('  [' + mark(report.steps.gitignore.ok) + '] 2. .gitignore 核对  (' + report.steps.gitignore.problems.length + ' 个问题)')
  for (const problem of report.steps.gitignore.problems) lines.push('      ' + problem)
  lines.push('  [' + mark(report.steps.stray.ok) + '] 3. 无关文件清理  (' + report.steps.stray.hits.length + ' 个文件)')
  for (const hit of report.steps.stray.hits) lines.push('      ' + hit.file + '  ' + hit.description)
  lines.push('')
  lines.push(report.ok ? '结论：通过，可以推送。' : '结论：阻断，不要推送。')
  return lines.join('\n')
}

export function main(argv, io = {}) {
  const stdout = io.stdout || function (text) { process.stdout.write(text + '\n') }
  const stderr = io.stderr || function (text) { process.stderr.write(text + '\n') }
  const args = Array.from(argv)
  if (args.includes('--help') || args.includes('-h')) {
    stdout('用法: node scripts/audit.mjs [--root <dir>] [--json]\n\n推送前三步检查：密钥扫描、.gitignore 核对、无关文件清理。任何命中返回退出码 1。')
    return 0
  }
  const json = args.includes('--json')
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1] : process.cwd()
  const report = audit({ root: root })
  if (json) stdout(JSON.stringify(report, null, 2))
  else stdout(render(report))
  if (!report.ok) stderr('audit: 有命中，停止推送。')
  return report.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
