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
const helperPath = path.join(repoRoot, 'client/helpers/search-navigation-events.js')
const guardedFiles = [
  'client/components/common/nav-header.vue',
  'client/components/common/search-results.vue'
]

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
    const handler = jest.fn()
    onSearchEnter(handler)

    emitSearchEnter()

    expect(handler).toHaveBeenCalledWith(true)
    offSearchEnter(handler)
  })

  test('emitSearchMove emits the shared search move event with the direction', () => {
    const handler = jest.fn()
    onSearchMove(handler)

    emitSearchMove('down')

    expect(handler).toHaveBeenCalledWith('down')
    offSearchMove(handler)
  })

  test('offSearchEnter unsubscribes from the shared search enter event with the same handler', () => {
    const handler = jest.fn()
    onSearchEnter(handler)
    offSearchEnter(handler)

    emitSearchEnter()

    expect(handler).not.toHaveBeenCalled()
  })

  test('offSearchMove unsubscribes from the shared search move event with the same handler', () => {
    const handler = jest.fn()
    onSearchMove(handler)
    offSearchMove(handler)

    emitSearchMove('up')

    expect(handler).not.toHaveBeenCalled()
  })

  test('offSearchEnter does not broadly unsubscribe without a handler', () => {
    const handler = jest.fn()
    onSearchEnter(handler)
    offSearchEnter()

    emitSearchEnter()

    expect(handler).toHaveBeenCalledWith(true)
    offSearchEnter(handler)
  })

  test('offSearchMove does not broadly unsubscribe without a handler', () => {
    const handler = jest.fn()
    onSearchMove(handler)
    offSearchMove()

    emitSearchMove('down')

    expect(handler).toHaveBeenCalledWith('down')
    offSearchMove(handler)
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

      expect(content).not.toMatch(/emitSearch(?:Enter|Move)\s*\(\s*this\.\$root/)
      expect(content).not.toMatch(/onSearch(?:Enter|Move)\s*\(\s*this\.\$root/)
      expect(content).not.toMatch(/offSearch(?:Enter|Move)\s*\(\s*this\.\$root/)
    }

    expect(offenders).toEqual([])
  })

  test('search navigation helper owns its bus instead of requiring caller root instances', () => {
    const source = fs.readFileSync(helperPath, 'utf8')

    expect(source).toMatch(/const\s+Vue\s*=\s*require\(\s*['"]vue['"]\s*\)/)
    expect(source).toMatch(/new\s+Vue\s*\(\s*\)/)
    expect(source).not.toMatch(/function\s+\w+\s*\(\s*root\b/)
    expect(source).not.toMatch(/\broot\s*\.\s*\$(?:emit|on|off)\b/)
  })
})
