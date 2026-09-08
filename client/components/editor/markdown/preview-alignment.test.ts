import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'

import { PreviewAlignmentScheduler, resolveVisiblePreviewTarget, stampDetailsSourceLine } from './preview-alignment'

afterEach(() => {
  document.body.replaceChildren()
})

describe('Markdown preview alignment', () => {
  it('calls the browser microtask scheduler without rebinding its native receiver', () => {
    const original = globalThis.queueMicrotask
    let aligned = false
    try {
      globalThis.queueMicrotask = function (this: unknown, callback: () => void): void {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
        callback()
      }
      const scheduler = new PreviewAlignmentScheduler(() => true, () => { aligned = true })
      scheduler.request()
      expect(aligned).toBe(true)
    } finally {
      globalThis.queueMicrotask = original
    }
  })

  it('coalesces mouse and keyboard cursor requests and retains explicit alignment', () => {
    const queued: (() => void)[] = []
    const aligned: boolean[] = []
    const scheduler = new PreviewAlignmentScheduler(() => true, force => aligned.push(force), callback => queued.push(callback))
    scheduler.request()
    scheduler.request()
    scheduler.request(true)
    expect(queued).toHaveLength(1)
    queued.shift()!()
    expect(aligned).toEqual([true])
    scheduler.request()
    queued.shift()!()
    expect(aligned).toEqual([true, false])
  })

  it('cancels queued follow when disabled and permits a fresh explicit request on re-enabling', () => {
    const queued: (() => void)[] = []
    const aligned: boolean[] = []
    let enabled = true
    const scheduler = new PreviewAlignmentScheduler(() => enabled, force => aligned.push(force), callback => queued.push(callback))
    scheduler.request()
    enabled = false
    scheduler.cancel()
    scheduler.request()
    enabled = true
    scheduler.request(true)
    queued.shift()!()
    expect(aligned).toEqual([])
    queued.shift()!()
    expect(aligned).toEqual([true])
  })

  it('waits for a fresh enhanced preview after typing and rechecks visibility and disposal at execution', () => {
    const queued: (() => void)[] = []
    const aligned: boolean[] = []
    const state = { enabled: true, dirty: false, shown: true, disposed: false }
    const scheduler = new PreviewAlignmentScheduler(
      () => state.enabled && !state.dirty && state.shown && !state.disposed,
      force => aligned.push(force),
      callback => queued.push(callback)
    )
    // A doc change precedes its keyboard cursor event; neither may use stale source anchors.
    state.dirty = true
    scheduler.request()
    expect(queued).toHaveLength(0)
    state.dirty = false
    scheduler.request(true)
    queued.shift()!()
    expect(aligned).toEqual([true])
    for (const blocked of ['enabled', 'shown', 'disposed'] as const) {
      scheduler.request()
      const previous = state[blocked]
      state[blocked] = !previous
      queued.shift()!()
      expect(aligned).toEqual([true])
      state[blocked] = previous
    }
  })

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
