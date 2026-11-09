import { sessionVersion } from '../helpers/account-session.ts'
import { randomUUID } from 'node:crypto'
import type http from 'node:http'
import type https from 'node:https'
import type { Socket } from 'node:net'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import type { Knex } from 'knex'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import * as Y from 'yjs'

import { canWritePage } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import errors from '../operations/errors.ts'
import {
  COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE,
  COLLABORATION_FORMAT,
  COLLABORATION_MAX_UPDATE_BYTES,
  COLLABORATION_MAX_PRESENCE_PARTICIPANTS,
  COLLABORATION_MAX_RECENT_RANGES,
  COLLABORATION_PRESENCE_TTL_MS,
  COLLABORATION_RECENT_TTL_MS,
  COLLABORATION_TEXT_KEY,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_UPDATE_VERSION,
  COLLABORATION_WEBSOCKET_PATH,
  COLLABORATION_WEBSOCKET_PROTOCOL,
  decodeCollaborationUpdate,
  parseCollaborationClientMessage,
  resolveCollaborationRange,
  resolveCollaborationRecent,
  type CollaborationParticipant,
  type CollaborationAwareness,
  type CollaborationConflictReason,
  type CollaborationClientMessage,
  type CollaborationServerMessage,
  type CollaborationSession
} from '../../shared/collaboration.ts'
import { CollaborationRoomStore, type CollaborationPageRecord, type CollaborationRoomRecord } from './collaboration-store.ts'

const { ApplicationError } = errors

type NodeServer = http.Server | https.Server

type EventBus = {
  on(event: string, listener: (value?: unknown) => void): void
  off(event: string, listener: (value?: unknown) => void): void
  emit(event: string, value?: unknown): void
}

interface CollaborationPrincipal extends Express.User {
  id: number
  isActive?: boolean
  authVersion?: number
  getGlobalPermissions?: () => string[]
  permissions: string[]
}

interface CollaborationPage extends CollaborationPageRecord {
  path: string
  localeCode: string
  visibility: 'public' | 'private'
  ownerId: number | null
  authorId?: number
  tags?: unknown
}

interface CollaborationClaims extends JwtPayload {
  kind: 'collaboration'
  authVersion?: number
  userId: number
  pageId: number
  format: typeof COLLABORATION_FORMAT
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  generation: number
  baseSourceRevision: string
  baseUpdatedAt: string
  exp: number
}
const MAX_PENDING_MESSAGES_PER_CLIENT = 8

interface CollaborationSocket {
  authVersion: number
  socket: WebSocket
  pageId: number
  userId: number
  generation: number
  baseSourceRevision: string
  baseUpdatedAt: string
  connectionId: string
  queue: Promise<void>
  pendingMessages: number
  acceptingUpdates: boolean
  presence: { participant: CollaborationParticipant; recentUntil: number } | null
  presenceWindow: number
  presenceMessages: number
  recentItems: Array<{ client: number; from: number; to: number; expiresAt: number }>
}
interface CollaborationMount {
  webSocketServer: WebSocketServer
  upgradeListener: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void
}


interface CollaborationWiki {
  INSTANCE_ID: string
  auth: {
    checkAccess(user: Express.User | undefined, permissions: readonly string[]): boolean
    loadPageRuleAuthority(requester: Express.User | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  config: {
    auth: { audience: string }
    certs: { private: string | Buffer, public: string | Buffer }
    features: { featurePageCollaboration?: boolean }
    sessionSecret: string
  }
  events: { inbound: EventBus, outbound: EventBus }
  logger: { error(value: unknown): void, warn(value: unknown): void }
  models: {
    knex: Knex
    pages: {
      query(): {
        findById(id: number): {
          withGraphFetched(relation: string): {
            modifyGraph(relation: string, callback: (builder: { select(...columns: string[]): unknown }) => void): Promise<CollaborationPage | undefined>
          }
        }
      }
    }
    users: {
      getRootUser(): Promise<CollaborationPrincipal>
      query(): {
        findById(id: number): {
          withGraphJoined(relation: string): {
            modifyGraph(relation: string, callback: (builder: { select(...columns: string[]): unknown }) => void): Promise<CollaborationPrincipal | undefined>
          }
        }
      }
    }
  }
}

export interface CollaborationService {
  init(): CollaborationService
  issueSession(input: { pageId: number, expectedUpdatedAt: string, requester: Express.User | undefined }): Promise<CollaborationSession>
  discardDraft(input: { pageId: number, expectedUpdatedAt: string, expectedSourceRevision: string, requester: Express.User | undefined }): Promise<void>
  install(server: NodeServer): void
  dispose(server?: NodeServer | null): Promise<void>
  pageChanged(pageId: number, forceConflict?: boolean): Promise<void>
}

const getWiki = (): CollaborationWiki =>
  (globalThis as typeof globalThis & { WIKI: unknown }).WIKI as unknown as CollaborationWiki
const timestamp = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new TypeError('Page update timestamp is invalid')
  return date.toISOString()
}
const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isClaims = (value: string | JwtPayload): value is CollaborationClaims => typeof value !== 'string' &&
  value.kind === 'collaboration' && isPositiveInteger(value.userId) && isPositiveInteger(value.pageId) &&
  value.format === COLLABORATION_FORMAT && value.protocolVersion === COLLABORATION_PROTOCOL_VERSION &&
  value.updateVersion === COLLABORATION_UPDATE_VERSION && isPositiveInteger(value.generation) && isPositiveInteger(value.exp) &&
  typeof value.baseSourceRevision === 'string' && /^[1-9][0-9]*$/u.test(value.baseSourceRevision) &&
  typeof value.baseUpdatedAt === 'string' && !Number.isNaN(Date.parse(value.baseUpdatedAt))
const send = (socket: WebSocket, message: CollaborationServerMessage): void => {
  if (socket.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify(message))
  } catch (error) {
    getWiki().logger.warn(error)
  }
}

