import {
  emitSearchEnter,
  emitSearchMove,
  emitSearchExit,
  emitSearchFocus,
  onSearchEnter,
  onSearchMove,
  onSearchExit,
  onSearchFocus,
  offSearchEnter,
  offSearchMove,
  offSearchExit,
  offSearchFocus
} from './search-navigation-events.ts'

const searchCases = [
  ['Enter', emitSearchEnter, onSearchEnter, offSearchEnter, [], [true]],
  ['Move', emitSearchMove, onSearchMove, offSearchMove, ['down'], ['down']],
  ['Exit', emitSearchExit, onSearchExit, offSearchExit, [false], [false]],
  ['Focus', emitSearchFocus, onSearchFocus, offSearchFocus, [], []]
]

describe('search navigation events', () => {
  test.each(searchCases)('emitSearch%s delivers its exact payload only to its own channel', (name, emit, on, off, args, payload) => {
    const listeners = searchCases.map(([channel, , subscribe, unsubscribe]) => {
      const handler = vi.fn()
      subscribe(handler)
      return [channel, handler, unsubscribe]
    })
    try {
      emit(...args)
      for (const [channel, handler] of listeners) {
        expect(handler.mock.calls).toEqual(channel === name ? [payload] : [])
      }
    } finally {
      for (const [, handler, unsubscribe] of listeners) unsubscribe(handler)
    }
  })

  test.each(searchCases)('offSearch%s removes only the selected listener', (name, emit, on, off, args, payload) => {
    const handler = vi.fn()
    const sibling = vi.fn()
    on(handler)
    on(sibling)
    try {
      off(handler)
      emit(...args)
      expect(handler).not.toHaveBeenCalled()
      expect(sibling.mock.calls).toEqual([payload])
    } finally {
      off(handler)
      off(sibling)
    }
  })

  test.each(searchCases)('offSearch%s preserves all listeners without a handler', (name, emit, on, off, args, payload) => {
    const handler = vi.fn()
    const sibling = vi.fn()
    on(handler)
    on(sibling)
    try {
      off()
      emit(...args)
      expect(handler.mock.calls).toEqual([payload])
      expect(sibling.mock.calls).toEqual([payload])
    } finally {
      off(handler)
      off(sibling)
    }
  })

  test('emitSearchMove preserves an upward direction', () => {
    const handler = vi.fn()
    onSearchMove(handler)
    try {
      emitSearchMove('up')
      expect(handler.mock.calls).toEqual([['up']])
    } finally {
      offSearchMove(handler)
    }
  })
})
