import { spawn } from 'node:child_process'
import path from 'node:path'
import { cleanEnvironment } from './local-ci-resources.ts'

// Reuse the complete ordinary contract, but never operational or browser matrices.
const child = spawn(process.execPath, ['--no-env-file', 'run', 'ci'], {
  cwd: path.resolve(import.meta.dir, '../..'),
  env: { ...cleanEnvironment(), BUN_OPTIONS: '--no-env-file' },
  stdio: 'inherit'
})
const terminate = (signal: NodeJS.Signals) => child.kill(signal)
process.once('SIGINT', terminate)
process.once('SIGTERM', terminate)
child.once('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.removeListener('SIGINT', terminate)
  process.removeListener('SIGTERM', terminate)
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143)
})
