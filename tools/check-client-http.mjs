/**
 * Lightweight regression checks for browser request policies.
 * This intentionally avoids a browser or test-framework dependency.
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

const jget = source.match(/const jget = async \(p\) => asJson\(await fetch\(API \+ p, \{[\s\S]*?\n    \}\)\)/)?.[0] || ''
if (!jget.includes("credentials: 'same-origin'")) fail('jget() must keep same-origin credentials')
if (!jget.includes("referrerPolicy: 'no-referrer'")) fail('jget() must suppress Referer')
if (!jget.includes('asJson(await fetch(API + p')) fail('jget() must keep the existing API URL and response parser')
if (!source.includes('if (res.ok) return res.json()')) fail('GET responses must keep the existing success parser')
if (!source.includes("throw new Error('HTTP ' + res.status")) fail('GET non-2xx responses must keep the existing error path')

const jpost = source.match(/const jpost = async \(p, body\) => asJson\(await fetch\(API \+ p, \{[\s\S]*?\n    \}\)\)/)?.[0] || ''
if (!jpost.includes("method: 'POST'")) fail('jpost() must remain a POST')
if (!jpost.includes("credentials: 'same-origin'")) fail('jpost() must keep same-origin credentials')
if (jpost.includes('referrerPolicy')) fail('jpost() must not change its request policy in this fix')

const coverImages = [...source.matchAll(/h\('img', \{[^\n]*src: API \+ '\/cover\?bv='[^\n]*\}\)/g)]
if (coverImages.length !== 2) fail(`expected two plugin cover images, found ${coverImages.length}`)
for (const match of coverImages) {
  if (!match[0].includes("referrerPolicy: 'no-referrer'")) fail('plugin cover images must suppress Referer')
}

if (process.exitCode) process.exit()
console.log('✓ client HTTP regression checks passed')
