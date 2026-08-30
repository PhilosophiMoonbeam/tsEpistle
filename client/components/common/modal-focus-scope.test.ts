import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { JSDOM } from 'jsdom'
import { createModalFocusScope } from './modal-focus-scope.ts'

const doms: JSDOM[] = []

afterEach(() => {
  while (doms.length > 0) doms.pop()?.window.close()
})

describe('modal focus scope', () => {
  test('isolates background, wraps keyboard focus, dismisses, and restores the trigger', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
      <main aria-hidden="false"><button id="trigger">Search</button><a href="/background">Background</a></main>
      <div id="surface"><section id="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <textarea id="composer"></textarea><button id="close">Close</button>
      </section></div><div class="v-overlay-container"></div>
    </body></html>`,
      { pretendToBeVisual: true }
    )
    doms.push(dom)
    const document = dom.window.document
    const trigger = document.querySelector<HTMLElement>('#trigger')!
    const background = document.querySelector<HTMLElement>('main')!
    const root = document.querySelector<HTMLElement>('#dialog')!
    const composer = document.querySelector<HTMLElement>('#composer')!
    const close = document.querySelector<HTMLElement>('#close')!
    for (const element of [trigger, background, root, composer, close]) {
      element.getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList
    }

    trigger.focus()
    let escapes = 0
    const scope = createModalFocusScope({
      root,
      restoreTarget: trigger,
      onEscape: () => {
        escapes += 1
      }
    })

    expect(background.inert).toBe(true)
    expect(background.getAttribute('aria-hidden')).toBe('true')
    scope.focusFirst()
    expect(document.activeElement).toBe(composer)
    trigger.focus()
    expect(document.activeElement).toBe(composer)

    close.focus()
    close.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(composer)
    composer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(close)

    const overlay = document.createElement('div')
    overlay.className = 'v-overlay--active'
    const overlayButton = document.createElement('button')
    overlayButton.getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList
    overlay.append(overlayButton)
    document.querySelector('.v-overlay-container')!.append(overlay)
    overlayButton.focus()
    expect(document.activeElement).toBe(overlayButton)

    composer.focus()
    composer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(escapes).toBe(1)

    scope.deactivate()
    expect(background.inert).toBe(false)
    expect(background.getAttribute('aria-hidden')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })
})
