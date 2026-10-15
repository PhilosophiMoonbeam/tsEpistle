import { afterEach, describe, expect, it } from '../../server/test/bun-test.mts'
import { browserWindow, document } from '../test/browser-dom.mts'
import { captureDiscussionAnchor, discussionAnchorRange, indexDiscussionText, locateDiscussionAnchor, normalizeDiscussionQuote } from './discussion-anchors.ts'

const roots: HTMLElement[] = []
afterEach(() => {
  browserWindow.getSelection()?.removeAllRanges()
  for (const root of roots.splice(0)) root.remove()
})
function article(html: string): HTMLElement {
  const root = document.createElement('article')
  root.innerHTML = html
  document.body.append(root)
  roots.push(root)
  return root
}
describe('reader passage anchors', () => {
  it('captures actual reader selection with normalized Unicode, heading/context and safe source offsets', () => {
    const root = article('<h2>Introduction</h2><p>Before <em>Cafe\u0301</em>   passage after.</p>')
    const start = root.querySelector('em')!.firstChild!
    const end = root.querySelector('p')!.lastChild!
    const range = document.createRange()
    range.setStart(start, 0)
    range.setEnd(end, 10)
    const selection = browserWindow.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const anchor = captureDiscussionAnchor(root, selection)!
    expect(anchor).not.toBeNull()
    expect(anchor.exact).toBe('Café passage')
    expect(anchor.heading).toBe('Introduction')
    expect(anchor.prefix).toContain('Before ')
    const before = root.innerHTML
    const match = discussionAnchorRange(indexDiscussionText(root), anchor)
    expect(match.status).toBe('found')
    if (match.status === 'found') expect(normalizeDiscussionQuote(match.range.toString())).toBe('Café passage')
    expect(root.innerHTML).toBe(before)
  })
  it('reanchors across inline reader decorations and changed whitespace without rewriting article markup', () => {
    const root = article('<p>Before <span>Café</span> <a href="?glossary=Passage">passage</a> after.</p>')
    const anchor = { exact: 'Cafe\u0301  passage', prefix: 'Before ', suffix: ' after.', heading: null, offset: 999 }
    const before = root.innerHTML
    const match = discussionAnchorRange(indexDiscussionText(root), anchor)
    expect(match.status).toBe('found')
    if (match.status === 'found') expect(match.range.toString()).toBe('Café passage')
    expect(root.innerHTML).toBe(before)
  })
  it('never uses a saved offset to guess among repeated quotes, but accepts unique context or heading', () => {
    const text = 'First repeat here. Second repeat there.'
    const anchor = { exact: 'repeat', prefix: '', suffix: '', heading: null, offset: 6 }
    expect(locateDiscussionAnchor(text, anchor)).toEqual({ status: 'ambiguous' })
    expect(locateDiscussionAnchor(text, { ...anchor, prefix: 'Second ', suffix: ' there.' })).toEqual({ status: 'found', start: 26, end: 32 })
    expect(locateDiscussionAnchor(text, { ...anchor, heading: 'Second section' }, offset => (offset > 20 ? 'Second section' : 'First section'))).toEqual({
      status: 'found',
      start: 26,
      end: 32
    })
    expect(locateDiscussionAnchor(text, { ...anchor, exact: 'Removed passage' })).toEqual({ status: 'missing' })
    expect(locateDiscussionAnchor(text, { ...anchor, prefix: 'Old context ' })).toEqual({ status: 'ambiguous' })
  })
  it('excludes controls/code/custom UI and refuses out-of-article, oversized or excluded selections', () => {
    const root = article(
      '<p data-comment-id="999" data-annotation-id="888">Ordinary passage</p><button>Private control</button><pre>Code passage</pre><wiki-widget>Widget text</wiki-widget>'
    )
    expect(indexDiscussionText(root).text).toBe('Ordinary passage')
    const range = document.createRange()
    range.selectNodeContents(root.querySelector('button')!)
    const selection = browserWindow.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(captureDiscussionAnchor(root, selection)).toBeNull()
    const outside = article('<p>Outside passage</p>')
    range.selectNodeContents(outside)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(captureDiscussionAnchor(root, selection)).toBeNull()
    root.innerHTML = `<p>${'x'.repeat(1001)}</p>`
    range.selectNodeContents(root.querySelector('p')!)
    selection.removeAllRanges()
    selection.addRange(range)
    expect(captureDiscussionAnchor(root, selection)).toBeNull()
  })
})
