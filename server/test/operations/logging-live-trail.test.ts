import { LoggingLiveTrailBroker } from '../../operations/logging-live-trail.ts'
import { describe, expect, it } from '../bun-test.mts'

describe('LoggingLiveTrailBroker', () => {
  it('closes a stalled subscriber with one overflow observation instead of retaining an unbounded queue', async () => {
    const broker = new LoggingLiveTrailBroker({ maxPendingEvents: 2, maxPendingBytes: 1024 })
    const source = broker.subscribe()

    broker.publish({ timestamp: new Date('2026-02-01T00:00:00.000Z'), level: 'info', output: 'first' })
    broker.publish({ timestamp: new Date('2026-02-01T00:00:01.000Z'), level: 'info', output: 'second' })
    broker.publish({ timestamp: new Date('2026-02-01T00:00:02.000Z'), level: 'info', output: 'third' })

    await expect(source.next()).resolves.toEqual({ value: { type: 'overflow' }, done: false })
    await expect(source.next()).resolves.toEqual({ value: undefined, done: true })
    expect(source.pendingEvents).toBe(0)
    expect(source.pendingBytes).toBe(0)
    expect(broker.subscriberCount).toBe(0)
  })

  it('applies the byte bound before a stalled subscription retains a large record', async () => {
    const broker = new LoggingLiveTrailBroker({ maxPendingEvents: 10, maxPendingBytes: 1 })
    const source = broker.subscribe()

    broker.publish({ timestamp: new Date('2026-02-01T00:00:00.000Z'), level: 'info', output: 'large record' })

    await expect(source.next()).resolves.toEqual({ value: { type: 'overflow' }, done: false })
    expect(source.pendingBytes).toBe(0)
    expect(broker.subscriberCount).toBe(0)
  })

  it('releases a subscriber that stops consuming records', async () => {
    const broker = new LoggingLiveTrailBroker()
    const source = broker.subscribe()

    await source.return?.()

    expect(broker.subscriberCount).toBe(0)
  })
})
