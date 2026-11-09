
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { WebSocket } from 'ws'
import * as Y from 'yjs'

import collaboration from '../../core/collaboration.ts'
import { CollaborationRoomStore, collaborationStateContent } from '../../core/collaboration-store.ts'
import { up as upCollaboration } from '../../db/migrations/2.5.136.ts'
import { up as upDiscardFencing } from '../../db/migrations/tsfranki-000012-collaboration-discard-fencing.ts'
import {
  COLLABORATION_TEXT_KEY,
  COLLABORATION_WEBSOCKET_PROTOCOL,
  createCollaborationRange,
  encodeCollaborationUpdate,
  decodeCollaborationUpdate,
  parseCollaborationServerMessage,
  type CollaborationServerMessage,
  type CollaborationSession
} from '../../../shared/collaboration.ts'

const globalWithWiki = globalThis as typeof globalThis & { WIKI?: unknown }
const originalWiki = globalWithWiki.WIKI
let knex: Knex
let server: http.Server
let socket: WebSocket | null
let authorityAllowed: boolean
const waitForMessage = (client: WebSocket, type: CollaborationServerMessage['type']): Promise<CollaborationServerMessage> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      client.off('message', onMessage)
      client.off('error', onError)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onMessage = (raw: Buffer): void => {
      const message = parseCollaborationServerMessage(JSON.parse(raw.toString('utf8')))
      if (message.type !== type) return
      cleanup()
      resolve(message)
    }
    client.on('message', onMessage)
    client.on('error', onError)
  })

beforeEach(async () => {
  authorityAllowed = true
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('users', table => table.integer('id').primary())
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.text('content').notNullable()
    table.string('editorKey').notNullable()
    table.string('updatedAt').notNullable()
    table.string('sourceRevision').notNullable()
  })
  await knex('users').insert({ id: 1 })
  await knex('pages').insert({
    id: 42,
    content: '# Shared\n',
    editorKey: 'markdown',
    updatedAt: '2026-08-15T12:00:00.000Z',
    sourceRevision: '1'
  })
  await upCollaboration(knex)
  await upDiscardFencing(knex)

  const page = {
    id: 42,
    content: '# Shared\n',
    editorKey: 'markdown',
    updatedAt: '2026-08-15T12:00:00.000Z',
    sourceRevision: '1',
    path: 'shared',
    localeCode: 'en',
    visibility: 'public' as const,
    ownerId: null,
    authorId: 1,
    tags: []
  }
  const principal = { id: 1, permissions: ['manage:system'], groups: [], isActive: true }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const events = new (await import('node:events')).EventEmitter()
  globalWithWiki.WIKI = {
    INSTANCE_ID: 'primary',
    auth: {
      checkAccess: () => true,
      checkPageAccess: (_user: Express.User | undefined, _permissions: readonly string[], _context: unknown, authority: { permissions: readonly string[] }) =>
        authorityAllowed && authority.permissions.includes('manage:system'),
      loadPageRuleAuthority: async (requester: Express.User | undefined) => ({
        requester,
        permissions: authorityAllowed ? ['manage:system'] : [],
        groups: [],
        tagAliases: {}
      })
    },
    config: {
      auth: { audience: 'urn:wiki.js' },
      certs: {
        private: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        public: publicKey.export({ type: 'spki', format: 'pem' })
      },
      features: { featurePageCollaboration: true },
      sessionSecret: 'test-session-secret'
    },
    events: { inbound: events, outbound: events },
    logger: { error: () => {}, warn: () => {} },
    models: {
      knex,
      pages: {
        query: () => ({
          findById: () => ({
            withGraphFetched: () => ({ modifyGraph: () => Promise.resolve(page) })
          })
        })
      },
      users: {
        getRootUser: () => Promise.resolve(principal),
        query: () => ({
          findById: () => ({
            withGraphJoined: () => ({ modifyGraph: () => Promise.resolve(principal) })
          })
        })
      }
    }
  }
  server = http.createServer()
  socket = null
})