class CollaborationServiceImpl implements CollaborationService {
  private readonly servers = new Map<NodeServer, CollaborationMount>()
  private readonly clients = new Map<number, Set<CollaborationSocket>>()
  private initialized = false
  private store: CollaborationRoomStore | null = null
  private readonly presenceDocuments = new Map<number, { document: Y.Doc; generation: number; revision: number }>()
  private presenceTimer: ReturnType<typeof setInterval> | null = null

  private readonly onRemoteRoomUpdated = (value?: unknown): void => {
    const pageId = value && typeof value === 'object' ? Reflect.get(value, 'pageId') : undefined
    const source = value && typeof value === 'object' ? Reflect.get(value, 'source') : undefined
    if (isPositiveInteger(pageId) && source !== getWiki().INSTANCE_ID) {
      void this.broadcastDurableState(pageId).catch(error => getWiki().logger.warn(error))
    }
  }

  private readonly onRemoteDraftDiscarded = (value?: unknown): void => {
    const pageId = value && typeof value === 'object' ? Reflect.get(value, 'pageId') : undefined
    const generation = value && typeof value === 'object' ? Reflect.get(value, 'generation') : undefined
    const source = value && typeof value === 'object' ? Reflect.get(value, 'source') : undefined
    if (!isPositiveInteger(pageId) || source === getWiki().INSTANCE_ID) return
    const roomClients = this.clients.get(pageId)
    if (!roomClients) return
    for (const client of roomClients) {
      if (isPositiveInteger(generation) && client.generation >= generation) continue
      client.acceptingUpdates = false
      client.socket.close(COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE, 'Collaboration draft discarded')
    }
  }

  private readonly onAuthorizationChanged = (): void => {
    queueMicrotask(() => { void this.recheckAll().catch(error => getWiki().logger.warn(error)) })
  }

  init(): CollaborationService {
    if (this.initialized) return this
    const wiki = getWiki()
    this.store = new CollaborationRoomStore(wiki.models.knex)
    wiki.events.inbound.on('collaborationRoomUpdated', this.onRemoteRoomUpdated)
    wiki.events.inbound.on('collaborationDraftDiscarded', this.onRemoteDraftDiscarded)
    for (const event of ['reloadGroups', 'addAuthRevoke', 'reloadConfig']) {
      wiki.events.inbound.on(event, this.onAuthorizationChanged)
      wiki.events.outbound.on(event, this.onAuthorizationChanged)
    }
    this.initialized = true
    this.presenceTimer = setInterval(() => {
      for (const [pageId, clients] of this.clients) {
        const now = Date.now()
        let changed = false
        for (const client of clients) {
          if (!client.presence) continue
          if (client.presence.participant.expiresAt <= now) {
            client.presence = null
            client.recentItems = []
            if (client.acceptingUpdates) send(client.socket, { type: 'awareness', generation: client.generation, self: null, peers: [] })
            changed = true
          } else if (client.presence.recentUntil <= now && client.presence.participant.recent.length) {
            client.presence.participant.recent = []
            changed = true
          }
        }
        if (changed) void this.broadcastAwareness(pageId).catch(() => {})
      }
    }, 1_000)
    this.presenceTimer.unref()
    return this
  }

  private roomStore(): CollaborationRoomStore {
    if (!this.store) throw new Error('Collaboration service is not initialized')
    return this.store
  }

  private enabled(): boolean {
    return getWiki().config.features.featurePageCollaboration !== false
  }

  private async loadPage(pageId: number): Promise<CollaborationPage | null> {
    const page = await getWiki().models.pages.query().findById(pageId).withGraphFetched('tags').modifyGraph('tags', builder => {
      builder.select('tags.id', 'tag')
    })
    return page ?? null
  }

  private async loadPrincipal(userId: number): Promise<CollaborationPrincipal | null> {
    const wiki = getWiki()
    const user = userId === 1
      ? await wiki.models.users.getRootUser()
      : await wiki.models.users.query().findById(userId).withGraphJoined('groups').modifyGraph('groups', builder => {
          builder.select('groups.id', 'permissions')
        })
    if (!user || user.isActive === false) return null
    if (userId !== 1 && typeof user.getGlobalPermissions === 'function') user.permissions = user.getGlobalPermissions()
    return user
  }

