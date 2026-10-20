#!/usr/bin/env node
// Thin entry point: the real code lives in lib/cli.js (built from src/cli.js),
// so the bin file stays free of logic and can fail clearly when lib/ has not
// been built yet.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'lib', 'cli.js')

if (!existsSync(entry)) {
  process.stderr.write('[dsh-readme-reel] lib/cli.js 不存在，请先运行 `node scripts/build.mjs`\n')
  process.exit(1)
}

const { main } = await import(pathToFileURL(entry).href)
const code = await main(process.argv.slice(2))
process.exit(code)
