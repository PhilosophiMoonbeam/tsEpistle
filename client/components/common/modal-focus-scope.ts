const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

interface BackgroundState {
  element: HTMLElement
  inert: boolean
  inertAttribute: string | null
  ariaHidden: string | null
}

export interface ModalFocusScope {
  containsFocus(): boolean
  deactivate(options?: { restoreFocus?: boolean }): void
  focusFirst(): void
}

interface ModalFocusScopeOptions {
  root: HTMLElement
  restoreTarget: HTMLElement | null
  onEscape: () => void
}

const isVisible = (element: HTMLElement): boolean => {
  const view = element.ownerDocument.defaultView
  if (!view) return false
  const style = view.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

const getFocusableElements = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(element => !element.closest('[inert], [aria-hidden="true"]') && isVisible(element))

const getActiveOverlays = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.ownerDocument.querySelectorAll<HTMLElement>('.v-overlay-container .v-overlay--active')).filter(overlay => !root.contains(overlay))

const isWithinModal = (root: HTMLElement, target: Node | null): boolean =>
  Boolean(target) && (root.contains(target) || getActiveOverlays(root).some(overlay => overlay.contains(target)))

const getModalFocusableElements = (root: HTMLElement): HTMLElement[] => [
  ...getFocusableElements(root),
  ...getActiveOverlays(root).flatMap(getFocusableElements)
]

const hideBackground = (root: HTMLElement): BackgroundState[] => {
  const states: BackgroundState[] = []
  const HTMLElementConstructor = root.ownerDocument.defaultView?.HTMLElement
  let current: HTMLElement = root

  while (current !== root.ownerDocument.body) {
    const parent = current.parentElement
    if (!parent) break
    for (const sibling of parent.children) {
      if (sibling === current || !HTMLElementConstructor || !(sibling instanceof HTMLElementConstructor)) continue
      const element = sibling as HTMLElement
      if (element.classList.contains('v-overlay-container')) continue
      states.push({
        element,
        inert: element.inert === true,
        inertAttribute: element.getAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden')
      })
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    }
    current = parent
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

export const createModalFocusScope = ({ root, restoreTarget, onEscape }: ModalFocusScopeOptions): ModalFocusScope => {
  const document = root.ownerDocument
  if (!root.contains(document.activeElement)) (getFocusableElements(root)[0] ?? root).focus()
  const background = hideBackground(root)
  let active = true

  const focusFirst = (): void => {
    getFocusableElements(root)[0]?.focus()
  }

  const containsFocus = (): boolean => isWithinModal(root, document.activeElement)

  const handleFocus = (event: FocusEvent): void => {
    if (!active || isWithinModal(root, event.target as Node | null)) return
    focusFirst()
  }

  const handleKeydown = (event: KeyboardEvent): void => {
    if (!active || event.defaultPrevented) return
    if (event.key === 'Escape' && root.contains(event.target as Node)) {
      event.preventDefault()
      event.stopPropagation()
      onEscape()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = getModalFocusableElements(root)
    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const focused = document.activeElement
    if (!isWithinModal(root, focused)) {
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

  return {
    containsFocus,
    focusFirst,
    deactivate({ restoreFocus = true } = {}) {
      if (!active) return
      active = false
      document.removeEventListener('focusin', handleFocus)
      document.removeEventListener('keydown', handleKeydown)
      restoreBackground(background)
      if (restoreFocus && restoreTarget?.isConnected) restoreTarget.focus()
    }
  }
}
