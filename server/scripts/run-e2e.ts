import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const node = Bun.which('node')
if (!node) throw new Error('Browser tests require Node.js for the pinned Playwright CLI.')
const command = [node, require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)]

const child = Bun.spawn(command, {
  cwd: fileURLToPath(new URL('../..', import.meta.url)),
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit'
})
const interrupt = (): void => { child.kill('SIGINT') }
const terminate = (): void => { child.kill('SIGTERM') }
process.once('SIGINT', interrupt)
process.once('SIGTERM', terminate)
try {
  process.exitCode = await child.exited
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', terminate)
}
