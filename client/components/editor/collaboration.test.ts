import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import * as Y from 'yjs'

import { createMarkdownCollaboration, type CollaborationStatus } from './collaboration.ts'
import { EditorAdapterController } from './common/editor-adapter.ts'
import { TextEditor } from './common/text-editor.ts'
import {
  COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE,
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

const sessionPayload = (generation = 1) => {
  const document = new Y.Doc()
  document.getText(COLLABORATION_TEXT_KEY).insert(0, '# Shared\n')
  const state = encodeCollaborationUpdate(Y.encodeStateAsUpdate(document))
  document.destroy()
  return {
    token: 'signed.token.value',
    pageId: 42,
    format: COLLABORATION_FORMAT,
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    updateVersion: COLLABORATION_UPDATE_VERSION,
    generation,
    revision: 0,
    baseSourceRevision: '1',
    baseUpdatedAt: '2026-08-15T12:00:00.000Z',
    state,
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

const createPeerEditors = async () => {
  const session = sessionPayload()
  const notifications: Array<Array<{ undo: number; redo: number }>> = [[], []]
  const peers = []
  for (let index = 0; index < 2; index++) {
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => session.baseUpdatedAt,
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => session
      })) as unknown as typeof window.fetch,
      onBaseline: vi.fn(),
      onStatus: vi.fn(),
      onHistoryChange: () => notifications[index].push(collaboration.historyDepth())
    })
    const parent = document.body.appendChild(document.createElement('div'))
    const editor = new TextEditor({
      parent,
      ariaLabel: `Peer ${index}`,
      dark: false,
      value: collaboration.content,
      history: collaboration
    })
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    peers.push({ collaboration, editor, socket, parent })
  }
  const delivered = [0, 0]
  const exchange = () => {
    for (let index = 0; index < peers.length; index++) {
      const socket = peers[index].socket
      while (delivered[index] < socket.sent.length) {
        const update = JSON.parse(socket.sent[delivered[index]++])
        for (const peer of peers) peer.socket.message({ ...update, revision: delivered[index] })
      }
    }
  }
  const destroy = () => {
    for (const peer of peers) {
      peer.editor.setHistory(null)
      peer.editor.destroy()
      peer.collaboration.destroy()
      peer.parent.remove()
    }
  }
  return { peers, notifications, exchange, destroy }
}

