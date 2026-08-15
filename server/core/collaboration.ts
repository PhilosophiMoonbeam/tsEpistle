import type http from 'node:http'
import type https from 'node:https'
import type { Socket } from 'node:net'
import jwt, { type JwtPayload } from 'jsonwebtoken'
import type { Knex } from 'knex'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

import { canWritePage } from '../helpers/page-access.ts'
import errors from '../operations/errors.ts'
import {
  COLLABORATION_FORMAT,
  COLLABORATION_MAX_UPDATE_BYTES,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_UPDATE_VERSION,
  COLLABORATION_WEBSOCKET_PATH,
  COLLABORATION_WEBSOCKET_PROTOCOL,
  decodeCollaborationUpdate,
  parseCollaborationClientMessage,
  type CollaborationConflictReason,
  type CollaborationClientMessage,
  type CollaborationServerMessage,
  type CollaborationSession
} from '../../shared/collaboration.ts'
import { CollaborationRoomStore, type CollaborationPageRecord } from './collaboration-store.ts'

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
  userId: number
  pageId: number
  format: typeof COLLABORATION_FORMAT
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION
  updateVersion: typeof COLLABORATION_UPDATE_VERSION
  baseUpdatedAt: string
  exp: number
}

interface CollaborationSocket {
  socket: WebSocket
  pageId: number
  userId: number
}
interface CollaborationMount {
  webSocketServer: WebSocketServer
  upgradeListener: (request: http.IncomingMessage, socket: Socket, head: Buffer) => void
}


interface CollaborationWiki {
  INSTANCE_ID: string
  auth: { checkAccess(user: Express.User | undefined, permissions: readonly string[], context?: unknown): boolean }
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
  value.updateVersion === COLLABORATION_UPDATE_VERSION && isPositiveInteger(value.exp) &&
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

