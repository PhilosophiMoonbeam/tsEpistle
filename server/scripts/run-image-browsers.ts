import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { capture, stopOwnedPhases, writeJson } from './local-ci-resources.ts'

const root = path.resolve(import.meta.dir, '../..')
const state = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state'), 'tsepistle-ci')
process.umask(0o077)
process.chdir(root)
const revision = capture(['git', 'rev-parse', 'HEAD'])
if (process.env.WIKI_BUILD_REVISION !== revision) throw new Error('Browser source revision mismatch.')
const namespace = `tsepistle-ci-local-${revision.slice(0, 7)}-${process.pid}-${randomBytes(2).toString('hex')}`
const artifacts = process.env.WIKI_LOCAL_CI_ARTIFACTS
if (!artifacts || !path.isAbsolute(artifacts)) throw new Error('An absolute browser artifact directory is required.')
await fs.mkdir(artifacts, { mode: 0o700 })
await writeJson(path.join(artifacts, 'owner.json'), { revision, namespace, workspace: root })
await fs.mkdir(state, { recursive: true, mode: 0o700 })
const child = spawn('flock', ['--nonblock', '--no-fork', '--conflict-exit-code', '75', path.join(state, 'ci.lock'), process.execPath, path.join(root, 'server/scripts/local-ci-resources.ts'), 'run', '--name', 'browsers', '--host-gib', '6', '--docker-gib', '3', '--', 'bash', 'dev/e2e/local-run.sh'], {
  cwd: root,
  env: {
    ...process.env,
    WIKI_TEST_NAMESPACE: namespace,
    WIKI_LOCAL_CI_BROWSER_JOBS: '1',
    WIKI_LOCAL_CI_PHASE_RUNNER: path.join(root, 'server/scripts/local-ci-resources.ts'),
    WIKI_CI_APP_MEMORY: '2g',
    WIKI_CI_POSTGRES_MEMORY: '1g'
  },
  stdio: 'inherit'
})
const terminate = (signal: NodeJS.Signals) => child.kill(signal)
process.once('SIGINT', terminate)
process.once('SIGTERM', terminate)
try {
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
  })
} finally {
  process.removeListener('SIGINT', terminate)
  process.removeListener('SIGTERM', terminate)
  await stopOwnedPhases(artifacts, namespace)
}