describe('Markdown collaboration history', () => {
  it('never enables undo for remote-only text and cannot reach ordinary history', async () => {
    const { peers, notifications, exchange, destroy } = await createPeerEditors()
    const [first, second] = peers
    try {
      second.editor.replaceOffsets('peer', second.editor.getValue().length, second.editor.getValue().length)
      exchange()
      const shared = '# Shared\npeer'
      expect(first.collaboration.content).toBe(shared)
      expect(first.editor.historyDepth()).toEqual({ undo: 0, redo: 0 })
      expect(notifications[0]).toEqual([])
      expect(first.editor.undo()).toBe(false)
      expect(first.editor.redo()).toBe(false)
      first.editor.setSelection({ line: 0, ch: 0 })
      first.editor.setSelection({ line: 1, ch: 2 })
      const content = first.parent.querySelector<HTMLElement>('.cm-content')!
      for (const key of ['z', 'y', 'u']) {
        content.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }))
      }
      for (const inputType of ['historyUndo', 'historyRedo']) {
        content.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }))
      }
      exchange()
      for (const peer of peers) {
        expect(peer.editor.getValue()).toBe(shared)
        expect(peer.collaboration.content).toBe(shared)
      }
      expect(first.editor.historyDepth()).toEqual({ undo: 0, redo: 0 })
    } finally {
      destroy()
    }
  })

  for (const route of ['toolbar', 'keyboard', 'native'] as const) {
    it(`undoes only local input through ${route} and reports finalized redo depths`, async () => {
      const { peers, notifications, exchange, destroy } = await createPeerEditors()
      const [first, second] = peers
      try {
        first.editor.replaceOffsets('local', first.editor.getValue().length, first.editor.getValue().length)
        exchange()
        second.editor.replaceOffsets('peer', second.editor.getValue().length, second.editor.getValue().length)
        exchange()
        expect(first.editor.historyDepth()).toEqual({ undo: 1, redo: 0 })
        expect(notifications[0]).toEqual([{ undo: 1, redo: 0 }])
        const content = first.parent.querySelector<HTMLElement>('.cm-content')!
        // Selection-only history is not an alternate text-undo path.
        first.editor.setSelection({ line: 0, ch: 0 })
        content.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', ctrlKey: true, bubbles: true, cancelable: true }))
        expect(first.editor.getValue()).toBe('# Shared\nlocalpeer')
        if (route === 'toolbar') expect(first.editor.undo()).toBe(true)
        else if (route === 'keyboard') content.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
        else content.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true }))
        exchange()
        for (const peer of peers) {
          expect(peer.editor.getValue()).toBe('# Shared\npeer')
          expect(peer.collaboration.content).toBe('# Shared\npeer')
        }
        expect(first.editor.historyDepth()).toEqual({ undo: 0, redo: 1 })
        expect(notifications[0].at(-1)).toEqual({ undo: 0, redo: 1 })
        expect(first.editor.undo()).toBe(false)
        if (route === 'toolbar') expect(first.editor.redo()).toBe(true)
        else if (route === 'keyboard') content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', keyCode: 90, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
        else content.dispatchEvent(new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true }))
        exchange()
        for (const peer of peers) {
          expect(peer.editor.getValue()).toBe('# Shared\nlocalpeer')
          expect(peer.collaboration.content).toBe('# Shared\nlocalpeer')
        }
        expect(first.editor.historyDepth()).toEqual({ undo: 1, redo: 0 })
        expect(notifications[0]).toEqual([{ undo: 1, redo: 0 }, { undo: 0, redo: 1 }, { undo: 1, redo: 0 }])
        expect(first.collaboration.pendingUpdateCount).toBe(0)
        expect(second.editor.historyDepth()).toEqual({ undo: 1, redo: 0 })
      } finally {
        destroy()
      }
    })
  }

  it('detaches replacement and clear before teardown and keeps fresh standalone history', async () => {
    const { peers, notifications, exchange, destroy } = await createPeerEditors()
    const [first, second] = peers
    const adapter = new EditorAdapterController({
      readText: () => first.editor.getValue(),
      writeText: text => first.editor.setValue(text),
      clearText: () => first.editor.setValue(''),
      destroyCollaboration: () => {
        first.editor.setHistory(null)
        first.collaboration.destroy()
      }
    })
    try {
      first.editor.replaceOffsets('local', first.editor.getValue().length, first.editor.getValue().length)
      exchange()
      const peerText = second.editor.getValue()
      const historyNotifications = notifications[0].length
      adapter.initialize()
      adapter.replaceText('detached replacement', { detached: true })
      expect(first.editor.getValue()).toBe('detached replacement')
      expect(first.editor.historyDepth()).toEqual({ undo: 1, redo: 0 })
      expect(first.editor.undo()).toBe(true)
      expect(first.editor.getValue()).toBe(peerText)
      expect(first.editor.undo()).toBe(false)
      expect(first.editor.redo()).toBe(true)
      expect(second.editor.getValue()).toBe(peerText)
      adapter.clear()
      expect(first.editor.getValue()).toBe('')
      first.editor.reset('standalone')
      expect(first.editor.historyDepth()).toEqual({ undo: 0, redo: 0 })
      first.editor.replaceOffsets('!', 10, 10)
      expect(first.editor.undo()).toBe(true)
      expect(first.editor.getValue()).toBe('standalone')
      expect(notifications[0]).toHaveLength(historyNotifications)
      expect(second.editor.getValue()).toBe(peerText)
    } finally {
      adapter.destroy()
      destroy()
    }
  })

  it('refreshes depth when peer deletion makes a local undo item obsolete', async () => {
    const { peers, notifications, exchange, destroy } = await createPeerEditors()
    const [first, second] = peers
    try {
      first.editor.replaceOffsets('local', first.editor.getValue().length, first.editor.getValue().length)
      exchange()
      second.editor.replaceOffsets('', '# Shared\n'.length, second.editor.getValue().length)
      exchange()
      expect(first.editor.getValue()).toBe('# Shared\n')
      expect(first.editor.historyDepth()).toEqual({ undo: 1, redo: 0 })
      expect(first.editor.undo()).toBe(false)
      expect(first.editor.historyDepth()).toEqual({ undo: 0, redo: 0 })
      expect(notifications[0]).toEqual([{ undo: 1, redo: 0 }, { undo: 0, redo: 0 }])
      expect(second.editor.getValue()).toBe('# Shared\n')
    } finally {
      destroy()
    }
  })
})

