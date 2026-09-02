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
  onEscape: () => void
}

interface ModalFocusScopeState {
  active: boolean
  root: HTMLElement
  additionalRoots: () => readonly HTMLElement[]
  observedAdditionalRoots: readonly HTMLElement[]
  background: readonly BackgroundState[]
  restoreFocus: boolean
  restoreTarget: RestoreTarget
}

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

const hideBackground = (root: HTMLElement, additionalRoots: readonly HTMLElement[]): BackgroundState[] => {
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
      ariaHidden: element.getAttribute('aria-hidden')
    })
    element.inert = true
    element.setAttribute('aria-hidden', 'true')
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
  for (const { element, inert, inertAttribute, ariaHidden } of states) {
    element.inert = inert
    if (inertAttribute === null) element.removeAttribute('inert')
    else element.setAttribute('inert', inertAttribute)
    if (ariaHidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', ariaHidden)
  }
}

const sameElements = (left: readonly HTMLElement[], right: readonly HTMLElement[]): boolean =>
  left.length === right.length && left.every((element, index) => element === right[index])

const reconcileBackgrounds = (document: Document, force = false): void => {
  const stack = scopeStacks.get(document)
  if (!stack?.length) return
  const nextAdditionalRoots = stack.map(state => state.additionalRoots())
  if (!force && stack.every((state, index) => sameElements(state.observedAdditionalRoots, nextAdditionalRoots[index]!))) return

  for (let index = stack.length - 1; index >= 0; index -= 1) restoreBackground(stack[index]!.background)
  for (const [index, state] of stack.entries()) {
    state.observedAdditionalRoots = nextAdditionalRoots[index]!
    const nestedRoots = stack.slice(index + 1).flatMap((nestedState, nestedIndex) => [nestedState.root, ...nextAdditionalRoots[index + nestedIndex + 1]!])
    state.background = hideBackground(state.root, [...state.observedAdditionalRoots, ...nestedRoots])
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

export const createModalFocusScope = ({ root, restoreTarget, additionalRoots, onEscape }: ModalFocusScopeOptions): ModalFocusScope => {
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
    restoreFocus: true,
    restoreTarget
  }
  stack.push(state)
  reconcileBackgrounds(document, true)
  const MutationObserverConstructor = document.defaultView?.MutationObserver
  const backgroundObserver = MutationObserverConstructor ? new MutationObserverConstructor(() => reconcileBackgrounds(document, true)) : null
  if (document.body) backgroundObserver?.observe(document.body, { childList: true, subtree: true })

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

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!isTopScope() || event.defaultPrevented) return
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
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && focused === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault()
      first.focus()
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
      document.removeEventListener('focusin', handleFocus)
      document.removeEventListener('keydown', handleKeydown)
      finishInactiveScopes(document)
    }
  }
}
