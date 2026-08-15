import type { Extension } from '@codemirror/state'
import { Awareness } from 'y-protocols/awareness'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'

import { fetchCollaborationSession } from '../../helpers/pages-api'
import {
  COLLABORATION_MAX_UPDATE_BYTES,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_TEXT_KEY,
  COLLABORATION_UPDATE_VERSION,
  COLLABORATION_WEBSOCKET_PROTOCOL,
  decodeCollaborationUpdate,
  encodeCollaborationUpdate,
  parseCollaborationServerMessage,
  type CollaborationConflictReason,
  type CollaborationSession
} from '../../../shared/collaboration'

const REMOTE_ORIGIN = Symbol('collaboration-remote')
const RECONNECT_DELAYS_MS = [500, 1_000, 2_500, 5_000, 10_000] as const

export type CollaborationConnectionState = 'connecting' | 'connected' | 'offline' | 'conflict'

export interface CollaborationStatus {
  state: CollaborationConnectionState
  participants: number
  conflict: CollaborationConflictReason | null
}

interface MarkdownCollaborationOptions {
  pageId: number
  expectedUpdatedAt: () => string
  fetchImpl: typeof window.fetch
  onStatus: (status: CollaborationStatus) => void
  onBaseUpdatedAt: (updatedAt: string) => void
}

export interface MarkdownCollaboration {
  readonly content: string
  readonly extension: Extension
  destroy(): void
}

class MarkdownCollaborationImpl implements MarkdownCollaboration {
  private readonly document = new Y.Doc()
  private readonly awareness = new Awareness(this.document)
  private readonly text = this.document.getText(COLLABORATION_TEXT_KEY)
  private readonly pending: Uint8Array[] = []
  private inFlight: string | null = null
  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private destroyed = false
  private conflicted = false
  private participants = 1

  readonly extension: Extension

  private constructor (private readonly options: MarkdownCollaborationOptions, session: CollaborationSession) {
    Y.applyUpdate(this.document, sessionState(session), REMOTE_ORIGIN)
    this.extension = yCollab(this.text, this.awareness)
    this.document.on('update', this.handleDocumentUpdate)
    this.connect(session)
  }

  static async create(options: MarkdownCollaborationOptions): Promise<MarkdownCollaborationImpl> {
    const session = await fetchCollaborationSession(
      options.fetchImpl.bind(window),
      options.pageId,
      options.expectedUpdatedAt()
    )
    return new MarkdownCollaborationImpl(options, session)
  }

  get content(): string {
    return this.text.toString()
  }

  private readonly handleDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN || this.destroyed || this.conflicted) return
    if (update.byteLength > COLLABORATION_MAX_UPDATE_BYTES) {
      this.setConflict('protocol-error')
      return
    }
    this.pending.push(update)
    this.flushPending()
  }

  private connect(session: CollaborationSession): void {
    if (this.destroyed || this.conflicted) return
    this.report('connecting')
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(
      `${scheme}//${window.location.host}${session.websocketPath}`,
      [COLLABORATION_WEBSOCKET_PROTOCOL, session.token]
    )
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.destroyed) return
      this.reconnectAttempt = 0
      this.inFlight = null
      this.report('connected')
      this.flushPending()
    })
    socket.addEventListener('message', event => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      try {
        const message = parseCollaborationServerMessage(JSON.parse(event.data))
        if (message.type === 'sync' || message.type === 'update') {
          Y.applyUpdate(this.document, sessionState(message), REMOTE_ORIGIN)
          if (message.type === 'update' && message.update === this.inFlight) {
            this.pending.shift()
            this.inFlight = null
            this.flushPending()
          }
          if (message.type === 'sync') {
            this.participants = message.participants
            this.options.onBaseUpdatedAt(message.baseUpdatedAt)
          }
        } else if (message.type === 'presence') {
          this.participants = message.participants
        } else if (message.type === 'saved') {
          this.options.onBaseUpdatedAt(message.baseUpdatedAt)
        } else {
          this.setConflict(message.reason)
          return
        }
        this.report('connected')
      } catch {
        this.setConflict('protocol-error')
      }
    })
    socket.addEventListener('close', event => {
      if (this.socket !== socket || this.destroyed || this.conflicted) return
      this.socket = null
      this.inFlight = null
      if (event.code === 4409 || event.code === 4401) {
        this.setConflict(event.code === 4409 ? 'page-changed' : 'permission-revoked')
      } else {
        this.report('offline')
        this.scheduleReconnect()
      }
    })
    socket.addEventListener('error', () => {
      if (this.socket === socket && !this.destroyed && !this.conflicted) this.report('offline')
    })
  }

  private flushPending(): void {
    const socket = this.socket
    const update = this.pending[0]
    if (!socket || socket.readyState !== WebSocket.OPEN || this.inFlight || !update) return
    this.inFlight = encodeCollaborationUpdate(update)
    try {
      socket.send(JSON.stringify({
        type: 'update',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        updateVersion: COLLABORATION_UPDATE_VERSION,
        update: this.inFlight
      }))
    } catch {
      this.inFlight = null
      socket.close()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed || this.conflicted) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void fetchCollaborationSession(
        this.options.fetchImpl.bind(window),
        this.options.pageId,
        this.options.expectedUpdatedAt()
      ).then(session => {
        Y.applyUpdate(this.document, sessionState(session), REMOTE_ORIGIN)
        this.connect(session)
      }).catch((error: unknown) => {
        const status = error && typeof error === 'object' ? Number(Reflect.get(error, 'status')) : 0
        if (status === 409) {
          this.setConflict('page-changed')
        } else if ([401, 403, 404].includes(status)) {
          this.setConflict('permission-revoked')
        } else {
          this.report('offline')
          this.scheduleReconnect()
        }
      })
    }, delay)
  }

  private setConflict(reason: CollaborationConflictReason): void {
    if (this.conflicted || this.destroyed) return
    this.conflicted = true
    clearTimeout(this.reconnectTimer ?? undefined)
    this.reconnectTimer = null
    this.socket?.close(1000, 'Collaboration stopped')
    this.socket = null
    this.options.onStatus({ state: 'conflict', participants: this.participants, conflict: reason })
  }

  private report(state: CollaborationConnectionState): void {
    this.options.onStatus({ state, participants: this.participants, conflict: null })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    clearTimeout(this.reconnectTimer ?? undefined)
    this.reconnectTimer = null
    this.document.off('update', this.handleDocumentUpdate)
    this.socket?.close(1000, 'Editor closed')
    this.socket = null
    this.awareness.destroy()
    this.document.destroy()
  }
}

const sessionState = (message: { state?: string, update?: string }): Uint8Array => {
  const encoded = message.state ?? message.update
  if (!encoded) throw new TypeError('Collaboration state is missing')
  return decodeCollaborationUpdate(encoded)
}

export const createMarkdownCollaboration = (options: MarkdownCollaborationOptions): Promise<MarkdownCollaboration> =>
  MarkdownCollaborationImpl.create(options)
