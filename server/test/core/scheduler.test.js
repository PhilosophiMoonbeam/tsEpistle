/** @vitest-environment node */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: forkMock }))

const loadScheduler = async (jobs = {}) => {
  vi.resetModules()
  global.WIKI = {
    ROOTPATH: '/wiki',
    config: { offline: false },
    data: { jobs },
    logger: { warn: vi.fn() }
  }
  return (await import('../../core/scheduler.ts')).default
}

class WorkerProcess extends EventEmitter {
  exitCode = null
  killed = false
  stderr = new PassThrough()

  kill(signal) {
    this.killed = true
    this.emit('exit', null, signal)
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

  it('serializes worker payloads and terminates an active child during shutdown', async () => {
    const child = new WorkerProcess()
    forkMock.mockReturnValue(child)
    const scheduler = await loadScheduler()

    scheduler.registerJob({ name: 'render-page', immediate: true, worker: true }, { pageId: 7 })
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledOnce())

    expect(forkMock.mock.calls[0][1]).toEqual([
      '--job=render-page',
      '--data={"pageId":7}'
    ])

    await scheduler.stop()

    expect(child.killed).toBe(true)
    expect(scheduler.jobs).toHaveLength(0)
  })
})