  private readonly onRemoteRoomUpdated = (value?: unknown): void => {
    const pageId = value && typeof value === 'object' ? Reflect.get(value, 'pageId') : undefined
    const source = value && typeof value === 'object' ? Reflect.get(value, 'source') : undefined
    if (isPositiveInteger(pageId) && source !== getWiki().INSTANCE_ID) {
      void this.broadcastDurableState(pageId).catch(error => getWiki().logger.warn(error))
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
    for (const event of ['reloadGroups', 'addAuthRevoke', 'reloadConfig']) {
      wiki.events.inbound.on(event, this.onAuthorizationChanged)
      wiki.events.outbound.on(event, this.onAuthorizationChanged)
    }
    this.initialized = true
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

  private async authorized(pageId: number, userId: number): Promise<{ page: CollaborationPage, principal: CollaborationPrincipal } | null> {
    if (!this.enabled()) return null
    const [page, principal] = await Promise.all([this.loadPage(pageId), this.loadPrincipal(userId)])
    if (!page || !principal || page.editorKey !== COLLABORATION_FORMAT || !canWritePage(principal, page)) return null
    return { page, principal }
  }

  async issueSession({ pageId, expectedUpdatedAt, requester }: { pageId: number, expectedUpdatedAt: string, requester: Express.User | undefined }): Promise<CollaborationSession> {
    if (!this.enabled()) throw new ApplicationError('Live collaboration is disabled.', { code: 'COLLABORATION_DISABLED', status: 409 })
    if (!isPositiveInteger(pageId) || typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt))) {
      throw new ApplicationError('Collaboration session input is invalid.', { code: 'INVALID_INPUT', status: 400 })
    }
    const userId = requester && isPositiveInteger(requester.id) ? requester.id : null
    if (!userId) throw new ApplicationError('Authentication is required.', { code: 'AUTH_REQUIRED', status: 401 })
    const authorization = await this.authorized(pageId, userId)
    if (!authorization) throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
    const pageUpdatedAt = timestamp(authorization.page.updatedAt)
    if (pageUpdatedAt !== timestamp(expectedUpdatedAt)) {
      throw new ApplicationError('The page changed before collaboration started.', { code: 'COLLABORATION_CONFLICT', status: 409 })
    }
    const room = await this.roomStore().open(authorization.page, userId)
    const wiki = getWiki()
    const token = jwt.sign({
      kind: 'collaboration',
      userId,
      pageId,
      format: COLLABORATION_FORMAT,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      updateVersion: COLLABORATION_UPDATE_VERSION,
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
      updateVersion: COLLABORATION_UPDATE_VERSION,
      revision: room.revision,
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
    const authorization = await this.authorized(claims.pageId, claims.userId)
    if (!authorization) throw new Error('Collaboration permission was denied')
    const room = await this.roomStore().open(authorization.page, claims.userId)
    if (timestamp(room.baseUpdatedAt) !== timestamp(claims.baseUpdatedAt)) {
      send(socket, { type: 'conflict', reason: 'page-changed' })
      socket.close(4409, 'Page changed')
      return
    }
    const client: CollaborationSocket = { socket, pageId: claims.pageId, userId: claims.userId }
    const roomClients = this.clients.get(claims.pageId) ?? new Set<CollaborationSocket>()
    roomClients.add(client)
    this.clients.set(claims.pageId, roomClients)
    socket.on('message', raw => { void this.receive(client, raw) })
    const refreshTimer = setTimeout(() => socket.close(4408, 'Session refresh required'), Math.max(1, claims.exp * 1_000 - Date.now()))
    socket.on('close', () => this.removeClient(client))
    socket.on('error', error => getWiki().logger.warn(error))
    socket.on('close', () => clearTimeout(refreshTimer))
    send(socket, {
      type: 'sync',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      updateVersion: COLLABORATION_UPDATE_VERSION,
      update: room.state,
      revision: room.revision,
      baseUpdatedAt: room.baseUpdatedAt,
      participants: roomClients.size
    })
    this.broadcastPresence(claims.pageId)
  }

  private async receive(client: CollaborationSocket, raw: RawData): Promise<void> {
    let message: CollaborationClientMessage
    try {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(new Uint8Array(raw))
      const text = bytes.toString('utf8')
      if (Buffer.byteLength(text, 'utf8') > COLLABORATION_MAX_UPDATE_BYTES * 2) throw new TypeError('Collaboration message is too large')
      message = parseCollaborationClientMessage(JSON.parse(text))
    } catch (error) {
      getWiki().logger.warn(error)
      this.conflict(client, 'protocol-error')
      return
    }
    try {
      const authorization = await this.authorized(client.pageId, client.userId)
      if (!authorization) {
        this.conflict(client, this.enabled() ? 'permission-revoked' : 'disabled')
        return
      }
      const room = await this.roomStore().get(client.pageId)
      if (!room || timestamp(room.baseUpdatedAt) !== timestamp(authorization.page.updatedAt)) {
        await this.pageChanged(client.pageId)
        this.conflict(client, 'page-changed')
        return
      }
      const result = await this.roomStore().apply(client.pageId, decodeCollaborationUpdate(message.update, COLLABORATION_MAX_UPDATE_BYTES), client.userId)
      const roomClients = this.clients.get(client.pageId)
      if (roomClients) {
        for (const recipient of roomClients) {
          send(recipient.socket, {
            type: 'update',
            protocolVersion: COLLABORATION_PROTOCOL_VERSION,
            updateVersion: COLLABORATION_UPDATE_VERSION,
            update: result.appliedUpdate,
            revision: result.revision
          })
        }
      }
      try {
        getWiki().events.outbound.emit('collaborationRoomUpdated', {
          pageId: client.pageId,
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
    send(client.socket, { type: 'conflict', reason })
    client.socket.close(4409, reason)
  }

  private removeClient(client: CollaborationSocket): void {
    const roomClients = this.clients.get(client.pageId)
    if (!roomClients) return
    roomClients.delete(client)
    if (roomClients.size === 0) this.clients.delete(client.pageId)
    else this.broadcastPresence(client.pageId)
  }

  private broadcastPresence(pageId: number): void {
    const roomClients = this.clients.get(pageId)
    if (!roomClients) return
    for (const client of roomClients) send(client.socket, { type: 'presence', participants: roomClients.size })
  }

  private async broadcastDurableState(pageId: number): Promise<void> {
    const roomClients = this.clients.get(pageId)
    if (!roomClients || roomClients.size === 0) return
    const room = await this.roomStore().get(pageId)
    if (!room) return
    for (const client of roomClients) send(client.socket, {
      type: 'sync',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      updateVersion: COLLABORATION_UPDATE_VERSION,
      update: room.state,
      revision: room.revision,
      baseUpdatedAt: room.baseUpdatedAt,
      participants: roomClients.size
    })
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
      if (!principal || !canWritePage(principal, page)) this.conflict(client, 'permission-revoked')
    }
  }

  private async recheckAll(): Promise<void> {
    for (const pageId of [...this.clients.keys()]) await this.recheckPage(pageId)
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
    if (forceConflict || result.kind === 'reset') {
      if (roomClients) for (const client of [...roomClients]) this.conflict(client, 'page-changed')
    } else if (result.kind === 'saved') {
      if (roomClients) for (const client of roomClients) send(client.socket, { type: 'saved', baseUpdatedAt: result.room.baseUpdatedAt })
    }
    if (result.kind !== 'missing') {
      getWiki().events.outbound.emit('collaborationRoomUpdated', {
        pageId,
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
      for (const event of ['reloadGroups', 'addAuthRevoke', 'reloadConfig']) {
        wiki.events.inbound.off(event, this.onAuthorizationChanged)
        wiki.events.outbound.off(event, this.onAuthorizationChanged)
      }
      this.clients.clear()
      this.initialized = false
      this.store = null
    }
  }
}

export default new CollaborationServiceImpl()
