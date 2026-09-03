
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { WebSocket } from 'ws'
import * as Y from 'yjs'

import collaboration from '../../core/collaboration.ts'
import { CollaborationRoomStore, collaborationStateContent } from '../../core/collaboration-store.ts'
import { up as upCollaboration } from '../../db/migrations/2.5.136.ts'
import { up as upDiscardFencing } from '../../db/migrations/tsfranki-000012-collaboration-discard-fencing.ts'
import {
  COLLABORATION_TEXT_KEY,
  COLLABORATION_WEBSOCKET_PROTOCOL,
  decodeCollaborationUpdate,
  parseCollaborationServerMessage,
  type CollaborationServerMessage
} from '../../../shared/collaboration.ts'

const globalWithWiki = globalThis as typeof globalThis & { WIKI?: unknown }
const originalWiki = globalWithWiki.WIKI
let knex: Knex
let server: http.Server
let socket: WebSocket | null

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
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('users', table => table.integer('id').primary())
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('sourceRevision').notNullable()
  })
  await knex('users').insert({ id: 1 })
  await knex('pages').insert({ id: 42, sourceRevision: '1' })
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
    auth: { checkAccess: () => true },
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

describe('collaboration service multi-instance transport', () => {
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
    })).rejects.toThrow('Another user changed this shared draft')
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
      })).rejects.toThrow('Another user is actively editing this page')
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(peerSocket.readyState).toBe(WebSocket.OPEN)
    } finally {
      peerSocket.terminate()
    }
  })
})
