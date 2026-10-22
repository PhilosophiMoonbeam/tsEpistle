import { randomUUID } from 'node:crypto'
import type http from 'node:http'
import type https from 'node:https'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

import {
  LIVE_NOTE_MAX_STATE_BYTES,
  LIVE_NOTE_MAX_UPDATE_BYTES,
  LIVE_NOTE_WEBSOCKET_PATH,
  parseLiveNoteClientMessage,
  type LiveNoteServerMessage,
  type LiveNoteView
} from '../../shared/live-notes.ts'
import { requestOriginMatches } from '../agents/origins.ts'
import { liveNotes, type LiveNoteSessionAuthorization as Authorization } from '../operations/live-notes.ts'

type NodeServer = http.Server | https.Server
type EventBus = {
  on(event: string, listener: (value?: unknown) => void): unknown
  off(event: string, listener: (value?: unknown) => void): unknown
}
interface LiveNoteWiki {
  config: { host: string }
  events: { inbound: EventBus; outbound: EventBus }
  logger: { warn(message: string): void }
}
interface Mount {
  webSocketServer: WebSocketServer
  upgradeListener(request: http.IncomingMessage, socket: Socket, head: Buffer): void
}
interface Client {
  mount: Mount
  socket: WebSocket
  connectionId: string
  token: string | null
  key: string | null
  identity: string | null
  expiresAt: number
  authReceived: boolean
  ready: boolean
  closed: boolean
  refreshQueued: boolean
  lastPongAt: number
  lastPingAt: number
  lastRevision: number
  lastCanEdit: boolean
  lastCanManage: boolean
  queue: Promise<void>
  pendingMessages: number
  authTimer: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
  closeTimer?: ReturnType<typeof setTimeout>
}

const MAX_CONNECTIONS = 256
const MAX_ROOM_CONNECTIONS = 64
const MAX_PENDING_MESSAGES = 8
const MAX_INBOUND_BYTES = Math.ceil(LIVE_NOTE_MAX_UPDATE_BYTES / 3) * 4 + 2_048
const MAX_OUTBOUND_BYTES = Math.ceil(LIVE_NOTE_MAX_STATE_BYTES / 3) * 4 + 4_096
const MAX_SOCKET_BUFFER_BYTES = MAX_OUTBOUND_BYTES * 2
const MAX_SERVICE_BUFFER_BYTES = 64 * 1_024 * 1_024
const AUTH_TIMEOUT_MS = 5_000
const REFRESH_INTERVAL_MS = 2_000
const PING_INTERVAL_MS = 15_000
const PONG_TIMEOUT_MS = 45_000
const SWEEP_INTERVAL_MS = 60 * 60 * 1_000
const MAX_SESSION_MS = 60 * 60 * 1_000
const AUTHORITY_EVENTS = ['reloadGroups', 'addAuthRevoke', 'reloadConfig']
const getWiki = (): LiveNoteWiki => {
  // Kernel/master own this composition root; no socket-controlled value enters it.
  const runtime: unknown = globalThis.WIKI
  return runtime as LiveNoteWiki
}
const identity = (authorization: Authorization): string =>
  JSON.stringify([authorization.principal.id, authorization.principal.providerKey, authorization.principal.authVersion ?? 0])
const rawBytes = (raw: RawData): number => (Array.isArray(raw) ? raw.reduce((total, chunk) => total + chunk.byteLength, 0) : raw.byteLength)
const rawText = (raw: RawData): string =>
  Array.isArray(raw)
    ? Buffer.concat(raw).toString('utf8')
    : Buffer.from(raw instanceof ArrayBuffer ? raw : raw.buffer, raw instanceof ArrayBuffer ? 0 : raw.byteOffset, raw.byteLength).toString('utf8')

/** Durable operations own the document; this service only owns transport and leases. */
export class LiveNoteCollaborationService {
  private readonly mounts = new Map<NodeServer, Mount>()
  private readonly clients = new Set<Client>()
  private readonly rooms = new Map<string, Set<Client>>()
  private readonly cleanups = new Set<Promise<void>>()
  private initialized = false
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private sweeping: Promise<void> | null = null

  private readonly onNoteChanged = (value?: unknown): void => {
    const key = value && typeof value === 'object' ? Reflect.get(value, 'key') : undefined
    if (typeof key !== 'string') return
    const clients = this.rooms.get(key)
    if (clients) for (const client of clients) this.refresh(client)
  }

