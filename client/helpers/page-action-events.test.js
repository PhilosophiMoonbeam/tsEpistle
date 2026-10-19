import * as pageActionEvents from './page-action-events.ts'

const { PAGE_EDIT_EVENT, PAGE_HISTORY_EVENT, PAGE_SOURCE_EVENT, PAGE_CONVERT_EVENT, PAGE_DUPLICATE_EVENT, PAGE_MOVE_EVENT, PAGE_DELETE_EVENT } =
  pageActionEvents

const pageActionCases = [
  ['PageEdit', PAGE_EDIT_EVENT],
  ['PageHistory', PAGE_HISTORY_EVENT],
  ['PageSource', PAGE_SOURCE_EVENT],
  ['PageConvert', PAGE_CONVERT_EVENT],
  ['PageDuplicate', PAGE_DUPLICATE_EVENT],
  ['PageMove', PAGE_MOVE_EVENT],
  ['PageDelete', PAGE_DELETE_EVENT]
]

describe('page action events', () => {
  test.each(pageActionCases)('emit%s delivers only to its own channel without payload', suffix => {
    const listeners = pageActionCases.map(([name]) => {
      const handler = vi.fn()
      pageActionEvents[`on${name}`](handler)
      return [name, handler]
    })
    try {
      pageActionEvents[`emit${suffix}`]()
      for (const [name, handler] of listeners) {
        expect(handler.mock.calls).toEqual(name === suffix ? [[]] : [])
      }
    } finally {
      for (const [name, handler] of listeners) pageActionEvents[`off${name}`](handler)
    }
  })

  test.each(pageActionCases)('off%s removes only the selected listener', suffix => {
    const handler = vi.fn()
    const sibling = vi.fn()
    pageActionEvents[`on${suffix}`](handler)
    pageActionEvents[`on${suffix}`](sibling)
    try {
      pageActionEvents[`off${suffix}`](handler)
      pageActionEvents[`emit${suffix}`]()
      expect(handler).not.toHaveBeenCalled()
      expect(sibling.mock.calls).toEqual([[]])
    } finally {
      pageActionEvents[`off${suffix}`](handler)
      pageActionEvents[`off${suffix}`](sibling)
    }
  })

  test.each(pageActionCases)('off%s preserves all listeners without a handler', suffix => {
    const handler = vi.fn()
    const sibling = vi.fn()
    pageActionEvents[`on${suffix}`](handler)
    pageActionEvents[`on${suffix}`](sibling)
    try {
      pageActionEvents[`off${suffix}`]()
      pageActionEvents[`emit${suffix}`]()
      expect(handler.mock.calls).toEqual([[]])
      expect(sibling.mock.calls).toEqual([[]])
    } finally {
      pageActionEvents[`off${suffix}`](handler)
      pageActionEvents[`off${suffix}`](sibling)
    }
  })
})
