import { shallowReactive } from 'vue'

export type ConfirmTone = 'default' | 'destructive'

export type ConfirmRequest = {
  /** Short question, for example "Discard unsaved theme changes?" */
  title: string
  /** Optional consequence line shown under the title. */
  message?: string
  /** Label of the action button. Defaults to "Discard". */
  confirmLabel?: string
  /** Label of the safe button. Defaults to "Keep editing". */
  cancelLabel?: string
  /** Destructive requests use the error color for the action button. */
  tone?: ConfirmTone
}

export type PendingConfirmation = ConfirmRequest & {
  id: number
  /** Connected invoking control, kept out of the public request API. */
  returnFocusTo: HTMLElement | null
}

type QueueEntry = PendingConfirmation & { resolve: (confirmed: boolean) => void }

const state = shallowReactive({
  queue: [] as QueueEntry[],
  hosts: 0
})

let sequence = 0

/** The request the mounted host must show now, or null. */
export const currentConfirmation = (): PendingConfirmation | null => {
  const entry = state.queue[0]
  if (!entry) return null
  const { resolve: _resolve, ...request } = entry
  return request
}

/**
 * Ask the user to confirm an action in the themed in-app dialog.
 * Requests are queued, so concurrent guards never overwrite each other.
 * Without a mounted host (component used outside the admin shell) the native
 * dialog is the safe fallback: an unsaved draft is never discarded silently.
 */
export const requestConfirmation = (request: ConfirmRequest): Promise<boolean> => {
  if (state.hosts === 0) {
    const text = request.message ? `${request.title}\n\n${request.message}` : request.title
    return Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(text) : false)
  }
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const active = typeof document !== 'undefined' ? document.activeElement : null
  const opener = active && typeof HTMLElement !== 'undefined' && active instanceof HTMLElement &&
    active.isConnected && active !== active.ownerDocument.body ? active : null
  // A request queued from within the current confirmation must return to its
  // original opener, not content that disappears when that request settles.
  const insideConfirmation = opener?.closest('.confirm-dialog') ||
    opener?.closest('.v-overlay__content')?.querySelector('.confirm-dialog')
  const returnFocusTo = insideConfirmation ? state.queue[0]?.returnFocusTo ?? null : opener
  state.queue = [...state.queue, { ...request, id: ++sequence, returnFocusTo, resolve }]
  return promise
}

/** Discard-draft confirmation with the shared destructive wording. */
export const confirmDiscard = (title: string, message?: string, confirmLabel?: string): Promise<boolean> =>
  requestConfirmation({ title, message, confirmLabel, tone: 'destructive' })

export const settleConfirmation = (id: number, confirmed: boolean): void => {
  const entry = state.queue.find(candidate => candidate.id === id)
  if (!entry) return
  state.queue = state.queue.filter(candidate => candidate.id !== id)
  entry.resolve(confirmed)
}

/** Called by the host on mount. The returned function unregisters it and cancels pending requests. */
export const registerConfirmationHost = (): (() => void) => {
  state.hosts += 1
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    state.hosts -= 1
    if (state.hosts > 0) return
    const pending = state.queue
    state.queue = []
    for (const entry of pending) entry.resolve(false)
  }
}
