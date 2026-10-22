import * as Y from 'yjs'
import { LiveNotesApiError, type LiveNotesApi } from './live-notes-api.ts'
import {
  parseLiveNoteServerMessage,
  LIVE_NOTE_MAX_STATE_BYTES,
  LIVE_NOTE_MAX_UPDATE_BYTES,
  LIVE_NOTE_TEXT_KEY,
  type LiveNoteView
} from '../../shared/live-notes.ts'

const REMOTE = Symbol('live-note-remote')
export type NoteConnection = 'connecting' | 'connected' | 'offline' | 'blocked'
export function encodeNoteUpdate(update: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < update.length; offset += 8192) binary += String.fromCharCode(...update.subarray(offset, offset + 8192))
  return btoa(binary)
}
export function decodeNoteState(state: string): Uint8Array {
  if (state.length > Math.ceil(LIVE_NOTE_MAX_STATE_BYTES / 3) * 4) throw new Error('Note state is too large.')
  const binary = atob(state)
  if (binary.length > LIVE_NOTE_MAX_STATE_BYTES) throw new Error('Note state is too large.')
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
export interface NoteCollaborationOptions {
  note: LiveNoteView
  api: LiveNotesApi
  identity: () => string
  onChange: () => void
  socket?: (url: string) => WebSocket
}

/** One owner per open note. View mode never owns or replaces this document. */
export class LiveNoteCollaboration {
  readonly document = new Y.Doc()
  readonly text = this.document.getText(LIVE_NOTE_TEXT_KEY)
  note: LiveNoteView
  state: NoteConnection = 'connecting'
  error = ''
  private readonly actor: string
  private readonly pending = new Map<string, Uint8Array>()
  private readonly sent = new Set<string>()
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | null = null
  private attempt = 0
  private epoch = 0
  private disposed = false
  private synced = false
  private oversized = false
  private authorizationReady = true

  constructor(private readonly options: NoteCollaborationOptions) {
    this.actor = options.identity()
    this.note = options.note
    Y.applyUpdate(this.document, decodeNoteState(options.note.state), REMOTE)
    this.document.on('update', this.changed)
  }
  get pendingCount(): number {
    return this.pending.size
  }
  get pendingBytes(): number {
    let bytes = 0
    for (const update of this.pending.values()) bytes += update.byteLength
    return bytes
  }
  get canEdit(): boolean {
    return (
      this.current() &&
      this.authorizationReady &&
      this.note.canEdit &&
      this.state !== 'blocked' &&
      !this.oversized &&
      this.pending.size < 128 &&
      this.pendingBytes < 256 * 1024
    )
  }
  private current(): boolean {
    return !this.disposed && this.actor === this.options.identity()
  }
  private notify(): void {
    this.options.onChange()
  }
  private readonly changed = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE || this.disposed) return
    // Retain even an untransmittable transaction for explicit local recovery.
    this.pending.set(crypto.randomUUID(), update)
    if (update.byteLength > LIVE_NOTE_MAX_UPDATE_BYTES) {
      this.oversized = true
      this.block('This edit exceeds the live update limit. Download your Markdown before leaving.')
    } else if (!this.current()) this.block('Your account changed. Download unsaved Markdown before reopening the note.')
    else this.flush()
    this.notify()
  }
  accept(note: LiveNoteView): void {
    if (!this.current() || note.key !== this.note.key || note.id !== this.note.id) return
    Y.applyUpdate(this.document, decodeNoteState(note.state), REMOTE)
    if (note.revision >= this.note.revision) this.note = note
    this.notify()
  }
  async connect(): Promise<void> {
    if (!this.current() || !this.authorizationReady || this.state === 'blocked') return
    clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const epoch = ++this.epoch
    const old = this.socket
    this.socket = null
    old?.close()
    this.sent.clear()
    this.synced = false
    this.state = 'connecting'
    this.notify()
    try {
      const session = await this.options.api.session(this.note.key, controller.signal)
      if (!this.current() || epoch !== this.epoch) return
      if (session.key !== this.note.key) throw new Error('Invalid note session.')
      const url = new URL(session.websocketPath, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = this.options.socket ? this.options.socket(url.href) : new WebSocket(url.href)
      this.socket = socket
      socket.addEventListener('open', () => {
        if (this.current() && this.socket === socket) socket.send(JSON.stringify({ type: 'auth', token: session.token }))
      })
      socket.addEventListener('message', event => {
        if (!this.current() || this.socket !== socket || typeof event.data !== 'string') return
        try {
          if (event.data.length > Math.ceil(LIVE_NOTE_MAX_STATE_BYTES / 3) * 4 + 8192) throw new Error('Invalid live note message.')
          const message = parseLiveNoteServerMessage(JSON.parse(event.data))
          if (message.type === 'error') {
            this.block(message.error)
            return
          }
          const note = message.note
          if (note.key !== this.note.key || note.id !== this.note.id) throw new Error('Invalid live note identity.')
          this.accept(note)
          if (message.type === 'ack') {
            this.pending.delete(message.requestId)
            this.sent.delete(message.requestId)
          }
          this.synced = true
          this.state = 'connected'
          this.error = ''
          this.attempt = 0
          this.flush()
          this.notify()
        } catch {
          this.block('The live connection returned an invalid response. Download unsaved Markdown before reopening.')
        }
      })
      socket.addEventListener('close', event => {
        if (this.socket !== socket || this.disposed) return
        this.socket = null
        this.synced = false
        if (event.code === 4403 || event.code === 4400) this.block('Access changed or the connection was refused. Download unsaved Markdown before reopening.')
        else this.reconnect()
      })
      socket.addEventListener('error', () => {
        if (this.socket === socket) socket.close()
      })
    } catch (error) {
      if (!this.current() || epoch !== this.epoch || controller.signal.aborted) return
      if (error instanceof LiveNotesApiError && [400, 401, 403, 404].includes(error.status)) this.block(error.message)
      else this.reconnect()
    }
  }
  private flush(): void {
    if (
      !this.current() ||
      !this.authorizationReady ||
      !this.synced ||
      !this.note.canEdit ||
      this.state === 'blocked' ||
      this.socket?.readyState !== 1 ||
      this.sent.size > 0
    )
      return
    for (const [requestId, update] of this.pending) {
      if (update.byteLength > LIVE_NOTE_MAX_UPDATE_BYTES || this.sent.has(requestId)) continue
      // Resending a request after reconnect is safe; only its durable ack retires it.
      if (this.socket.bufferedAmount > 256 * 1024) {
        this.socket.close()
        return
      }
      this.socket.send(JSON.stringify({ type: 'update', requestId, update: encodeNoteUpdate(update) }))
      this.sent.add(requestId)
      return
    }
  }
  private reconnect(): void {
    if (!this.current() || !this.authorizationReady || this.state === 'blocked') return
    this.state = 'offline'
    this.notify()
    this.timer = setTimeout(
      () => {
        void this.connect()
      },
      Math.min(10_000, 500 * 2 ** this.attempt++)
    )
  }
  /** A warm, same-account auth refresh fences transport, not document identity. */
  setAuthorizationReady(ready: boolean): void {
    if (this.authorizationReady === ready || this.state === 'blocked' || !this.current()) return
    this.authorizationReady = ready
    if (ready) {
      void this.connect()
      return
    }
    this.epoch++
    this.controller?.abort()
    clearTimeout(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.synced = false
    this.state = 'offline'
    this.notify()
  }
  block(message: string): void {
    this.state = 'blocked'
    this.error = message
    this.epoch++
    this.controller?.abort()
    clearTimeout(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.notify()
  }
  invalidateIdentity(): void {
    if (!this.current()) this.block('Your account changed. Download unsaved Markdown before reopening the note.')
  }
  destroy(): void {
    this.disposed = true
    this.epoch++
    this.controller?.abort()
    clearTimeout(this.timer)
    this.socket?.close()
    this.document.off('update', this.changed)
    this.document.destroy()
  }
}
