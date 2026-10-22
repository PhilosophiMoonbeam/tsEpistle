const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

interface BackgroundState {
  element: HTMLElement
  inert: boolean
  inertAttribute: string | null
  ariaHidden: string | null
  backdropSuppressed: string | null
}

type RestoreTarget = HTMLElement | null | (() => HTMLElement | null)

export interface ModalFocusScope {
  containsFocus(): boolean
  deactivate(options?: { restoreFocus?: boolean }): void
  focusFirst(): void
}

interface ModalFocusScopeOptions {
  root: HTMLElement
  restoreTarget: RestoreTarget
  additionalRoots?: () => readonly HTMLElement[]
  // Only full-cover blurred surfaces opt in; plain dialogs must retain background glass.
  backdropRoots?: () => readonly HTMLElement[]
  onEscape: () => void
}

interface ModalFocusScopeState {
  active: boolean
  root: HTMLElement
  additionalRoots: () => readonly HTMLElement[]
  observedAdditionalRoots: readonly HTMLElement[]
  background: readonly BackgroundState[]
  backdropRoots: () => readonly HTMLElement[]
  restoreFocus: boolean
  restoreTarget: RestoreTarget
}

export const activeOwnedOverlayRoots = (contentSelector: string): HTMLElement[] =>
  Array.from(
    new Set(
      Array.from(document.querySelectorAll<HTMLElement>(contentSelector))
        .map(content => content.closest<HTMLElement>('.v-overlay--active'))
        .filter((overlay): overlay is HTMLElement => overlay !== null)
    )
  )

const scopeStacks = new WeakMap<Document, ModalFocusScopeState[]>()

const isVisible = (element: HTMLElement): boolean => {
  const view = element.ownerDocument.defaultView
  if (!view) return false
  const style = view.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

const getFocusableElements = (root: HTMLElement): HTMLElement[] => {
  const candidates = [...(root.matches(focusableSelector) ? [root] : []), ...Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))]
  return candidates.filter(
    element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert], [aria-hidden="true"]') && isVisible(element)
  )
}

const containsTarget = (roots: readonly HTMLElement[], target: Node | null): boolean =>
  Boolean(target) && roots.some(candidate => candidate === target || candidate.contains(target))

const isWithinModal = (root: HTMLElement, additionalRoots: readonly HTMLElement[], target: Node | null): boolean =>
  containsTarget([root, ...additionalRoots], target)

const getModalFocusableElements = (root: HTMLElement, additionalRoots: readonly HTMLElement[]): HTMLElement[] =>
  Array.from(new Set([...additionalRoots.flatMap(getFocusableElements), ...getFocusableElements(root)]))

const hideBackground = (root: HTMLElement, additionalRoots: readonly HTMLElement[], suppressBackdrop: boolean): BackgroundState[] => {
  const states: BackgroundState[] = []
  const HTMLElementConstructor = root.ownerDocument.defaultView?.HTMLElement
  const protectedElements = new Set<HTMLElement>()
  const hiddenElements = new Set<HTMLElement>()
  const hideElement = (element: HTMLElement): void => {
    hiddenElements.add(element)
    states.push({
      element,
      inert: element.inert === true,
      inertAttribute: element.getAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
      backdropSuppressed: element.getAttribute('data-modal-backdrop-suppressed')
    })
    element.inert = true
    element.setAttribute('aria-hidden', 'true')
    if (suppressBackdrop) element.setAttribute('data-modal-backdrop-suppressed', '')
  }

  for (const protectedRoot of [root, ...additionalRoots]) {
    let current: HTMLElement | null = protectedRoot
    while (current) {
      protectedElements.add(current)
      if (current === root.ownerDocument.body) break
      current = current.parentElement
    }
  }

  for (const current of protectedElements) {
    const parent = current.parentElement
    if (!parent) continue
    for (const sibling of parent.children) {
      if (
        protectedElements.has(sibling as HTMLElement) ||
        hiddenElements.has(sibling as HTMLElement) ||
        !HTMLElementConstructor ||
        !(sibling instanceof HTMLElementConstructor)
      )
        continue
      const element = sibling as HTMLElement
      if (element.classList.contains('v-overlay-container')) {
        for (const overlay of element.children) {
          if (protectedElements.has(overlay as HTMLElement) || hiddenElements.has(overlay as HTMLElement) || !(overlay instanceof HTMLElementConstructor))
            continue
          hideElement(overlay as HTMLElement)
        }
        continue
      }
      hideElement(element)
    }
  }

  return states
}