describe('Markdown collaboration connection', () => {
  it('uses an ephemeral subprotocol token and surfaces a server conflict without discarding content', async () => {
    const onBaseline = vi.fn()
    const statuses: CollaborationStatus[] = []
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl: vi.fn(response) as unknown as typeof window.fetch,
      onBaseline,
      onStatus: status => statuses.push(status)
    })
    const socket = FakeWebSocket.instances[0]
    expect(socket.protocols).toEqual([COLLABORATION_WEBSOCKET_PROTOCOL, 'signed.token.value'])
    expect(socket.url).toBe('wss://wiki.example.test/collaboration')
    expect(collaboration.content).toBe('# Shared\n')
    expect(collaboration.generation).toBe(1)

    socket.open()
    socket.message({
      type: 'saved',
      baseUpdatedAt: '2026-08-15T12:01:00.000Z',
      baseSourceRevision: '2'
    })
    socket.message({ type: 'presence', participants: 2 })
    socket.message({ type: 'conflict', reason: 'page-changed' })
    expect(onBaseline).toHaveBeenCalledWith({
      updatedAt: '2026-08-15T12:01:00.000Z',
      sourceRevision: '2'
    })

    expect(statuses.at(-1)).toEqual({ state: 'conflict', participants: 2, conflict: 'page-changed' })
    expect(collaboration.content).toBe('# Shared\n')
    collaboration.destroy()
  })

  it('fetches a fresh token and reconnects after an unexpected disconnect', async () => {
    const tokens = ['initial.session.token', 'refreshed.session.token']
    const session = sessionPayload()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ...session, token: tokens.shift() })
    })) as unknown as typeof window.fetch
    const statuses: CollaborationStatus[] = []
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl,
      onBaseline: vi.fn(),
      onStatus: status => statuses.push(status)
    })
    const parent = document.body.appendChild(document.createElement('div'))
    const editor = new TextEditor({
      parent,
      ariaLabel: 'Reconnected editor',
      dark: false,
      value: collaboration.content,
      history: collaboration
    })
    editor.replaceOffsets('local', editor.getValue().length, editor.getValue().length)
    expect(editor.undo()).toBe(true)
    expect(editor.historyDepth()).toEqual({ undo: 0, redo: 1 })
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].close(1006)

    await vi.advanceTimersByTimeAsync(500)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].protocols).toEqual([COLLABORATION_WEBSOCKET_PROTOCOL, 'refreshed.session.token'])
    FakeWebSocket.instances[1].open()
    expect(statuses.at(-1)?.state).toBe('connected')
    expect(editor.historyDepth()).toEqual({ undo: 0, redo: 1 })
    expect(editor.redo()).toBe(true)
    expect(editor.getValue()).toBe('# Shared\nlocal')
    expect(collaboration.content).toBe('# Shared\nlocal')
    editor.setHistory(null)
    editor.destroy()
    parent.remove()
    collaboration.destroy()
  })

  it('keeps updates queued until acknowledged and resends an interrupted update', async () => {
    const fetchImpl = vi.fn(response) as unknown as typeof window.fetch
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl,
      onBaseline: vi.fn(),
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

  it('reports a discarded terminal state and never reconnects or resends stale local updates', async () => {
    const fetchImpl = vi.fn(response) as unknown as typeof window.fetch
    const statuses: CollaborationStatus[] = []
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl,
      onBaseline: vi.fn(),
      onStatus: status => statuses.push(status)
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
    view.dispatch({ changes: { from: view.state.doc.length, insert: '<!-- discarded -->' } })
    expect(socket.sent).toHaveLength(1)

    socket.close(COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(statuses.at(-1)).toEqual({ state: 'conflict', participants: 1, conflict: 'draft-discarded' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
    view.destroy()
    collaboration.destroy()
  })

  it('stops instead of merging a reset generation into a stale document on re-entry', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => sessionPayload(2)
      }) as unknown as typeof window.fetch
    const statuses: CollaborationStatus[] = []
    const collaboration = await createMarkdownCollaboration({
      pageId: 42,
      expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
      fetchImpl,
      onBaseline: vi.fn(),
      onStatus: status => statuses.push(status)
    })
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].close(1006)

    await vi.advanceTimersByTimeAsync(500)

    expect(statuses.at(-1)).toEqual({ state: 'conflict', participants: 1, conflict: 'draft-discarded' })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(collaboration.content).toBe('# Shared\n')
    collaboration.destroy()
  })
})
