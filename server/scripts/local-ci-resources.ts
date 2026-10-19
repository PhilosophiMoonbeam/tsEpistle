import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers'

const root = path.resolve(import.meta.dir, '../..')
const state = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state'), 'tsepistle-ci')
const builder = 'tsepistle-local-ci'
const gib = 1024 ** 3
const headroom = 4 * gib
process.umask(0o077)

type Owner = { revision: string; namespace: string; workspace: string }
type BuilderInfo = { Id: string; State: { Running: boolean }; HostConfig: { Memory: number; MemorySwap: number; CpuQuota: number; CpuPeriod: number } }
type BuilderMarker = { name?: string; container?: string; active?: { namespace: string; unit: string } }
type Memory = { currentBytes: number; peakBytes: number; events: Record<string, number> }
type ContainerMemory = { id: string; name: string; phase: string; running: boolean; oomKilled: boolean; limitBytes: number; memory?: Memory }
type Phase = {
  name: string
  unit: string
  namespace: string
  revision: string
  status: 'starting' | 'passed' | 'failed'
  hostLimitBytes: number
  dockerBudgetBytes: number
  headroomBytes: number
  host?: Memory
  containers?: ContainerMemory[]
  sampledTotalPeakBytes?: number
  minimumHostAvailableBytes?: number
  exitCode?: number
  systemdResult?: string
  error?: string
}

export function cleanEnvironment(): NodeJS.ProcessEnv {
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
    BUN_TEST_JOBS: '8',
    WIKI_CI_APP_MEMORY: '2g',
    WIKI_CI_APP_CPUS: '2',
    WIKI_CI_POSTGRES_MEMORY: '1g',
    WIKI_CI_POSTGRES_CPUS: '1',
    WIKI_LOCAL_CI_KIND_MEMORY: '6g',
    WIKI_LOCAL_CI_KIND_CPUS: '4',
    WIKI_LOCAL_CI_BROWSER_JOBS: '4',
    WIKI_LOCAL_CI_TOOLS: path.join(state, 'tools')
  }
}

export function capture(command: string[], cwd = root, env = cleanEnvironment()): string {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, env, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command[0]} ${command[1] || ''} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

