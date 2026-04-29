const fs = require('fs')
const path = require('path')

const {
  SEARCH_ENTER_EVENT,
  SEARCH_MOVE_EVENT,
  emitSearchEnter,
  emitSearchMove,
  onSearchEnter,
  onSearchMove,
  offSearchEnter,
  offSearchMove
} = require('./search-navigation-events')

const repoRoot = path.resolve(__dirname, '../..')
const guardedFiles = [
  'client/components/common/nav-header.vue',
  'client/components/common/search-results.vue'
]

function createRoot () {
  return {
    $emit: jest.fn(),
    $on: jest.fn(),
    $off: jest.fn()
  }
}

function getLineNumber (content, index) {
  return content.slice(0, index).split(/\r?\n/).length
}

function directRootEventPattern (eventName) {
  return new RegExp(
    '\\bthis\\s*\\.\\s*\\$root\\s*\\.\\s*\\$(?:emit|on|off)\\s*\\(\\s*([\'"`])' + eventName + '\\1',
    'g'
  )
}

describe('search navigation events', () => {
  test('emitSearchEnter emits the shared search enter event with the legacy payload', () => {
    const root = createRoot()

    emitSearchEnter(root)

    expect(root.$emit).toHaveBeenCalledWith(SEARCH_ENTER_EVENT, true)
  })

  test('emitSearchMove emits the shared search move event with the direction', () => {
    const root = createRoot()

    emitSearchMove(root, 'down')

    expect(root.$emit).toHaveBeenCalledWith(SEARCH_MOVE_EVENT, 'down')
  })

  test('onSearchEnter subscribes to the shared search enter event', () => {
    const root = createRoot()
    const handler = jest.fn()

    onSearchEnter(root, handler)

    expect(root.$on).toHaveBeenCalledWith(SEARCH_ENTER_EVENT, handler)
  })

  test('onSearchMove subscribes to the shared search move event', () => {
    const root = createRoot()
    const handler = jest.fn()

    onSearchMove(root, handler)

    expect(root.$on).toHaveBeenCalledWith(SEARCH_MOVE_EVENT, handler)
  })

  test('offSearchEnter unsubscribes from the shared search enter event with the same handler', () => {
    const root = createRoot()
    const handler = jest.fn()

    offSearchEnter(root, handler)

    expect(root.$off).toHaveBeenCalledWith(SEARCH_ENTER_EVENT, handler)
  })

  test('offSearchMove unsubscribes from the shared search move event with the same handler', () => {
    const root = createRoot()
    const handler = jest.fn()

    offSearchMove(root, handler)

    expect(root.$off).toHaveBeenCalledWith(SEARCH_MOVE_EVENT, handler)
  })

  test('offSearchEnter does not broadly unsubscribe without a handler', () => {
    const root = createRoot()

    offSearchEnter(root)

    expect(root.$off).not.toHaveBeenCalled()
  })

  test('offSearchMove does not broadly unsubscribe without a handler', () => {
    const root = createRoot()

    offSearchMove(root)

    expect(root.$off).not.toHaveBeenCalled()
  })
})

describe('search navigation event usage', () => {
  test('common search components use the helper instead of direct root bus search events', () => {
    const offenders = []

    for (const relPath of guardedFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')

      for (const eventName of [SEARCH_ENTER_EVENT, SEARCH_MOVE_EVENT]) {
        const pattern = directRootEventPattern(eventName)
        let match

        while ((match = pattern.exec(content)) !== null) {
          offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root event for ${eventName}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
