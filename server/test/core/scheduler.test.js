
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }))
vi.mockModule('node:child_process', import.meta.url, () => ({ fork: forkMock }))

const loadScheduler = async (jobs = {}) => {
  vi.resetModules()
  global.WIKI = {
    ROOTPATH: '/wiki',
    config: { offline: false },
    data: { jobs },
    logger: { warn: vi.fn() }
  }
  return (await vi.importFresh('../../core/scheduler.ts', import.meta.url)).default
}

class WorkerProcess extends EventEmitter {
  exitCode = null
  killed = false
  stderr = new PassThrough()
  signals = []
  exitOnKill = true

  emitExit(code, signal) {
    this.exitCode = code
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }

  kill(signal) {
    this.killed = true
    this.signals.push(signal)
    if (this.exitOnKill) this.emitExit(null, signal)
    return true
  }
}

describe('scheduler lifecycle', () => {
  beforeEach(() => {
    forkMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts configured timers once and clears them on stop', async () => {
    const scheduler = await loadScheduler({ purgeUploads: { repeat: true, schedule: 'PT5M' } })

    scheduler.start()
    scheduler.start()

    expect(scheduler.jobs).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    await scheduler.stop()

    expect(scheduler.jobs).toHaveLength(0)
    expect(scheduler.started).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects unsafe runtime-selected job names before scheduling', async () => {
    const scheduler = await loadScheduler()

    expect(() => scheduler.registerJob({ name: '../worker', schedule: 'PT1M' })).toThrow('Invalid scheduler job name')
    expect(scheduler.jobs).toHaveLength(0)
  })

  it('terminates an active child during shutdown', async () => {
    const child = new WorkerProcess()
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()

    scheduler.registerJob({ name: 'render-page', immediate: true, worker: true }, { pageId: 7 })
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledOnce())

    await scheduler.stop()

    expect(child.killed).toBe(true)
    expect(scheduler.jobs).toHaveLength(0)
  })
  it('bounds retained worker stderr while preserving successful and failed settlement metadata', async () => {
    const prefix = 'p'.repeat(65_536)
    const successfulChild = new WorkerProcess()
    const failedChild = new WorkerProcess()
    forkMock.mockReturnValueOnce(successfulChild).mockReturnValueOnce(failedChild)
    const scheduler = await loadScheduler()

    const successful = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })
    successfulChild.stderr.write(prefix)
    successfulChild.stderr.write('success-overflow')
    successfulChild.emitExit(0, null)
    await expect(successful.finished).resolves.toBe(`${prefix}\n[truncated]`)

    const failed = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })
    failedChild.stderr.write(prefix)
    failedChild.stderr.write('failure-overflow')
    failedChild.emitExit(7, 'SIGTERM')
    await expect(failed.finished).rejects.toMatchObject({
      exitCode: 7,
      exitSignal: 'SIGTERM',
      stderr: `${prefix}\n[truncated]`
    })
    expect(JSON.stringify(scheduler.snapshot())).not.toContain('success-overflow')
    expect(JSON.stringify(scheduler.snapshot())).not.toContain('failure-overflow')
  })
  it('waits for stdio close before materializing stderr after child exit', async () => {
    const prefix = 'e'.repeat(65_536)
    const child = new WorkerProcess()
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })

    child.stderr.write(prefix)
    child.emit('exit', 0, null)
    child.stderr.write('late-tail')
    expect(job.process).toBe(child)
    child.emit('close', 0, null)

    await expect(job.finished).resolves.toBe(`${prefix}\n[truncated]`)
    expect(job.process).toBeUndefined()
    expect(JSON.stringify(scheduler.snapshot())).not.toContain('late-tail')
  })
  it('distinguishes an exited worker whose stderr never closes', async () => {
    const child = new WorkerProcess()
    child.exitOnKill = false
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })

    const stopping = job.stop()
    child.exitCode = 0
    child.emit('exit', 0, null)
    vi.advanceTimersByTime(5_000)

    await expect(stopping).rejects.toMatchObject({ code: 'SCHEDULER_WORKER_COMPLETION_UNCONFIRMED' })
    expect(job.process).toBe(child)
    expect(scheduler.jobs).toHaveLength(1)
    expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'running', lastOutcome: null })

    child.emit('close', 0, null)
    await job.finished
    expect(job.process).toBeUndefined()
  })


  it('bounds unconfirmed worker cancellation and cleans up after a late close', async () => {
    const child = new WorkerProcess()
    child.exitOnKill = false
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })

    const stopping = job.stop()
    expect(job.stop()).toBe(stopping)
    expect(child.signals).toEqual(['SIGTERM'])

    vi.advanceTimersByTime(999)
    expect(child.signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    vi.advanceTimersByTime(4_000)
    await expect(stopping).rejects.toMatchObject({ code: 'SCHEDULER_WORKER_TERMINATION_UNCONFIRMED' })
    expect(vi.getTimerCount()).toBe(0)
    expect(job.process).toBe(child)
    expect(job.stopping).toBe(true)
    expect(scheduler.jobs).toHaveLength(1)
    expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'running', lastOutcome: null })
    expect(job.stop()).toBe(stopping)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])

    child.exitCode = 0
    child.emit('exit', 0, null)
    expect(job.process).toBe(child)
    child.emit('close', 0, null)
    await job.finished
    expect(job.process).toBeUndefined()
    expect(scheduler.jobs).toHaveLength(0)
    expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'stopped', lastOutcome: 'stopped', failures: 0 })
  })

  it('signals active workers concurrently and settles early exit and error races once', async () => {
    const earlyExitChild = new WorkerProcess()
    const errorRaceChild = new WorkerProcess()
    earlyExitChild.exitOnKill = false
    errorRaceChild.exitOnKill = false
    forkMock.mockReturnValueOnce(earlyExitChild).mockReturnValueOnce(errorRaceChild)
    const scheduler = await loadScheduler()
    const earlyExitJob = scheduler.registerJob({ name: 'early-exit', immediate: true, worker: true })
    const errorRaceJob = scheduler.registerJob({ name: 'error-race', immediate: true, worker: true })

    const stopping = scheduler.stop()
    expect(scheduler.stop()).toBe(stopping)
    expect(earlyExitChild.signals).toEqual(['SIGTERM'])
    expect(errorRaceChild.signals).toEqual(['SIGTERM'])

    earlyExitChild.exitCode = 0
    earlyExitChild.emitExit(0, null)
    const failure = new Error('worker transport failed')
    errorRaceChild.emit('error', failure)
    errorRaceChild.emitExit(1, 'SIGTERM')
    await stopping
    await Promise.all([earlyExitJob.finished, errorRaceJob.finished])
    vi.advanceTimersByTime(1_000)

    expect(earlyExitChild.signals).toEqual(['SIGTERM'])
    expect(errorRaceChild.signals).toEqual(['SIGTERM'])
    expect(scheduler.started).toBe(false)
    expect(scheduler.snapshot().jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'early-exit', state: 'stopped', lastOutcome: 'stopped', failures: 0 }),
        expect.objectContaining({ name: 'error-race', state: 'stopped', lastOutcome: 'stopped', failures: 0 })
      ])
    )
  })

  it('surfaces unconfirmed scheduler cancellation without starting another generation', async () => {
    const child = new WorkerProcess()
    child.exitOnKill = false
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler({ renderPage: { onInit: true, worker: true } })
    scheduler.start()
    const job = scheduler.jobs[0]
    const forkCalls = forkMock.mock.calls.length

    const stopping = scheduler.stop()
    vi.advanceTimersByTime(5_000)
    await expect(stopping).rejects.toMatchObject({ code: 'SCHEDULER_WORKER_TERMINATION_UNCONFIRMED' })
    expect(scheduler.started).toBe(true)
    expect(scheduler.jobs).toHaveLength(1)
    expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'running', lastOutcome: null })
    const retry = scheduler.stop()
    expect(retry).not.toBe(stopping)
    await expect(retry).rejects.toMatchObject({ code: 'SCHEDULER_WORKER_TERMINATION_UNCONFIRMED' })
    scheduler.start()
    expect(forkMock).toHaveBeenCalledTimes(forkCalls)

    child.exitCode = 0
    child.emitExit(0, null)
    await job.finished
    expect(job.process).toBeUndefined()
    expect(scheduler.started).toBe(true)
  })
  it('does not treat a worker error as termination confirmation', async () => {
    const child = new WorkerProcess()
    child.exitOnKill = false
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })

    child.emit('error', new Error('worker transport failed'))
    const stopping = job.stop()
    vi.advanceTimersByTime(1_000)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    vi.advanceTimersByTime(4_000)
    await expect(stopping).rejects.toMatchObject({ code: 'SCHEDULER_WORKER_TERMINATION_UNCONFIRMED' })
    expect(job.process).toBe(child)
    expect(scheduler.jobs).toHaveLength(1)

    child.emitExit(1, 'SIGKILL')
    await job.finished
    expect(job.process).toBeUndefined()
  })

  it('shares an active job stop with an overlapping scheduler stop', async () => {
    const child = new WorkerProcess()
    child.exitOnKill = false
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })

    const stopping = job.stop()
    const schedulerStopping = scheduler.stop()
    expect(scheduler.jobs).toContain(job)
    expect(child.signals).toEqual(['SIGTERM'])
    expect(job.stop()).toBe(stopping)

    child.emitExit(0, null)
    await Promise.all([stopping, schedulerStopping])
    expect(child.signals).toEqual(['SIGTERM'])
    expect(scheduler.jobs).toHaveLength(0)
    expect(scheduler.started).toBe(false)
  })

  it('rejects serialization and synchronous fork setup failures in the public promise', async () => {
    const scheduler = await loadScheduler()
    const circular = {}
    circular.self = circular
    const serializationFailure = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true }, circular)
    await expect(serializationFailure.finished).rejects.toBeInstanceOf(Error)
    expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'finished', lastOutcome: 'failed', failures: 1 })
    expect(forkMock).not.toHaveBeenCalled()

    forkMock.mockImplementationOnce(() => {
      throw new Error('synchronous spawn failure')
    })
    const forkFailure = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true })
    await expect(forkFailure.finished).rejects.toThrow('synchronous spawn failure')
    expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'finished', lastOutcome: 'failed', failures: 1 })
  })

  it('does not reschedule an active repeating job stopped before completion', async () => {
    const child = new WorkerProcess()
    child.exitOnKill = false
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({ name: 'render-page', immediate: true, worker: true, repeat: true, schedule: 'PT1S' })

    const stopping = job.stop()
    expect(scheduler.jobs).toContain(job)
    child.emitExit(0, null)
    await stopping
    vi.advanceTimersByTime(10_000)

    expect(forkMock).toHaveBeenCalledOnce()
    expect(scheduler.jobs).toHaveLength(0)
    expect(scheduler.snapshot().jobs[0]).toMatchObject({ state: 'stopped', lastOutcome: 'stopped' })
  })


  it('observes waiting, running, completion and the next repeated invocation without exposing worker data', async () => {
    const child = new WorkerProcess()
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({name:'render-page', worker:true, repeat:true, schedule:'PT5M'}, {secret:'private payload'})
    expect(scheduler.snapshot().jobs[0]).toMatchObject({state:'waiting', runs:0, lastOutcome:null})
    expect(scheduler.snapshot().jobs[0].nextRunAt).not.toBeNull()
    vi.advanceTimersByTime(300000)
    expect(scheduler.snapshot().jobs[0]).toMatchObject({state:'running', runs:1, nextRunAt:null})
    child.emitExit(0, null)
    await job.finished
    expect(scheduler.snapshot().jobs[0]).toMatchObject({state:'waiting', runs:1, failures:0, lastOutcome:'succeeded'})
    expect(JSON.stringify(scheduler.snapshot())).not.toContain('private payload')
    const copied = scheduler.snapshot()
    copied.jobs[0].state = 'failed'
    expect(scheduler.snapshot().jobs[0].state).toBe('waiting')
    await scheduler.stop()
    expect(scheduler.snapshot()).toMatchObject({started:false, jobs:[{state:'stopped', nextRunAt:null}]})
  })

  it('retains failed execution observations without raw stderr, then observes recovery', async () => {
    const child = new WorkerProcess()
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()
    const job = scheduler.registerJob({name:'render-page', worker:true, repeat:true, immediate:true, schedule:'PT5M'})
    child.stderr.write('credential-bearing error')
    child.emitExit(1, null)
    const executionError = await job.finished.catch(error => error)
    expect(executionError).toMatchObject({ exitCode: 1, stderr: 'credential-bearing error' })
    expect(scheduler.snapshot().jobs[0]).toMatchObject({state:'waiting', lastOutcome:'failed', failures:1})
    expect(JSON.stringify(scheduler.snapshot())).not.toContain('credential-bearing')
    const recovered = new WorkerProcess()
    forkMock.mockReturnValue(recovered)
    vi.advanceTimersByTime(300000)
    recovered.emitExit(0, null)
    await job.finished
    expect(scheduler.snapshot().jobs[0]).toMatchObject({lastOutcome:'succeeded', runs:2, failures:1})
    await scheduler.stop()
  })

  it('records offline skips and retains a bounded history of completed tasks', async () => {
    const scheduler = await loadScheduler({syncGraphLocales:{offlineSkip:true,repeat:true}})
    global.WIKI.config.offline = true
    scheduler.start()
    expect(scheduler.snapshot().jobs[0]).toMatchObject({name:'sync-graph-locales',state:'skipped',runs:0})
    for(let i=0;i<55;i++) {
      const child = new WorkerProcess()
      forkMock.mockReturnValue(child)
      const job = scheduler.registerJob({name:'render-page',worker:true,immediate:true})
      child.emitExit(0, null)
      await job.finished
    }
    expect(scheduler.snapshot().jobs.filter(job=>job.state==='finished')).toHaveLength(50)
    expect(scheduler.jobs).toHaveLength(0)
    await scheduler.stop()
  })
})
