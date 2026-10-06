import { type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type TestJob = { finished: Promise<unknown>; process?: ChildProcess; stop(): Promise<unknown> }
type TestScheduler = {
  jobs: TestJob[]
  started: boolean
  registerJob(options: { name: string; immediate?: boolean; worker?: boolean; repeat?: boolean; schedule?: string }, data?: unknown): TestJob
  start(): void
  stop(): Promise<void>
  snapshot(): { started: boolean; jobs: Array<Record<string, unknown>> }
}
type KillSpy = {
  mockRestore(): void
  mock: { calls: Array<[NodeJS.Signals | number | undefined]> }
}

const awaitBounded = async <T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('scheduler worker lifecycle timed out')), timeoutMs)
      })
    ])
  } finally {
    // A real wall-clock bound is required because this integration test waits on an external child process.
    clearTimeout(timer)
  }
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

const waitForFile = async (path: string, timeoutMs = 5_000): Promise<void> => {
  const started = Date.now()
  while (!(await fileExists(path))) {
    if (Date.now() - started >= timeoutMs) throw new Error(`scheduler worker readiness timed out: ${path}`)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 10)
    await promise
  }
}

const writeWorkerFixture = async (rootPath: string, workMarker: string): Promise<void> => {
  await mkdir(join(rootPath, 'server', 'core'), { recursive: true })
  await writeFile(
    join(rootPath, 'server', 'core', 'worker.ts'),
    `import { unlinkSync, writeFileSync } from 'node:fs'
const workMarker = ${JSON.stringify(workMarker)}
const shouldFail = process.argv.some(argument => argument.includes('"fail":true'))
writeFileSync(workMarker, 'work')
await Promise.resolve()
unlinkSync(workMarker)
if (process.connected) process.disconnect?.()
if (shouldFail) process.exitCode = 7
`
  )
}
const writeAdmissionWorkerFixture = async (rootPath: string): Promise<void> => {
  await mkdir(join(rootPath, 'server', 'core'), { recursive: true })
  await writeFile(
    join(rootPath, 'server', 'core', 'worker.ts'),
    `import { writeFileSync } from 'node:fs'
const dataArgument = process.argv.find(argument => argument.startsWith('--data='))
const { readyMarker } = JSON.parse(dataArgument!.slice('--data='.length))
const { promise, resolve } = Promise.withResolvers<void>()
process.on('message', message => {
  if (message === 'finish') resolve()
})
writeFileSync(readyMarker, String(process.pid))
await promise
if (process.connected) process.disconnect?.()
`
  )
}
const writeStubbornWorkerFixture = async (rootPath: string, readyMarker: string): Promise<void> => {
  await mkdir(join(rootPath, 'server', 'core'), { recursive: true })
  await writeFile(
    join(rootPath, 'server', 'core', 'worker.ts'),
    `import { writeFileSync } from 'node:fs'
const readyMarker = ${JSON.stringify(readyMarker)}
process.on('SIGTERM', () => {})
writeFileSync(readyMarker, 'ready')
await new Promise(() => {})
`
  )
}
const writeOutputWorkerFixture = async (rootPath: string): Promise<void> => {
  await mkdir(join(rootPath, 'server', 'core'), { recursive: true })
  await writeFile(
    join(rootPath, 'server', 'core', 'worker.ts'),
    `const shouldFail = process.argv.some(argument => argument.includes('"fail":true'))
const prefix = 'p'.repeat(65536)
const writeChunk = (chunk: string) => new Promise<void>(resolve => process.stderr.write(chunk, resolve))
await writeChunk(prefix.slice(0, 32768))
await writeChunk(prefix.slice(32768))
await writeChunk('overflow-tail')
if (process.connected) process.disconnect?.()
if (shouldFail) process.exitCode = 7
`
  )
}

