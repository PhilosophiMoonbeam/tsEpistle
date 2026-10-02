import { exceedsComparisonInputLimits, type HistoryDiffOutcome, type HistoryDiffRequest } from './history-diff.ts'

type HistoryDiffEngine = (request: HistoryDiffRequest) => HistoryDiffOutcome

/** Time the worker gets for one comparison before it is stopped. */
export const HISTORY_DIFF_WORKER_TIMEOUT_MS = 10_000
const OUTCOME_CACHE_SIZE = 8

export type HistoryDiffWorker = {
  postMessage(message: unknown): void
  terminate(): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void
}

export type HistoryDiffRendererOptions = {
  /** Returns a worker, or null when workers are unavailable. */
  readonly createWorker?: () => HistoryDiffWorker | null
  readonly timeoutMs?: number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export type HistoryDiffRenderer = {
  /** Returns a cached outcome without starting work. */
  peek(request: HistoryDiffRequest): HistoryDiffOutcome | undefined
  render(request: HistoryDiffRequest): Promise<HistoryDiffOutcome>
  dispose(): void
}

type Pending = {
  readonly cacheKey: string
  readonly request: HistoryDiffRequest
  readonly resolve: (outcome: HistoryDiffOutcome) => void
  readonly timer: unknown
}

const defaultCreateWorker = (): HistoryDiffWorker | null => {
  if (typeof Worker !== 'function') return null
  // Vite bundles the worker from this exact `new URL(..., import.meta.url)` form.
  return new Worker(new URL('./history-diff.worker.ts', import.meta.url), { type: 'module', name: 'history-diff' })
}

const outcomeCacheKey = (request: HistoryDiffRequest): string => `${request.key}|${request.format}`

/**
 * Renders history comparisons in a Web Worker. Results are cached per
 * content key and format. When no worker can start (unsupported browser or
 * a strict Content-Security-Policy), it uses the same bounded engine on the
 * main thread. A worker that does not answer in time is stopped and the
 * comparison is reported as `timeout`; even a first-job timeout leaves the
 * next request eligible to start a new worker.
 */
export const createHistoryDiffRenderer = (options: HistoryDiffRendererOptions = {}): HistoryDiffRenderer => {
  const createWorker = options.createWorker ?? defaultCreateWorker
  const timeoutMs = options.timeoutMs ?? HISTORY_DIFF_WORKER_TIMEOUT_MS
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>))
  const outcomes = new Map<string, HistoryDiffOutcome>()
  const pending = new Map<number, Pending>()
  let inline: Promise<HistoryDiffEngine> | null = null
  let worker: HistoryDiffWorker | null = null
  let workerUnavailable = false
  let workerAnswered = false
  let nextId = 0
  let disposed = false

  const remember = (cacheKey: string, outcome: HistoryDiffOutcome): void => {
    // Timeouts and failures depend on load, not on the contents; a retry runs again.
    if (outcome.status === 'timeout' || outcome.status === 'failed') return
    outcomes.delete(cacheKey)
    outcomes.set(cacheKey, outcome)
    while (outcomes.size > OUTCOME_CACHE_SIZE) {
      const oldest = outcomes.keys().next().value
      if (oldest === undefined) break
      outcomes.delete(oldest)
    }
  }

  const settle = (id: number, outcome: HistoryDiffOutcome): void => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimer(entry.timer)
    remember(entry.cacheKey, outcome)
    entry.resolve(outcome)
  }

  const stopWorker = (outcome: HistoryDiffOutcome): void => {
    const current = worker
    worker = null
    try {
      current?.terminate()
    } catch {}
    for (const id of [...pending.keys()]) settle(id, outcome)
  }

  // Main-thread fallback. The diff libraries load only when it is needed.
  const runInline = async (request: HistoryDiffRequest): Promise<HistoryDiffOutcome> => {
    inline ??= import('./history-diff-engine.ts').then(module => module.createHistoryDiffEngine())
    try {
      return (await inline)(request)
    } catch {
      inline = null
      return { status: 'failed' }
    }
  }

  const startWorker = (): HistoryDiffWorker | null => {
    if (worker || workerUnavailable) return worker
    try {
      worker = createWorker()
    } catch {
      worker = null
    }
    if (!worker) {
      workerUnavailable = true
      return null
    }
    const started = worker
    workerAnswered = false
    started.addEventListener('message', (event: MessageEvent) => {
      if (started !== worker) return
      workerAnswered = true
      const data: unknown = event.data
      if (!data || typeof data !== 'object') return
      const id = Reflect.get(data, 'id')
      const outcome = Reflect.get(data, 'outcome') as HistoryDiffOutcome | undefined
      if (typeof id !== 'number' || !outcome || typeof outcome.status !== 'string') return
      settle(id, outcome)
    })
    const fail = () => {
      if (started !== worker) return
      if (workerAnswered) {
        // The worker stopped while it was working, for example out of memory.
        // Do not repeat that work on the page thread; report the failure.
        stopWorker({ status: 'failed' })
        return
      }
      // The worker never loaded, for example because a Content-Security-Policy
      // blocks it. Do not retry; finish waiting comparisons on the page thread.
      workerUnavailable = true
      worker = null
      try {
        started.terminate()
      } catch {}
      for (const [id, entry] of [...pending.entries()]) {
        void runInline(entry.request).then(outcome => settle(id, outcome))
      }
    }
    started.addEventListener('error', fail)
    started.addEventListener('messageerror', fail)
    return started
  }

  const peek = (request: HistoryDiffRequest): HistoryDiffOutcome | undefined => {
    const cacheKey = outcomeCacheKey(request)
    const cached = outcomes.get(cacheKey)
    if (cached) {
      outcomes.delete(cacheKey)
      outcomes.set(cacheKey, cached)
    }
    return cached
  }

  const inflight = new Map<string, Promise<HistoryDiffOutcome>>()

  const renderInWorker = (active: HistoryDiffWorker, cacheKey: string, request: HistoryDiffRequest): Promise<HistoryDiffOutcome> => {
    const running = inflight.get(cacheKey)
    if (running) return running
    const id = ++nextId
    const promise = new Promise<HistoryDiffOutcome>(resolve => {
      const timer = setTimer(() => {
        if (!pending.has(id)) return
        // No startup acknowledgement exists; a slow first job is not a load failure.
        stopWorker({ status: 'timeout' })
      }, timeoutMs)
      pending.set(id, { cacheKey, request, resolve, timer })
      try {
        active.postMessage({ id, request })
      } catch {
        settle(id, { status: 'failed' })
      }
    }).finally(() => {
      if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey)
    })
    inflight.set(cacheKey, promise)
    return promise
  }

  return {
    peek,
    render (request) {
      if (disposed) return Promise.resolve({ status: 'failed' })
      const cacheKey = outcomeCacheKey(request)
      const cached = peek(request)
      if (cached) return Promise.resolve(cached)
      if (request.source === request.target) {
        remember(cacheKey, { status: 'empty' })
        return Promise.resolve({ status: 'empty' })
      }
      // Do not copy oversized texts to the worker at all.
      if (exceedsComparisonInputLimits(request.source, request.target)) {
        remember(cacheKey, { status: 'limit' })
        return Promise.resolve({ status: 'limit' })
      }
      const active = startWorker()
      if (!active) {
        return runInline(request).then(outcome => {
          remember(cacheKey, outcome)
          return outcome
        })
      }
      return renderInWorker(active, cacheKey, request)
    },
    dispose () {
      disposed = true
      stopWorker({ status: 'failed' })
      outcomes.clear()
    }
  }
}
