
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const { forkMock, inlineJobMock } = vi.hoisted(() => ({ forkMock: vi.fn(), inlineJobMock: vi.fn() }))
vi.mockModule('node:child_process', import.meta.url, () => ({ fork: forkMock }))
vi.mockModule('../../jobs/render-page.ts', import.meta.url, () => ({ default: inlineJobMock }))

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
  pid = 1234
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
    inlineJobMock.mockReset().mockResolvedValue(undefined)
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

  it('admits only two workers, hands closed slots off FIFO, and leaves non-worker jobs independent', async () => {
    const children = Array.from({ length: 4 }, () => new WorkerProcess())
    for (const child of children) forkMock.mockReturnValueOnce(child)
    const scheduler = await loadScheduler()
    const first = scheduler.registerJob({ name: 'first-worker', immediate: true, worker: true })
    const second = scheduler.registerJob({ name: 'second-worker', immediate: true, worker: true })
    const third = scheduler.registerJob({ name: 'third-worker', immediate: true, worker: true })
    const fourth = scheduler.registerJob({ name: 'fourth-worker', immediate: true, worker: true })
    const thirdFinished = third.finished
    let thirdSettled = false
    void thirdFinished.then(() => { thirdSettled = true })

    expect(forkMock).toHaveBeenCalledTimes(2)
    expect(third.process).toBeUndefined()
    expect(fourth.process).toBeUndefined()
    expect(scheduler.snapshot().jobs.find(job => job.name === 'third-worker')).toMatchObject({
      state: 'waiting', runs: 0, lastStartedAt: null, nextRunAt: null
    })
    const inline = scheduler.registerJob({ name: 'render-page', immediate: true }, { pageId: 42 })
    await inline.finished
    expect(inlineJobMock).toHaveBeenCalledWith({ pageId: 42 })
    expect(forkMock).toHaveBeenCalledTimes(2)
    expect(thirdSettled).toBe(false)

    children[0].emit('exit', 0, null)
    await Promise.resolve()
    expect(forkMock).toHaveBeenCalledTimes(2)
    children[0].emit('close', 0, null)
    await first.finished
    expect(forkMock).toHaveBeenCalledTimes(3)
    expect(forkMock.mock.calls[2][1]).toEqual(['--job=third-worker'])
    expect(third.process).toBe(children[2])
    expect(third.finished).toBe(thirdFinished)
    expect(fourth.process).toBeUndefined()
    expect(thirdSettled).toBe(false)

    children[1].emitExit(0, null)
    await second.finished
    expect(forkMock.mock.calls[3][1]).toEqual(['--job=fourth-worker'])
    children[2].emitExit(0, null)
    children[3].emitExit(0, null)
    await Promise.all([thirdFinished, fourth.finished])
    expect(scheduler.jobs).toHaveLength(0)
  })

  it('settles a cancelled queued worker without later forking or repeating it', async () => {
    const children = Array.from({ length: 3 }, () => new WorkerProcess())
    for (const child of children) forkMock.mockReturnValueOnce(child)
    const scheduler = await loadScheduler()
    const first = scheduler.registerJob({ name: 'first-worker', immediate: true, worker: true })
    const second = scheduler.registerJob({ name: 'second-worker', immediate: true, worker: true })
    const cancelled = scheduler.registerJob({ name: 'cancelled-worker', immediate: true, worker: true, repeat: true, schedule: 'PT1S' })
    const next = scheduler.registerJob({ name: 'next-worker', immediate: true, worker: true })
    const finished = cancelled.finished
    const stopping = cancelled.stop()
    expect(cancelled.stop()).toBe(stopping)
    await Promise.all([finished, stopping])
    expect(scheduler.jobs).not.toContain(cancelled)
    expect(scheduler.snapshot().jobs.find(job => job.name === 'cancelled-worker')).toMatchObject({
      state: 'stopped', runs: 0, lastStartedAt: null, nextRunAt: null
    })

    children[0].emitExit(0, null)
    await first.finished
    expect(forkMock.mock.calls[2][1]).toEqual(['--job=next-worker'])
    children[1].emitExit(0, null)
    children[2].emitExit(0, null)
    await Promise.all([second.finished, next.finished])
    vi.advanceTimersByTime(10_000)
    expect(forkMock).toHaveBeenCalledTimes(3)
    expect(scheduler.jobs).toHaveLength(0)
  })

  it('cancels queued workers before shutdown can hand off terminating child slots', async () => {
    const children = Array.from({ length: 2 }, () => new WorkerProcess())
    for (const child of children) {
      child.exitOnKill = false
      forkMock.mockReturnValueOnce(child)
    }
    const scheduler = await loadScheduler()
    const first = scheduler.registerJob({ name: 'first-worker', immediate: true, worker: true })
    const second = scheduler.registerJob({ name: 'second-worker', immediate: true, worker: true })
    const queued = scheduler.registerJob({ name: 'queued-worker', immediate: true, worker: true, repeat: true, schedule: 'PT1S' })
    const stopping = scheduler.stop()
    expect(() => scheduler.registerJob({ name: 'during-shutdown', immediate: true, worker: true })).toThrow('Scheduler is stopping')
    await queued.finished
    expect(queued.process).toBeUndefined()
    expect(children.map(child => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']])
    children[0].emit('exit', 0, null)
    await Promise.resolve()
    expect(forkMock).toHaveBeenCalledTimes(2)
    children[0].emit('close', 0, null)
    children[1].emitExit(0, null)
    await Promise.all([stopping, first.finished, second.finished, queued.stop()])
    vi.advanceTimersByTime(10_000)
    expect(forkMock).toHaveBeenCalledTimes(2)
    expect(scheduler.jobs).toHaveLength(0)
    expect(scheduler.started).toBe(false)
  })

  it('retains an errored live worker slot until both termination and close are confirmed', async () => {
    const children = Array.from({ length: 3 }, () => new WorkerProcess())
    children[0].exitOnKill = false
    for (const child of children) forkMock.mockReturnValueOnce(child)
    const scheduler = await loadScheduler()
    const first = scheduler.registerJob({ name: 'first-worker', immediate: true, worker: true })
    const second = scheduler.registerJob({ name: 'second-worker', immediate: true, worker: true })
    const third = scheduler.registerJob({ name: 'third-worker', immediate: true, worker: true })
    children[0].emit('error', new Error('worker transport failed'))
    children[0].emit('close', 1, null)
    const stopping = first.stop()
    vi.advanceTimersByTime(5_000)
    await expect(stopping).rejects.toMatchObject({ code: 'SCHEDULER_WORKER_TERMINATION_UNCONFIRMED' })
    expect(forkMock).toHaveBeenCalledTimes(2)
    expect(first.process).toBe(children[0])
    children[0].emit('exit', 1, 'SIGKILL')
    await first.finished
    expect(forkMock).toHaveBeenCalledTimes(3)
    children[1].emitExit(0, null)
    children[2].emitExit(0, null)
    await Promise.all([second.finished, third.finished])
  })

  it('hands slots on after queued serialization, synchronous fork, and asynchronous spawn failures', async () => {
    const firstChild = new WorkerProcess()
    const secondChild = new WorkerProcess()
    const spawnFailureChild = new WorkerProcess()
    spawnFailureChild.pid = undefined
    const lastChild = new WorkerProcess()
    forkMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockImplementationOnce(() => { throw new Error('synchronous spawn failure') })
      .mockReturnValueOnce(spawnFailureChild)
      .mockReturnValueOnce(lastChild)
    const scheduler = await loadScheduler()
    const first = scheduler.registerJob({ name: 'first-worker', immediate: true, worker: true })
    const second = scheduler.registerJob({ name: 'second-worker', immediate: true, worker: true })
    const circular = {}
    circular.self = circular
    const serializationFailure = scheduler.registerJob({ name: 'serialization-failure', immediate: true, worker: true }, circular)
    const forkFailure = scheduler.registerJob({ name: 'fork-failure', immediate: true, worker: true })
    const spawnFailure = scheduler.registerJob({ name: 'spawn-failure', immediate: true, worker: true })
    const last = scheduler.registerJob({ name: 'last-worker', immediate: true, worker: true })

    expect(forkMock).toHaveBeenCalledTimes(2)
    firstChild.emitExit(0, null)
    await first.finished
    await expect(serializationFailure.finished).rejects.toBeInstanceOf(Error)
    await expect(forkFailure.finished).rejects.toThrow('synchronous spawn failure')
    expect(spawnFailure.process).toBe(spawnFailureChild)
    expect(last.process).toBeUndefined()
    spawnFailureChild.emit('error', new Error('asynchronous spawn failure'))
    spawnFailureChild.emit('close', -1, null)
    await expect(spawnFailure.finished).rejects.toThrow('asynchronous spawn failure')
    expect(last.process).toBe(lastChild)
    lastChild.emitExit(0, null)
    secondChild.emitExit(0, null)
    await Promise.all([last.finished, second.finished])
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
    expect(scheduler.jobs).toHaveLength(0)
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
    const completedIds = []
    for(let i=0;i<55;i++) {
      const child = new WorkerProcess()
      forkMock.mockReturnValue(child)
      const job = scheduler.registerJob({name:'render-page',worker:true,immediate:true})
      completedIds.push(scheduler.snapshot().jobs.find(observation => observation.state === 'running').id)
      child.emitExit(0, null)
      await job.finished
    }
    expect(scheduler.snapshot().jobs.filter(job=>job.state==='finished')).toHaveLength(50)
    const retainedIds = scheduler.snapshot().jobs.filter(job => job.state === 'finished').map(job => job.id)
    expect([...retainedIds].sort()).toEqual(completedIds.slice(5).sort())
    for (const id of completedIds.slice(0, 5)) expect(retainedIds).not.toContain(id)
    expect(scheduler.jobs).toHaveLength(0)
    await scheduler.stop()
  })
})