const restoreBackground = (states: readonly BackgroundState[]): void => {
  for (const { element, inert, inertAttribute, ariaHidden, backdropSuppressed } of states) {
    element.inert = inert
    if (inertAttribute === null) element.removeAttribute('inert')
    else element.setAttribute('inert', inertAttribute)
    if (ariaHidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', ariaHidden)
    if (backdropSuppressed === null) element.removeAttribute('data-modal-backdrop-suppressed')
    else element.setAttribute('data-modal-backdrop-suppressed', backdropSuppressed)
  }
}

const sameElements = (left: readonly HTMLElement[], right: readonly HTMLElement[]): boolean =>
  left.length === right.length && left.every((element, index) => element === right[index])

const hasBackdrop = (element: HTMLElement): boolean => {
  if (!element.isConnected) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return Boolean(style && [style.getPropertyValue('backdrop-filter'), style.getPropertyValue('-webkit-backdrop-filter')].some(value => value && value !== 'none'))
}

const reconcileBackgrounds = (document: Document, force = false): void => {
  const stack = scopeStacks.get(document)
  if (!stack?.length) return
  const nextAdditionalRoots = stack.map(state => state.additionalRoots())
  if (!force && stack.every((state, index) => sameElements(state.observedAdditionalRoots, nextAdditionalRoots[index]!))) return

  for (let index = stack.length - 1; index >= 0; index -= 1) restoreBackground(stack[index]!.background)
  for (const [index, state] of stack.entries()) {
    state.observedAdditionalRoots = nextAdditionalRoots[index]!
    const nestedRoots = stack.slice(index + 1).flatMap((nestedState, nestedIndex) => [nestedState.root, ...nextAdditionalRoots[index + nestedIndex + 1]!])
    state.background = hideBackground(
      state.root,
      [...state.observedAdditionalRoots, ...nestedRoots],
      state.active && state.backdropRoots().some(hasBackdrop)
    )
  }
}
const restoreTargetElement = (target: RestoreTarget): HTMLElement | null => (typeof target === 'function' ? target() : target)

const finishInactiveScopes = (document: Document): void => {
  const stack = scopeStacks.get(document)
  if (!stack) return

  while (stack.length > 0 && !stack[stack.length - 1]!.active) {
    const state = stack.pop()!
    restoreBackground(state.background)
    if (!state.restoreFocus) continue
    const target = restoreTargetElement(state.restoreTarget)
    if (target?.isConnected && !target.matches(':disabled') && !target.closest('[inert], [aria-hidden="true"]')) target.focus({ preventScroll: true })
  }

  if (stack.length === 0) scopeStacks.delete(document)
  else reconcileBackgrounds(document, true)
}

export const createModalFocusScope = ({ root, restoreTarget, additionalRoots, backdropRoots, onEscape }: ModalFocusScopeOptions): ModalFocusScope => {
  const document = root.ownerDocument
  const currentAdditionalRoots = (): readonly HTMLElement[] => additionalRoots?.().filter(element => element.isConnected) ?? []
  const stack = scopeStacks.get(document) ?? []
  if (!scopeStacks.has(document)) scopeStacks.set(document, stack)
  const observedAdditionalRoots = currentAdditionalRoots()
  const state: ModalFocusScopeState = {
    active: true,
    root,
    additionalRoots: currentAdditionalRoots,
    observedAdditionalRoots,
    background: [],
    backdropRoots: backdropRoots ?? (() => []),
    restoreFocus: true,
    restoreTarget
  }
  stack.push(state)
  reconcileBackgrounds(document, true)
  const MutationObserverConstructor = document.defaultView?.MutationObserver
  const observedBackdropElements = new Set<HTMLElement>()
  const observeBackdropOwners = (): void => {
    for (const owner of state.backdropRoots()) {
      let element: HTMLElement | null = owner
      while (element) {
        if (!observedBackdropElements.has(element)) {
          observedBackdropElements.add(element)
          backgroundObserver?.observe(element, { attributes: true, attributeFilter: ['class', 'style'] })
        }
        // A teleported scrim can be outside the focus root; observe only that
        // explicit owner, not unrelated ancestors of the portal.
        if (element === root || !root.contains(owner)) break
        element = element.parentElement
      }
    }
  }
  const backgroundObserver = MutationObserverConstructor ? new MutationObserverConstructor(() => {
    observeBackdropOwners()
    reconcileBackgrounds(document, true)
  }) : null
  if (document.body) backgroundObserver?.observe(document.body, { childList: true, subtree: true })
  observeBackdropOwners()

  // Attribute observation is limited to explicit owners and their modal ancestors.
  // Animation completion retires opaque glass; media changes preserve fallbacks.
  const handleBackdropTransition = (event: Event): void => {
    if (state.backdropRoots().some(element => element === event.target)) reconcileBackgrounds(document, true)
  }
  const backdropEvents = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel']
  if (backdropRoots) for (const event of backdropEvents) root.addEventListener(event, handleBackdropTransition)
  const backdropMedia = backdropRoots && document.defaultView?.matchMedia
    ? ['(prefers-reduced-transparency: reduce)', '(forced-colors: active)'].map(query => document.defaultView!.matchMedia(query))
    : []
  const reconcileBackdrop = (): void => reconcileBackgrounds(document, true)
  for (const media of backdropMedia) media.addEventListener('change', reconcileBackdrop)

  const modalAdditionalRoots = (): readonly HTMLElement[] => {
    reconcileBackgrounds(document)
    return state.observedAdditionalRoots
  }

  const isTopScope = (): boolean => state.active && stack[stack.length - 1] === state
  const focusFirst = (): void => {
    if (!isTopScope()) return
    ;(getModalFocusableElements(root, modalAdditionalRoots())[0] ?? root).focus()
  }

  const containsFocus = (): boolean => isTopScope() && isWithinModal(root, modalAdditionalRoots(), document.activeElement)

  const handleFocus = (event: FocusEvent): void => {
    if (!isTopScope() || isWithinModal(root, modalAdditionalRoots(), event.target as Node | null)) return
    focusFirst()
  }

  const focusKeyboardTarget = (target: HTMLElement, previous: Element | null): void => {
    if (target.tagName !== 'IFRAME') {
      target.focus()
      return
    }
    // Gecko can ignore iframe focus until native cancelled-Tab processing ends.
    // Focus the browsing context as well as its host; Window.focus is cross-origin safe.
    document.defaultView!.requestAnimationFrame(() => {
      if (!isTopScope() || !target.isConnected || document.activeElement !== previous) return
      target.focus()
      if (isTopScope() && target.isConnected && document.activeElement === target) {
        ;(target as HTMLIFrameElement).contentWindow?.focus()
      }
    })
  }

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!isTopScope() || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    // An owned Vuetify menu/dialog manages its own Tab and Escape handling.
    const ElementConstructor = document.defaultView?.Element
    const overlay = ElementConstructor && event.target instanceof ElementConstructor ? event.target.closest('.v-overlay--active') : null
    if (overlay && isWithinModal(root, modalAdditionalRoots(), overlay)) return
    // Opening dialogs can receive Escape before their enter transition moves focus.
    if (event.key === 'Escape' && modalAdditionalRoots().some(element => element.matches('.v-overlay--active'))) return
    if (event.key === 'Escape' && containsTarget([root, ...modalAdditionalRoots()], event.target as Node)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      onEscape()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = getModalFocusableElements(root, modalAdditionalRoots())
    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const focused = document.activeElement
    if (!isWithinModal(root, modalAdditionalRoots(), focused)) {
      event.preventDefault()
      focusKeyboardTarget(event.shiftKey ? last : first, focused)
    } else if (event.shiftKey && focused === first) {
      event.preventDefault()
      focusKeyboardTarget(last, focused)
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault()
      focusKeyboardTarget(first, focused)
    }
  }

  document.addEventListener('focusin', handleFocus)
  document.addEventListener('keydown', handleKeydown)
  if (!isWithinModal(root, modalAdditionalRoots(), document.activeElement)) focusFirst()

  return {
    containsFocus,
    focusFirst,
    deactivate({ restoreFocus = true } = {}) {
      if (!state.active) return
      state.active = false
      state.restoreFocus = restoreFocus
      backgroundObserver?.disconnect()
      if (backdropRoots) for (const event of backdropEvents) root.removeEventListener(event, handleBackdropTransition)
      for (const media of backdropMedia) media.removeEventListener('change', reconcileBackdrop)
      document.removeEventListener('focusin', handleFocus)
      document.removeEventListener('keydown', handleKeydown)
      finishInactiveScopes(document)
    }
  }
}