  private readonly onAuthorityChanged = (): void => {
    for (const client of this.clients) this.refresh(client)
  }

  init(): this {
    if (this.initialized) return this
    const { events } = getWiki()
    events.inbound.on('liveNoteUpdated', this.onNoteChanged)
    events.outbound.on('liveNoteUpdated', this.onNoteChanged)
    for (const event of AUTHORITY_EVENTS) {
      events.inbound.on(event, this.onAuthorityChanged)
      events.outbound.on(event, this.onAuthorityChanged)
    }
    this.initialized = true
    return this
  }

  install(server: NodeServer): void {
    this.init()
    if (this.mounts.has(server)) return
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES, perMessageDeflate: false })
    const mount: Mount = {
      webSocketServer,
      upgradeListener: (request, socket, head): void => {
        if (request.url?.split('?', 1)[0] !== LIVE_NOTE_WEBSOCKET_PATH) return
        if (!requestOriginMatches(request.headers.origin, getWiki().config.host)) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        if (this.clients.size >= MAX_CONNECTIONS) {
          socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return
        }
        webSocketServer.handleUpgrade(request, socket, head, client => webSocketServer.emit('connection', client))
      }
    }
    webSocketServer.on('connection', socket => this.connect(mount, socket))
    server.on('upgrade', mount.upgradeListener)
    this.mounts.set(server, mount)
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.tick(), REFRESH_INTERVAL_MS)
      this.refreshTimer.unref()
    }
    if (!this.sweepTimer) {
      // Retention is deliberately delayed and single-flight, never a startup data drain.
      this.sweepTimer = setInterval(() => {
        if (this.sweeping) return
        this.sweeping = liveNotes
          .sweepUntouched()
          .then(() => undefined)
          .catch(() => getWiki().logger.warn('Live note retention sweep failed.'))
          .finally(() => {
            this.sweeping = null
          })
      }, SWEEP_INTERVAL_MS)
      this.sweepTimer.unref()
    }
  }

  private connect(mount: Mount, socket: WebSocket): void {
    const client: Client = {
      mount,
      socket,
      connectionId: randomUUID(),
      token: null,
      key: null,
      identity: null,
      expiresAt: 0,
      authReceived: false,
      ready: false,
      closed: false,
      refreshQueued: false,
      lastPongAt: Date.now(),
      lastPingAt: 0,
      lastRevision: -1,
      lastCanEdit: false,
      lastCanManage: false,
      queue: Promise.resolve(),
      pendingMessages: 0,
      authTimer: setTimeout(() => this.close(client, 4408, 'Authentication required'), AUTH_TIMEOUT_MS)
    }
    client.authTimer.unref()
    this.clients.add(client)
    socket.on('close', () => this.remove(client))
    socket.on('error', () => this.close(client, 1011, 'Live notes temporarily unavailable'))
    socket.on('pong', () => {
      client.lastPongAt = Date.now()
    })
    socket.on('message', (raw, isBinary) => {
      if (client.closed) return
      if (isBinary || rawBytes(raw) > MAX_INBOUND_BYTES) {
        this.close(client, 4400, 'Invalid live note message')
        return
      }
      try {
        const message = parseLiveNoteClientMessage(JSON.parse(rawText(raw)))
        if (!client.authReceived) {
          if (message.type !== 'auth') throw new TypeError('Authentication must be first')
          client.authReceived = true
          this.enqueue(client, () => this.admit(client, message.token))
        } else {
          if (message.type !== 'update') throw new TypeError('Authentication cannot change')
          this.enqueue(client, () => this.update(client, message))
        }
      } catch {
        this.close(client, 4400, 'Invalid live note message')
      }
    })
  }

  private enqueue(client: Client, action: () => Promise<void>): void {
    if (client.closed) return
    if (client.pendingMessages >= MAX_PENDING_MESSAGES) {
      this.close(client, 4429, 'Live note queue limit reached')
      return
    }
    client.pendingMessages += 1
    client.queue = client.queue
      .then(async () => {
        if (!client.closed && client.socket.readyState === WebSocket.OPEN) await action()
      })
      .catch(error => this.fail(client, error))
      .finally(() => {
        client.pendingMessages -= 1
      })
  }

  private async authorize(client: Client): Promise<Authorization> {
    if (!client.token || client.expiresAt <= Date.now()) {
      this.close(client, 4408, 'Session refresh required')
      throw new Error('Session expired')
    }
    let authorization: Authorization
    try {
      authorization = await liveNotes.authorizeSession(client.token)
    } catch {
      this.close(client, 4401, 'Session authorization lost')
      throw new Error('Session authorization lost')
    }
    if (authorization.key !== client.key || identity(authorization) !== client.identity || Date.parse(authorization.expiresAt) !== client.expiresAt) {
      this.close(client, 4401, 'Session authorization lost')
      throw new Error('Session identity changed')
    }
    if (client.expiresAt <= Date.now()) {
      this.close(client, 4408, 'Session refresh required')
      throw new Error('Session expired')
    }
    return authorization
  }

  private async admit(client: Client, token: string): Promise<void> {
    let authorization: Authorization
    try {
      authorization = await liveNotes.authorizeSession(token)
    } catch {
      this.close(client, 4401, 'Unauthorized')
      return
    }
    const expiresAt = Date.parse(authorization.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + MAX_SESSION_MS) {
      this.close(client, 4401, 'Unauthorized')
      return
    }
    if (client.closed) return
    client.token = token
    client.key = authorization.key
    client.identity = identity(authorization)
    client.expiresAt = expiresAt
    const room = this.rooms.get(authorization.key) ?? new Set<Client>()
    if (room.size >= MAX_ROOM_CONNECTIONS) {
      this.close(client, 4429, 'Live note room limit reached')
      return
    }
    // Reserve capacity before awaiting the durable lease; no document is cached here.
    room.add(client)
    this.rooms.set(authorization.key, room)
    await liveNotes.lease(authorization.key, client.connectionId, new Date(expiresAt))
    const current = await this.authorize(client)
    const note = await liveNotes.read(current.principal, current.key)
    if (client.closed) return
    clearTimeout(client.authTimer)
    client.expiryTimer = setTimeout(() => this.close(client, 4408, 'Session refresh required'), Math.max(1, expiresAt - Date.now()))
    client.expiryTimer.unref()
    client.ready = true
    this.sendNote(client, { type: 'sync', note })
  }

  private async update(client: Client, message: { requestId: string; update: string }): Promise<void> {
    if (!client.ready) return
    const authorization = await this.authorize(client)
    const before = await liveNotes.read(authorization.principal, authorization.key)
    if (!before.canEdit) {
      this.close(client, 4403, 'Write permission required')
      return
    }
    if (client.closed) return
    await liveNotes.applyUpdate(authorization.principal, authorization.key, { requestId: message.requestId, update: message.update })
    // Acknowledgement follows commit, then a fresh token/policy check. An uncertain
    // transport outcome remains retryable under the durable request ID.
    const current = await this.authorize(client)
    const note = await liveNotes.read(current.principal, current.key)
    if (client.closed) return
    this.sendNote(client, { type: 'ack', requestId: message.requestId, note })
    this.onNoteChanged({ key: current.key })
  }

  private refresh(client: Client): void {
    if (!client.ready || client.closed || client.refreshQueued) return
    client.refreshQueued = true
    this.enqueue(client, async () => {
      try {
        const authorization = await this.authorize(client)
        const note = await liveNotes.read(authorization.principal, authorization.key)
        if (note.revision !== client.lastRevision || note.canEdit !== client.lastCanEdit || note.canManage !== client.lastCanManage)
          this.sendNote(client, { type: 'sync', note })
      } finally {
        client.refreshQueued = false
      }
    })
  }

  private sendNote(client: Client, message: LiveNoteServerMessage & { note: LiveNoteView }): void {
    if (client.closed || client.socket.readyState !== WebSocket.OPEN) return
    if (client.expiresAt <= Date.now()) {
      this.close(client, 4408, 'Session refresh required')
      return
    }
    if (message.note.state.length > Math.ceil(LIVE_NOTE_MAX_STATE_BYTES / 3) * 4) {
      this.close(client, 1011, 'Live notes temporarily unavailable')
      return
    }
    const data = JSON.stringify(message)
    const bytes = Buffer.byteLength(data)
    let buffered = 0
    for (const peer of this.clients) buffered += peer.socket.bufferedAmount
    if (bytes > MAX_OUTBOUND_BYTES || client.socket.bufferedAmount + bytes > MAX_SOCKET_BUFFER_BYTES || buffered + bytes > MAX_SERVICE_BUFFER_BYTES) {
      this.close(client, 4429, 'Live note transport limit reached')
      return
    }
    try {
      client.socket.send(data, error => {
        if (error) this.close(client, 1011, 'Live notes temporarily unavailable')
      })
      client.lastRevision = message.note.revision
      client.lastCanEdit = message.note.canEdit
      client.lastCanManage = message.note.canManage
    } catch {
      this.close(client, 1011, 'Live notes temporarily unavailable')
    }
  }

  private tick(): void {
    const now = Date.now()
    for (const client of this.clients) {
      if (client.closed) continue
      if (now - client.lastPongAt > PONG_TIMEOUT_MS) {
        this.close(client, 4408, 'Connection timed out')
        continue
      }
      if (now - client.lastPingAt >= PING_INTERVAL_MS && client.socket.readyState === WebSocket.OPEN) {
        client.lastPingAt = now
        try {
          client.socket.ping()
        } catch {
          this.close(client, 1011, 'Live notes temporarily unavailable')
        }
      }
      this.refresh(client)
    }
  }

  private fail(client: Client, error: unknown): void {
    if (client.closed) return
    const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined
    if (status === 401 || status === 403 || status === 404) this.close(client, 4403, 'Live note access lost')
    else if (status === 400 || status === 413 || error instanceof TypeError) this.close(client, 4400, 'Invalid live note message')
    else {
      getWiki().logger.warn('Live note transport operation failed.')
      this.close(client, 1011, 'Live notes temporarily unavailable')
    }
  }

  private close(client: Client, code: number, reason: string): void {
    if (client.closed) return
    client.closed = true
    client.ready = false
    clearTimeout(client.authTimer)
    clearTimeout(client.expiryTimer)
    client.closeTimer = setTimeout(() => client.socket.terminate(), 1_000)
    client.closeTimer.unref()
    try {
      client.socket.close(code, reason)
    } catch {
      client.socket.terminate()
    }
  }

  private remove(client: Client): void {
    client.closed = true
    client.ready = false
    clearTimeout(client.authTimer)
    clearTimeout(client.expiryTimer)
    clearTimeout(client.closeTimer)
    this.clients.delete(client)
    if (client.key) {
      const room = this.rooms.get(client.key)
      room?.delete(client)
      if (room?.size === 0) this.rooms.delete(client.key)
    }
    // Wait for any in-flight admission before releasing, so a late lease cannot
    // outlive a socket which closed while the database was answering.
    const cleanup = client.queue
      .then(() => liveNotes.release(client.connectionId))
      .catch(() => getWiki().logger.warn('Live note connection lease release failed.'))
      .finally(() => this.cleanups.delete(cleanup))
    this.cleanups.add(cleanup)
  }

  async dispose(server: NodeServer | null = null): Promise<void> {
    const targets = server ? [server] : [...this.mounts.keys()]
    const closing: Promise<void>[] = []
    for (const target of targets) {
      const mount = this.mounts.get(target)
      if (!mount) continue
      target.off('upgrade', mount.upgradeListener)
      this.mounts.delete(target)
      for (const client of this.clients) if (client.mount === mount) this.close(client, 1001, 'Server shutdown')
      const { promise, resolve } = Promise.withResolvers<void>()
      mount.webSocketServer.close(() => resolve())
      closing.push(promise)
    }
    if (this.mounts.size === 0) {
      clearInterval(this.refreshTimer)
      clearInterval(this.sweepTimer)
      this.refreshTimer = undefined
      this.sweepTimer = undefined
      if (this.initialized) {
        const { events } = getWiki()
        events.inbound.off('liveNoteUpdated', this.onNoteChanged)
        events.outbound.off('liveNoteUpdated', this.onNoteChanged)
        for (const event of AUTHORITY_EVENTS) {
          events.inbound.off(event, this.onAuthorityChanged)
          events.outbound.off(event, this.onAuthorityChanged)
        }
        this.initialized = false
      }
    }
    await Promise.all(closing)
    await Promise.all([...this.cleanups])
    if (this.mounts.size === 0) await this.sweeping
  }
}

export default new LiveNoteCollaborationService()
