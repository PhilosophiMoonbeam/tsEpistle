import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import * as Y from 'yjs'

import { createMarkdownCollaboration, type CollaborationStatus } from './collaboration.ts'
import {
  COLLABORATION_FORMAT,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_TEXT_KEY,
  COLLABORATION_UPDATE_VERSION,
  COLLABORATION_WEBSOCKET_PATH,
  COLLABORATION_WEBSOCKET_PROTOCOL,
  encodeCollaborationUpdate
} from '../../../shared/collaboration.ts'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING
  binaryType = ''

  constructor (readonly url: string, readonly protocols: string[]) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }

  message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const sessionPayload = () => {
  const document = new Y.Doc()
  document.getText(COLLABORATION_TEXT_KEY).insert(0, '# Shared\n')
  return {
    token: 'signed.token.value',
    pageId: 42,
    format: COLLABORATION_FORMAT,
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    updateVersion: COLLABORATION_UPDATE_VERSION,
    revision: 0,
    baseUpdatedAt: '2026-08-15T12:00:00.000Z',
    state: encodeCollaborationUpdate(Y.encodeStateAsUpdate(document)),
    websocketPath: COLLABORATION_WEBSOCKET_PATH
  }
}

const response = () => Promise.resolve({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => sessionPayload()
})

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Markdown collaboration connection', () => {
  it('uses an ephemeral subprotocol token and surfaces a server conflict without discarding content', async () => {
    const statuses: CollaborationStatus[] = []
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl: vi.fn(response) as unknown as typeof window.fetch,
      onBaseUpdatedAt: vi.fn(),
      onStatus: status => statuses.push(status)
    })
    const socket = FakeWebSocket.instances[0]
    expect(socket.protocols).toEqual([COLLABORATION_WEBSOCKET_PROTOCOL, 'signed.token.value'])
    expect(socket.url).toBe('wss://wiki.example.test/collaboration')
    expect(collaboration.content).toBe('# Shared\n')

    socket.open()
    socket.message({ type: 'presence', participants: 2 })
    socket.message({ type: 'conflict', reason: 'page-changed' })

    expect(statuses.at(-1)).toEqual({ state: 'conflict', participants: 2, conflict: 'page-changed' })
    expect(collaboration.content).toBe('# Shared\n')
    collaboration.destroy()
  })

  it('fetches a fresh token and reconnects after an unexpected disconnect', async () => {
    const fetchImpl = vi.fn(response) as unknown as typeof window.fetch
    const statuses: CollaborationStatus[] = []
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl,
      onBaseUpdatedAt: vi.fn(),
      onStatus: status => statuses.push(status)
    })
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].close(1006)

    await vi.advanceTimersByTimeAsync(500)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.instances[1].open()
    expect(statuses.at(-1)?.state).toBe('connected')
    collaboration.destroy()
  })

  it('keeps updates queued until acknowledged and resends an interrupted update', async () => {
    const fetchImpl = vi.fn(response) as unknown as typeof window.fetch
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl,
      onBaseUpdatedAt: vi.fn(),
      onStatus: vi.fn()
    })
    const socket = FakeWebSocket.instances[0]
    socket.open()
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({
        doc: collaboration.content,
        extensions: [collaboration.extension]
      })
    })

    view.dispatch({ changes: { from: view.state.doc.length, insert: 'A' } })
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'B' } })
    expect(socket.sent).toHaveLength(1)
    const first = JSON.parse(socket.sent[0])
    socket.message({ ...first, revision: 1 })
    expect(socket.sent).toHaveLength(2)
    const interrupted = socket.sent[1]

    socket.close(1006)
    await vi.advanceTimersByTimeAsync(500)
    const reconnected = FakeWebSocket.instances[1]
    reconnected.open()
    expect(reconnected.sent).toEqual([interrupted])

    view.destroy()
    collaboration.destroy()
  })
})
