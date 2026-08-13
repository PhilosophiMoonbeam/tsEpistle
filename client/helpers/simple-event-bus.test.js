import { createEventBus } from './simple-event-bus.ts'

describe('simple event bus', () => {
  test('emits synchronously and forwards all payload arguments', () => {
    const bus = createEventBus()
    const calls = []

    bus.on('event', (first, second) => {
      calls.push([first, second])
    })
    bus.emit('event', 'one', 'two')

    expect(calls).toEqual([['one', 'two']])
  })

  test('unsubscribes only the matching handler and ignores missing handlers', () => {
    const bus = createEventBus()
    const first = vi.fn()
    const second = vi.fn()

    bus.on('event', first)
    bus.on('event', second)
    bus.off('event')
    bus.off('event', first)
    bus.emit('event', 'payload')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('payload')
  })

  test('uses an emit snapshot when listeners mutate subscriptions', () => {
    const bus = createEventBus()
    const first = vi.fn(() => bus.off('event', second))
    const second = vi.fn()

    bus.on('event', first)
    bus.on('event', second)
    bus.emit('event')
    bus.emit('event')

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
