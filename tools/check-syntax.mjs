import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const files = [join(root, 'index.js')]
for (const dir of ['lib', 'tools']) {
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (name.endsWith('.mjs')) files.push(join(root, dir, name))
  }
}

const check = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true })
  child.once('error', (error) => resolve({ file, error }))
  child.once('exit', (code, signal) => resolve({ file, code, signal }))
})

for (const file of files) {
  const result = await check(file)
  if (result.error || result.code !== 0) {
    if (result.error) console.error(`${file}: ${result.error.message}`)
    process.exitCode = result.code || 1
    break
  }
}

if (!process.exitCode) console.log(`✓ syntax OK (${files.length} JavaScript modules)`)