afterEach(async () => {
  socket?.terminate()
  await collaboration.dispose(server)
  if (server.listening) server.close()
  await knex.destroy()
  if (originalWiki === undefined) delete globalWithWiki.WIKI
  else globalWithWiki.WIKI = originalWiki
})

describe('opt-in ephemeral collaboration presence', () => {
  const connect = async (pageId = 42): Promise<{ client: WebSocket; session: CollaborationSession }> => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const session = await collaboration.issueSession({ pageId, expectedUpdatedAt: '2026-08-15T12:00:00.000Z', requester: { id: 1 } as Express.User })
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/collaboration`, [COLLABORATION_WEBSOCKET_PROTOCOL, session.token], {
      headers: { Origin: `http://127.0.0.1:${address.port}` }
    })
    const sync = waitForMessage(client, 'sync')
    await once(client, 'open')
    await sync
    return { client, session }
  }
  const share = async (client: WebSocket, generation: number, extra: Record<string, unknown> = {}) => {
    const received = waitForMessage(client, 'awareness')
    client.send(JSON.stringify({ type: 'awareness', protocolVersion: 1, generation, enabled: true, selection: null, recent: [], ...extra }))
    const message = await received
    if (message.type !== 'awareness') throw new Error('Expected awareness')
    return message
  }

  it('requires mutual opt-in, supplies fresh unspoofable labels, and never persists awareness', async () => {
    collaboration.init(); collaboration.install(server)
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const first = await connect()
    socket = first.client
    const second = await connect()
    const observed: CollaborationServerMessage[] = []
    second.client.on('message', raw => observed.push(parseCollaborationServerMessage(JSON.parse(raw.toString()))))
    try {
      const before = await knex('pageCollaborationRooms').where({ pageId: 42 }).first()
      const one = await share(first.client, first.session.generation)
      expect(one.self).toMatch(/^[0-9a-f-]{36}$/u)
      expect(one.peers).toEqual([])
      // A durable round trip settles the server queue without an arbitrary sleep.
      const barrier = waitForMessage(second.client, 'update')
      second.client.send(JSON.stringify({ type: 'update', protocolVersion: 1, updateVersion: 1, generation: first.session.generation, update: 'AAA=' }))
      await barrier
      expect(observed.filter(message => message.type === 'awareness')).toEqual([])
      const afterDurableBarrier = await knex('pageCollaborationRooms').where({ pageId: 42 }).first()
      const two = await share(second.client, second.session.generation)
      expect(two.self).not.toBe(one.self)
      expect(two.peers).toMatchObject([{ token: one.self, label: `Participant ${one.self!.slice(0, 8)}`, selection: null, recent: [] }])
      expect(await knex('pageCollaborationRooms').where({ pageId: 42 }).first()).toEqual(afterDurableBarrier)
      expect(afterDurableBarrier.state).toBe(before.state)
      const refused = await share(first.client, first.session.generation, { token: two.self })
      expect(refused).toMatchObject({ self: null, peers: [] })
      expect(first.client.readyState).toBe(WebSocket.OPEN)
      const next = await share(first.client, first.session.generation)
      expect(next.self).not.toBe(one.self)
      const optOut = await share(first.client, first.session.generation, { enabled: false })
      expect(optOut).toMatchObject({ self: null, peers: [] })
      first.client.close()
      await once(first.client, 'close')
      const afterDeparture = await share(second.client, second.session.generation)
      expect(afterDeparture.peers).toEqual([])
      const reconnected = await connect()
      try {
        const fresh = await share(reconnected.client, reconnected.session.generation)
        expect(fresh.self).not.toBe(next.self)
        const persisted = JSON.stringify(await knex('pageCollaborationRooms').where({ pageId: 42 }).first())
        expect(persisted).not.toContain(fresh.self!)
        expect(persisted).not.toContain('Participant')
      } finally { reconnected.client.terminate() }
    } finally { second.client.terminate() }
  })

  it('accepts only fresh same-connection edit ranges and drops stale/malformed presence without blocking source updates', async () => {
    collaboration.init(); collaboration.install(server)
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const first = await connect()
    socket = first.client
    const second = await connect()
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, decodeCollaborationUpdate(first.session.state))
      const text = doc.getText(COLLABORATION_TEXT_KEY)
      const original = createCollaborationRange(text, 0, 4)
      await share(first.client, first.session.generation)
      await share(second.client, second.session.generation)
      const initial = await share(first.client, first.session.generation, { selection: original, recent: [original] })
      expect(initial.self).not.toBeNull()
      const oldFromPeer = await share(second.client, second.session.generation)
      expect(oldFromPeer.peers[0].recent).toEqual([])
      let update: Uint8Array | null = null
      doc.on('update', value => { update = value })
      const from = text.length
      text.insert(from, 'new')
      const recent = createCollaborationRange(text, from, text.length)
      const applied = waitForMessage(first.client, 'update')
      first.client.send(JSON.stringify({ type: 'update', protocolVersion: 1, updateVersion: 1, generation: first.session.generation, update: encodeCollaborationUpdate(update!) }))
      await applied
      await share(first.client, first.session.generation, { selection: recent, recent: [recent] })
      const fromPeer = await share(second.client, second.session.generation)
      expect(fromPeer.peers[0].recent).toEqual([recent])
      await share(second.client, second.session.generation, { recent: [recent] })
      const noSpoof = await share(first.client, first.session.generation)
      expect(noSpoof.peers[0].recent).toEqual([])
      const stale = await share(first.client, first.session.generation + 1)
      expect(stale.self).toBeNull()
      expect(first.client.readyState).toBe(WebSocket.OPEN)
      const malformed = await share(first.client, first.session.generation, { selection: { start: {}, end: {} } })
      expect(malformed.self).toBeNull()
      expect(collaborationStateContent((await new CollaborationRoomStore(knex).get(42))!.state)).toBe('# Shared\nnew')
    } finally { doc.destroy(); second.client.terminate() }
  })

  it('expires idle tokens, refreshes identity, and refuses revoked actors', async () => {
    collaboration.init(); collaboration.install(server)
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const first = await connect()
    socket = first.client
    const old = await share(first.client, first.session.generation)
    const expired = waitForMessage(first.client, 'awareness')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000)
    try { expect(await expired).toMatchObject({ self: null, peers: [] }) } finally { clock.mockRestore() }
    const fresh = await share(first.client, first.session.generation)
    expect(fresh.self).not.toBe(old.self)
    authorityAllowed = false
    const conflict = waitForMessage(first.client, 'conflict')
    first.client.send(JSON.stringify({ type: 'awareness', protocolVersion: 1, generation: first.session.generation, enabled: true, selection: null, recent: [] }))
    expect(await conflict).toMatchObject({ reason: 'permission-revoked' })
  })

  it('omits attribution for merged multi-author and replayed state', async () => {
    collaboration.init(); collaboration.install(server)
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const first = await connect()
    socket = first.client
    const second = await connect()
    const author = new Y.Doc(), peer = new Y.Doc()
    try {
      await share(first.client, first.session.generation)
      await share(second.client, second.session.generation)
      Y.applyUpdate(author, decodeCollaborationUpdate(first.session.state))
      Y.applyUpdate(peer, decodeCollaborationUpdate(first.session.state))
      const firstText = author.getText(COLLABORATION_TEXT_KEY), secondText = peer.getText(COLLABORATION_TEXT_KEY)
      const at = firstText.length
      firstText.insert(at, 'A'); secondText.insert(at, 'B')
      const ranges = [createCollaborationRange(firstText, at, at + 1), createCollaborationRange(secondText, at, at + 1)]
      const aggregate = encodeCollaborationUpdate(Y.mergeUpdates([Y.encodeStateAsUpdate(author), Y.encodeStateAsUpdate(peer)]))
      for (let repetition = 0; repetition < 2; repetition += 1) {
        const applied = waitForMessage(first.client, 'update')
        first.client.send(JSON.stringify({ type: 'update', protocolVersion: 1, updateVersion: 1, generation: first.session.generation, update: aggregate }))
        await applied
        await share(first.client, first.session.generation, { recent: ranges })
        const viewed = await share(second.client, second.session.generation)
        expect(viewed.peers[0].recent).toEqual([])
      }
    } finally { author.destroy(); peer.destroy(); second.client.terminate() }
  })

  it('rate-limits presence independently while continuing to acknowledge durable updates', async () => {
    collaboration.init(); collaboration.install(server)
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const first = await connect()
    socket = first.client
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const received: CollaborationServerMessage[] = []
    first.client.on('message', raw => received.push(parseCollaborationServerMessage(JSON.parse(raw.toString()))))
    try {
      for (let count = 0; count < 8; count += 1) await share(first.client, first.session.generation)
      first.client.send(JSON.stringify({ type: 'awareness', protocolVersion: 1, generation: first.session.generation, enabled: true, selection: null, recent: [] }))
      const barrier = waitForMessage(first.client, 'update')
      first.client.send(JSON.stringify({ type: 'update', protocolVersion: 1, updateVersion: 1, generation: first.session.generation, update: 'AAA=' }))
      await barrier
      expect(received.filter(message => message.type === 'awareness')).toHaveLength(8)
      expect(first.client.readyState).toBe(WebSocket.OPEN)
    } finally { clock.mockRestore() }
  })

  it('withholds presence from anonymous actors and other authorized rooms', async () => {
    await knex('pages').insert({ id: 43, content: 'Other room', editorKey: 'markdown', updatedAt: '2026-08-15T12:00:00.000Z', sourceRevision: '1' })
    const wiki = globalWithWiki.WIKI as { models: { pages: { query(): unknown } } }
    wiki.models.pages.query = () => ({
      findById: (id: number) => ({
        withGraphFetched: () => ({
          modifyGraph: async () => ({
            ...await knex('pages').where({ id }).first(),
            path: `room-${id}`, localeCode: 'en', visibility: 'public', ownerId: null, authorId: 1, tags: []
          })
        })
      })
    })
    collaboration.init(); collaboration.install(server)
    await expect(collaboration.issueSession({ pageId: 42, expectedUpdatedAt: '2026-08-15T12:00:00.000Z', requester: undefined })).rejects.toMatchObject({ status: 401 })
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const first = await connect(42)
    socket = first.client
    const other = await connect(43)
    try {
      const one = await share(first.client, first.session.generation)
      const elsewhere = await share(other.client, other.session.generation)
      expect(elsewhere.peers).toEqual([])
      expect(elsewhere.self).not.toBe(one.self)
      const sameRoom = await share(first.client, first.session.generation)
      expect(sameRoom.peers).toEqual([])
    } finally { other.client.terminate() }
  })
})