  private async authorized(pageId: number, userId: number, expectedAuthVersion?: number): Promise<{ page: CollaborationPage, principal: CollaborationPrincipal } | null> {
    if (!this.enabled()) return null
    const [page, principal] = await Promise.all([this.loadPage(pageId), this.loadPrincipal(userId)])
    if (!page || !principal || page.editorKey !== COLLABORATION_FORMAT) return null
    const authority = await getWiki().auth.loadPageRuleAuthority(principal)
    if (!canWritePage(principal, page, authority)) return null
    if (expectedAuthVersion !== undefined && expectedAuthVersion !== sessionVersion(principal.authVersion)) return null
    return { page, principal }
  }

  async issueSession({ pageId, expectedUpdatedAt, requester }: { pageId: number, expectedUpdatedAt: string, requester: Express.User | undefined }): Promise<CollaborationSession> {
    if (!this.enabled()) throw new ApplicationError('Live collaboration is disabled.', { code: 'COLLABORATION_DISABLED', status: 409 })
    if (!isPositiveInteger(pageId) || typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt))) {
      throw new ApplicationError('Collaboration session input is invalid.', { code: 'INVALID_INPUT', status: 400 })
    }
    const userId = requester && isPositiveInteger(requester.id) ? requester.id : null
    if (!userId) throw new ApplicationError('Authentication is required.', { code: 'AUTH_REQUIRED', status: 401 })
    const authorization = await this.authorized(pageId, userId, sessionVersion(requester && Reflect.get(requester, 'authVersion')) ?? -1)
    if (!authorization) throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
    const pageUpdatedAt = timestamp(authorization.page.updatedAt)
    if (pageUpdatedAt !== timestamp(expectedUpdatedAt)) {
      throw new ApplicationError('The page changed before collaboration started.', { code: 'COLLABORATION_CONFLICT', status: 409 })
    }
    const room = await this.roomStore().open(authorization.page)
    if (room.baseUpdatedAt !== timestamp(expectedUpdatedAt) ||
      room.baseSourceRevision !== String(authorization.page.sourceRevision)) {
      throw new ApplicationError('The page changed before collaboration started.', { code: 'COLLABORATION_CONFLICT', status: 409 })
    }
    const wiki = getWiki()
    const token = jwt.sign({
      kind: 'collaboration',
      authVersion: sessionVersion(authorization.principal.authVersion),
      userId,
      pageId,
      format: COLLABORATION_FORMAT,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      generation: room.generation,
      updateVersion: COLLABORATION_UPDATE_VERSION,
      baseSourceRevision: room.baseSourceRevision,
      baseUpdatedAt: room.baseUpdatedAt
    }, {
      key: wiki.config.certs.private,
      passphrase: wiki.config.sessionSecret
    }, {
      algorithm: 'RS256',
      expiresIn: 300,
      audience: wiki.config.auth.audience,
      issuer: 'urn:wiki.js'
    })
    return {
      token,
      pageId,
      format: COLLABORATION_FORMAT,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      generation: room.generation,
      updateVersion: COLLABORATION_UPDATE_VERSION,
      revision: room.revision,
      baseSourceRevision: room.baseSourceRevision,
      baseUpdatedAt: room.baseUpdatedAt,
      state: room.state,
      websocketPath: COLLABORATION_WEBSOCKET_PATH
    }
  }

  install(server: NodeServer): void {
    this.init()
    if (this.servers.has(server)) return
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: COLLABORATION_MAX_UPDATE_BYTES * 2,
      perMessageDeflate: false,
      handleProtocols: protocols => protocols.has(COLLABORATION_WEBSOCKET_PROTOCOL) ? COLLABORATION_WEBSOCKET_PROTOCOL : false
    })
    const upgradeListener = (request: http.IncomingMessage, socket: Socket, head: Buffer): void => {
      if (request.url?.split('?', 1)[0] !== COLLABORATION_WEBSOCKET_PATH) return
      webSocketServer.handleUpgrade(request, socket, head, client => {
        webSocketServer.emit('connection', client, request)
      })
    }
    server.on('upgrade', upgradeListener)
    webSocketServer.on('connection', (socket, request) => {
      void this.admit(socket, request).catch(error => {
        getWiki().logger.warn(error)
        socket.close(4401, 'Unauthorized')
      })
    })
    this.servers.set(server, { webSocketServer, upgradeListener })
  }

  private sameOrigin(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin
    const host = request.headers.host
    if (!origin || !host) return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  private tokenFromRequest(request: http.IncomingMessage): string | null {
    const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean)
    return protocols.length === 2 && protocols[0] === COLLABORATION_WEBSOCKET_PROTOCOL ? (protocols[1] ?? null) : null
  }

  private verifyToken(token: string): CollaborationClaims {
    const wiki = getWiki()
    const claims = jwt.verify(token, wiki.config.certs.public, {
      audience: wiki.config.auth.audience,
      issuer: 'urn:wiki.js',
      algorithms: ['RS256']
    })
    if (!isClaims(claims)) throw new Error('Invalid collaboration claims')
    return claims
  }

  private async admit(socket: WebSocket, request: http.IncomingMessage): Promise<void> {
    if (!this.sameOrigin(request)) throw new Error('Collaboration origin is invalid')
    const rawToken = this.tokenFromRequest(request)
    if (!rawToken) throw new Error('Collaboration token is missing')
    const claims = this.verifyToken(rawToken)
    const authorization = await this.authorized(claims.pageId, claims.userId, sessionVersion(claims.authVersion) ?? -1)
    if (!authorization) throw new Error('Collaboration permission was denied')
    if (timestamp(authorization.page.updatedAt) !== timestamp(claims.baseUpdatedAt) ||
      String(authorization.page.sourceRevision) !== claims.baseSourceRevision) {
      send(socket, { type: 'conflict', reason: 'page-changed' })
      socket.close(4409, 'Page changed')
      return
    }

    const client: CollaborationSocket = {
      socket,
      authVersion: sessionVersion(claims.authVersion) ?? -1,
      pageId: claims.pageId,
      userId: claims.userId,
      generation: claims.generation,
      baseSourceRevision: claims.baseSourceRevision,
      baseUpdatedAt: claims.baseUpdatedAt,
      connectionId: randomUUID(),
      queue: Promise.resolve(),
      pendingMessages: 0,
      acceptingUpdates: false,
      presence: null,
      presenceWindow: 0,
      presenceMessages: 0,
      recentItems: []
    }
    const roomClients = this.clients.get(claims.pageId) ?? new Set<CollaborationSocket>()
    roomClients.add(client)
    this.clients.set(claims.pageId, roomClients)
    const admission = this.roomStore().admit(
      claims.pageId,
      claims.generation,
      claims.userId,
      client.connectionId,
      new Date(claims.exp * 1_000),
      claims.baseUpdatedAt,
      claims.baseSourceRevision
    ).then(room => {
      client.acceptingUpdates = Boolean(room && socket.readyState === WebSocket.OPEN)
      return room
    })
    const refreshTimer = setTimeout(() => socket.close(4408, 'Session refresh required'), Math.max(1, claims.exp * 1_000 - Date.now()))
    socket.on('close', () => this.removeClient(client))
    socket.on('error', error => getWiki().logger.warn(error))
    socket.on('close', () => clearTimeout(refreshTimer))
    socket.on('message', raw => {
      if (client.pendingMessages >= MAX_PENDING_MESSAGES_PER_CLIENT) {
        this.conflict(client, 'protocol-error')
        return
      }
      client.pendingMessages += 1
      client.queue = client.queue
        .then(async () => {
          await admission
          return client.acceptingUpdates && client.socket.readyState === WebSocket.OPEN ? this.receive(client, raw) : undefined
        })
        .catch(error => {
          getWiki().logger.warn(error)
          client.socket.close(1011, 'Collaboration temporarily unavailable')
        })
        .finally(() => { client.pendingMessages -= 1 })
    })

    const room = await admission
    if (!room) {
      send(socket, { type: 'conflict', reason: 'draft-discarded' })
      socket.close(COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE, 'Collaboration draft discarded')
      return
    }
    if (socket.readyState !== WebSocket.OPEN) {
      await this.roomStore().leave(client.connectionId)
      return
    }
    send(socket, {
      type: 'sync',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      updateVersion: COLLABORATION_UPDATE_VERSION,
      generation: room.generation,
      update: room.state,
      revision: room.revision,
      baseSourceRevision: room.baseSourceRevision,
      baseUpdatedAt: room.baseUpdatedAt,
      participants: roomClients.size
    })
    this.broadcastPresence(claims.pageId)
  }

  private async receive(client: CollaborationSocket, raw: RawData): Promise<void> {
    let message: CollaborationClientMessage
    let isAwareness = false
    try {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(new Uint8Array(raw))
      const text = bytes.toString('utf8')
      if (Buffer.byteLength(text, 'utf8') > COLLABORATION_MAX_UPDATE_BYTES * 2) throw new TypeError('Collaboration message is too large')
      const parsed: unknown = JSON.parse(text)
      isAwareness = Boolean(parsed && typeof parsed === 'object' && Reflect.get(parsed, 'type') === 'awareness')
      if (isAwareness) {
        const now = Date.now()
        if (now - client.presenceWindow >= 1_000) {
          client.presenceWindow = now
          client.presenceMessages = 0
        }
        client.presenceMessages += 1
        if (client.presenceMessages > 8) {
          if (Reflect.get(parsed as object, 'enabled') === false && client.presence) {
            client.presence = null
            client.recentItems = []
            void this.broadcastAwareness(client.pageId).catch(() => {})
          }
          return
        }
      }
      message = parseCollaborationClientMessage(parsed)
    } catch (error) {
      if (isAwareness) {
        client.presence = null
        client.recentItems = []
        send(client.socket, { type: 'awareness', generation: client.generation, self: null, peers: [] })
        void this.broadcastAwareness(client.pageId).catch(() => {})
        return
      }
      getWiki().logger.warn(error)
      this.conflict(client, 'protocol-error')
      return
    }
    if (message.generation !== client.generation) {
      if (message.type === 'awareness') {
        client.presence = null
        client.recentItems = []
        send(client.socket, { type: 'awareness', generation: client.generation, self: null, peers: [] })
        void this.broadcastAwareness(client.pageId).catch(() => {})
        return
      }
      this.conflict(client, 'draft-discarded')
      return
    }
    if (message.type === 'awareness') {
      try {
        await this.receiveAwareness(client, message)
      } catch {
        client.presence = null
        client.recentItems = []
        send(client.socket, { type: 'awareness', generation: client.generation, self: null, peers: [] })
        void this.broadcastAwareness(client.pageId).catch(() => {})
      }
      return
    }
    try {
      const authorization = await this.authorized(client.pageId, client.userId, sessionVersion(client.authVersion) ?? -1)
      if (!authorization) {
        this.conflict(client, this.enabled() ? 'permission-revoked' : 'disabled')
        return
      }
      const room = await this.roomStore().get(client.pageId)
      if (!room || timestamp(room.baseUpdatedAt) !== timestamp(authorization.page.updatedAt) ||
        room.baseSourceRevision !== String(authorization.page.sourceRevision)) {
        await this.pageChanged(client.pageId)
        if (client.acceptingUpdates) this.conflict(client, 'page-changed')
        return
      }
      const update = decodeCollaborationUpdate(message.update, COLLABORATION_MAX_UPDATE_BYTES)
      // Replayed state and multi-author aggregates have no recent-edit author.
      const freshItems = client.presence
        ? Y.decodeUpdate(Y.diffUpdate(update, Y.encodeStateVectorFromUpdate(decodeCollaborationUpdate(room.state)))).structs
        : []
      const singleAuthor = new Set(freshItems.map(item => item.id.client)).size === 1
      const result = await this.roomStore().apply(
        client.pageId,
        client.generation,
        client.connectionId,
        update,
        client.userId
      )
      if (!result) {
        this.conflict(client, 'draft-discarded')
        return
      }
      const now = Date.now()
      client.recentItems = client.recentItems.filter(item => item.expiresAt > now)
      if (singleAuthor && client.presence) {
        client.recentItems.push(...freshItems.filter(item => item instanceof Y.Item).map(item => ({
          client: item.id.client, from: item.id.clock, to: item.id.clock + item.length - 1,
          expiresAt: now + COLLABORATION_RECENT_TTL_MS
        })))
        client.recentItems = client.recentItems.slice(-COLLABORATION_MAX_RECENT_RANGES)
      }
      const roomClients = this.clients.get(client.pageId)
      if (roomClients) {
        for (const recipient of roomClients) {
          if (recipient.generation !== result.generation) continue
          send(recipient.socket, {
            type: 'update',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            updateVersion: COLLABORATION_UPDATE_VERSION,
            generation: result.generation,
            update: result.appliedUpdate,
            revision: result.revision
          })
        }
      }
      try {
        getWiki().events.outbound.emit('collaborationRoomUpdated', {
          pageId: client.pageId,
          generation: result.generation,
          revision: result.revision,
          source: getWiki().INSTANCE_ID
        })
      } catch (error) {
        getWiki().logger.warn(error)
      }
    } catch (error) {
      getWiki().logger.warn(error)
      if (error instanceof TypeError) this.conflict(client, 'protocol-error')
      else client.socket.close(1011, 'Collaboration temporarily unavailable')
    }
  }

  private conflict(client: CollaborationSocket, reason: CollaborationConflictReason): void {
    client.acceptingUpdates = false
    client.presence = null
    client.recentItems = []
    void this.broadcastAwareness(client.pageId).catch(() => {})
    send(client.socket, { type: 'conflict', reason })
    client.socket.close(reason === 'draft-discarded' ? COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE : 4409, reason)
  }

  private removeClient(client: CollaborationSocket): void {
    const store = this.store
    client.acceptingUpdates = false
    client.presence = null
    client.recentItems = []
    if (store) void store.leave(client.connectionId).catch(error => getWiki().logger.warn(error))
    const roomClients = this.clients.get(client.pageId)
    if (!roomClients) return
    roomClients.delete(client)
    if (roomClients.size === 0) {
      this.clients.delete(client.pageId)
      this.presenceDocuments.get(client.pageId)?.document.destroy()
      this.presenceDocuments.delete(client.pageId)
    } else {
      this.broadcastPresence(client.pageId)
      void this.broadcastAwareness(client.pageId).catch(() => {})
    }
  }

  private broadcastPresence(pageId: number): void {
    const roomClients = this.clients.get(pageId)
    if (!roomClients) return
    for (const client of roomClients) send(client.socket, { type: 'presence', participants: roomClients.size })
  }

  private presenceText(room: CollaborationRoomRecord): Y.Text {
    let cached = this.presenceDocuments.get(room.pageId)
    if (cached && cached.generation !== room.generation) {
      cached.document.destroy()
      this.presenceDocuments.delete(room.pageId)
      cached = undefined
    }
    if (!cached) {
      cached = { document: new Y.Doc(), generation: room.generation, revision: -1 }
      this.presenceDocuments.set(room.pageId, cached)
    }
    if (cached.revision !== room.revision) {
      Y.applyUpdate(cached.document, decodeCollaborationUpdate(room.state))
      cached.revision = room.revision
    }
    return cached.document.getText(COLLABORATION_TEXT_KEY)
  }

  private async receiveAwareness(client: CollaborationSocket, message: CollaborationAwareness): Promise<void> {
    // This branch never writes a room, contributor, connection, or source record.
    const now = Date.now()
    const clients = this.clients.get(client.pageId)
    const room = await this.roomStore().get(client.pageId)
    if (!clients?.has(client) || !client.acceptingUpdates || client.socket.readyState !== WebSocket.OPEN) return
    if (!room || room.generation !== client.generation) {
      this.conflict(client, 'draft-discarded')
      return
    }
    const authorization = await this.authorized(client.pageId, client.userId, client.authVersion)
    if (!authorization) {
      this.conflict(client, this.enabled() ? 'permission-revoked' : 'disabled')
      return
    }
    if (room.baseSourceRevision !== String(authorization.page.sourceRevision) ||
      timestamp(room.baseUpdatedAt) !== timestamp(authorization.page.updatedAt)) {
      this.conflict(client, 'page-changed')
      return
    }
    if (!message.enabled || (!client.presence && [...clients].filter(peer => peer.presence).length >= COLLABORATION_MAX_PRESENCE_PARTICIPANTS)) {
      client.presence = null
      client.recentItems = []
      send(client.socket, { type: 'awareness', generation: client.generation, self: null, peers: [] })
    } else {
      const text = this.presenceText(room)
      const selection = message.selection && resolveCollaborationRange(text, message.selection) ? message.selection : null
      let recentUntil = now + COLLABORATION_RECENT_TTL_MS
      const recent = message.recent.filter(range => {
        const start = range.start.item, end = range.end.item
        const item = start && end && client.recentItems.find(candidate => candidate.expiresAt > now && candidate.client === start.client &&
          candidate.client === end.client && candidate.from <= start.clock && candidate.to >= end.clock)
        if (!item || !resolveCollaborationRecent(text, range).length) return false
        recentUntil = Math.min(recentUntil, item.expiresAt)
        return true
      })
      const token = client.presence?.participant.token ?? randomUUID()
      client.presence = {
        participant: { token, label: `Participant ${token.slice(0, 8)}`, selection, recent, expiresAt: now + COLLABORATION_PRESENCE_TTL_MS },
        recentUntil
      }
    }
    await this.broadcastAwareness(client.pageId)
  }

  private async broadcastAwareness(pageId: number): Promise<void> {
    const clients = this.clients.get(pageId)
    if (!clients) return
    const candidates = [...clients].filter(client => client.presence && client.acceptingUpdates && client.socket.readyState === WebSocket.OPEN)
    if (!candidates.length) {
      this.presenceDocuments.get(pageId)?.document.destroy()
      this.presenceDocuments.delete(pageId)
      return
    }
    const authorized = await Promise.all(candidates.map(async client => ({ client, authorization: await this.authorized(pageId, client.userId, client.authVersion) })))
    const room = await this.roomStore().get(pageId)
    if (!room || this.clients.get(pageId) !== clients) return
    const now = Date.now()
    const current = authorized.filter(({ client, authorization }) => {
      if (!authorization || room.generation !== client.generation ||
        room.baseSourceRevision !== String(authorization.page.sourceRevision) ||
        timestamp(room.baseUpdatedAt) !== timestamp(authorization.page.updatedAt)) {
        client.presence = null
        this.conflict(client, !authorization ? 'permission-revoked' : 'page-changed')
        return false
      }
      return clients.has(client) && client.acceptingUpdates && client.socket.readyState === WebSocket.OPEN &&
        client.presence !== null && client.presence.participant.expiresAt > now
    })
    if (!current.length) {
      this.presenceDocuments.get(pageId)?.document.destroy()
      this.presenceDocuments.delete(pageId)
      return
    }
    const text = this.presenceText(room)
    for (const { client } of current) {
      const presence = client.presence!
      if (presence.participant.selection && !resolveCollaborationRange(text, presence.participant.selection)) presence.participant.selection = null
      presence.participant.recent = presence.recentUntil <= now ? [] :
        presence.participant.recent.filter(range => resolveCollaborationRecent(text, range).length > 0)
    }
    for (const { client } of current) {
      if (!client.presence || !client.acceptingUpdates) continue
      send(client.socket, {
        type: 'awareness',
        generation: room.generation,
        self: client.presence.participant.token,
        peers: current.filter(peer => peer.client !== client && peer.client.presence).map(peer => peer.client.presence!.participant)
      })
    }
  }

  private async broadcastDurableState(pageId: number): Promise<void> {
    const roomClients = this.clients.get(pageId)
    if (!roomClients || roomClients.size === 0) return
    const room = await this.roomStore().get(pageId)
    if (!room) return
    if (!this.enabled()) {
      for (const client of [...roomClients]) this.conflict(client, 'disabled')
      return
    }
    const page = await this.loadPage(pageId)
    if (!page || page.editorKey !== COLLABORATION_FORMAT) {
      for (const client of [...roomClients]) this.conflict(client, 'page-changed')
      return
    }
    if (timestamp(room.baseUpdatedAt) !== timestamp(page.updatedAt) ||
      room.baseSourceRevision !== String(page.sourceRevision)) {
      for (const client of [...roomClients]) this.conflict(client, 'page-changed')
      return
    }
    for (const client of [...roomClients]) {
      if (timestamp(client.baseUpdatedAt) !== timestamp(page.updatedAt) ||
        client.baseSourceRevision !== String(page.sourceRevision)) {
        this.conflict(client, 'page-changed')
        continue
      }
      if (client.generation !== room.generation) {
        this.conflict(client, 'draft-discarded')
        continue
      }
      const principal = await this.loadPrincipal(client.userId)
      const authority = principal ? await getWiki().auth.loadPageRuleAuthority(principal) : null
      if (!principal || sessionVersion(client.authVersion) !== sessionVersion(principal.authVersion) ||
        !authority || !canWritePage(principal, page, authority)) {
        this.conflict(client, 'permission-revoked')
        continue
      }
      client.baseUpdatedAt = room.baseUpdatedAt
      client.baseSourceRevision = room.baseSourceRevision
      send(client.socket, {
        type: 'sync',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        updateVersion: COLLABORATION_UPDATE_VERSION,
        generation: room.generation,
        update: room.state,
        revision: room.revision,
        baseSourceRevision: room.baseSourceRevision,
        baseUpdatedAt: room.baseUpdatedAt,
        participants: roomClients.size
      })
    }
  }

  private async recheckPage(pageId: number): Promise<void> {
    const roomClients = this.clients.get(pageId)
    if (!roomClients) return
    if (!this.enabled()) {
      for (const client of [...roomClients]) this.conflict(client, 'disabled')
      return
    }
    const page = await this.loadPage(pageId)
    if (!page || page.editorKey !== COLLABORATION_FORMAT) {
      for (const client of [...roomClients]) this.conflict(client, 'page-changed')
      return
    }
    for (const client of [...roomClients]) {
      const principal = await this.loadPrincipal(client.userId)
      const authority = principal ? await getWiki().auth.loadPageRuleAuthority(principal) : null
      if (!principal || !authority || sessionVersion(client.authVersion) !== sessionVersion(principal.authVersion) || !canWritePage(principal, page, authority)) this.conflict(client, 'permission-revoked')
    }
  }

  private async recheckAll(): Promise<void> {
    for (const pageId of [...this.clients.keys()]) await this.recheckPage(pageId)
  }

  async discardDraft({
    pageId,
    expectedUpdatedAt,
    expectedSourceRevision,
    requester
  }: {
    pageId: number
    expectedUpdatedAt: string
    expectedSourceRevision: string
    requester: Express.User | undefined
  }): Promise<void> {
    if (!this.enabled()) throw new ApplicationError('Live collaboration is disabled.', { code: 'COLLABORATION_DISABLED', status: 409 })
    if (!isPositiveInteger(pageId) || typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt)) ||
      typeof expectedSourceRevision !== 'string' || !/^[1-9][0-9]*$/u.test(expectedSourceRevision)) {
      throw new ApplicationError('Collaboration discard input is invalid.', { code: 'INVALID_INPUT', status: 400 })
    }
    const userId = requester && isPositiveInteger(requester.id) ? requester.id : null
    if (!userId) throw new ApplicationError('Authentication is required.', { code: 'AUTH_REQUIRED', status: 401 })
    const authorization = await this.authorized(pageId, userId)
    if (!authorization) throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
    if (timestamp(authorization.page.updatedAt) !== timestamp(expectedUpdatedAt) ||
      String(authorization.page.sourceRevision) !== expectedSourceRevision) {
      throw new ApplicationError('The page changed before the collaboration draft could be discarded.', {
        code: 'COLLABORATION_CONFLICT',
        status: 409
      })
    }

    const room = await this.roomStore().get(pageId)
    if (!room) return
    const currentAuthorization = await this.authorized(pageId, userId)
    if (!currentAuthorization) {
      throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
    }
    if (timestamp(currentAuthorization.page.updatedAt) !== timestamp(expectedUpdatedAt) ||
      String(currentAuthorization.page.sourceRevision) !== expectedSourceRevision) {
      throw new ApplicationError('The page changed before the collaboration draft could be discarded.', {
        code: 'COLLABORATION_CONFLICT',
        status: 409
      })
    }

    const reset = await this.roomStore().resetDraft(
      currentAuthorization.page,
      userId,
      room.revision,
      room.generation,
      expectedSourceRevision
    )
    if (reset.kind === 'active-peer') {
      throw new ApplicationError('Another user is actively editing this page. Their shared draft was not discarded.', {
        code: 'COLLABORATION_ACTIVE_PEERS',
        status: 409
      })
    }
    if (reset.kind === 'other-contributors') {
      throw new ApplicationError('Another user changed this shared draft. It was not discarded.', {
        code: 'COLLABORATION_DRAFT_CONTRIBUTOR_CONFLICT',
        status: 409
      })
    }
    if (reset.kind !== 'reset') {
      throw new ApplicationError('The shared draft or page changed while it was being discarded. Try again.', {
        code: 'COLLABORATION_CONFLICT',
        status: 409
      })
    }

    try {
      getWiki().events.outbound.emit('collaborationDraftDiscarded', {
        pageId,
        generation: reset.room.generation,
        revision: reset.room.revision,
        source: getWiki().INSTANCE_ID
      })
    } catch (error) {
      getWiki().logger.warn(error)
    }
    const roomClients = this.clients.get(pageId)
    if (!roomClients) return
    for (const client of [...roomClients]) {
      if (client.generation >= reset.room.generation) continue
      client.acceptingUpdates = false
      client.socket.close(COLLABORATION_DRAFT_DISCARDED_CLOSE_CODE, 'Collaboration draft discarded')
    }
  }

  async pageChanged(pageId: number, forceConflict = false): Promise<void> {
    if (!isPositiveInteger(pageId)) return
    const page = await this.loadPage(pageId)
    if (!page) {
      const roomClients = this.clients.get(pageId)
      if (roomClients) for (const client of [...roomClients]) this.conflict(client, 'page-changed')
      return
    }
    if (page.editorKey !== COLLABORATION_FORMAT) {
      const roomClients = this.clients.get(pageId)
      if (roomClients) for (const client of [...roomClients]) this.conflict(client, 'page-changed')
      return
    }
    const result = await this.roomStore().synchronizePage(page, isPositiveInteger(page.authorId) ? page.authorId : 1)
    const roomClients = this.clients.get(pageId)
    if (result.kind !== 'missing' && (result.kind === 'conflict' || result.kind === 'reset' || forceConflict)) {
      if (roomClients) {
        for (const client of [...roomClients]) {
          const baseChanged = timestamp(client.baseUpdatedAt) !== timestamp(result.room.baseUpdatedAt) ||
            client.baseSourceRevision !== result.room.baseSourceRevision
          const generationChanged = client.generation !== result.room.generation
          if (result.kind === 'conflict' || baseChanged || generationChanged) {
            this.conflict(client, 'page-changed')
          }
        }
      }
    } else if (result.kind === 'saved') {
      if (roomClients) {
        for (const client of roomClients) {
          client.baseUpdatedAt = result.room.baseUpdatedAt
          client.baseSourceRevision = result.room.baseSourceRevision
          send(client.socket, {
            type: 'saved',
            baseUpdatedAt: result.room.baseUpdatedAt,
            baseSourceRevision: result.room.baseSourceRevision
          })
        }
      }
    }
    if (result.kind !== 'missing') {
      getWiki().events.outbound.emit('collaborationRoomUpdated', {
        pageId,
        generation: result.room.generation,
        revision: result.room.revision,
        source: getWiki().INSTANCE_ID
      })
    }
    await this.recheckPage(pageId)
  }

  async dispose(server: NodeServer | null = null): Promise<void> {
    const targets = server ? [server] : [...this.servers.keys()]
    for (const target of targets) {
      const mount = this.servers.get(target)
      if (!mount) continue
      target.off('upgrade', mount.upgradeListener)
      for (const client of mount.webSocketServer.clients) client.close(1001, 'Server shutdown')
      await new Promise<void>(resolve => mount.webSocketServer.close(() => resolve()))
      this.servers.delete(target)
    }
    if (this.servers.size === 0 && this.initialized) {
      const wiki = getWiki()
      wiki.events.inbound.off('collaborationRoomUpdated', this.onRemoteRoomUpdated)
      wiki.events.inbound.off('collaborationDraftDiscarded', this.onRemoteDraftDiscarded)
      for (const event of ['reloadGroups', 'addAuthRevoke', 'reloadConfig']) {
        wiki.events.inbound.off(event, this.onAuthorizationChanged)
        wiki.events.outbound.off(event, this.onAuthorizationChanged)
      }
      clearInterval(this.presenceTimer ?? undefined)
      this.presenceTimer = null
      for (const cached of this.presenceDocuments.values()) cached.document.destroy()
      this.presenceDocuments.clear()
      this.clients.clear()
      this.initialized = false
      this.store = null
    }
  }
}

export default new CollaborationServiceImpl()