const writePreloadFixture = async (preloadPath: string, preloadMarker: string): Promise<void> => {
  await writeFile(preloadPath, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(preloadMarker)}, 'preloaded')\n`)
}

const runWorker = async (
  scheduler: TestScheduler,
  rootPath: string,
  execArgvFlag: '--watch' | '--hot',
  shouldFail: boolean,
  originalExecArgv: string[]
): Promise<void> => {
  const suffix = `${execArgvFlag.slice(2)}-${shouldFail ? 'failure' : 'success'}`
  const preloadPath = join(rootPath, `${suffix}.preload.ts`)
  const preloadMarker = join(rootPath, `${suffix}.preload.marker`)
  const workMarker = join(rootPath, `${suffix}.work.marker`)
  await writePreloadFixture(preloadPath, preloadMarker)
  await writeWorkerFixture(rootPath, workMarker)

  process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv, execArgvFlag, '--preload', preloadPath)
  const job = scheduler.registerJob({ name: 'worker-lifecycle', immediate: true, worker: true }, shouldFail ? { fail: true } : undefined)
  const child = job.process
  if (!child) throw new Error('scheduler worker did not expose its child process')
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  try {
    if (shouldFail) {
      await expect(awaitBounded(job.finished)).rejects.toMatchObject({ exitCode: 7 })
    } else {
      await awaitBounded(job.finished)
    }
    expect(await fileExists(preloadMarker)).toBe(true)
    expect(await fileExists(workMarker)).toBe(false)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    try {
      await awaitBounded(closed, 2_000)
    } catch {
      if (child.exitCode === null) child.kill('SIGKILL')
      await awaitBounded(closed, 2_000)
    }
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv)
  }
}

describe('real scheduler worker lifecycle', () => {
  it('filters only watch and hot flags while preserving preload execution and failure settlement', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'tsepistle-scheduler-worker-'))
    const originalExecArgv = [...process.execArgv]
    let scheduler: TestScheduler | undefined
    try {
      globalThis.WIKI = {
        ROOTPATH: rootPath,
        config: { offline: false },
        data: { jobs: {} },
        logger: { info: vi.fn(), warn: vi.fn() }
      } as never
      scheduler = (await vi.importFresh('../../core/scheduler.ts', import.meta.url)).default as TestScheduler
      await runWorker(scheduler, rootPath, '--watch', false, originalExecArgv)
      await runWorker(scheduler, rootPath, '--hot', false, originalExecArgv)
      await runWorker(scheduler, rootPath, '--hot', true, originalExecArgv)
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv)
      await rm(rootPath, { recursive: true, force: true })
    }
  })
  it('escalates a readiness-marked worker that ignores SIGTERM and settles cancellation once', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'tsepistle-scheduler-worker-stop-'))
    const readyMarker = join(rootPath, 'worker.ready')
    const originalExecArgv = [...process.execArgv]
    let scheduler: TestScheduler | undefined
    let child: ChildProcess | undefined
    let closed: Promise<void> | undefined
    let killSpy: KillSpy | undefined
    try {
      await writeStubbornWorkerFixture(rootPath, readyMarker)
      globalThis.WIKI = {
        ROOTPATH: rootPath,
        config: { offline: false },
        data: { jobs: { stubbornWorker: { onInit: true, worker: true } } },
        logger: { info: vi.fn(), warn: vi.fn() }
      } as never
      scheduler = (await vi.importFresh('../../core/scheduler.ts', import.meta.url)).default as TestScheduler
      scheduler.start()
      const job = scheduler.jobs[0]
      child = job.process
      if (!child) throw new Error('scheduler worker did not expose its child process')
      killSpy = vi.spyOn(child, 'kill')
      const closedSignal = Promise.withResolvers<void>()
      child.once('close', closedSignal.resolve)
      closed = closedSignal.promise

      await awaitBounded(waitForFile(readyMarker))
      await awaitBounded(scheduler.stop())
      await awaitBounded(closed)

      expect(killSpy).toHaveBeenCalledTimes(2)
      expect(killSpy.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
      expect(scheduler.started).toBe(false)
      expect(job.process).toBeUndefined()
      expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'stopped', lastOutcome: 'stopped', failures: 0 })
      await awaitBounded(job.stop())
      await awaitBounded(scheduler.stop())
      expect(killSpy).toHaveBeenCalledTimes(2)
    } finally {
      killSpy?.mockRestore()
      if (child && child.exitCode === null) child.kill('SIGKILL')
      if (closed) {
        try {
          await awaitBounded(closed, 2_000)
        } catch {
          // The process was already cleaned up or the bounded test cleanup expired.
        }
      }
      process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv)
      await rm(rootPath, { recursive: true, force: true })
    }
  })
  it('holds a third real worker until close and cancels unspawned workers during individual stop and shutdown', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'tsepistle-scheduler-worker-admission-'))
    const originalExecArgv = [...process.execArgv]
    const children = new Map<ChildProcess, Promise<void>>()
    let scheduler: TestScheduler | undefined
    const track = (job: TestJob): ChildProcess | undefined => {
      const child = job.process
      if (child && !children.has(child)) {
        const { promise, resolve } = Promise.withResolvers<void>()
        child.once('close', resolve)
        children.set(child, promise)
      }
      return child
    }
    try {
      await writeAdmissionWorkerFixture(rootPath)
      globalThis.WIKI = {
        ROOTPATH: rootPath,
        config: { offline: false },
        data: { jobs: {} },
        logger: { info: vi.fn(), warn: vi.fn() }
      } as never
      scheduler = (await vi.importFresh('../../core/scheduler.ts', import.meta.url)).default as TestScheduler
      const firstMarker = join(rootPath, 'first.ready')
      const secondMarker = join(rootPath, 'second.ready')
      const thirdMarker = join(rootPath, 'third.ready')
      const cancelledMarker = join(rootPath, 'cancelled.ready')
      const shutdownMarker = join(rootPath, 'shutdown.ready')
      const first = scheduler.registerJob({ name: 'first-worker', immediate: true, worker: true }, { readyMarker: firstMarker })
      const second = scheduler.registerJob({ name: 'second-worker', immediate: true, worker: true }, { readyMarker: secondMarker })
      const third = scheduler.registerJob({ name: 'third-worker', immediate: true, worker: true }, { readyMarker: thirdMarker })
      const cancelled = scheduler.registerJob(
        { name: 'cancelled-worker', immediate: true, worker: true, repeat: true, schedule: 'PT0.01S' },
        { readyMarker: cancelledMarker }
      )
      for (const job of [first, second, third, cancelled]) track(job)
      await Promise.all([waitForFile(firstMarker), waitForFile(secondMarker)])
      expect(third.process).toBeUndefined()
      expect(cancelled.process).toBeUndefined()
      expect(await fileExists(thirdMarker)).toBe(false)
      expect(scheduler.snapshot().jobs.find(job => job.name === 'third-worker')).toMatchObject({
        state: 'waiting',
        runs: 0,
        lastStartedAt: null
      })
      const thirdFinished = third.finished
      await awaitBounded(Promise.all([cancelled.stop(), cancelled.finished]))

      first.process!.send('finish')
      await awaitBounded(first.finished)
      expect(first.process).toBeUndefined()
      expect(third.finished).toBe(thirdFinished)
      const thirdChild = track(third)
      expect(thirdChild?.pid).toBeGreaterThan(0)
      await waitForFile(thirdMarker)
      const livePids = [second.process?.pid, thirdChild?.pid]
      expect(new Set(livePids).size).toBe(2)
      expect(livePids.every(pid => typeof pid === 'number' && pid > 0)).toBe(true)
      expect(await fileExists(cancelledMarker)).toBe(false)

      const shutdownQueued = scheduler.registerJob({ name: 'shutdown-worker', immediate: true, worker: true }, { readyMarker: shutdownMarker })
      expect(shutdownQueued.process).toBeUndefined()
      await awaitBounded(scheduler.stop())
      await awaitBounded(Promise.all([second.finished, thirdFinished, shutdownQueued.finished, shutdownQueued.stop()]))
      expect(await fileExists(shutdownMarker)).toBe(false)
      expect(await fileExists(cancelledMarker)).toBe(false)
      expect(scheduler.jobs).toHaveLength(0)
      expect(scheduler.started).toBe(false)
      await awaitBounded(Promise.all(children.values()))
    } finally {
      for (const job of scheduler?.jobs ?? []) track(job)
      for (const child of children.keys()) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      try {
        await awaitBounded(Promise.all(children.values()), 2_000)
        await scheduler?.stop()
      } finally {
        process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv)
        await rm(rootPath, { recursive: true, force: true })
      }
    }
  })
  it('retains one bounded stderr prefix across chunks for successful and failed workers', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'tsepistle-scheduler-worker-stderr-'))
    const originalExecArgv = [...process.execArgv]
    const expected = `${'p'.repeat(65_536)}\n[truncated]`
    let scheduler: TestScheduler | undefined
    try {
      await writeOutputWorkerFixture(rootPath)
      globalThis.WIKI = {
        ROOTPATH: rootPath,
        config: { offline: false },
        data: { jobs: {} },
        logger: { info: vi.fn(), warn: vi.fn() }
      } as never
      scheduler = (await vi.importFresh('../../core/scheduler.ts', import.meta.url)).default as TestScheduler
      const successful = scheduler.registerJob({ name: 'worker-lifecycle', immediate: true, worker: true })
      await expect(awaitBounded(successful.finished)).resolves.toBe(expected)
      const failed = scheduler.registerJob({ name: 'worker-lifecycle', immediate: true, worker: true }, { fail: true })
      await expect(awaitBounded(failed.finished)).rejects.toMatchObject({ exitCode: 7, stderr: expected })
      expect(JSON.stringify(scheduler.snapshot())).not.toContain('overflow-tail')
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv)
      await rm(rootPath, { recursive: true, force: true })
    }
  })
})
