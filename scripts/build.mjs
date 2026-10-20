#!/usr/bin/env node
// Dependency-free build.
//
// The host half is plain ESM whose only imports are `node:` builtins and its
// own sibling modules, so copying src/ into lib/ is a complete build: no
// bundler, no devDependency that can fail to install.
//
// The client half is CommonJS loaded through window.__ModuleLoader__ with a
// harness-provided require(), so it may not carry a relative require of its
// own. The single relative require (the stylesheet) is inlined below, and the
// build fails loudly if that require ever changes shape.
//
// lib/ is committed, exactly like dsh-warden's, so `git diff --exit-code -- lib`
// is a meaningful packaging check in CI.

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapClient } from './wrap-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// host.js becomes index.js; its sibling ESM modules keep their names.
const entries = await readdir(join(root, 'src'))
const hostModules = entries.filter((file) => file.endsWith('.js')).sort()
if (!hostModules.includes('host.js')) throw new Error('src/host.js is missing')
for (const file of hostModules) {
  const target = file === 'host.js' ? 'index.js' : file
  await copyFile(join(root, 'src', file), join(out, target))
}

const cssModule = await import(pathToFileURL(join(root, 'src', 'client-css.cjs')).href)
const css = cssModule.default
if (typeof css !== 'string' || css.length === 0) {
  throw new Error('src/client-css.cjs did not export a non-empty CSS string')
}

const clientSource = await readFile(join(root, 'src', 'client.cjs'), 'utf8')
const CSS_REQUIRE = /require\((['"])\.\/client-css\.cjs\1\)/
if (!CSS_REQUIRE.test(clientSource)) {
  throw new Error('src/client.cjs no longer requires ./client-css.cjs — update scripts/build.mjs')
}

const bundle = wrapClient(clientSource.replace(CSS_REQUIRE, JSON.stringify(css)), pkg.name)
await writeFile(join(out, 'client.js'), bundle)

// Compile the client bundle and import the host module: a broken build fails
// here rather than in the browser, where the error is much harder to read.
new Function(bundle)
const host = await import(pathToFileURL(join(out, 'index.js')).href)
if (host.name !== pkg.name || typeof host.apply !== 'function') {
  throw new Error('invalid host plugin export: expected name "' + pkg.name + '" and an apply() function')
}
if (!Array.isArray(host.inject)) {
  throw new Error('invalid host plugin export: inject must be an array')
}

console.log('Built ' + pkg.name + ' ' + pkg.version + ': lib/index.js and lib/client.js')
