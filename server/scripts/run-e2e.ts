import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const node = Bun.which('node')
if (!node) throw new Error('Browser tests require Node.js for the pinned Playwright CLI.')
const command = [node, require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)]
const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY
const xvfb = needsDisplay ? Bun.which('xvfb-run') : null
if (needsDisplay && !xvfb) throw new Error('Linux browser tests require xvfb-run for WebKitGTK. Install Xvfb or provide a working DISPLAY.')

const child = Bun.spawn(xvfb ? [xvfb, '--auto-servernum', ...command] : command, {
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
