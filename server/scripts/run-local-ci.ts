import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { availableMemory, capture, cleanEnvironment, stopOwnedBuilder, stopOwnedPhases, writeJson } from './local-ci-resources.ts'

const root = path.resolve(import.meta.dir, '../..')
const state = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state'), 'tsepistle-ci')
const gib = 1024 ** 3
process.umask(0o077)
process.chdir(root)

type Gate = { name: string; seconds: number; status: 'passed' | 'failed' }
type Options = { browserJobs: 1; testJobs: number }
type Owner = { revision: string; namespace: string; workspace: string; options: Options }

async function execute(command: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string, onFailedExit?: () => Promise<void>): Promise<number> {
  const log = createWriteStream(logFile, { mode: 0o600 })
  const child = spawn(command[0]!, command.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let interrupted = false
  let exitCleanup: Promise<void> | undefined
  let cleanupError: unknown
  const terminate = () => {
    interrupted = true
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  const forward = (output: NodeJS.WriteStream) => (chunk: Buffer) => {
    output.write(chunk)
    log.write(chunk)
  }
  child.once('exit', code => {
    if (code !== 0 && onFailedExit)
      exitCleanup = onFailedExit().catch(error => {
        cleanupError = error
      })
  })
  child.stdout!.on('data', forward(process.stdout))
  child.stderr!.on('data', forward(process.stderr))
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(interrupted || cleanupError ? 130 : (code ?? 1)))
    })
  } finally {
    await exitCleanup
    process.removeListener('SIGINT', terminate)
    process.removeListener('SIGTERM', terminate)
    await new Promise<void>(resolve => log.end(resolve))
  }
}

function assertFreshNamespace(namespace: string): void {
  const containers = capture(['docker', 'ps', '-a', '--format', '{{.Names}}']).split('\n')
  const volumes = capture(['docker', 'volume', 'ls', '--format', '{{.Name}}']).split('\n')
  const networks = capture(['docker', 'network', 'ls', '--format', '{{.Name}}']).split('\n')
  if ([...containers, ...volumes, ...networks].some(name => name.startsWith(`${namespace}-`)))
    throw new Error('Local CI namespace already exists; refusing to adopt its resources.')
}

async function cleanupNamespace(namespace: string): Promise<void> {
  if (!/^tsepistle-ci-local-[a-f0-9]{7}-\d+-[a-f0-9]{4}$/.test(namespace)) throw new Error('Unsafe local CI cleanup namespace.')
  const names = capture(['docker', 'ps', '-a', '--format', '{{.Names}}'])
    .split('\n')
    .filter(name => name.startsWith(`${namespace}-`))
  if (names.length) capture(['docker', 'rm', '--force', '--volumes', ...names])
  for (const kind of ['volume', 'network']) {
    const resources = capture(['docker', kind, 'ls', '--format', '{{.Name}}'])
      .split('\n')
      .filter(name => name.startsWith(`${namespace}-`))
    for (const name of resources) capture(['docker', kind, 'rm', name])
  }
}

