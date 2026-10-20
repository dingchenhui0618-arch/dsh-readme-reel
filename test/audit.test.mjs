// Pre-push audit tests. The scanner is the last line of defence before a push,
// so it gets the same treatment as the product code: known-bad input must be
// caught, known-good input must not produce noise.

import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  audit,
  checkGitignore,
  findStrays,
  listCandidateFiles,
  REQUIRED_GITIGNORE,
  scanText,
} from '../scripts/audit.mjs'

test('scanText catches GitHub, AWS, Slack and Google style tokens', () => {
  // The fixtures are assembled at runtime, so this file itself stays clean for
  // the very audit it tests: no literal credential-shaped string is committed.
  const text = [
    'const token = "' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123' + '"',
    'aws = ' + 'AKIA' + 'IOSFODNN7EXAMPLE',
    'slack = ' + 'xoxb-' + '123456789012-abcdefghijklm',
    'g = ' + 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv',
  ].join('\n')
  const hits = scanText(text, 'fixture.js')
  const ids = new Set(hits.map((hit) => hit.rule))
  assert.ok(ids.has('github-token'))
  assert.ok(ids.has('aws-key'))
  assert.ok(ids.has('slack-token'))
  assert.ok(ids.has('google-key'))
  for (const hit of hits) {
    assert.equal(hit.file, 'fixture.js')
    assert.ok(hit.line >= 1)
    assert.ok(!hit.excerpt.includes('abcdefghijklmnopqrstuvwxyz0123'), 'excerpt is redacted')
  }
})

test('scanText catches private keys, credential assignments and connection strings', () => {
  const text = [
    '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
    'apiKey: "' + '0123456789abcdef0123456789abcdef' + '"',
    'DATABASE_URL=' + 'postgres://reel:' + 'hunter2' + '@127.0.0.1:5432/app',
  ].join('\n')
  const ids = new Set(scanText(text, 'fixture.md').map((hit) => hit.rule))
  assert.ok(ids.has('private-key'))
  assert.ok(ids.has('credential-assignment'))
  assert.ok(ids.has('connection-string'))
})

test('scanText catches machine-specific home paths', () => {
  const machinePath = 'path: C:' + '\\Users\\' + 'someone\\project\\shot.png'
  const ids = new Set(scanText(machinePath, 'fixture.txt').map((hit) => hit.rule))
  assert.ok(ids.has('home-path'))
  assert.equal(scanText('see docs/shots and docs/reel', 'clean.md').length, 0)
})

test('the audit:allow marker exempts a line', () => {
  const text = 'const fake = "ghp_abcdefghijklmnopqrstuvwxyz0123" // audit:allow'
  assert.equal(scanText(text, 'fixture.js').length, 0)
})

test('checkGitignore reports each missing required entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audit-ignore-'))
  await writeFile(join(root, '.gitignore'), 'node_modules/\n*.log\n')
  const problems = checkGitignore(root)
  assert.equal(problems.length, REQUIRED_GITIGNORE.length - 2)
  assert.ok(problems.some((problem) => problem.includes('.env')))
  assert.ok(problems.some((problem) => problem.includes('.frames')))

  await writeFile(join(root, '.gitignore'), REQUIRED_GITIGNORE.map((entry) => entry + '/').join('\n'))
  assert.deepEqual(checkGitignore(root), [])
})

test('findStrays flags temp files, debug scripts and oversized blobs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audit-strays-'))
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'normal.md'), '# ok\n')
  await writeFile(join(root, 'notes.tmp'), 'x')
  await writeFile(join(root, '_smoke.mjs'), 'x')
  await writeFile(join(root, 'backup~'), 'x')
  await writeFile(join(root, 'docs', 'reel.webm'), Buffer.alloc(64))
  const files = listCandidateFiles(root)
  const hits = findStrays(root, files)
  const names = hits.map((hit) => hit.file)
  assert.ok(names.includes('notes.tmp'))
  assert.ok(names.includes('_smoke.mjs'))
  assert.ok(names.includes('backup~'))
  assert.ok(!names.includes('normal.md'))
  assert.ok(!names.includes('docs/reel.webm'))
})

test('audit passes on a clean tree and stops on a planted secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audit-run-'))
  await writeFile(join(root, '.gitignore'), REQUIRED_GITIGNORE.map((entry) => entry).join('\n'))
  await writeFile(join(root, 'README.md'), '# clean\n\nNothing secret here.\n')
  const clean = audit({ root: root })
  assert.equal(clean.ok, true, JSON.stringify(clean.steps))
  assert.equal(clean.filesChecked >= 2, true)

  // Built at runtime so this fixture is not itself a credential-shaped literal.
  const planted = 'ghp' + '_' + 'abcdefghijklmnopqrstuvwxyz0123'
  await writeFile(join(root, 'config.yml'), 'token: "' + planted + '"\n')
  const dirty = audit({ root: root })
  assert.equal(dirty.ok, false)
  assert.ok(dirty.steps.secrets.hits.some((hit) => hit.file === 'config.yml'))
})
