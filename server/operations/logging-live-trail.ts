export interface LoggingLiveTrailLine {
  timestamp: Date
  level: string
  output: string
}

export type LoggingLiveTrailDelivery = { type: 'line'; line: LoggingLiveTrailLine } | { type: 'overflow' }

export interface LoggingLiveTrailSource extends AsyncIterableIterator<LoggingLiveTrailDelivery> {
  readonly pendingEvents: number
  readonly pendingBytes: number
}

export interface LoggingLiveTrailBrokerOptions {
  maxPendingEvents?: number
  maxPendingBytes?: number
}

const encoder = new TextEncoder()
const DEFAULT_MAX_PENDING_EVENTS = 64
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024

class BoundedLoggingLiveTrailSource implements LoggingLiveTrailSource {
  readonly #broker: LoggingLiveTrailBroker
  readonly #queue: Array<{ delivery: Extract<LoggingLiveTrailDelivery, { type: 'line' }>; bytes: number }> = []
  #bytes = 0
  #waiting: PromiseWithResolvers<IteratorResult<LoggingLiveTrailDelivery>> | null = null
  #overflowed = false
  #closed = false

  constructor(broker: LoggingLiveTrailBroker) {
    this.#broker = broker
  }

  get pendingEvents(): number {
    return this.#queue.length
  }
  get pendingBytes(): number {
    return this.#bytes
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<LoggingLiveTrailDelivery> {
    return this
  }

  next(): Promise<IteratorResult<LoggingLiveTrailDelivery>> {
    const queued = this.#queue.shift()
    if (queued) {
      this.#bytes -= queued.bytes
      return Promise.resolve({ value: queued.delivery, done: false })
    }
    if (this.#overflowed) {
      this.#overflowed = false
      return Promise.resolve({ value: { type: 'overflow' }, done: false })
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true })
    this.#waiting = Promise.withResolvers<IteratorResult<LoggingLiveTrailDelivery>>()
    return this.#waiting.promise
  }

  return(): Promise<IteratorResult<LoggingLiveTrailDelivery>> {
    this.#finish()
    return Promise.resolve({ value: undefined, done: true })
  }

  throw(error?: unknown): Promise<IteratorResult<LoggingLiveTrailDelivery>> {
    this.#finish()
    return Promise.reject(error)
  }

  push(line: LoggingLiveTrailLine): void {
    if (this.#closed) return
    const delivery = { type: 'line' as const, line }
    if (this.#waiting) {
      const waiting = this.#waiting
      this.#waiting = null
      waiting.resolve({ value: delivery, done: false })
      return
    }
    const bytes = encoder.encode(JSON.stringify(line)).byteLength
    if (this.#queue.length >= this.#broker.maxPendingEvents || this.#bytes + bytes > this.#broker.maxPendingBytes) {
      this.#overflow()
      return
    }
    this.#queue.push({ delivery, bytes })
    this.#bytes += bytes
  }

  #overflow(): void {
    if (this.#closed) return
    this.#closed = true
    this.#overflowed = true
    this.#queue.splice(0)
    this.#bytes = 0
    this.#broker.unsubscribe(this)
    if (this.#waiting) {
      const waiting = this.#waiting
      this.#waiting = null
      this.#overflowed = false
      waiting.resolve({ value: { type: 'overflow' }, done: false })
    }
  }

  #finish(): void {
    if (this.#closed) return
    this.#closed = true
    this.#queue.splice(0)
    this.#bytes = 0
    this.#broker.unsubscribe(this)
    if (this.#waiting) {
      const waiting = this.#waiting
      this.#waiting = null
      waiting.resolve({ value: undefined, done: true })
    }
  }
}

/** A bounded, in-process source for privileged live logging consumers. */
export class LoggingLiveTrailBroker {
  readonly maxPendingEvents: number
  readonly maxPendingBytes: number
  readonly #subscribers = new Set<BoundedLoggingLiveTrailSource>()

  constructor(options: LoggingLiveTrailBrokerOptions = {}) {
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
  }

  subscribe(): LoggingLiveTrailSource {
    const source = new BoundedLoggingLiveTrailSource(this)
    this.#subscribers.add(source)
    return source
  }

  publish(line: LoggingLiveTrailLine): void {
    for (const subscriber of this.#subscribers) subscriber.push(line)
  }

  unsubscribe(source: BoundedLoggingLiveTrailSource): void {
    this.#subscribers.delete(source)
  }

  get subscriberCount(): number {
    return this.#subscribers.size
  }
}
