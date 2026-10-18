import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const root = path.resolve(import.meta.dir, '../..')
const state = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state'), 'tsepistle-ci')
const builder = 'tsepistle-local-ci'
const gib = 1024 ** 3
process.umask(0o077)
process.chdir(root)

type Gate = { name: string; seconds: number; status: 'passed' | 'failed' }
type Owner = { revision: string; namespace: string; workspace: string }

function capture(command: string[], cwd = root, env = cleanEnvironment()): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, env, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command[0]} ${command[1] || ''} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function availableMemory(): Promise<number> {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(await fs.readFile('/proc/meminfo', 'utf8'))
  if (!match) throw new Error('Linux MemAvailable is unavailable.')
  return Number(match[1]) * 1024
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'DBUS_SESSION_BUS_ADDRESS',
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'BUILDX_CONFIG',
    'PLAYWRIGHT_BROWSERS_PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy'
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return {
    ...env,
    CI: '1',
    BUILDX_BUILDER: builder,
    WIKI_CI_APP_MEMORY: '4g',
    WIKI_CI_APP_CPUS: '2',
    WIKI_CI_POSTGRES_MEMORY: '1g',
    WIKI_CI_POSTGRES_CPUS: '1',
    WIKI_LOCAL_CI_KIND_MEMORY: '6g',
    WIKI_LOCAL_CI_KIND_CPUS: '4',
    WIKI_LOCAL_CI_BROWSER_JOBS: '2',
    WIKI_LOCAL_CI_TOOLS: path.join(state, 'tools')
  }
}

