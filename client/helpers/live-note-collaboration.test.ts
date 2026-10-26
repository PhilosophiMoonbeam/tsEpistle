import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import '../test/browser-dom.mts'
import * as Y from 'yjs'
import { LiveNoteCollaboration, encodeNoteUpdate, decodeNoteState } from './live-note-collaboration.ts'
import { createLiveNotesApi, type LiveNotesApi } from './live-notes-api.ts'
import { parseLiveNoteClientMessage, type LiveNoteView } from '../../shared/live-notes.ts'

class Socket {
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  private listeners = new Map<string, Array<(event: unknown) => void>>()
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(value: string) {
    this.sent.push(value)
  }
  close(code = 1000) {
    this.readyState = 3
    this.emit('close', { code })
  }
  open() {
    this.readyState = 1
    this.emit('open', {})
  }
  message(message: unknown) {
    this.emit('message', { data: JSON.stringify(message) })
  }
  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}
const live: LiveNoteCollaboration[] = []
const docs: Y.Doc[] = []
afterEach(() => {
  for (const item of live.splice(0)) item.destroy()
  for (const doc of docs.splice(0)) doc.destroy()
  vi.useRealTimers()
})
const newDoc = () => {
  const doc = new Y.Doc()
  docs.push(doc)
  return doc
}
function view(doc: Y.Doc, revision = 0, canEdit = true): LiveNoteView {
  return {
    id: '3cd9d8ad-b4fc-48ba-82f0-b65dc7ff833a',
    key: 'team-note',
    ownerId: 1,
    title: 'Team',
    access: 'edit',
    revision,
    updatedAt: '2026-10-22T00:00:00.000Z',
    canEdit,
    canManage: canEdit,
    state: encodeNoteUpdate(Y.encodeStateAsUpdate(doc))
  }
}
function fixture(note: LiveNoteView, identity: () => string = () => 'account-one') {
  const sockets: Socket[] = []
  const api = {
    ...createLiveNotesApi(async () => { throw new Error('Unexpected live note API request') }, () => 'csrf'),
    session: vi.fn<LiveNotesApi['session']>(async () => ({ key: note.key, token: 'session', websocketPath: '/_api/live-notes/_socket', expiresAt: '2099-01-01T00:00:00.000Z' }))
  } satisfies LiveNotesApi
  const client = new LiveNoteCollaboration({
    note,
    api,
    identity,
    onChange: vi.fn(),
    socket: () => {
      const socket = new Socket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    }
  })
  live.push(client)
  return { client, sockets, api }
}
const updates = (socket: Socket) => socket.sent.map(value => parseLiveNoteClientMessage(JSON.parse(value))).filter(message => message.type === 'update')
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('live note durable lifecycle', () => {
  it('merges two independent editors without seeding twice and retires only the matching durable acknowledgement', async () => {
    const server = newDoc()
    server.getText('content').insert(0, 'Start')
    const initial = view(server)
    const first = fixture(initial),
      second = fixture(initial)
    await Promise.all([first.client.connect(), second.client.connect()])
    for (const peer of [first, second]) {
      peer.sockets[0].open()
      peer.sockets[0].message({ type: 'sync', note: initial })
    }
    first.client.text.insert(5, ' A')
    second.client.text.insert(0, 'B ')
    const updateA = updates(first.sockets[0])[0],
      updateB = updates(second.sockets[0])[0]
    Y.applyUpdate(server, decodeNoteState(updateA.update))
    Y.applyUpdate(server, decodeNoteState(updateB.update))
    const committed = view(server, 2)
    first.sockets[0].message({ type: 'sync', note: committed })
    first.sockets[0].message({ type: 'ack', requestId: 'unrelated', note: committed })
    expect(first.client.pendingCount).toBe(1)
    first.sockets[0].message({ type: 'ack', requestId: updateA.requestId, note: committed })
    second.sockets[0].message({ type: 'ack', requestId: updateB.requestId, note: committed })
    expect(first.client.text.toString()).toBe('B Start A')
    expect(second.client.text.toString()).toBe('B Start A')
    expect(first.client.pendingCount).toBe(0)
    expect(second.client.pendingCount).toBe(0)
  })

  it('reuses the same document and request identity after an uncertain disconnect and applies restores as CRDT updates', async () => {
    vi.useFakeTimers()
    const server = newDoc()
    server.getText('content').insert(0, 'before')
    const initial = view(server),
      peer = fixture(initial)
    await peer.client.connect()
    const originalDocument = peer.client.document
    peer.sockets[0].open()
    peer.sockets[0].message({ type: 'sync', note: initial })
    peer.client.text.insert(6, ' unsaved')
    const request = updates(peer.sockets[0])[0]
    Y.applyUpdate(server, decodeNoteState(request.update)) // committed, but the acknowledgement is lost
    peer.sockets[0].close(1011)
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    peer.sockets[1].open()
    peer.sockets[1].message({ type: 'sync', note: view(server, 1) })
    expect(peer.client.document).toBe(originalDocument)
    expect(peer.client.text.toString()).toBe('before unsaved')
    expect(updates(peer.sockets[1])).toEqual([request])
    expect(peer.client.pendingCount).toBe(1)
    peer.sockets[1].message({ type: 'ack', requestId: request.requestId, note: view(server, 1) })
    server.transact(() => {
      const text = server.getText('content')
      text.delete(0, text.length)
      text.insert(0, 'restored')
    })
    peer.sockets[1].message({ type: 'sync', note: view(server, 2) })
    expect(peer.client.document).toBe(originalDocument)
    expect(peer.client.text.toString()).toBe('restored')
    expect(peer.client.pendingCount).toBe(0)
  })

  it('keeps pending recovery text but forbids sends and session admission under another account', async () => {
    let actor = 'one'
    const server = newDoc(),
      peer = fixture(view(server), () => actor)
    await peer.client.connect()
    peer.sockets[0].open()
    peer.sockets[0].message({ type: 'sync', note: view(server) })
    peer.client.text.insert(0, 'recover me')
    const sent = peer.sockets[0].sent.length
    actor = 'two'
    peer.client.invalidateIdentity()
    expect(peer.client.canEdit).toBe(false)
    expect(peer.client.state).toBe('blocked')
    expect(peer.client.text.toString()).toBe('recover me')
    expect(peer.client.pendingCount).toBe(1)
    await peer.client.connect()
    expect(peer.api.session).toHaveBeenCalledTimes(1)
    expect(peer.sockets[0].sent).toHaveLength(sent)
  })

  it('ignores admission that finishes after an identity change or disposal', async () => {
    const server = newDoc()
    let actor = 'one'
    const peer = fixture(view(server), () => actor)
    const admission = Promise.withResolvers<{ key: string; token: string; websocketPath: '/_api/live-notes/_socket'; expiresAt: string }>()
    peer.api.session.mockImplementationOnce(() => admission.promise)
    const connecting = peer.client.connect()
    actor = 'two'
    peer.client.invalidateIdentity()
    admission.resolve({ key: 'team-note', token: 'old-account-token', websocketPath: '/_api/live-notes/_socket', expiresAt: '2099-01-01T00:00:00.000Z' })
    await connecting
    expect(peer.sockets).toHaveLength(0)
  })

  it('keeps a read session live after edit capability is revoked without transmitting pending edits', async () => {
    const server = newDoc(),
      initial = view(server),
      peer = fixture(initial)
    await peer.client.connect()
    peer.sockets[0].open()
    peer.sockets[0].message({ type: 'sync', note: initial })
    peer.sockets[0].message({ type: 'sync', note: view(server, 1, false) })
    expect(peer.client.canEdit).toBe(false)
    expect(peer.client.state).toBe('connected')
    server.getText('content').insert(0, 'still readable')
    peer.sockets[0].message({ type: 'sync', note: view(server, 2, false) })
    expect(peer.client.text.toString()).toBe('still readable')
    expect(updates(peer.sockets[0])).toEqual([])
  })
})

