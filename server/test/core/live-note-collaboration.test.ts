import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import createKnex, { type Knex } from 'knex'
import jwt from 'jsonwebtoken'
import { WebSocket } from 'ws'
import * as Y from 'yjs'

import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { LiveNoteCollaborationService } from '../../core/live-note-collaboration.ts'
import { up } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import { liveNotes } from '../../operations/live-notes.ts'
import { decodeCollaborationUpdate } from '../../../shared/collaboration.ts'
import {
  LIVE_NOTE_MAX_STATE_BYTES,
  LIVE_NOTE_MAX_UPDATE_BYTES,
  LIVE_NOTE_TEXT_KEY,
  parseLiveNoteServerMessage,
  type LiveNoteServerMessage,
  type LiveNoteView
} from '../../../shared/live-notes.ts'

type NoteMessage = Exclude<LiveNoteServerMessage, { type: 'error' }>
const globals = globalThis as typeof globalThis & { WIKI?: unknown }
const originalWiki = globals.WIKI
const owner = { id: 1, authVersion: 0, providerKey: 'local' } as Express.User
const reader = { id: 3, authVersion: 0, providerKey: 'local' } as Express.User
const writer = { id: 4, authVersion: 0, providerKey: 'local' } as Express.User
const secret = 'live-note-socket-test-session-secret'
let knex: Knex
let events: EventEmitter
let deliverNoteEvents: boolean
let canonicalOrigin: string
let servers: http.Server[]
let services: LiveNoteCollaborationService[]
let sockets: WebSocket[]

