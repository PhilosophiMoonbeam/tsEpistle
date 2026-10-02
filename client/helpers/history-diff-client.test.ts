import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { HistoryDiffRequest } from './history-diff.ts'
import { createHistoryDiffRenderer, type HistoryDiffWorker } from './history-diff-client.ts'

const request = (overrides: Partial<HistoryDiffRequest> = {}): HistoryDiffRequest => ({
  key: '1:2',
  path: 'home',
  source: 'Original paragraph\n',
  target: 'Updated paragraph\n',
  format: 'line-by-line',
  ...overrides
})

type Listener = (event: { data?: unknown }) => void

// A controllable worker double. Messages are answered only when the test says so.
const createFakeWorker = () => {
  const listeners = new Map<string, Listener[]>()
  const posted: Array<{ id: number, request: HistoryDiffRequest }> = []
  const worker = {
    posted,
    terminate: vi.fn(),
    postMessage: (message: unknown) => {
      posted.push(message as { id: number, request: HistoryDiffRequest })
    },
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    answer (index: number, outcome: unknown) {
      const message = posted[index]
      if (!message) throw new Error(`no message ${index}`)
      for (const listener of listeners.get('message') ?? []) listener({ data: { id: message.id, outcome } })
    },
    emit (type: 'error' | 'messageerror') {
      for (const listener of listeners.get(type) ?? []) listener({})
    }
  }
  return worker
}

const manualTimers = () => {
  const timers: Array<{ callback: () => void, cleared: boolean }> = []
  return {
    timers,
    setTimer: (callback: () => void) => {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle: unknown) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    fire () {
      for (const timer of timers) if (!timer.cleared) timer.callback()
    }
  }
}

