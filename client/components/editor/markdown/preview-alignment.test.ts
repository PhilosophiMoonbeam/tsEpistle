import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'

import { resolveVisiblePreviewTarget, stampDetailsSourceLine } from './preview-alignment'

afterEach(() => {
  document.body.replaceChildren()
})

describe('Markdown preview alignment', () => {
  it('stamps details blocks while preserving their authored attributes', () => {
    expect(stampDetailsSourceLine('<details open>\n<summary>Example</summary>\n', 7)).toBe('<details data-source-line="7" open>\n<summary>Example</summary>\n')
    expect(stampDetailsSourceLine('<section>Example</section>\n', 7)).toBeNull()
  })

  it('uses the visible summary for source lines hidden by collapsed details', () => {
    document.body.innerHTML = `
      <main>
        <details id="outer">
          <summary id="outer-summary">Outer</summary>
          <details id="inner">
            <summary id="inner-summary">Inner</summary>
            <p id="target">Hidden source line</p>
          </details>
        </details>
      </main>
    `
    const outer = document.querySelector<HTMLDetailsElement>('#outer')!
    const inner = document.querySelector<HTMLDetailsElement>('#inner')!
    const target = document.querySelector<HTMLElement>('#target')!

    expect(resolveVisiblePreviewTarget(target).id).toBe('outer-summary')

    outer.open = true
    expect(resolveVisiblePreviewTarget(target).id).toBe('inner-summary')

    inner.open = true
    expect(resolveVisiblePreviewTarget(target)).toBe(target)
  })

  it('falls back to the collapsed details element when no summary exists', () => {
    document.body.innerHTML = '<details><p id="target">Hidden source line</p></details>'
    const target = document.querySelector<HTMLElement>('#target')!

    expect(resolveVisiblePreviewTarget(target)).toBe(target.parentElement)
  })
})
