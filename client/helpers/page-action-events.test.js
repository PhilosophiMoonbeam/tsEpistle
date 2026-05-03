const fs = require('fs')
const path = require('path')

const pageActionEvents = require('./page-action-events')

const {
  PAGE_EDIT_EVENT,
  PAGE_HISTORY_EVENT,
  PAGE_SOURCE_EVENT,
  PAGE_CONVERT_EVENT,
  PAGE_DUPLICATE_EVENT,
  PAGE_MOVE_EVENT,
  PAGE_DELETE_EVENT
} = pageActionEvents

const repoRoot = path.resolve(__dirname, '../..')
const helperPath = path.join(repoRoot, 'client/helpers/page-action-events.js')
const guardedFiles = [
  'client/themes/default/components/page.vue',
  'client/components/common/nav-header.vue'
]
const pageActionEventNames = [
  PAGE_EDIT_EVENT,
  PAGE_HISTORY_EVENT,
  PAGE_SOURCE_EVENT,
  PAGE_CONVERT_EVENT,
  PAGE_DUPLICATE_EVENT,
  PAGE_MOVE_EVENT,
  PAGE_DELETE_EVENT
]
const pageActionCases = [
  ['PageEdit', PAGE_EDIT_EVENT],
  ['PageHistory', PAGE_HISTORY_EVENT],
  ['PageSource', PAGE_SOURCE_EVENT],
  ['PageConvert', PAGE_CONVERT_EVENT],
  ['PageDuplicate', PAGE_DUPLICATE_EVENT],
  ['PageMove', PAGE_MOVE_EVENT],
  ['PageDelete', PAGE_DELETE_EVENT]
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

describe('page action events', () => {
  test.each(pageActionCases)('emit%s emits the shared %s event', (suffix) => {
    const handler = jest.fn()
    pageActionEvents[`on${suffix}`](handler)

    pageActionEvents[`emit${suffix}`]()

    expect(handler).toHaveBeenCalledTimes(1)
    pageActionEvents[`off${suffix}`](handler)
  })

  test.each(pageActionCases)('off%s unsubscribes from the shared %s event with the same handler', (suffix) => {
    const handler = jest.fn()
    pageActionEvents[`on${suffix}`](handler)
    pageActionEvents[`off${suffix}`](handler)

    pageActionEvents[`emit${suffix}`]()

    expect(handler).not.toHaveBeenCalled()
  })

  test.each(pageActionCases)('off%s does not broadly unsubscribe without a handler', (suffix) => {
    const handler = jest.fn()
    pageActionEvents[`on${suffix}`](handler)
    pageActionEvents[`off${suffix}`]()

    pageActionEvents[`emit${suffix}`]()

    expect(handler).toHaveBeenCalledTimes(1)
    pageActionEvents[`off${suffix}`](handler)
  })
})

describe('page action event usage', () => {
  test('page action components use the helper instead of direct root bus page action events', () => {
    const offenders = []

    for (const relPath of guardedFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')

      for (const eventName of pageActionEventNames) {
        const pattern = directRootEventPattern(eventName)
        let match

        while ((match = pattern.exec(content)) !== null) {
          offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root event for ${eventName}`)
        }
      }

      expect(content).not.toMatch(/emitPage(?:Edit|History|Source|Convert|Duplicate|Move|Delete)\s*\(\s*this\.\$root/)
      expect(content).not.toMatch(/onPage(?:Edit|History|Source|Convert|Duplicate|Move|Delete)\s*\(\s*this\.\$root/)
      expect(content).not.toMatch(/offPage(?:Edit|History|Source|Convert|Duplicate|Move|Delete)\s*\(\s*this\.\$root/)
    }

    expect(offenders).toEqual([])
  })

  test('page action helper owns its bus instead of requiring caller root instances', () => {
    const source = fs.readFileSync(helperPath, 'utf8')

    expect(source).toMatch(/const\s+Vue\s*=\s*require\(\s*['"]vue['"]\s*\)/)
    expect(source).toMatch(/new\s+Vue\s*\(\s*\)/)
    expect(source).not.toMatch(/function\s+\w+\s*\(\s*root\b/)
    expect(source).not.toMatch(/\broot\s*\.\s*\$(?:emit|on|off)\b/)
  })
})
