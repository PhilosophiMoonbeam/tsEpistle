import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanEnvironment } from './local-ci-resources.ts'

const root = path.resolve(import.meta.dir, '../..')
// Bun 1.4.3's native audit loads dotenv even with --no-env-file. Audit only the
// real manifest and lockfile from an empty cwd; audit never modifies either input.
const cwd = mkdtempSync(path.join(tmpdir(), 'tsepistle-ci-audit-'))
let exitSignal: NodeJS.Signals | null = null
try {
  for (const filename of ['package.json', 'bun.lock']) symlinkSync(path.join(root, filename), path.join(cwd, filename))
  const child = spawn(process.execPath, ['--no-env-file', 'audit', '--production'], {
    cwd,
    env: cleanEnvironment(),
    stdio: 'inherit'
  })
  const terminate = (signal: NodeJS.Signals) => child.kill(signal)
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        exitSignal = signal
        resolve(code)
      })
    })
    process.exitCode = code ?? 1
  } finally {
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
  }
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
if (exitSignal) process.kill(process.pid, exitSignal)
