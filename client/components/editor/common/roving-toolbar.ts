import type { Directive, DirectiveBinding } from 'vue'

// WAI-ARIA toolbar pattern: one tab stop per toolbar, arrow keys move between
// tools, Home/End jump to the ends and Escape hands focus back to the document.

export type RovingToolbarOptions = {
  /** Called on Escape so the owner can return focus to the editing surface. */
  readonly onEscape?: () => void
}

type RovingHost = HTMLElement & {
  __rovingToolbar?: {
    active: HTMLElement | null
    options: RovingToolbarOptions | undefined
    keydown: (event: KeyboardEvent) => void
    focusin: (event: FocusEvent) => void
  }
}

const ITEM_SELECTOR = 'button, [role="button"], a[href], input[type="checkbox"]'

const isUsable = (element: HTMLElement): boolean =>
  !element.hasAttribute('disabled') && !element.closest('[hidden], [inert]') && element.getAttribute('aria-hidden') !== 'true'

/** Tools that belong to this toolbar (the directive host has role=toolbar), excluding nested toolbars. */
export const rovingToolbarItems = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    element => isUsable(element) && element.closest('[role="toolbar"]') === root
  )

export const syncRovingToolbar = (root: RovingHost): HTMLElement | null => {
  const state = root.__rovingToolbar
  const items = rovingToolbarItems(root)
  const active = state?.active && items.includes(state.active) ? state.active : items[0] ?? null
  if (state) state.active = active
  for (const item of items) item.tabIndex = item === active ? 0 : -1
  return active
}

const isRtl = (root: HTMLElement): boolean => {
  const direction = root.closest('[dir]')?.getAttribute('dir')
  return direction === 'rtl'
}

export const moveRovingFocus = (root: RovingHost, key: string): boolean => {
  const items = rovingToolbarItems(root)
  if (items.length === 0) return false
  const current = items.findIndex(item => item === document.activeElement || item.contains(document.activeElement))
  const from = current >= 0 ? current : Math.max(0, items.indexOf(root.__rovingToolbar?.active as HTMLElement))
  const vertical = root.getAttribute('aria-orientation') === 'vertical'
  const forward = vertical ? 'ArrowDown' : isRtl(root) ? 'ArrowLeft' : 'ArrowRight'
  const backward = vertical ? 'ArrowUp' : isRtl(root) ? 'ArrowRight' : 'ArrowLeft'
  let next: number
  if (key === forward) next = (from + 1) % items.length
  else if (key === backward) next = (from - 1 + items.length) % items.length
  else if (key === 'Home') next = 0
  else if (key === 'End') next = items.length - 1
  else return false
  const target = items[next]
  if (!target) return false
  if (root.__rovingToolbar) root.__rovingToolbar.active = target
  syncRovingToolbar(root)
  target.focus()
  return true
}

const install = (root: RovingHost, binding: DirectiveBinding<RovingToolbarOptions | undefined>): void => {
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target instanceof HTMLElement ? event.target : null
    // Text fields inside a toolbar keep their own caret keys.
    if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    if (event.key === 'Escape') {
      const onEscape = root.__rovingToolbar?.options?.onEscape
      if (onEscape) {
        event.preventDefault()
        onEscape()
      }
      return
    }
    if (moveRovingFocus(root, event.key)) event.preventDefault()
  }
  const focusin = (event: FocusEvent) => {
    const state = root.__rovingToolbar
    if (!state || !(event.target instanceof HTMLElement)) return
    const item = rovingToolbarItems(root).find(candidate => candidate === event.target || candidate.contains(event.target as Node))
    if (item) {
      state.active = item
      syncRovingToolbar(root)
    }
  }
  root.__rovingToolbar = { active: null, options: binding.value, keydown, focusin }
  root.addEventListener('keydown', keydown)
  root.addEventListener('focusin', focusin)
  syncRovingToolbar(root)
}

export const vRovingToolbar: Directive<RovingHost, RovingToolbarOptions | undefined> = {
  mounted: install,
  updated (root, binding) {
    if (root.__rovingToolbar) root.__rovingToolbar.options = binding.value
    syncRovingToolbar(root)
  },
  beforeUnmount (root) {
    const state = root.__rovingToolbar
    if (!state) return
    root.removeEventListener('keydown', state.keydown)
    root.removeEventListener('focusin', state.focusin)
    delete root.__rovingToolbar
  }
}
