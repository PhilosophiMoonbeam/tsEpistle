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

describe('page action events', () => {
  test.each(pageActionCases)('emit%s emits the shared %s event', (suffix, eventName) => {
    const root = createRoot()

    pageActionEvents[`emit${suffix}`](root)

    expect(root.$emit).toHaveBeenCalledWith(eventName)
  })

  test.each(pageActionCases)('on%s subscribes to the shared %s event', (suffix, eventName) => {
    const root = createRoot()
    const handler = jest.fn()

    pageActionEvents[`on${suffix}`](root, handler)

    expect(root.$on).toHaveBeenCalledWith(eventName, handler)
  })

  test.each(pageActionCases)('off%s unsubscribes from the shared %s event with the same handler', (suffix, eventName) => {
    const root = createRoot()
    const handler = jest.fn()

    pageActionEvents[`off${suffix}`](root, handler)

    expect(root.$off).toHaveBeenCalledWith(eventName, handler)
  })

  test.each(pageActionCases)('off%s does not broadly unsubscribe without a handler', (suffix) => {
    const root = createRoot()

    pageActionEvents[`off${suffix}`](root)

    expect(root.$off).not.toHaveBeenCalled()
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
    }

    expect(offenders).toEqual([])
  })
})
