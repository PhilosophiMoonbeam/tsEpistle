import { afterAll, beforeAll, expect, it, vi } from '../../server/test/bun-test.mts'

const previousAbortController = Object.getOwnPropertyDescriptor(globalThis, 'AbortController')
let readerCitedCopyText: typeof import('./reader-cited-copy.ts').readerCitedCopyText
let hydrateReaderCitedCopy: typeof import('./reader-cited-copy.ts').hydrateReaderCitedCopy
let appContext: import('vue').AppContext
beforeAll(async () => {
  Object.defineProperty(globalThis, 'AbortController', { configurable: true, writable: true, value: window.AbortController })
  // Keep sibling action presentation outside this isolated DOM-extraction regression.
  vi.mockModule('../components/common/cited-copy-action.vue', import.meta.url, () => ({ default: { inheritAttrs: false, render: () => null } }))
  const helpers = await import('./reader-cited-copy.ts')
  readerCitedCopyText = helpers.readerCitedCopyText
  hydrateReaderCitedCopy = helpers.hydrateReaderCitedCopy
  appContext = (await import('vue')).createApp({ render: () => null })._context
})
afterAll(() => {
  if (previousAbortController) Object.defineProperty(globalThis, 'AbortController', previousAbortController)
  else Reflect.deleteProperty(globalThis, 'AbortController')
})

it('copies the visible nested summary without admitting closed or hidden disclosure bodies', () => {
  const root = document.createElement('article')
  let retire: (() => void) | undefined
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
    const expected = 'Outer contract\n\nVisible +7% and -$10.\n\nNested summary €5.'
    expect(readerCitedCopyText(disclosure, root)).toBe(expected)
    retire = hydrateReaderCitedCopy(root, {
      appContext, identity: 'public-reader', hintIdPrefix: 'reader-copy-test',
      source: () => null, isCurrent: () => true, unavailable: 'Source unavailable'
    })
    expect(readerCitedCopyText(disclosure, root)).toBe(expected)
  } finally {
    retire?.()
    root.remove()
  }
})