const text = (note: LiveNoteView): string => {
  const document = new Y.Doc()
  try {
    Y.applyUpdate(document, decodeCollaborationUpdate(note.state, LIVE_NOTE_MAX_STATE_BYTES))
    return document.getText(LIVE_NOTE_TEXT_KEY).toString()
  } finally {
    document.destroy()
  }
}
const edit = (note: LiveNoteView, value: string): string => {
  const document = new Y.Doc()
  try {
    Y.applyUpdate(document, decodeCollaborationUpdate(note.state, LIVE_NOTE_MAX_STATE_BYTES))
    let update: Uint8Array | undefined
    document.on('update', next => {
      update = next
    })
    document.getText(LIVE_NOTE_TEXT_KEY).insert(0, value)
    if (!update) throw new Error('Expected a Yjs text update')
    return Buffer.from(update).toString('base64')
  } finally {
    document.destroy()
  }
}
const nextMessage = (socket: WebSocket, match: (message: NoteMessage) => boolean = () => true): Promise<NoteMessage> => {
  const { promise, resolve, reject } = Promise.withResolvers<NoteMessage>()
  const cleanup = (): void => {
    clearTimeout(timer)
    socket.off('message', onMessage)
    socket.off('close', onClose)
    socket.off('error', onError)
  }
  const onError = (error: Error): void => {
    cleanup()
    reject(error)
  }
  const onClose = (code: number): void => {
    cleanup()
    reject(new Error(`Socket closed before expected message: ${code}`))
  }
  const onMessage = (raw: Buffer): void => {
    try {
      const message = parseLiveNoteServerMessage(JSON.parse(raw.toString('utf8')))
      if (message.type === 'error') throw new Error(message.error)
      if (!match(message)) return
      cleanup()
      resolve(message)
    } catch (error) {
      cleanup()
      reject(error)
    }
  }
  const timer = setTimeout(() => {
    cleanup()
    reject(new Error('Expected live note socket message'))
  }, 6_000)
  socket.on('message', onMessage)
  socket.on('close', onClose)
  socket.on('error', onError)
  return promise
}
const start = async (): Promise<{ service: LiveNoteCollaborationService; server: http.Server; port: number }> => {
  const service = new LiveNoteCollaborationService()
  const server = http.createServer((_req, response) => response.end('unchanged HTTP'))
  services.push(service)
  servers.push(server)
  service.install(server)
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener')
  if (!canonicalOrigin) {
    canonicalOrigin = `http://127.0.0.1:${address.port}`
    const wiki = globals.WIKI as { config: { host: string } }
    wiki.config.host = canonicalOrigin
  }
  return { service, server, port: address.port }
}
const open = async (port: number, token: string): Promise<{ socket: WebSocket; note: LiveNoteView }> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/_api/live-notes/_socket`, { headers: { Origin: canonicalOrigin } })
  sockets.push(socket)
  const initial = nextMessage(socket, message => message.type === 'sync')
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'auth', token }))
  return { socket, note: (await initial).note }
}

beforeEach(async () => {
  servers = []
  services = []
  sockets = []
  canonicalOrigin = ''
  deliverNoteEvents = true
  events = new EventEmitter()
  const emit = events.emit.bind(events)
  events.emit = (event: string | symbol, ...values: unknown[]): boolean => (event === 'liveNoteUpdated' && !deliverNoteEvents ? false : emit(event, ...values))
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
    // Match PostgreSQL's boolean result types at the real operations boundary.
    postProcessResponse: (response: unknown): unknown => {
      const row = (value: unknown): unknown => {
        if (!value || typeof value !== 'object') return value
        const record = value as Record<string, unknown>
        return {
          ...record,
          ...('isActive' in record ? { isActive: Boolean(record.isActive) } : {}),
          ...('everEdited' in record ? { everEdited: Boolean(record.everEdited) } : {})
        }
      }
      return Array.isArray(response) ? response.map(row) : row(response)
    }
  })
  await knex.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable().defaultTo(true)
    table.integer('authVersion').notNullable().defaultTo(0)
    table.string('providerKey').notNullable().defaultTo('local')
  })
  await knex.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.text('permissions').notNullable()
  })
  await knex.schema.createTable('userGroups', table => {
    table.integer('userId')
    table.integer('groupId')
  })
  await knex('users').insert([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
  await knex('groups').insert([
    { id: 3, permissions: JSON.stringify(['read:notes']) },
    { id: 4, permissions: JSON.stringify(['write:notes']) }
  ])
  await knex('userGroups').insert([
    { userId: 3, groupId: 3 },
    { userId: 4, groupId: 4 }
  ])
  await up(knex)
  globals.WIKI = {
    config: { host: 'http://127.0.0.1', auth: { audience: 'live-note-tests' }, sessionSecret: secret },
    models: { knex },
    events: { inbound: events, outbound: events },
    logger: { warn: () => {} }
  }
})

afterEach(async () => {
  for (const socket of sockets) socket.terminate()
  for (const service of services) await service.dispose()
  for (const server of servers) {
    if (!server.listening) continue
    const closed = once(server, 'close')
    server.close()
    await closed
  }
  await knex.destroy()
  if (originalWiki === undefined) delete globals.WIKI
  else globals.WIKI = originalWiki
})

describe('live note websocket lifecycle', () => {
  it('merges concurrent clients on independent services, durably acknowledges, and reconnects without reseeding', async () => {
    const note = await liveNotes.create(owner, { key: 'concurrent-note' })
    await liveNotes.updateAccess(owner, note.key, { expectedRevision: note.revision, access: 'edit' })
    const first = await start()
    const second = await start()
    const firstSession = await liveNotes.session(owner, note.key)
    const secondSession = await liveNotes.session(writer, note.key)
    const left = await open(first.port, firstSession.token)
    const right = await open(second.port, secondSession.token)
    const leftUpdate = edit(left.note, 'left')
    const rightUpdate = edit(right.note, 'right')
    const leftAck = nextMessage(left.socket, message => message.type === 'ack' && message.requestId === 'left-request')
    const rightAck = nextMessage(right.socket, message => message.type === 'ack' && message.requestId === 'right-request')
    const mergedLeft = nextMessage(left.socket, message => message.note.revision >= left.note.revision + 2)
    const mergedRight = nextMessage(right.socket, message => message.note.revision >= right.note.revision + 2)
    left.socket.send(JSON.stringify({ type: 'update', requestId: 'left-request', update: leftUpdate }))
    right.socket.send(JSON.stringify({ type: 'update', requestId: 'right-request', update: rightUpdate }))
    await Promise.all([leftAck, rightAck])
    const durable = await liveNotes.read(owner, note.key)
    expect(text(durable)).toContain('left')
    expect(text(durable)).toContain('right')
    expect(durable.revision).toBe(left.note.revision + 2)
    expect(await knex('liveNoteRequests').where({ noteId: note.id }).count({ total: '*' }).first()).toMatchObject({ total: 2 })
    for (const synchronized of await Promise.all([mergedLeft, mergedRight])) expect(text(synchronized.note)).toBe(text(durable))

    const leftClosed = once(left.socket, 'close')
    left.socket.close()
    await leftClosed
    const reconnected = await open(second.port, firstSession.token)
    expect(text(reconnected.note)).toBe(text(durable))
    expect(reconnected.note.revision).toBe(durable.revision)
    expect((await knex('liveNoteConnections')).length).toBe(2)
    const repeated = nextMessage(reconnected.socket, message => message.type === 'ack' && message.requestId === 'left-request')
    reconnected.socket.send(JSON.stringify({ type: 'update', requestId: 'left-request', update: leftUpdate }))
    expect((await repeated).note.revision).toBe(durable.revision)
    expect((await liveNotes.read(owner, note.key)).revision).toBe(durable.revision)
  })

  it('refreshes committed state from another instance even when every notification is lost', async () => {
    // This integration exercises the actual ws/platform timer path, not a fake
    // clock which could also suppress the underlying transport's own callbacks.
    const note = await liveNotes.create(owner, { key: 'polled-note' })
    const { port } = await start()
    const session = await liveNotes.session(owner, note.key)
    const peer = await open(port, session.token)
    deliverNoteEvents = false
    const refreshed = nextMessage(peer.socket, message => message.type === 'sync' && message.note.revision > note.revision)
    await liveNotes.applyUpdate(owner, note.key, { requestId: 'remote-commit', update: edit(note, 'remote persisted text') })
    expect(text((await refreshed).note)).toBe('remote persisted text')
  })

  it('allows readers to follow edits but never write', async () => {
    const created = await liveNotes.create(owner, { key: 'reader-note' })
    const note = await liveNotes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'edit' })
    const { port } = await start()
    const peer = await open(port, (await liveNotes.session(reader, note.key)).token)
    expect(peer.note.canEdit).toBe(false)
    const following = nextMessage(peer.socket, message => message.type === 'sync' && message.note.revision > note.revision)
    await liveNotes.applyUpdate(owner, note.key, { requestId: 'owner-edit', update: edit(note, 'visible to reader') })
    const current = (await following).note
    expect(text(current)).toBe('visible to reader')
    const closed = once(peer.socket, 'close')
    peer.socket.send(JSON.stringify({ type: 'update', requestId: 'reader-write', update: edit(current, 'forbidden') }))
    expect((await closed)[0]).toBe(4403)
    expect(text(await liveNotes.read(owner, note.key))).toBe('visible to reader')
  })

  it('admits an explicitly eligible guest reader without granting write authority', async () => {
    await knex('userGroups').insert({ userId: 2, groupId: 3 })
    const guest = { id: 2, authVersion: 0, ownershipUserId: null } as Express.User
    const created = await liveNotes.create(owner, { key: 'guest-reader-note' })
    const note = await liveNotes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'read' })
    const { port } = await start()
    const peer = await open(port, (await liveNotes.session(guest, note.key)).token)
    expect(peer.note.canEdit).toBe(false)
    expect(peer.note.canManage).toBe(false)
    const closed = once(peer.socket, 'close')
    peer.socket.send(JSON.stringify({ type: 'update', requestId: 'guest-write', update: edit(note, 'forbidden') }))
    expect((await closed)[0]).toBe(4403)
    expect((await liveNotes.read(owner, note.key)).revision).toBe(note.revision)
  })

  it.each(['group permission', 'account session version', 'private sharing without notifications'])(
    'revokes live data after %s changes before publishing a fresh state',
    async mode => {
      const created = await liveNotes.create(owner, { key: 'revoked-note' })
      const note = await liveNotes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'edit' })
      const { port } = await start()
      const peer = await open(port, (await liveNotes.session(writer, note.key)).token)
      const received: string[] = []
      peer.socket.on('message', raw => received.push(raw.toString()))
      const closed = once(peer.socket, 'close')
      if (mode === 'group permission') await knex('groups').where({ id: 4 }).update({ permissions: '[]' })
      else if (mode === 'account session version') await knex('users').where({ id: 4 }).update({ authVersion: 1 })
      else {
        // Lost pubsub must not preserve admission after a sharing-policy change.
        deliverNoteEvents = false
        await liveNotes.updateAccess(owner, note.key, { expectedRevision: note.revision, access: 'private' })
      }
      await liveNotes.applyUpdate(owner, note.key, { requestId: 'after-revocation', update: edit(note, 'new confidential text') })
      expect([4401, 4403]).toContain((await closed)[0])
      expect(received).toEqual([])
    }
  )

  it('downgrades an editor to live reader when only note write access is removed', async () => {
    const created = await liveNotes.create(owner, { key: 'downgraded-note' })
    const editable = await liveNotes.updateAccess(owner, created.key, { expectedRevision: 0, access: 'edit' })
    const { port } = await start()
    const peer = await open(port, (await liveNotes.session(writer, created.key)).token)
    const downgraded = nextMessage(peer.socket, message => message.type === 'sync' && !message.note.canEdit)
    await liveNotes.updateAccess(owner, created.key, { expectedRevision: editable.revision, access: 'read' })
    expect((await downgraded).note.canEdit).toBe(false)
    expect(peer.socket.readyState).toBe(WebSocket.OPEN)
  })

  it('does not expose state or acquire a room lease for invalid or expired authentication', async () => {
    const note = await liveNotes.create(owner, { key: 'auth-note' })
    const { port } = await start()
    const session = await liveNotes.session(owner, note.key)
    const claims = jwt.decode(session.token)
    if (!claims || typeof claims === 'string') throw new Error('Expected live note claims')
    const expiredAt = Math.floor(Date.now() / 1000) - 1
    const expired = jwt.sign({ ...claims, iat: expiredAt - 300, exp: expiredAt }, secret, { algorithm: 'HS256' })
    for (const token of ['invalid-token', expired]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/_api/live-notes/_socket`, { headers: { Origin: canonicalOrigin } })
      sockets.push(socket)
      const messages: string[] = []
      socket.on('message', raw => messages.push(raw.toString()))
      await once(socket, 'open')
      const closed = once(socket, 'close')
      socket.send(JSON.stringify({ type: 'auth', token }))
      expect((await closed)[0]).toBe(4401)
      expect(messages).toEqual([])
    }
    expect(await knex('liveNoteConnections')).toEqual([])
  })

  it('requires authentication first and does not allow a live socket to change identity', async () => {
    const note = await liveNotes.create(owner, { key: 'identity-note' })
    const { port } = await start()
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/_api/live-notes/_socket`, { headers: { Origin: canonicalOrigin } })
    sockets.push(unauthenticated)
    await once(unauthenticated, 'open')
    const rejected = once(unauthenticated, 'close')
    unauthenticated.send(JSON.stringify({ type: 'update', requestId: 'before-auth', update: edit(note, 'not admitted') }))
    expect((await rejected)[0]).toBe(4400)
    expect((await liveNotes.read(owner, note.key)).revision).toBe(0)

    const session = await liveNotes.session(owner, note.key)
    const peer = await open(port, session.token)
    const other = await liveNotes.create(owner, { key: 'other-identity' })
    const otherSession = await liveNotes.session(owner, other.key)
    const messages: string[] = []
    peer.socket.on('message', raw => messages.push(raw.toString()))
    const closed = once(peer.socket, 'close')
    peer.socket.send(JSON.stringify({ type: 'auth', token: otherSession.token }))
    expect((await closed)[0]).toBe(4400)
    expect(messages).toEqual([])
  })

  it('rejects a forged Host and Origin instead of trusting their agreement', async () => {
    const { port } = await start()
    const { promise, resolve, reject } = Promise.withResolvers<number | undefined>()
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/_api/live-notes/_socket',
        headers: {
          Host: 'attacker.example',
          Origin: 'https://attacker.example',
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13'
        }
      },
      response => {
        response.resume()
        resolve(response.statusCode)
      }
    )
    request.on('error', reject)
    expect(await promise).toBe(403)
    expect(await knex('liveNoteConnections')).toEqual([])
  })

  it('expires a connected session and releases its durable lease on shutdown', async () => {
    const note = await liveNotes.create(owner, { key: 'expiry-note' })
    const { port, service } = await start()
    const session = await liveNotes.session(owner, note.key)
    const claims = jwt.decode(session.token)
    if (!claims || typeof claims === 'string') throw new Error('Expected live note claims')
    // Keep the signed five-minute lifetime exact while exercising real platform expiry.
    const expiresAt = Math.floor(Date.now() / 1000) + 2
    const short = jwt.sign({ ...claims, iat: expiresAt - 300, exp: expiresAt }, secret, { algorithm: 'HS256' })
    const peer = await open(port, short)
    expect((await knex('liveNoteConnections')).length).toBe(1)
    expect((await once(peer.socket, 'close'))[0]).toBe(4408)
    await service.dispose()
    expect(await knex('liveNoteConnections')).toEqual([])
  })

  it('releases active leases and closes sockets when a listener is disposed', async () => {
    const note = await liveNotes.create(owner, { key: 'shutdown-note' })
    const { port, service, server } = await start()
    const peer = await open(port, (await liveNotes.session(owner, note.key)).token)
    expect((await knex('liveNoteConnections')).length).toBe(1)
    const closed = once(peer.socket, 'close')
    await service.dispose(server)
    expect((await closed)[0]).toBe(1001)
    expect(await knex('liveNoteConnections')).toEqual([])
    expect(server.listenerCount('upgrade')).toBe(0)
    expect(events.listenerCount('liveNoteUpdated')).toBe(0)
  })

  it('bounds queued updates while storage is unavailable and never acknowledges uncommitted work', async () => {
    const note = await liveNotes.create(owner, { key: 'queue-note' })
    const { port, service } = await start()
    const peer = await open(port, (await liveNotes.session(owner, note.key)).token)
    const update = edit(note, 'queued')
    const transaction = await knex.transaction()
    const messages: string[] = []
    peer.socket.on('message', raw => messages.push(raw.toString()))
    try {
      const closed = once(peer.socket, 'close')
      for (let index = 0; index < 10; index += 1) peer.socket.send(JSON.stringify({ type: 'update', requestId: `queued-${index}`, update }))
      expect((await closed)[0]).toBe(4429)
      expect(messages).toEqual([])
    } finally {
      await transaction.commit()
    }
    await service.dispose()
    expect((await liveNotes.read(owner, note.key)).revision).toBe(0)
    expect(await knex('liveNoteConnections')).toEqual([])
  })

  it('rejects updates larger than the decoded byte limit without persisting them', async () => {
    const note = await liveNotes.create(owner, { key: 'oversized-note' })
    const { port } = await start()
    const peer = await open(port, (await liveNotes.session(owner, note.key)).token)
    const closed = once(peer.socket, 'close')
    peer.socket.send(JSON.stringify({ type: 'update', requestId: 'oversized', update: Buffer.alloc(LIVE_NOTE_MAX_UPDATE_BYTES + 1).toString('base64') }))
    expect((await closed)[0]).toBe(4400)
    expect((await liveNotes.read(owner, note.key)).revision).toBe(0)
  })
})
