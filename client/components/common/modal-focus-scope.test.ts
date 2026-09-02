import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { JSDOM } from 'jsdom'
import { createModalFocusScope } from './modal-focus-scope.ts'

const doms: JSDOM[] = []

afterEach(() => {
  while (doms.length > 0) doms.pop()?.window.close()
})

describe('modal focus scope', () => {
  test('isolates background and unrelated overlays, allows owned portals, wraps focus, and restores the trigger', async () => {
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
    const ownedOverlayRoots: HTMLElement[] = []
    const scope = createModalFocusScope({
      root,
      restoreTarget: trigger,
      additionalRoots: () => ownedOverlayRoots,
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
    const overlayContainer = document.querySelector('.v-overlay-container')!
    overlayContainer.append(overlay)
    await new Promise<void>(resolve => dom.window.queueMicrotask(resolve))
    expect(overlay.inert).toBe(true)
    expect(overlay.getAttribute('aria-hidden')).toBe('true')
    overlayButton.focus()
    expect(document.activeElement).toBe(composer)

    const ownedOverlay = document.createElement('div')
    ownedOverlay.className = 'v-overlay--active'
    const ownedOverlayButton = document.createElement('button')
    ownedOverlayButton.getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList
    ownedOverlay.append(ownedOverlayButton)
    ownedOverlayRoots.push(ownedOverlay)
    overlayContainer.append(ownedOverlay)
    await new Promise<void>(resolve => dom.window.queueMicrotask(resolve))
    expect(ownedOverlay.hasAttribute('inert')).toBe(false)
    expect(ownedOverlay.getAttribute('aria-hidden')).toBeNull()
    expect(overlay.inert).toBe(true)
    expect(overlay.getAttribute('aria-hidden')).toBe('true')
    ownedOverlayButton.focus()
    expect(document.activeElement).toBe(ownedOverlayButton)
    ownedOverlayButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(close)

    composer.focus()
    composer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(escapes).toBe(1)

    scope.deactivate()
    expect(background.inert).toBe(false)
    expect(background.getAttribute('aria-hidden')).toBe('false')
    expect(overlay.inert).toBe(false)
    expect(overlay.getAttribute('aria-hidden')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
