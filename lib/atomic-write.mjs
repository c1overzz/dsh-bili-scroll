import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Replace a small state file in one rename step.
 *
 * State files are read as complete JSON documents. Writing a temporary file
 * beside the target means a forced desktop shutdown leaves either the old
 * document or the new one, never a half-written JSON prefix.
 */
export function writeAtomic(file, value, {
  encoding = 'utf8',
  writeFile = writeFileSync,
  rename = renameSync,
  remove = rmSync,
  makeDir = mkdirSync,
} = {}) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  makeDir(dirname(file), { recursive: true })
  try {
    writeFile(temp, value, encoding)
    try {
      rename(temp, file)
    } catch (error) {
      // Windows can reject replacing an existing file with rename(). The
      // fallback still preserves the important invariant: the target is
      // removed only after the complete temporary document was written.
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error
      remove(file, { force: true })
      rename(temp, file)
    }
  } finally {
    try { remove(temp, { force: true }) } catch { /* cleanup is best effort */ }
  }
}

export function writeJsonAtomic(file, value, options = {}) {
  writeAtomic(file, JSON.stringify(value, null, 2), options)
}
