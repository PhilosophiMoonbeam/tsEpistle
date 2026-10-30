import { beforeAll, expect, it, vi } from '../../server/test/bun-test.mts'

let readerCitedCopyText: typeof import('./reader-cited-copy.ts').readerCitedCopyText
beforeAll(async () => {
  // This isolated helper test does not render the sibling action component.
  vi.mockModule('../components/common/cited-copy-action.vue', import.meta.url, () => ({ default: {} }))
  readerCitedCopyText = (await import('./reader-cited-copy.ts')).readerCitedCopyText
})

it('copies the visible nested summary without admitting closed or hidden disclosure bodies', () => {
  const root = document.createElement('article')
  try {
    root.innerHTML = [
      '<details open><summary>Outer contract</summary><p>Visible +7% and -$10.</p>',
      '<details>Closed text before the summary<summary>Nested <strong>summary</strong> €5.</summary>',
      'Closed text after the summary<p>Closed body</p><summary>Not the primary summary</summary></details>',
      '<details hidden><summary>Hidden summary</summary><p>Hidden body</p></details>',
      '<details aria-hidden="true"><summary>Inaccessible summary</summary></details>',
      '</details>'
    ].join('')
    document.body.append(root)
    const disclosure = root.querySelector('details')!
    expect(readerCitedCopyText(disclosure, root)).toBe('Outer contract\n\nVisible +7% and -$10.\n\nNested summary €5.')
  } finally {
    root.remove()
  }
})