describe('history comparison renderer', () => {
  it('renders in the worker and serves repeated requests from the cache', async () => {
    const worker = createFakeWorker()
    const renderer = createHistoryDiffRenderer({ createWorker: () => worker as unknown as HistoryDiffWorker })

    const pending = renderer.render(request())
    expect(worker.posted).toHaveLength(1)
    expect(renderer.peek(request())).toBeUndefined()
    worker.answer(0, { status: 'ready', html: '<b>diff</b>' })
    expect(await pending).toEqual({ status: 'ready', html: '<b>diff</b>' })

    expect(renderer.peek(request())).toEqual({ status: 'ready', html: '<b>diff</b>' })
    expect(await renderer.render(request())).toEqual({ status: 'ready', html: '<b>diff</b>' })
    expect(worker.posted).toHaveLength(1)

    // Another format of the same comparison is a separate render request.
    const sideBySide = renderer.render(request({ format: 'side-by-side' }))
    expect(worker.posted).toHaveLength(2)
    worker.answer(1, { status: 'ready', html: '<i>side</i>' })
    expect(await sideBySide).toEqual({ status: 'ready', html: '<i>side</i>' })
  })

  it('shares one worker job between identical requests in flight', async () => {
    const worker = createFakeWorker()
    const renderer = createHistoryDiffRenderer({ createWorker: () => worker as unknown as HistoryDiffWorker })
    const first = renderer.render(request())
    const second = renderer.render(request())
    expect(worker.posted).toHaveLength(1)
    worker.answer(0, { status: 'empty' })
    expect(await first).toEqual({ status: 'empty' })
    expect(await second).toEqual({ status: 'empty' })
  })

  it('answers equal and oversized texts without copying them to the worker', async () => {
    const createWorker = vi.fn(() => createFakeWorker() as unknown as HistoryDiffWorker)
    const renderer = createHistoryDiffRenderer({ createWorker })
    expect(await renderer.render(request({ source: 'same', target: 'same' }))).toEqual({ status: 'empty' })
    expect(await renderer.render(request({ key: '3:4', source: 'a'.repeat(1_000_001), target: 'b' }))).toEqual({ status: 'limit' })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it.each([false, true])('stops a timed-out worker and retries in a new one (warmed: %s)', async (warmed) => {
    const created: Array<ReturnType<typeof createFakeWorker>> = []
    const timers = manualTimers()
    const renderer = createHistoryDiffRenderer({
      createWorker: () => {
        const worker = createFakeWorker()
        created.push(worker)
        return worker as unknown as HistoryDiffWorker
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    })

    if (warmed) {
      const warm = renderer.render(request({ key: 'warm' }))
      created[0]!.answer(0, { status: 'empty' })
      await warm
    }

    const slow = renderer.render(request())
    const first = created[0]!
    const slowIndex = warmed ? 1 : 0
    expect(first.posted).toHaveLength(slowIndex + 1)
    timers.fire()
    expect(await slow).toEqual({ status: 'timeout' })
    expect(first.terminate).toHaveBeenCalledTimes(1)
    // Timeouts are not cached; a retry starts a fresh worker.
    expect(renderer.peek(request())).toBeUndefined()
    const retry = renderer.render(request())
    expect(created).toHaveLength(2)
    const second = created[1]!
    expect(second.posted).toHaveLength(1)
    expect(second.posted[0]!.request).toEqual(request())
    // A result from the terminated worker cannot finish or cache the retry.
    first.answer(slowIndex, { status: 'ready', html: 'stale' })
    expect(renderer.peek(request())).toBeUndefined()
    expect(second.terminate).not.toHaveBeenCalled()
    second.answer(0, { status: 'ready', html: 'ok' })
    expect(await retry).toEqual({ status: 'ready', html: 'ok' })
    expect(renderer.peek(request())).toEqual({ status: 'ready', html: 'ok' })
    first.answer(slowIndex, { status: 'ready', html: 'late stale' })
    expect(renderer.peek(request())).toEqual({ status: 'ready', html: 'ok' })
    renderer.dispose()
  })

  it('falls back to the page thread when the worker cannot load', async () => {
    const worker = createFakeWorker()
    const createWorker = vi.fn(() => worker as unknown as HistoryDiffWorker)
    const renderer = createHistoryDiffRenderer({ createWorker })
    const pending = renderer.render(request())
    worker.emit('error')
    const outcome = await pending
    expect(outcome.status).toBe('ready')
    expect(worker.terminate).toHaveBeenCalled()
    // A blocked worker is not retried.
    const next = await renderer.render(request({ key: '2:3', source: 'a\n', target: 'b\n' }))
    expect(next.status).toBe('ready')
    expect(createWorker).toHaveBeenCalledTimes(1)
  })

  it('falls back to the page thread when no worker can be created', async () => {
    const renderer = createHistoryDiffRenderer({ createWorker: () => null })
    const outcome = await renderer.render(request())
    expect(outcome.status).toBe('ready')
  })

  it('reports a worker crash during work without repeating the work on the page thread', async () => {
    const worker = createFakeWorker()
    const renderer = createHistoryDiffRenderer({ createWorker: () => worker as unknown as HistoryDiffWorker })
    const warm = renderer.render(request({ key: 'warm' }))
    worker.answer(0, { status: 'empty' })
    await warm
    const pending = renderer.render(request())
    worker.emit('error')
    expect(await pending).toEqual({ status: 'failed' })
    expect(renderer.peek(request())).toBeUndefined()
  })

  it('settles waiting requests and stops the worker on dispose', async () => {
    const worker = createFakeWorker()
    const renderer = createHistoryDiffRenderer({ createWorker: () => worker as unknown as HistoryDiffWorker })
    const pending = renderer.render(request())
    renderer.dispose()
    expect(await pending).toEqual({ status: 'failed' })
    expect(worker.terminate).toHaveBeenCalled()
    expect(await renderer.render(request())).toEqual({ status: 'failed' })
  })

  it('computes comparisons in a real module worker', async () => {
    const renderer = createHistoryDiffRenderer()
    try {
      const outcome = await renderer.render(request())
      expect(outcome.status).toBe('ready')
      if (outcome.status === 'ready') expect(outcome.html).toContain('d2h-ins')
    } finally {
      renderer.dispose()
    }
  })
})