async function execute(command: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): Promise<number> {
  const log = createWriteStream(logFile, { mode: 0o600 })
  const child = spawn(command[0]!, command.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let interrupted = false
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
  child.stdout!.on('data', forward(process.stdout))
  child.stderr!.on('data', forward(process.stderr))
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(interrupted ? 130 : (code ?? 1)))
    })
  } finally {
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

async function ensureBuilder(): Promise<void> {
  type BuilderInfo = { Id: string; HostConfig: { Memory: number; MemorySwap: number; CpuQuota: number; CpuPeriod: number } }
  const inspectContainer = (): BuilderInfo | undefined => {
    const result = spawnSync('docker', ['inspect', `buildx_buildkit_${builder}0`], { encoding: 'utf8', env: cleanEnvironment() })
    if (result.error) throw result.error
    if (result.status === 0) return JSON.parse(result.stdout)[0] as BuilderInfo
    if (/no such (object|container)/i.test(result.stderr)) return undefined
    throw new Error(result.stderr.trim())
  }
  const checkLimits = (info: BuilderInfo) => {
    if (
      info.HostConfig.Memory !== 8 * gib ||
      info.HostConfig.MemorySwap !== 8 * gib ||
      info.HostConfig.CpuQuota !== 800000 ||
      info.HostConfig.CpuPeriod !== 100000
    )
      throw new Error('Local CI builder resource limits changed.')
  }
  const markerPath = path.join(state, 'builder.json')
  const inspection = spawnSync('docker', ['buildx', 'inspect', builder], { encoding: 'utf8', env: cleanEnvironment() })
  const existing = inspectContainer()
  if (inspection.error) throw inspection.error
  if (inspection.status === 0) {
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { name?: string; container?: string }
    if (marker.name !== builder) throw new Error('Refusing to adopt an unowned local CI builder.')
    if (existing) {
      if (!marker.container || marker.container !== existing.Id) throw new Error('Refusing to start a replacement builder.')
      checkLimits(existing)
    }
  } else {
    if (!/no builder|not found/i.test(inspection.stderr)) throw new Error(inspection.stderr.trim())
    if (existing) throw new Error('Refusing to adopt an existing fixed-name BuildKit container.')
    capture([
      'docker',
      'buildx',
      'create',
      '--name',
      builder,
      '--driver',
      'docker-container',
      '--driver-opt',
      'memory=8g',
      '--driver-opt',
      'memory-swap=8g',
      '--driver-opt',
      'cpu-period=100000',
      '--driver-opt',
      'cpu-quota=800000'
    ])
    await writeJson(markerPath, { name: builder })
  }
  let info: BuilderInfo | undefined
  try {
    capture(['docker', 'buildx', 'inspect', '--bootstrap', builder])
  } finally {
    info = inspectContainer()
    if (!existing && info) {
      checkLimits(info)
      await writeJson(markerPath, { name: builder, container: info.Id })
    }
  }
  if (!info || (existing && existing.Id !== info.Id)) throw new Error('Local CI builder identity changed during startup.')
  checkLimits(info)
}

async function stopOwnedBuilder(): Promise<void> {
  let marker: { name?: string; container?: string }
  try {
    marker = JSON.parse(await fs.readFile(path.join(state, 'builder.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (marker.name !== builder) throw new Error('Local CI builder ownership changed.')
  const inspection = spawnSync('docker', ['inspect', `buildx_buildkit_${builder}0`], { encoding: 'utf8', env: cleanEnvironment() })
  if (inspection.error) throw inspection.error
  if (inspection.status !== 0) {
    if (/no such (object|container)/i.test(inspection.stderr)) return
    throw new Error(inspection.stderr.trim())
  }
  const container = JSON.parse(inspection.stdout)[0]
  if (!marker.container || marker.container !== container.Id) throw new Error('Refusing to stop an unidentified or replacement builder.')
  capture(['docker', 'buildx', 'stop', builder])
}

async function inside(runDir: string, namespace: string, revision: string): Promise<void> {
  const owner = JSON.parse(await fs.readFile(path.join(runDir, 'owner.json'), 'utf8')) as Owner
  if (owner.workspace !== root || owner.namespace !== namespace || owner.revision !== revision || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Frozen local CI invocation does not match its owner.')
  if (capture(['git', 'rev-parse', 'HEAD']) !== revision) throw new Error('Frozen local CI revision changed.')
  const env: NodeJS.ProcessEnv = { ...cleanEnvironment(), WIKI_TEST_NAMESPACE: namespace, WIKI_BUILD_REVISION: revision, WIKI_LOCAL_CI_ARTIFACTS: runDir }
  const gates: Gate[] = []
  let imageId: string | undefined
  let builderReady = false
  let pressure = false
  let active = false
  const unit = process.env.WIKI_LOCAL_CI_SCOPE
  const stopForPressure = () => {
    pressure = true
    console.error('Local CI stopped: fewer than 4 GiB remain available; maintained services take priority.')
    if (unit) spawn('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
  }
  const monitor = setInterval(() => {
    if (active && !pressure)
      void availableMemory()
        .then(bytes => {
          if (bytes < 4 * gib) stopForPressure()
        })
        .catch(error => {
          console.error(error)
          stopForPressure()
        })
  }, 2000)
  const gate = async (name: string, command: string[]) => {
    console.log(`\nLocal CI: ${name} — ${path.join(runDir, `${name}.log`)}`)
    const started = performance.now()
    active = true
    let status = 1
    try {
      status = await execute(command, root, env, path.join(runDir, `${name}.log`))
    } finally {
      active = false
    }
    gates.push({ name, seconds: (performance.now() - started) / 1000, status: status === 0 ? 'passed' : 'failed' })
    if (status !== 0 || pressure) throw new Error(`Local CI ${name} failed (${status}).`)
  }
  try {
    await gate('dependencies', ['bun', 'install', '--frozen-lockfile'])
    await gate('quality', ['bun', 'run', 'ci'])
    await ensureBuilder()
    builderReady = true
    const tag = `local/tsepistle:ci-${revision.slice(0, 12)}-${namespace.split('-').at(-1)}`
    await gate('image', ['bun', 'run', 'docker:build', tag])
    const image = JSON.parse(capture(['docker', 'image', 'inspect', tag]))[0]
    if (image.Config.Labels['org.opencontainers.image.revision'] !== revision || image.Os !== 'linux' || image.Architecture !== 'amd64')
      throw new Error('Built image source/platform mismatch.')
    imageId = image.Id
    env.WIKI_TEST_IMAGE = imageId
    await gate('contracts', ['bash', 'dev/ci/local-contracts.sh'])
    capture(['docker', 'buildx', 'stop', builder])
    builderReady = false
    await gate('browsers', ['bash', 'dev/e2e/local-run.sh'])
    const result = { status: 'passed', revision, amd64ImageId: imageId, artifacts: runDir, gates }
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
  } finally {
    clearInterval(monitor)
    if (builderReady) capture(['docker', 'buildx', 'stop', builder])
  }
}

async function outside(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Full local CI requires Linux x64.')
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { packageManager: string }
  if (`bun@${process.versions.bun}` !== pkg.packageManager) throw new Error(`Local CI requires ${pkg.packageManager}.`)
  if (capture(['git', 'status', '--porcelain']))
    throw new Error('Commit the source inputs before local CI; ignored .env and credentials are excluded from its clean worktree.')
  const liveFiles = capture(['git', 'ls-files', '--', '.env', '.env.*', '.agent-ready_login', 'config.yml'])
    .split('\n')
    .filter(file => file && !/\.(example|sample|template)$/.test(file))
  if (liveFiles.length) throw new Error('Live configuration/credential paths are tracked; refusing to copy them into local CI.')
  if ((await availableMemory()) < 24 * gib)
    throw new Error('Full local CI requires at least 24 GiB currently available RAM; no maintained service has been changed.')
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
    `Local CI source: ${revision}\nArtifacts: ${runDir}\nHost limit: 8 GiB / 8 CPUs; Docker builder: 8 GiB / 8 CPUs; two bounded browser lanes, then exclusive core/performance.`
  )
  let added = false
  let namespaceAvailable = false
  let status = 1
  let cancelled = false
  const stop = () => {
    cancelled = true
    spawn('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const errors: unknown[] = []
  try {
    assertFreshNamespace(namespace)
    namespaceAvailable = true
    capture(['git', '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', workspace, revision])
    added = true
    await writeJson(path.join(runDir, 'owner.json'), { revision, namespace, workspace } satisfies Owner)
    const env = { ...cleanEnvironment(), WIKI_LOCAL_CI_SCOPE: unit }
    if (cancelled) throw new Error('Local CI was cancelled before scope startup.')
    status = await execute(
      [
        'systemd-run',
        '--user',
        '--scope',
        '--quiet',
        '--unit',
        namespace,
        '--property=MemoryHigh=6G',
        '--property=MemoryMax=8G',
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
      path.join(runDir, 'execution.log')
    )
  } catch (error) {
    errors.push(error)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    for (const cleanup of [
      async () => {
        if (namespaceAvailable) await cleanupNamespace(namespace)
      },
      stopOwnedBuilder,
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
    'Usage: bun run ci:local\nRuns the complete routine CI contract locally from clean committed source. Requires Linux x64, pinned Bun/Node, Docker with ARM64 binfmt, systemd user scopes, native Playwright libraries, and 24 GiB available RAM. No registry publication or maintained-service replacement occurs. Results and tested image identity are retained in ~/.local/state/tsepistle-ci/.'
  )
} else {
  try {
    if (process.argv[2] === '--inside-worktree' && process.argv.length === 6) await inside(process.argv[3]!, process.argv[4]!, process.argv[5]!)
    else if (process.argv.length === 2) await outside()
    else throw new Error('Unknown local CI arguments; use --help.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
