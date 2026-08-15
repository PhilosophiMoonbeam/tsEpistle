/** @vitest-environment node */

import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'

import collaboration from '../../core/collaboration.ts'
import { CollaborationRoomStore } from '../../core/collaboration-store.ts'
import { up as upCollaboration } from '../../db/migrations/2.5.136.ts'
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
  await knex.schema.createTable('pages', table => table.integer('id').primary())
  await knex('users').insert({ id: 1 })
  await knex('pages').insert({ id: 42 })
  await upCollaboration(knex)

  const page = {
    id: 42,
    content: '# Shared\n',
    editorKey: 'markdown',
    updatedAt: '2026-08-15T12:00:00.000Z',
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
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
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
    ], { origin: `http://127.0.0.1:${address.port}` })
    const initialSync = waitForMessage(socket, 'sync')
    await once(socket, 'open')
    await initialSync

    const peerStore = new CollaborationRoomStore(knex)
    const room = await peerStore.get(42)
    if (!room) throw new Error('Expected a durable collaboration room')
    const document = new Y.Doc()
    Y.applyUpdate(document, decodeCollaborationUpdate(room.state))
    let peerUpdate: Uint8Array | null = null
    document.on('update', update => { peerUpdate = update })
    document.getText(COLLABORATION_TEXT_KEY).insert(document.getText(COLLABORATION_TEXT_KEY).length, 'peer')
    if (!peerUpdate) throw new Error('Expected a peer update')
    await peerStore.apply(42, peerUpdate, 1)

    const remoteSync = waitForMessage(socket, 'sync')
    const wiki = globalWithWiki.WIKI as { events: { inbound: { emit(event: string, value: unknown): void } } }
    wiki.events.inbound.emit('collaborationRoomUpdated', { pageId: 42, source: 'peer' })
    const message = await remoteSync
    if (message.type !== 'sync') throw new Error('Expected a collaboration sync message')
    const synchronized = new Y.Doc()
    Y.applyUpdate(synchronized, decodeCollaborationUpdate(message.update))
    expect(synchronized.getText(COLLABORATION_TEXT_KEY).toString()).toBe('# Shared\npeer')
  })
})