it('drains a reconnect backlog with one outstanding durable request instead of overflowing the server queue', async () => {
  vi.useFakeTimers()
  const server = newDoc(),
    initial = view(server),
    peer = fixture(initial)
  await peer.client.connect()
  peer.sockets[0].open()
  peer.sockets[0].message({ type: 'sync', note: initial })
  peer.sockets[0].close(1011)
  for (let index = 0; index < 20; index++) peer.client.text.insert(peer.client.text.length, String(index % 10))
  expect(peer.client.pendingCount).toBe(20)
  await peer.client.connect()
  const socket = peer.sockets[1]
  socket.open()
  socket.message({ type: 'sync', note: initial })
  expect(updates(socket)).toHaveLength(1)
  for (let index = 0; index < 20; index++) {
    const request = updates(socket)[index]
    expect(request).toBeDefined()
    expect(updates(socket)).toHaveLength(index + 1)
    Y.applyUpdate(server, decodeNoteState(request.update))
    socket.message({ type: 'ack', requestId: request.requestId, note: view(server, index + 1) })
  }
  expect(peer.client.pendingCount).toBe(0)
  expect(server.getText('content').toString()).toBe('01234567890123456789')
  expect(peer.client.text.toString()).toBe(server.getText('content').toString())
})

it('pauses transport readiness without destroying a same-account document or retiring pending updates', async () => {
  const server = newDoc(),
    initial = view(server),
    peer = fixture(initial)
  await peer.client.connect()
  peer.sockets[0].open()
  peer.sockets[0].message({ type: 'sync', note: initial })
  const document = peer.client.document
  peer.client.text.insert(0, 'pending')
  const request = updates(peer.sockets[0])[0]
  peer.client.setAuthorizationReady(false)
  expect(peer.client.state).toBe('offline')
  expect(peer.client.canEdit).toBe(false)
  await peer.client.connect()
  expect(peer.api.session).toHaveBeenCalledTimes(1)
  peer.client.accept(initial)
  peer.client.setAuthorizationReady(true)
  await flush()
  peer.sockets[1].open()
  peer.sockets[1].message({ type: 'sync', note: initial })
  expect(updates(peer.sockets[1])).toEqual([request])
  expect(peer.client.document).toBe(document)
  expect(peer.client.pendingCount).toBe(1)
  Y.applyUpdate(server, decodeNoteState(request.update))
  peer.sockets[1].message({ type: 'ack', requestId: request.requestId, note: view(server, 1) })
  expect(peer.client.pendingCount).toBe(0)
  expect(peer.client.text.toString()).toBe('pending')
})