describe('collaboration service multi-instance transport', () => {
  it.each(['notification', 'next message'])('ends live collaboration authority on account revocation via %s', async mode => {
    const wiki = globalWithWiki.WIKI as { models: { users: { getRootUser(): Promise<{ authVersion?: number }> } }; events: { outbound: { emit(event: string, data: unknown): void } } }
    const principal = await wiki.models.users.getRootUser()
    collaboration.init(); collaboration.install(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address')
    const session = await collaboration.issueSession({ pageId: 42, expectedUpdatedAt: '2026-08-15T12:00:00.000Z', requester: { id: 1 } as Express.User })
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/collaboration`, [COLLABORATION_WEBSOCKET_PROTOCOL, session.token], { headers: { Origin: `http://127.0.0.1:${address.port}` } })
    const sync = waitForMessage(socket, 'sync'); await once(socket, 'open'); await sync
    const conflict = waitForMessage(socket, 'conflict'), closed = once(socket, 'close')
    principal.authVersion = 1
    if (mode === 'notification') wiki.events.outbound.emit('addAuthRevoke', { id: 1, kind: 'u' })
    else socket.send(JSON.stringify({ type: 'update', protocolVersion: session.protocolVersion, updateVersion: session.updateVersion, generation: session.generation, update: 'AAA=' }))
    expect(await conflict).toMatchObject({ reason: 'permission-revoked' }); await closed
    await expect(collaboration.issueSession({ pageId: 42, expectedUpdatedAt: '2026-08-15T12:00:00.000Z', requester: { id: 1, authVersion: 0 } as Express.User })).rejects.toMatchObject({ status: 404 })
    const fresh = await collaboration.issueSession({ pageId: 42, expectedUpdatedAt: '2026-08-15T12:00:00.000Z', requester: { id: 1, authVersion: 1 } as Express.User })
    expect(JSON.parse(Buffer.from(fresh.token.split('.')[1]!, 'base64url').toString()).authVersion).toBe(1)
  })
  it('rechecks fresh page authority for the next message without a reload event', async () => {
    collaboration.init()
    collaboration.install(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP server address')
    const session = await collaboration.issueSession({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      requester: { id: 1 } as Express.User
    })
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/collaboration`, [
      COLLABORATION_WEBSOCKET_PROTOCOL,
      session.token
    ], { headers: { Origin: `http://127.0.0.1:${address.port}` } })
    const sync = waitForMessage(socket, 'sync')
    await once(socket, 'open')
    await sync

    authorityAllowed = false
    const conflict = waitForMessage(socket, 'conflict')
    const closed = once(socket, 'close')
    socket.send(JSON.stringify({
      type: 'update',
      protocolVersion: session.protocolVersion,
      updateVersion: session.updateVersion,
      generation: session.generation,
      update: 'AAA='
    }))
    expect(await conflict).toMatchObject({ reason: 'permission-revoked' })
    await closed
  })

  it('broadcasts durable updates written by an independent instance without sticky sessions', async () => {
    collaboration.init()
    collaboration.install(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP server address')

    const session = await collaboration.issueSession({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      requester: { id: 1 } as Express.User
    })
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/collaboration`, [
      COLLABORATION_WEBSOCKET_PROTOCOL,
      session.token
    ], { headers: { Origin: `http://127.0.0.1:${address.port}` } })
    const initialSync = waitForMessage(socket, 'sync')
    await once(socket, 'open')
    const initialMessage = await initialSync
    if (initialMessage.type !== 'sync') throw new Error('Expected an initial collaboration sync message')
    expect(initialMessage.baseSourceRevision).toBe('1')

    const peerStore = new CollaborationRoomStore(knex)
    const room = await peerStore.get(42)
    if (!room) throw new Error('Expected a durable collaboration room')
    const document = new Y.Doc()
    Y.applyUpdate(document, decodeCollaborationUpdate(room.state))
    let peerUpdate: Uint8Array | null = null
    document.on('update', update => { peerUpdate = update })
    document.getText(COLLABORATION_TEXT_KEY).insert(document.getText(COLLABORATION_TEXT_KEY).length, 'peer')
    if (!peerUpdate) throw new Error('Expected a peer update')
    await peerStore.admit(
      42,
      room.generation,
      1,
      'independent-instance',
      new Date(Date.now() + 60_000),
      room.baseUpdatedAt,
      room.baseSourceRevision
    )
    await peerStore.apply(42, room.generation, 'independent-instance', peerUpdate, 1)

    const remoteSync = waitForMessage(socket, 'sync')
    const wiki = globalWithWiki.WIKI as { events: { inbound: { emit(event: string, value: unknown): void } } }
    wiki.events.inbound.emit('collaborationRoomUpdated', { pageId: 42, source: 'peer' })
    const message = await remoteSync
    if (message.type !== 'sync') throw new Error('Expected a collaboration sync message')
    expect(message.baseSourceRevision).toBe(room.baseSourceRevision)
    const synchronized = new Y.Doc()
    Y.applyUpdate(synchronized, decodeCollaborationUpdate(message.update))
    expect(synchronized.getText(COLLABORATION_TEXT_KEY).toString()).toBe('# Shared\npeer')
  })

  it('resets an owned durable draft so a new session re-enters persisted content', async () => {
    collaboration.init()
    const session = await collaboration.issueSession({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      requester: { id: 1 } as Express.User
    })
    const document = new Y.Doc()
    Y.applyUpdate(document, decodeCollaborationUpdate(session.state))
    let update: Uint8Array | null = null
    document.on('update', value => { update = value })
    document.getText(COLLABORATION_TEXT_KEY).insert(document.getText(COLLABORATION_TEXT_KEY).length, '<!-- discarded -->')
    if (!update) throw new Error('Expected a collaboration update')
    const draftStore = new CollaborationRoomStore(knex)
    await draftStore.admit(
      42,
      session.generation,
      1,
      'draft-author',
      new Date(Date.now() + 60_000),
      session.baseUpdatedAt,
      session.baseSourceRevision
    )
    await draftStore.apply(42, session.generation, 'draft-author', update, 1)

    await collaboration.discardDraft({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      expectedSourceRevision: '1',
      requester: { id: 1 } as Express.User
    })

    const reopened = await collaboration.issueSession({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      requester: { id: 1 } as Express.User
    })
    expect(collaborationStateContent(reopened.state)).toBe('# Shared\n')
  })

  it('refuses to discard a durable draft contributed to by another user', async () => {
    await knex('users').insert({ id: 2 })
    collaboration.init()
    const session = await collaboration.issueSession({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      requester: { id: 1 } as Express.User
    })
    const document = new Y.Doc()
    Y.applyUpdate(document, decodeCollaborationUpdate(session.state))
    let update: Uint8Array | null = null
    document.on('update', value => { update = value })
    document.getText(COLLABORATION_TEXT_KEY).insert(document.getText(COLLABORATION_TEXT_KEY).length, 'other user')
    if (!update) throw new Error('Expected a collaboration update')
    const roomStore = new CollaborationRoomStore(knex)
    await roomStore.admit(
      42,
      session.generation,
      2,
      'other-author',
      new Date(Date.now() + 60_000),
      session.baseUpdatedAt,
      session.baseSourceRevision
    )
    await roomStore.apply(42, session.generation, 'other-author', update, 2)
    await roomStore.leave('other-author')

    await expect(collaboration.discardDraft({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      expectedSourceRevision: '1',
      requester: { id: 1 } as Express.User
    })).rejects.toMatchObject({ name: 'COLLABORATION_DRAFT_CONTRIBUTOR_CONFLICT', status: 409 })
    expect(collaborationStateContent((await roomStore.get(42))?.state ?? '')).toContain('other user')
  })

  it('refuses room-wide discard while another user has an active collaboration socket', async () => {
    await knex('users').insert({ id: 2 })
    collaboration.init()
    collaboration.install(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP server address')
    const firstSession = await collaboration.issueSession({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      requester: { id: 1 } as Express.User
    })
    const peerSession = await collaboration.issueSession({
      pageId: 42,
      expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
      requester: { id: 2 } as Express.User
    })
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/collaboration`, [
      COLLABORATION_WEBSOCKET_PROTOCOL,
      firstSession.token
    ], { headers: { Origin: `http://127.0.0.1:${address.port}` } })
    const peerSocket = new WebSocket(`ws://127.0.0.1:${address.port}/collaboration`, [
      COLLABORATION_WEBSOCKET_PROTOCOL,
      peerSession.token
    ], { headers: { Origin: `http://127.0.0.1:${address.port}` } })
    try {
      const firstSync = waitForMessage(socket, 'sync')
      const peerSync = waitForMessage(peerSocket, 'sync')
      await Promise.all([once(socket, 'open'), once(peerSocket, 'open'), firstSync, peerSync])

      await expect(collaboration.discardDraft({
        pageId: 42,
        expectedUpdatedAt: '2026-08-15T12:00:00.000Z',
        expectedSourceRevision: '1',
        requester: { id: 1 } as Express.User
      })).rejects.toMatchObject({ name: 'COLLABORATION_ACTIVE_PEERS', status: 409 })
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(peerSocket.readyState).toBe(WebSocket.OPEN)
    } finally {
      peerSocket.terminate()
    }
  })
})
