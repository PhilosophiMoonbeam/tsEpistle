export type EditorAdapterCapture = {
  readonly text: string
  readonly editVersion: number
}

export type EditorAdapterSafety = {
  readonly ready: boolean
  readonly editVersion: number
  readonly nonPersisted: boolean
  readonly mergeDirty: boolean
  readonly collaborationBacklog: number
  readonly revision: string
}

export type EditorAdapterStateListener = (safety: EditorAdapterSafety) => void

export type EditorAdapterReplaceOptions = {
  readonly detached?: boolean
}
let nextEditorAdapterId = 0

/**
 * The narrow bridge between a real editor document and the editor shell.
 *
 * Adapters deliberately expose text capture separately from reload safety: a
 * synchronous capture is useful for a foreground save, while the safety
 * snapshot also accounts for initialization, detached state, merge memory and
 * live collaboration backlog. No method claims that metadata or a text capture
 * has reached durable storage.
 */
export interface EditorAdapter {
  capture(): EditorAdapterCapture
  snapshot(): EditorAdapterSafety
  replaceText(text: string, options?: EditorAdapterReplaceOptions): void
  clear(): void
  /** Best effort only; callers must not treat this as a durable commit. */
  flushEligibleText(): void
  /** Acknowledge only the exact captured version that reached durable storage. */
  markPersisted?: (editVersion?: number) => void
  setMergeDirty?: (dirty: boolean) => void
  destroy(): void
  onState(listener: EditorAdapterStateListener): () => void
}

/** Binds the browser's backgrounding signals to one best-effort text flush. */
export const bindEditorFlushSignals = (adapter: Pick<EditorAdapter, 'flushEligibleText'>): (() => void) => {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function' ||
    typeof window.removeEventListener !== 'function'
  ) return () => {}
  const flush = (): void => {
    try {
      adapter.flushEligibleText()
    } catch {
      // Background lifecycle delivery is best effort and never a durability claim.
    }
  }
  try {
    window.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)
  } catch {
    return () => {}
  }
  return () => {
    try {
      window.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
    } catch {
      // A window can be torn down while cleanup is running.
    }
  }
}

type EditorAdapterControllerOptions = {
  readonly readText: () => string
  readonly writeText: (text: string, options?: EditorAdapterReplaceOptions) => void
  readonly clearText: () => void
  readonly flushText?: () => void
  readonly destroyCollaboration?: () => void
  readonly collaborationBacklog?: () => number
}

/**
 * Small stateful implementation shared by the source and visual editors.
 * `initialize()` is intentionally separate from construction so an adapter
 * cannot report reload-safe before its underlying editor is mounted.
 */
export class EditorAdapterController implements EditorAdapter {
  private readonly instanceId = ++nextEditorAdapterId
  private ready = false
  private editVersion = 0
  private nonPersisted = false
  private mergeDirty = false
  private revision = 0
  private destroyed = false
  private suppressTextChange = 0
  private readonly listeners = new Set<EditorAdapterStateListener>()

  constructor(private readonly options: EditorAdapterControllerOptions) {}

  initialize(): void {
    if (this.destroyed || this.ready) return
    this.ready = true
    this.publish()
  }

  capture(): EditorAdapterCapture {
    return {
      text: this.options.readText(),
      editVersion: this.editVersion
    }
  }

  snapshot(): EditorAdapterSafety {
    let collaborationBacklog = 0
    try {
      collaborationBacklog = Math.max(0, Math.floor(this.options.collaborationBacklog?.() ?? 0))
    } catch {
      collaborationBacklog = Number.MAX_SAFE_INTEGER
    }
    return {
      ready: this.ready && !this.destroyed,
      editVersion: this.editVersion,
      nonPersisted: this.nonPersisted,
      mergeDirty: this.mergeDirty,
      collaborationBacklog,
      revision: `${this.instanceId}:${this.revision}:${this.editVersion}:${this.nonPersisted ? 1 : 0}:${this.mergeDirty ? 1 : 0}:${collaborationBacklog}`
    }
  }

  replaceText(text: string, options: EditorAdapterReplaceOptions = {}): void {
    if (this.destroyed) return
    if (options.detached) this.options.destroyCollaboration?.()
    this.suppressTextChange += 1
    try {
      this.options.writeText(text, options)
    } finally {
      this.suppressTextChange -= 1
    }
    this.noteTextChange()
  }

  clear(): void {
    if (this.destroyed) return
    this.options.destroyCollaboration?.()
    this.suppressTextChange += 1
    try {
      this.options.clearText()
    } finally {
      this.suppressTextChange -= 1
    }
    this.noteTextChange()
  }

  flushEligibleText(): void {
    if (this.destroyed || !this.ready) return
    try {
      this.options.flushText?.()
    } finally {
      this.publish()
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.ready = false
    this.options.destroyCollaboration?.()
    this.listeners.clear()
  }

  onState(listener: EditorAdapterStateListener): () => void {
    if (this.destroyed) return () => {}
    this.listeners.add(listener)
    try {
      listener(this.snapshot())
    } catch {
      this.listeners.delete(listener)
    }
    return () => this.listeners.delete(listener)
  }

  /** Called by an editor's document-change callback. */
  noteTextChange(): void {
    if (this.destroyed || this.suppressTextChange > 0) return
    this.editVersion += 1
    this.nonPersisted = true
    this.revision += 1
    this.publish()
  }

  /** Called by the shell after a matching text capture is durably committed. */
  markPersisted(editVersion = this.editVersion): void {
    if (this.destroyed || editVersion !== this.editVersion) return
    this.nonPersisted = false
    this.revision += 1
    this.publish()
  }

  setMergeDirty(dirty: boolean): void {
    if (this.destroyed || this.mergeDirty === dirty) return
    this.mergeDirty = dirty
    this.revision += 1
    this.publish()
  }

  /** Lets collaboration report backlog changes without exposing mutable state. */
  notifyState(): void {
    if (!this.destroyed) this.publish()
  }

  private publish(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Lifecycle observers cannot break editor input.
      }
    }
  }
}