async function inside(runDir: string, namespace: string, revision: string): Promise<void> {
  const owner = JSON.parse(await fs.readFile(path.join(runDir, 'owner.json'), 'utf8')) as Owner
  if (
    owner.workspace !== root ||
    owner.namespace !== namespace ||
    owner.revision !== revision ||
    !/^[a-f0-9]{40}$/.test(revision) ||
    owner.options?.browserJobs !== 1 ||
    !Number.isInteger(owner.options?.testJobs) ||
    owner.options.testJobs < 1 ||
    owner.options.testJobs > 4
  )
    throw new Error('Frozen local CI invocation does not match its owner.')
  if (capture(['git', 'rev-parse', 'HEAD']) !== revision) throw new Error('Frozen local CI revision changed.')
  const env: NodeJS.ProcessEnv = {
    ...cleanEnvironment(),
    WIKI_TEST_NAMESPACE: namespace,
    WIKI_BUILD_REVISION: revision,
    WIKI_LOCAL_CI_ARTIFACTS: runDir,
    WIKI_LOCAL_CI_PHASE_RUNNER: path.join(root, 'server/scripts/local-ci-resources.ts'),
    WIKI_LOCAL_CI_BROWSER_JOBS: String(owner.options.browserJobs),
    BUN_TEST_JOBS: String(owner.options.testJobs)
  }
  Object.assign(process.env, env)
  const gates: Gate[] = []
  let imageId: string | undefined
  const gate = async (name: string, command: string[], hostGiB?: number, dockerGiB = 0, useBuilder = false) => {
    console.log(`\nLocal CI: ${name} — ${path.join(runDir, `${name}.log`)}`)
    const started = performance.now()
    const invocation =
      hostGiB === undefined
        ? command
        : [
            process.execPath,
            env.WIKI_LOCAL_CI_PHASE_RUNNER!,
            'run',
            '--name',
            name,
            '--host-gib',
            String(hostGiB),
            '--docker-gib',
            String(dockerGiB),
            ...(useBuilder ? ['--builder'] : []),
            '--',
            ...command
          ]
    const status = await execute(invocation, root, env, path.join(runDir, `${name}.log`), () => stopOwnedPhases(runDir, namespace))
    gates.push({ name, seconds: (performance.now() - started) / 1000, status: status === 0 ? 'passed' : 'failed' })
    if (status !== 0) throw new Error(`Local CI ${name} failed (${status}).`)
  }
  try {
    await gate('dependencies', ['bun', 'install', '--frozen-lockfile'], 4)
    const offlineBrowserCache = `PLAYWRIGHT_BROWSERS_PATH=${path.join(runDir, 'offline-browser')}`
    await gate(
      'offline-browser',
      ['env', offlineBrowserCache, 'node', createRequire(import.meta.url).resolve('@playwright/test/cli'), 'install', '--only-shell', 'chromium'],
      1
    )
    await gate('quality', ['env', offlineBrowserCache, 'bun', 'run', 'ci'], 8)
    const tag = `local/tsepistle:ci-${revision.slice(0, 12)}-${namespace.split('-').at(-1)}`
    await gate('image', ['bun', 'run', 'docker:build', tag], 1, 8, true)
    const image = JSON.parse(capture(['docker', 'image', 'inspect', tag]))[0]
    if (image.Config.Labels['org.opencontainers.image.revision'] !== revision || image.Os !== 'linux' || image.Architecture !== 'amd64')
      throw new Error('Built image source/platform mismatch.')
    imageId = image.Id
    env.WIKI_TEST_IMAGE = imageId
    await gate('contracts', ['bash', 'dev/ci/local-contracts.sh'])
    // Engine families run serially; core and strict renderers remain exclusive.
    await gate('browsers', ['bash', 'dev/e2e/local-run.sh'], 4, 5)
    for (const file of (await fs.readdir(path.join(runDir, 'resources'))).filter(file => file.endsWith('.json'))) {
      const phase = JSON.parse(await fs.readFile(path.join(runDir, 'resources', file), 'utf8'))
      if (phase.status !== 'passed' || phase.namespace !== namespace || phase.revision !== revision) throw new Error('Resource qualification is incomplete.')
    }
    const result = {
      status: 'passed',
      revision,
      amd64ImageId: imageId,
      artifacts: runDir,
      resources: path.join(runDir, 'resources'),
      options: owner.options,
      gates
    }
    await writeJson(path.join(runDir, 'result.json'), result)
    console.log(`\nLocal CI gates passed: ${revision}\nImage: ${imageId}\nResults: ${runDir}`)
  } catch (error) {
    await writeJson(path.join(runDir, 'result.json'), {
      status: 'failed',
      revision,
      amd64ImageId: imageId,
      gates,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

function options(args: string[]): Options {
  const result: Options = { browserJobs: 1, testJobs: 4 }
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    const separator = argument.indexOf('=')
    const flag = separator < 0 ? argument : argument.slice(0, separator)
    if (flag !== '--browser-jobs' && flag !== '--test-jobs') throw new Error(`Unknown local CI option: ${flag}; use --help.`)
    if (seen.has(flag)) throw new Error(`Duplicate local CI option: ${flag}.`)
    seen.add(flag)
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1)
    const maximum = flag === '--browser-jobs' ? 1 : 4
    if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw new Error(`${flag} must be an integer between 1 and ${maximum}.`)
    if (flag === '--browser-jobs') result.browserJobs = Number(value) as Options['browserJobs']
    else result.testJobs = Number(value)
  }
  return result
}

async function outside(options: Options): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Full local CI requires Linux x64.')
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { packageManager: string }
  if (`bun@${process.versions.bun}` !== pkg.packageManager) throw new Error(`Local CI requires ${pkg.packageManager}.`)
  if (capture(['git', 'status', '--porcelain']))
    throw new Error('Commit the source inputs before local CI; ignored .env and credentials are excluded from its clean worktree.')
  const liveFiles = capture(['git', 'ls-files', '--', '.env', '.env.*', '.agent-ready_login', 'config.yml'])
    .split('\n')
    .filter(file => file && !/\.(example|sample|template)$/.test(file))
  if (liveFiles.length) throw new Error('Live configuration/credential paths are tracked; refusing to copy them into local CI.')
  if ((await availableMemory()) < 8 * gib)
    throw new Error('Local CI cannot start below its 8 GiB host safety headroom; no maintained service has been changed.')
  const selectedContext = process.env.DOCKER_CONTEXT || capture(['docker', 'context', 'show'])
  const endpoint =
    process.env.DOCKER_CONTEXT || !process.env.DOCKER_HOST
      ? capture(['docker', 'context', 'inspect', selectedContext, '--format', '{{.Endpoints.docker.Host}}'])
      : process.env.DOCKER_HOST
  if (!endpoint?.startsWith('unix://')) throw new Error('Local CI requires a local Unix-socket Docker endpoint.')
  const revision = capture(['git', 'rev-parse', 'HEAD'])
  const nonce = randomBytes(2).toString('hex')
  const namespace = `tsepistle-ci-local-${revision.slice(0, 7)}-${process.pid}-${nonce}`
  await fs.mkdir(state, { recursive: true, mode: 0o700 })
  const runDir = await fs.mkdtemp(path.join(state, `${revision.slice(0, 9)}-`))
  const workspace = path.join(runDir, 'workspace')
  const unit = `${namespace}.scope`
  console.log(
    `Local CI source: ${revision}\nArtifacts: ${runDir}\nPer-phase host/Docker allocation is capped at 9 GiB with 8 GiB safety headroom; ${options.browserJobs} browser lane, ${options.testJobs} unit worker(s). All qualification gates remain enabled.`
  )
  let added = false
  let namespaceAvailable = false
  let status = 1
  let cancelled = false
  const errors: unknown[] = []
  let stopping: Promise<void> | undefined
  const stop = () => {
    cancelled = true
    spawn('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
    stopping ??= stopOwnedPhases(runDir, namespace).catch(error => {
      errors.push(error)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    assertFreshNamespace(namespace)
    namespaceAvailable = true
    capture(['git', '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', workspace, revision])
    added = true
    await writeJson(path.join(runDir, 'owner.json'), { revision, namespace, workspace, options } satisfies Owner)
    const env = { ...cleanEnvironment(), WIKI_LOCAL_CI_SCOPE: unit, WIKI_LOCAL_CI_ARTIFACTS: runDir, WIKI_TEST_NAMESPACE: namespace }
    if (cancelled) throw new Error('Local CI was cancelled before scope startup.')
    status = await execute(
      [
        'systemd-run',
        '--user',
        '--scope',
        '--quiet',
        '--unit',
        namespace,
        '--property=MemoryMax=512M',
        '--property=MemorySwapMax=0',
        '--property=CPUQuota=800%',
        '--property=CPUWeight=10',
        process.execPath,
        path.join(workspace, 'server/scripts/run-local-ci.ts'),
        '--inside-worktree',
        runDir,
        namespace,
        revision
      ],
      workspace,
      env,
      path.join(runDir, 'execution.log'),
      () => stopOwnedPhases(runDir, namespace)
    )
  } catch (error) {
    errors.push(error)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await stopping
    for (const cleanup of [
      () => stopOwnedPhases(runDir, namespace),
      async () => {
        if (namespaceAvailable) await cleanupNamespace(namespace)
      },
      () => stopOwnedBuilder(namespace),
      async () => {
        if (added) capture(['git', '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', '--force', workspace])
      }
    ]) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (cancelled) errors.push(new Error('Local CI cancelled.'))
  if (status !== 0) errors.push(new Error(`Local CI exited with status ${status}.`))
  if (errors.length) {
    throw new AggregateError(errors, `Local CI failed; artifacts retained at ${runDir}: ${errors.map(String).join('; ')}`)
  }
  const result = JSON.parse(await fs.readFile(path.join(runDir, 'result.json'), 'utf8')) as { status?: string; revision?: string }
  if (result.status !== 'passed' || result.revision !== revision) throw new Error('Local CI result does not match the frozen source.')
  await writeJson(path.join(state, 'last-passed.json'), result)
  console.log(`Local CI complete: ${revision}; cleanup verified. Results: ${runDir}`)
}

if (process.argv.includes('--help')) {
  console.log(
    'Usage: bun run ci:local [--browser-jobs 1] [--test-jobs 1..4]\nRuns every qualification gate from clean committed source. One browser lane and one Playwright worker run at a time; isolated tests use at most four workers. Core and strict renderer projects remain exclusive. Requires Linux x64, pinned Bun/Node, local Docker with ARM64 binfmt, systemd user scopes, cgroup v2 accounting and native Playwright libraries. Browser CPU quota remains 16 cores; other phases remain capped at eight. Each phase admits at most 9 GiB combined host/Docker limits plus 8 GiB free headroom. Both coordinators have 512 MiB hard limits; the canonical command holds the host-wide CI lock. No swap, registry publication or maintained-service replacement occurs. Results and tested image identity remain in ~/.local/state/tsepistle-ci/.'
  )
} else {
  try {
    if (process.argv[2] === '--inside-worktree' && process.argv.length === 6) await inside(process.argv[3]!, process.argv[4]!, process.argv[5]!)
    else await outside(options(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
