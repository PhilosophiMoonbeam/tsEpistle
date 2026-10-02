import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'
import '../../../test/browser-dom.mts'
import {
  EMPTY_MARKDOWN_FORMAT_STATE,
  FORMATTING_TOOLS,
  describeMarkdownFormatState,
  formatShortcut,
  markdownFormatStateFromPath,
  toolTooltip
} from './formatting-tools.ts'
import { moveRovingFocus, rovingToolbarItems, syncRovingToolbar, vRovingToolbar } from './roving-toolbar.ts'

afterEach(() => {
  document.body.replaceChildren()
})

describe('shared formatting tools', () => {
  it('renders platform shortcuts in tooltips but not in accessible names', () => {
    expect(formatShortcut('Mod-b', false)).toBe('Ctrl+B')
    expect(formatShortcut('Mod-Shift-z', true)).toBe('⌘⇧Z')
    expect(toolTooltip('Bold', FORMATTING_TOOLS.bold, false)).toBe('Bold (Ctrl+B)')
    expect(toolTooltip('Highlight', FORMATTING_TOOLS.highlight, false)).toBe('Highlight')
  })

  it('uses a content-extension icon instead of the QR code icon', () => {
    expect(FORMATTING_TOOLS.contentExtension.icon).toBe('mdi-puzzle-outline')
    expect(Object.values(FORMATTING_TOOLS).every(tool => tool.labelKey.startsWith('editor:markup.'))).toBe(true)
  })

  it('derives Markdown toolbar state from the innermost syntax path', () => {
    const state = markdownFormatStateFromPath(['StrongEmphasis', 'Paragraph', 'ListItem', 'BulletList', 'ListItem', 'OrderedList', 'Document'])
    expect(state.bold).toBe(true)
    expect(state.italic).toBe(false)
    expect(state.unorderedList).toBe(true)
    expect(state.orderedList).toBe(false)
    expect(markdownFormatStateFromPath(['ATXHeading2', 'Document']).headingLevel).toBe(2)
    expect(markdownFormatStateFromPath(['Document'])).toEqual(EMPTY_MARKDOWN_FORMAT_STATE)
    const label = (key: string, values?: Record<string, unknown>) => (values ? `${key}:${values.level}` : key)
    expect(describeMarkdownFormatState(markdownFormatStateFromPath(['Emphasis', 'ATXHeading3']), label)).toBe(
      'editor:markup.headingShort:3 · editor:markup.italic'
    )
  })
})

const mountToolbar = (markup: string) => {
  const root = document.createElement('div')
  root.setAttribute('role', 'toolbar')
  root.innerHTML = markup
  document.body.append(root)
  return root
}

describe('roving toolbar focus', () => {
  it('keeps one tab stop and moves with arrows, Home and End', () => {
    const root = mountToolbar('<button id="a">A</button><button id="b" disabled>B</button><button id="c" aria-disabled="true">C</button><button id="d">D</button>')
    let escaped = 0
    vRovingToolbar.mounted?.(root, { value: { onEscape: () => escaped++ } } as never, null as never, null as never)

    expect(rovingToolbarItems(root).map(item => item.id)).toEqual(['a', 'c', 'd'])
    expect(rovingToolbarItems(root).map(item => item.tabIndex)).toEqual([0, -1, -1])
    root.querySelector<HTMLButtonElement>('#a')?.focus()

    root.querySelector('#a')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement?.id).toBe('c')
    expect(root.querySelector<HTMLButtonElement>('#c')?.tabIndex).toBe(0)
    expect(root.querySelector<HTMLButtonElement>('#a')?.tabIndex).toBe(-1)

    root.querySelector('#c')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement?.id).toBe('d')
    root.querySelector('#d')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement?.id).toBe('a')
    root.querySelector('#a')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(escaped).toBe(1)
  })

  it('reverses arrow keys in right-to-left layouts and ignores nested toolbars', () => {
    const root = mountToolbar('<button id="a">A</button><button id="b">B</button><div role="toolbar"><button id="nested">N</button></div>')
    root.setAttribute('dir', 'rtl')
    syncRovingToolbar(root)
    root.querySelector<HTMLButtonElement>('#a')?.focus()

    expect(rovingToolbarItems(root).map(item => item.id)).toEqual(['a', 'b'])
    expect(moveRovingFocus(root, 'ArrowLeft')).toBe(true)
    expect(document.activeElement?.id).toBe('b')
    expect(moveRovingFocus(root, 'PageDown')).toBe(false)
  })

  it('uses Up and Down for a vertical toolbar', () => {
    const root = mountToolbar('<button id="a">A</button><button id="b">B</button>')
    root.setAttribute('aria-orientation', 'vertical')
    syncRovingToolbar(root)
    root.querySelector<HTMLButtonElement>('#a')?.focus()

    expect(moveRovingFocus(root, 'ArrowRight')).toBe(false)
    expect(moveRovingFocus(root, 'ArrowDown')).toBe(true)
    expect(document.activeElement?.id).toBe('b')
  })
})
