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
    const overlayTab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    ownedOverlayButton.dispatchEvent(overlayTab)
    expect(overlayTab.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(ownedOverlayButton)
    const overlayEscape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ownedOverlayButton.dispatchEvent(overlayEscape)
    expect(overlayEscape.defaultPrevented).toBe(false)
    expect(escapes).toBe(0)

    composer.focus()
    const earlyEscape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    composer.dispatchEvent(earlyEscape)
    expect(earlyEscape.defaultPrevented).toBe(false)
    expect(escapes).toBe(0)
    ownedOverlay.classList.remove('v-overlay--active')
    composer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(escapes).toBe(1)

    scope.deactivate()
    expect(background.inert).toBe(false)
    expect(background.getAttribute('aria-hidden')).toBe('false')
    expect(overlay.inert).toBe(false)
    expect(overlay.getAttribute('aria-hidden')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test('only blurred opt-in scopes suppress background glass and restore it across nested previews and plain dialogs', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><head><style>
        #conversation { backdrop-filter: blur(10px); }
        #toolbar { backdrop-filter: blur(36px); }
        #preview { backdrop-filter: blur(3px); }
      </style></head><body>
        <main data-modal-backdrop-suppressed="original"></main>
        <section id="workspace" tabindex="-1"><header id="toolbar"></header><div id="conversation"></div></section>
      </body></html>`,
      { pretendToBeVisual: true }
    )
    doms.push(dom)
    const document = dom.window.document
    const background = document.querySelector<HTMLElement>('main')!
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const conversation = document.querySelector<HTMLElement>('#conversation')!
    const toolbar = document.querySelector<HTMLElement>('#toolbar')!
    const workspaceScope = createModalFocusScope({
      root: workspace,
      restoreTarget: null,
      backdropRoots: () => [toolbar, conversation],
      onEscape: () => {}
    })
    expect(background.getAttribute('data-modal-backdrop-suppressed')).toBe('')
    expect(workspace.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)

    const dialog = document.createElement('section')
    dialog.tabIndex = -1
    document.body.append(dialog)
    const dialogScope = createModalFocusScope({ root: dialog, restoreTarget: null, onEscape: () => {} })
    expect(workspace.inert).toBe(true)
    expect(workspace.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    dialogScope.deactivate({ restoreFocus: false })
    dialog.remove()

    // Nested drawers/dialogs isolate sibling conversation content for a11y,
    // but the older workspace scope must not suppress its own visible glass.
    workspace.append(dialog)
    const nestedDialogScope = createModalFocusScope({ root: dialog, restoreTarget: null, onEscape: () => {} })
    expect(conversation.inert).toBe(true)
    expect(conversation.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    expect(toolbar.inert).toBe(true)
    expect(toolbar.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    expect(workspace.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    expect(background.getAttribute('data-modal-backdrop-suppressed')).toBe('')
    nestedDialogScope.deactivate({ restoreFocus: false })
    dialog.remove()

    const preview = document.createElement('section')
    preview.id = 'preview'
    preview.tabIndex = -1
    document.body.append(preview)
    const previewScope = createModalFocusScope({
      root: preview,
      restoreTarget: workspace,
      backdropRoots: () => [preview],
      onEscape: () => {}
    })
    expect(workspace.hasAttribute('data-modal-backdrop-suppressed')).toBe(true)
    expect(preview.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)

    // Portals inserted while the preview is open join the existing isolation lifecycle.
    const portal = document.createElement('aside')
    document.body.append(portal)
    const portalUpdate = Promise.withResolvers<void>()
    dom.window.queueMicrotask(portalUpdate.resolve)
    await portalUpdate.promise
    expect(portal.hasAttribute('data-modal-backdrop-suppressed')).toBe(true)
    previewScope.deactivate()
    preview.remove()
    expect(workspace.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    expect(background.getAttribute('data-modal-backdrop-suppressed')).toBe('')
    workspaceScope.deactivate({ restoreFocus: false })
    expect(background.getAttribute('data-modal-backdrop-suppressed')).toBe('original')
    expect(portal.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
  })

  test('unfiltered opt-in surfaces keep background glass and out-of-order close leaves no suppression behind', () => {
    const dom = new JSDOM(
      '<!doctype html><html><head><style>#preview { backdrop-filter: blur(3px); }</style></head><body><main></main><section id="workspace" tabindex="-1"></section><section id="preview" tabindex="-1"></section></body></html>',
      { pretendToBeVisual: true }
    )
    doms.push(dom)
    const document = dom.window.document
    const background = document.querySelector<HTMLElement>('main')!
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const preview = document.querySelector<HTMLElement>('#preview')!
    const workspaceScope = createModalFocusScope({
      root: workspace,
      restoreTarget: null,
      backdropRoots: () => [workspace],
      onEscape: () => {}
    })
    expect(background.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    const previewScope = createModalFocusScope({
      root: preview,
      restoreTarget: null,
      backdropRoots: () => [preview],
      onEscape: () => {}
    })
    expect(workspace.hasAttribute('data-modal-backdrop-suppressed')).toBe(true)
    workspaceScope.deactivate({ restoreFocus: false })
    previewScope.deactivate({ restoreFocus: false })
    expect(background.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    expect(workspace.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    expect(background.inert).toBe(false)
  })

  test('tracks late owners and contextual class changes without rewriting isolation for streaming content', async () => {
    const dom = new JSDOM(
      '<!doctype html><html><head><style>.included .glass { backdrop-filter: blur(10px); }</style></head><body><main></main><section id="workspace" tabindex="-1"><div id="context"></div></section></body></html>',
      { pretendToBeVisual: true }
    )
    doms.push(dom)
    const document = dom.window.document
    const background = document.querySelector<HTMLElement>('main')!
    const workspace = document.querySelector<HTMLElement>('#workspace')!
    const context = document.querySelector<HTMLElement>('#context')!
    const scope = createModalFocusScope({
      root: workspace,
      restoreTarget: null,
      backdropRoots: () => Array.from(workspace.querySelectorAll<HTMLElement>('.glass')),
      onEscape: () => {}
    })
    const owner = document.createElement('div')
    owner.className = 'glass'
    context.append(owner)
    const mounted = Promise.withResolvers<void>()
    dom.window.queueMicrotask(mounted.resolve)
    await mounted.promise
    expect(background.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)

    context.classList.add('included')
    const included = Promise.withResolvers<void>()
    dom.window.queueMicrotask(included.resolve)
    await included.promise
    expect(background.hasAttribute('data-modal-backdrop-suppressed')).toBe(true)

    const backgroundWrites: MutationRecord[] = []
    const isolationObserver = new dom.window.MutationObserver(records => backgroundWrites.push(...records))
    isolationObserver.observe(background, { attributes: true })
    owner.append(document.createElement('p'))
    const streamed = Promise.withResolvers<void>()
    dom.window.queueMicrotask(streamed.resolve)
    await streamed.promise
    expect(backgroundWrites).toHaveLength(0)
    isolationObserver.disconnect()

    context.classList.remove('included')
    const excluded = Promise.withResolvers<void>()
    dom.window.queueMicrotask(excluded.resolve)
    await excluded.promise
    expect(background.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
    scope.deactivate({ restoreFocus: false })
    context.classList.add('included')
    const closed = Promise.withResolvers<void>()
    dom.window.queueMicrotask(closed.resolve)
    await closed.promise
    expect(background.hasAttribute('data-modal-backdrop-suppressed')).toBe(false)
  })

  test('does not let a deferred iframe handoff override newer focus or a closed scope', async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><section role="dialog" tabindex="-1"><button id="back">Back</button><button id="other">Other</button><iframe title="Editor"></iframe></section></body></html>',
      { pretendToBeVisual: true }
    )
    doms.push(dom)
    const document = dom.window.document
    const root = document.querySelector<HTMLElement>('section')!
    const back = document.querySelector<HTMLElement>('#back')!
    const other = document.querySelector<HTMLElement>('#other')!
    const iframe = document.querySelector<HTMLIFrameElement>('iframe')!
    // JSDOM has no native child-window focus; browser coverage exercises that handoff.
    iframe.contentWindow!.focus = () => {}
    for (const element of [root, back, other, iframe]) {
      element.getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList
    }
    const scope = createModalFocusScope({ root, restoreTarget: null, onEscape: () => {} })
    const reverseTab = () => back.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    )

    back.focus()
    reverseTab()
    await new Promise<void>(resolve => dom.window.queueMicrotask(resolve))
    expect(document.activeElement).toBe(back)
    await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve()))
    expect(document.activeElement).toBe(iframe)

    back.focus()
    reverseTab()
    other.focus()
    await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve()))
    expect(document.activeElement).toBe(other)

    back.focus()
    reverseTab()
    scope.deactivate({ restoreFocus: false })
    await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve()))
    expect(document.activeElement).toBe(back)
  })
})