export async function availableMemory(): Promise<number> {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(await fs.readFile('/proc/meminfo', 'utf8'))
  if (!match) throw new Error('Linux MemAvailable is unavailable.')
  return Number(match[1]) * 1024
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function builderInfo(): BuilderInfo | undefined {
  const inspected = spawnSync('docker', ['inspect', `buildx_buildkit_${builder}0`], { encoding: 'utf8', env: cleanEnvironment() })
  if (inspected.error) throw inspected.error
  if (inspected.status === 0) return JSON.parse(inspected.stdout)[0] as BuilderInfo
  if (/no such (object|container)/i.test(inspected.stderr)) return undefined
  throw new Error(inspected.stderr.trim())
}

async function ensureBuilder(namespace: string, unit: string): Promise<void> {
  const markerPath = path.join(state, 'builder.json')
  const inspection = spawnSync('docker', ['buildx', 'inspect', builder], { encoding: 'utf8', env: cleanEnvironment() })
  if (inspection.error) throw inspection.error
  const existing = builderInfo()
  let marker: BuilderMarker
  const check = (info: BuilderInfo) => {
    if (
      info.HostConfig.Memory !== 8 * gib ||
      info.HostConfig.MemorySwap !== 8 * gib ||
      info.HostConfig.CpuQuota !== 800000 ||
      info.HostConfig.CpuPeriod !== 100000
    )
      throw new Error('Local CI builder resource limits changed.')
  }
  if (inspection.status === 0) {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as BuilderMarker
    if (marker.name !== builder || (existing && marker.container !== existing.Id)) throw new Error('Refusing to adopt an unowned or replacement builder.')
    if (existing) {
      check(existing)
      if (existing.State.Running) throw new Error('Local CI builder is already running outside this phase.')
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
    marker = { name: builder }
  }
  marker.active = { namespace, unit }
  await writeJson(markerPath, marker)
  let info: BuilderInfo | undefined
  try {
    capture(['docker', 'buildx', 'inspect', '--bootstrap', builder])
  } finally {
    info = builderInfo()
    if (!existing && info) {
      check(info)
      marker.container = info.Id
      await writeJson(markerPath, marker)
    }
  }
  if (!info || (existing && existing.Id !== info.Id)) throw new Error('Local CI builder identity changed during startup.')
  check(info)
}

export async function stopOwnedBuilder(namespace: string): Promise<void> {
  let marker: BuilderMarker
  try {
    marker = JSON.parse(await fs.readFile(path.join(state, 'builder.json'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (marker.name !== builder) throw new Error('Local CI builder ownership changed.')
  if (marker.active?.namespace !== namespace) return
  const info = builderInfo()
  if (!info) {
    delete marker.active
    await writeJson(path.join(state, 'builder.json'), marker)
    return
  }
  if (!marker.container || marker.container !== info.Id) throw new Error('Refusing to stop an unidentified or replacement builder.')
  if (info.State.Running) capture(['docker', 'buildx', 'stop', builder])
  delete marker.active
  await writeJson(path.join(state, 'builder.json'), marker)
}

async function owner(): Promise<{ runDir: string; owner: Owner }> {
  const runDir = process.env.WIKI_LOCAL_CI_ARTIFACTS
  if (!runDir || !path.isAbsolute(runDir)) throw new Error('A private local CI artifact directory is required.')
  const stat = await fs.lstat(runDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error('Local CI artifact ownership changed.')
  const value = JSON.parse(await fs.readFile(path.join(runDir, 'owner.json'), 'utf8')) as Owner
  if (
    value.workspace !== root ||
    !/^tsepistle-ci-local-[a-f0-9]{7}-\d+-[a-f0-9]{4}$/.test(value.namespace) ||
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    capture(['git', 'rev-parse', 'HEAD']) !== value.revision
  )
    throw new Error('Resource phase does not match its frozen owner/source.')
  const namespace = process.env.WIKI_TEST_NAMESPACE
  if (namespace !== value.namespace && !namespace?.startsWith(`${value.namespace}-`)) throw new Error('Resource phase namespace changed.')
  return { runDir, owner: value }
}

async function cgroupDirectory(pid: number): Promise<string> {
  const membership = (await fs.readFile(`/proc/${pid}/cgroup`, 'utf8'))
    .split('\n')
    .find(line => line.startsWith('0::'))
    ?.slice(3)
  if (!membership || !membership.startsWith('/') || membership.split('/').includes('..')) throw new Error('A readable cgroup v2 memory controller is required.')
  return path.join('/sys/fs/cgroup', membership)
}

async function cgroupMemory(pid: number): Promise<Memory> {
  const directory = await cgroupDirectory(pid)
  const [current, peak, events] = await Promise.all(
    ['memory.current', 'memory.peak', 'memory.events'].map(file => fs.readFile(path.join(directory, file), 'utf8'))
  )
  return {
    currentBytes: Number(current),
    peakBytes: Number(peak),
    events: Object.fromEntries(
      events!
        .trim()
        .split('\n')
        .map(line => {
          const [key, value] = line.split(' ')
          return [key!, Number(value)]
        })
    )
  }
}

async function containerMemory(id: string, phase: string, namespace: string, allowBuilder = false): Promise<ContainerMemory | undefined> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Expected an immutable Docker container ID.')
  const result = spawnSync('docker', ['inspect', id], { encoding: 'utf8', env: cleanEnvironment() })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (/no such (object|container)/i.test(result.stderr)) return undefined
    throw new Error(result.stderr.trim())
  }
  const value = JSON.parse(result.stdout)[0]
  const name = String(value.Name).replace(/^\//, '')
  if (!name.startsWith(`${namespace}-`)) {
    const marker = allowBuilder ? JSON.parse(await fs.readFile(path.join(state, 'builder.json'), 'utf8')) : undefined
    if (name !== `buildx_buildkit_${builder}0` || marker?.name !== builder || marker.container !== value.Id)
      throw new Error('Refusing to inspect foreign resource memory.')
  }
  let memory: Memory | undefined
  if (value.State.Running && value.State.Pid > 0) {
    try {
      memory = await cgroupMemory(value.State.Pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return {
    id: value.Id,
    name,
    phase,
    running: value.State.Running,
    oomKilled: value.State.OOMKilled === true,
    limitBytes: value.HostConfig.Memory,
    ...(memory ? { memory } : {})
  }
}

async function snapshot(id: string): Promise<void> {
  const context = await owner()
  const phase = process.env.WIKI_LOCAL_CI_ACTIVE_PHASE
  if (!phase || !/^[a-z][a-z0-9-]{0,70}$/.test(phase)) throw new Error('A bound active phase is required for a resource snapshot.')
  const value = await containerMemory(id, phase, context.owner.namespace)
  if (!value?.memory) throw new Error(`Required cgroup memory snapshot is unavailable for ${id}.`)
  const directory = path.join(context.runDir, 'resources', 'containers')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await writeJson(path.join(directory, `${id}.json`), value)
}

function stopUnit(unit: string): void {
  const result = spawnSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && !/not loaded|not found|does not exist/i.test(result.stderr)) throw new Error(result.stderr.trim())
}

export async function stopOwnedPhases(runDir: string, namespace: string): Promise<void> {
  let files: string[]
  try {
    files = await fs.readdir(path.join(runDir, 'resources'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const errors: unknown[] = []
  for (const file of files.filter(file => file.endsWith('.json'))) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(runDir, 'resources', file), 'utf8')) as Phase
      if (record.namespace !== namespace || record.unit !== `${namespace}-${record.name}.scope` || !/^[a-z][a-z0-9-]{0,70}$/.test(record.name))
        throw new Error('Refusing to stop a foreign phase unit.')
      stopUnit(record.unit)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Local CI phase cleanup failed.')
}

async function worker(name: string, command: string[], useBuilder: boolean): Promise<number> {
  if (!/^[a-z][a-z0-9-]{0,70}$/.test(name)) throw new Error('Invalid local CI worker phase name.')
  const context = await owner()
  const file = path.join(context.runDir, 'resources', `${name}.json`)
  const record = JSON.parse(await fs.readFile(file, 'utf8')) as Phase
  if (
    record.namespace !== context.owner.namespace ||
    record.revision !== context.owner.revision ||
    record.unit !== `${record.namespace}-${name}.scope` ||
    record.status !== 'starting'
  )
    throw new Error('Phase ownership changed before execution.')
  const group = await cgroupDirectory(process.pid)
  if (
    !group.endsWith(`/${record.unit}`) ||
    Number(await fs.readFile(path.join(group, 'memory.max'), 'utf8')) !== record.hostLimitBytes ||
    Number(await fs.readFile(path.join(group, 'memory.swap.max'), 'utf8')) !== 0
  )
    throw new Error('Phase is not inside its declared bounded scope.')
  const containers = new Map<string, ContainerMemory>()
  let child: ChildProcess | undefined
  let killTimer: NodeJS.Timeout | undefined
  let cancelled = false
  let measurementError: unknown
  let sampledTotalPeakBytes = 0
  let minimumHostAvailableBytes = Number.MAX_SAFE_INTEGER
  let sampling: Promise<void> | undefined
  const terminate = () => {
    cancelled = true
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    killTimer ??= setTimeout(() => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      spawn('systemctl', ['--user', 'stop', record.unit], { stdio: 'ignore' })
    }, 5000).unref()
  }
  process.once('SIGINT', terminate)
  process.once('SIGTERM', terminate)
  const sample = async () => {
    const host = await cgroupMemory(process.pid)
    const available = await availableMemory()
    minimumHostAvailableBytes = Math.min(minimumHostAvailableBytes, available)
    if (available < headroom) {
      measurementError = new Error('Local CI stopped: fewer than 4 GiB remain available.')
      terminate()
    }
    const entries = capture(['docker', 'ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}']).split('\n').filter(Boolean)
    let total = host.currentBytes
    for (const entry of entries) {
      const [id, containerName] = entry.split(' ')
      if (!containerName?.startsWith(`${record.namespace}-`) && !(useBuilder && containerName === `buildx_buildkit_${builder}0`)) continue
      const value = await containerMemory(id!, name, record.namespace, useBuilder)
      if (!value) continue
      const previous = containers.get(value.id)
      if (previous?.memory && value.memory) value.memory.peakBytes = Math.max(previous.memory.peakBytes, value.memory.peakBytes)
      if (!value.memory && previous?.memory) value.memory = { ...previous.memory, currentBytes: 0 }
      containers.set(value.id, value)
      total += value.running ? (value.memory?.currentBytes ?? 0) : 0
    }
    sampledTotalPeakBytes = Math.max(sampledTotalPeakBytes, total)
  }
  const tick = () => {
    if (sampling) return
    sampling = sample()
      .catch(error => {
        measurementError = error
        terminate()
      })
      .finally(() => {
        sampling = undefined
      })
  }
  let timer: NodeJS.Timeout | undefined
  let code = 1
  const errors: unknown[] = []
  try {
    if (useBuilder) await ensureBuilder(record.namespace, record.unit)
    timer = setInterval(tick, 1000)
    await sample()
    if (cancelled || measurementError) throw measurementError || new Error('Phase cancelled before command startup.')
    const env = { ...process.env, WIKI_LOCAL_CI_ACTIVE_PHASE: name }
    child = spawn(command[0]!, command.slice(1), { cwd: root, env, detached: true, stdio: 'inherit' })
    code = await new Promise<number>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', value => resolve(value ?? 1))
    })
  } catch (error) {
    errors.push(error)
  }
  clearInterval(timer)
  clearTimeout(killTimer)
  await sampling
  try {
    await sample()
    record.host = await cgroupMemory(process.pid)
    const snapshotDirectory = path.join(context.runDir, 'resources', 'containers')
    let snapshots: string[] = []
    try {
      snapshots = await fs.readdir(snapshotDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const filename of snapshots) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) throw new Error('Unexpected container snapshot file.')
      const final = JSON.parse(await fs.readFile(path.join(snapshotDirectory, filename), 'utf8')) as ContainerMemory
      if (final.phase !== name) continue
      if (
        `${final.id}.json` !== filename ||
        !final.name.startsWith(`${record.namespace}-`) ||
        !final.memory ||
        !Number.isFinite(final.memory.peakBytes) ||
        final.memory.peakBytes <= 0
      )
        throw new Error('Container snapshot does not match this resource phase.')
      if (final.memory.peakBytes >= (containers.get(final.id)?.memory?.peakBytes ?? 0)) containers.set(final.id, final)
    }
    if (record.host.events.oom_kill || [...containers.values()].some(value => value.oomKilled || value.memory?.events.oom_kill))
      throw new Error('A local CI resource was OOM-killed.')
  } catch (error) {
    errors.push(error)
  }
  if (useBuilder) {
    try {
      await stopOwnedBuilder(record.namespace)
    } catch (error) {
      errors.push(error)
    }
  }
  process.removeListener('SIGINT', terminate)
  process.removeListener('SIGTERM', terminate)
  if (cancelled) errors.push(new Error('Local CI phase cancelled.'))
  if (measurementError) errors.push(measurementError)
  record.status = code === 0 && errors.length === 0 ? 'passed' : 'failed'
  record.exitCode = record.status === 'passed' ? 0 : code || 1
  record.containers = [...containers.values()]
  record.sampledTotalPeakBytes = sampledTotalPeakBytes
  record.minimumHostAvailableBytes = minimumHostAvailableBytes
  if (errors.length) record.error = errors.map(String).join('; ')
  await writeJson(file, record)
  if (errors.length) console.error(record.error)
  return record.exitCode
}

export async function runPhase(
  name: string,
  command: string[],
  hostGiB: number,
  dockerGiB: number,
  env: NodeJS.ProcessEnv,
  useBuilder = false
): Promise<number> {
  if (
    !/^[a-z][a-z0-9-]{0,70}$/.test(name) ||
    !Number.isInteger(hostGiB) ||
    hostGiB < 1 ||
    hostGiB > 8 ||
    !Number.isInteger(dockerGiB) ||
    dockerGiB < 0 ||
    dockerGiB > 32 ||
    (useBuilder && dockerGiB < 8) ||
    !command.length
  )
    throw new Error('Invalid local CI phase budget or command.')
  const context = await owner()
  const directory = path.join(context.runDir, 'resources')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const unit = `${context.owner.namespace}-${name}.scope`
  const file = path.join(directory, `${name}.json`)
  try {
    await fs.access(file)
    throw new Error(`Phase ${name} already has a result; start a fresh local CI run.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const record: Phase = {
    name,
    unit,
    namespace: context.owner.namespace,
    revision: context.owner.revision,
    status: 'starting',
    hostLimitBytes: hostGiB * gib,
    dockerBudgetBytes: dockerGiB * gib,
    headroomBytes: headroom
  }
  await writeJson(file, record)
  const required = (hostGiB + dockerGiB) * gib + headroom
  const available = await availableMemory()
  if (available < required) {
    record.status = 'failed'
    record.error = `${name} needs ${hostGiB + dockerGiB + 4} GiB available (${hostGiB} host + ${dockerGiB} Docker + 4 headroom); ${(available / gib).toFixed(1)} GiB are available.`
    await writeJson(file, record)
    throw new Error(record.error)
  }
  console.log(`Local CI resources: ${name}: host ${hostGiB} GiB, Docker ${dockerGiB} GiB, headroom 4 GiB`)
  let cancelled = false
  let child: ChildProcess | undefined
  const stop = () => {
    cancelled = true
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    stopUnit(unit)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  let code = 1
  let failure: unknown
  try {
    if (cancelled) throw new Error('Phase cancelled before scope startup.')
    const args = [
      '--user',
      '--scope',
      '--quiet',
      '--unit',
      unit.slice(0, -6),
      '--property=MemoryAccounting=yes',
      `--property=MemoryMax=${hostGiB}G`,
      '--property=MemorySwapMax=0',
      '--property=TimeoutStopSec=10s',
      // Avoid quota-induced software-renderer stalls; worker and memory caps remain separate.
      name === 'browsers' ? '--property=CPUQuota=1600%' : '--property=CPUQuota=800%',
      '--property=CPUWeight=10',
      process.execPath,
      import.meta.path,
      'worker',
      name,
      useBuilder ? 'builder' : 'no-builder',
      '--',
      ...command
    ]
    child = spawn('systemd-run', args, { cwd: root, env, detached: true, stdio: 'inherit' })
    if (cancelled) stop()
    code = await new Promise<number>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', value => resolve(value ?? 1))
    })
  } catch (error) {
    failure = error
  }
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  try {
    const current = JSON.parse(await fs.readFile(file, 'utf8')) as Phase
    if (code !== 0 || cancelled || current.status !== 'passed') {
      current.status = 'failed'
      current.exitCode = code || 1
      const info = spawnSync('systemctl', ['--user', 'show', unit, '--property=Result', '--property=MemoryPeak'], { encoding: 'utf8' })
      const fields = Object.fromEntries(
        info.stdout
          .trim()
          .split('\n')
          .map(row => row.split('='))
      )
      current.systemdResult = fields.Result
      if (Number(fields.MemoryPeak) > 0 && !current.host) current.host = { currentBytes: 0, peakBytes: Number(fields.MemoryPeak), events: {} }
      if (failure || cancelled) current.error = String(failure || 'Local CI phase cancelled.')
      await writeJson(file, current)
      code = current.exitCode
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error]) : error
  }
  try {
    stopUnit(unit)
  } catch (error) {
    failure = failure ? new AggregateError([failure, error]) : error
  }
  if (useBuilder) {
    try {
      await stopOwnedBuilder(context.owner.namespace)
    } catch (error) {
      failure = failure ? new AggregateError([failure, error]) : error
    }
  }
  if (failure) throw failure
  return cancelled ? 130 : code
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === 'snapshot' && args[1] === '--container' && args.length === 3) await snapshot(args[2]!)
    else if (args[0] === 'worker' && args[3] === '--' && ['builder', 'no-builder'].includes(args[2]!))
      process.exitCode = await worker(args[1]!, args.slice(4), args[2] === 'builder')
    else if (args[0] === 'run') {
      const separator = args.indexOf('--')
      const flags = args.slice(1, separator)
      let name = '',
        host = NaN,
        docker = NaN,
        useBuilder = false
      while (flags.length) {
        const flag = flags.shift()
        if (flag === '--builder') useBuilder = true
        else if (flag === '--name') name = flags.shift() || ''
        else if (flag === '--host-gib') host = Number(flags.shift())
        else if (flag === '--docker-gib') docker = Number(flags.shift())
        else throw new Error(`Unknown local CI resource option: ${flag}`)
      }
      if (separator < 0) throw new Error('Expected a local CI phase command after --.')
      process.exitCode = await runPhase(name, args.slice(separator + 1), host, docker, process.env, useBuilder)
    } else throw new Error('Invalid internal local CI resource invocation.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
