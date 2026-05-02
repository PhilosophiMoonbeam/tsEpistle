const fs = require('fs')
const path = require('path')

const {
  EDITOR_LINK_TO_PAGE_EVENT,
  emitEditorLinkToPage,
  onEditorLinkToPage,
  offEditorLinkToPage
} = require('./editor-link-events')

const repoRoot = path.resolve(__dirname, '../..')
const guardedLinkListenerFiles = [
  'client/components/editor/editor-ckeditor.vue'
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

function directEditorLinkToPagePattern () {
  return /\bthis\s*\.\s*\$root\s*\.\s*\$(?:emit|on|off)\s*\(\s*(['"`])editorLinkToPage\1/g
}

describe('editor link events', () => {
  test('emitEditorLinkToPage emits the shared editor link event with the original payload', () => {
    const root = createRoot()
    const opts = {
      locale: 'en',
      path: 'docs/page'
    }

    emitEditorLinkToPage(root, opts)

    expect(root.$emit).toHaveBeenCalledWith(EDITOR_LINK_TO_PAGE_EVENT, opts)
  })

  test('onEditorLinkToPage subscribes to the shared editor link event', () => {
    const root = createRoot()
    const handler = jest.fn()

    onEditorLinkToPage(root, handler)

    expect(root.$on).toHaveBeenCalledWith(EDITOR_LINK_TO_PAGE_EVENT, handler)
  })

  test('offEditorLinkToPage unsubscribes from the shared editor link event with the same handler', () => {
    const root = createRoot()
    const handler = jest.fn()

    offEditorLinkToPage(root, handler)

    expect(root.$off).toHaveBeenCalledWith(EDITOR_LINK_TO_PAGE_EVENT, handler)
  })

  test('offEditorLinkToPage does not broadly unsubscribe without a handler', () => {
    const root = createRoot()

    offEditorLinkToPage(root)

    expect(root.$off).not.toHaveBeenCalled()
  })
})

describe('editor link event listener usage', () => {
  test('migrated link listeners avoid direct root bus listeners', () => {
    const offenders = []

    for (const relPath of guardedLinkListenerFiles) {
      const filePath = path.join(repoRoot, relPath)
      const content = fs.readFileSync(filePath, 'utf8')
      const pattern = directEditorLinkToPagePattern()
      let match

      while ((match = pattern.exec(content)) !== null) {
        offenders.push(`${relPath}:${getLineNumber(content, match.index)}: direct this.$root listener for ${EDITOR_LINK_TO_PAGE_EVENT}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
