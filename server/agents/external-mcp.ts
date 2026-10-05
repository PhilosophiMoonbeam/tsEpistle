import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { AxMCPClient, AxMCPStreamableHTTPTransport, type AxMCPCatalogSnapshot, type AxMCPClientOptions, type AxMCPEra, type AxMCPTask } from '@ax-llm/ax'
import type { Knex } from 'knex'
// Bun's built-in fetch ignores Undici dispatchers; the explicit entry point is required for DNS pinning.
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici/index.js'
import {
  CreateAdminExternalMcpServerSchema,
  ExternalMcpServerInputSchema,
  ExternalMcpGroupPolicyInputSchema,
  ExternalMcpGrantsInputSchema,
  type CreateAdminExternalMcpServerInput,
  type ExternalMcpServerInput,
  type ExternalMcpServerView,
  type ExternalMcpGroupPolicyView,
  type ExternalMcpAttribution
} from '../../shared/agents/external-mcp.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { AgentRepositoryError } from './repository.ts'
import type { AgentSecretRegistry } from './providers/secrets.ts'

export const EXTERNAL_MCP_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  cleanupMs: 1_000,
  requestBytes: 256 * 1_024,
  responseBytes: 2 * 1_024 * 1_024,
  catalogBytes: 2 * 1_024 * 1_024,
  catalogEntries: 256,
  catalogPages: 4,
  maxClients: 16,
  personalEndpoints: 16
})
export interface ExternalMcpRequester {
  readonly id: number
  readonly authVersion?: number
}
export type ExternalMcpResolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly LookupAddress[]>
/** Portable header tuples keep the Bun/DOM boundary compatible with Undici's pinned dispatcher. */
export type ExternalMcpFetchImplementation = (url: URL, init: Omit<UndiciRequestInit, 'headers'> & { headers: [string, string][] }) => Promise<Response>
export interface ExternalMcpEndpointGuard {
  readonly fetch: typeof globalThis.fetch
  /** Cancels invocations while leaving only live-authorized task/session cleanup available. */
  cancelRequests(): void
  close(): Promise<void>
}
export interface ExternalMcpServiceDependencies {
  readonly knex: Knex
  readonly secrets: AgentSecretRegistry
  /** Outbound MCP switch, independent of the inbound Wiki /mcp service. */
  readonly enabled: () => boolean
  readonly resolve?: ExternalMcpResolver
  readonly fetch?: ExternalMcpFetchImplementation
}
type Database = Knex | Knex.Transaction
interface ServerRow {
  id: string
  displayName: string
  endpointUrl: string
  scope: 'admin' | 'personal'
  ownerId: number | null
  status: 'enabled' | 'disabled'
  revision: number
  authMode: 'none' | 'bearer'
  secretReference: string | null
  createdAt: Date | string
  updatedAt: Date | string
}
interface Actor {
  id: number
  authVersion: number
  groupIds: number[]
  permissions: string[]
}
interface AllowedServer {
  row: ServerRow
  stamp: string
}
export interface ExternalMcpDiscovery {
  readonly attribution: ExternalMcpAttribution
  readonly catalog: AxMCPCatalogSnapshot
}
export interface ExternalMcpLease {
  readonly clients: readonly AxMCPClient[]
  readonly servers: readonly ExternalMcpServerView[]
  inspectCatalog(serverId: string): Promise<ExternalMcpDiscovery>
  close(): Promise<void>
}
function fail(code: string, message: string, status = 403): never {
  throw new AgentRepositoryError(code, message, status)
}
const denied = (): never => fail('EXTERNAL_MCP_ACCESS_DENIED', 'External MCP access is unavailable')
const revision = (expected: number, actual: number): void => {
  if (!Number.isSafeInteger(expected) || expected !== actual)
    fail('EXTERNAL_MCP_REVISION_CHANGED', 'External MCP configuration changed; reload it before saving', 409)
}
const idValue = (id: string): string =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : fail('INVALID_EXTERNAL_MCP_ID', 'Choose a valid external MCP endpoint', 400)
const booleanValue = (value: unknown): boolean => value === true || value === 1
const permissionValues = (value: unknown): string[] => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
const namespaceFor = (id: string): string => `external_${id.replaceAll('-', '')}`
const dateValue = (value: Date | string): string => new Date(value).toISOString()
const egressDenied = (): never => fail('EXTERNAL_MCP_EGRESS_DENIED', 'External MCP endpoint is not a public HTTPS destination', 502)
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const)
  blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20]
] as const)
  blocked.addSubnet(network, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const assertPublicAddresses = (addresses: readonly LookupAddress[]): void => {
  if (addresses.length === 0 || addresses.length > 64) return egressDenied()
  for (const { address, family } of addresses) {
    const actual = isIP(address)
    if (
      actual !== family ||
      (actual !== 4 && actual !== 6) ||
      blocked.check(address, actual === 4 ? 'ipv4' : 'ipv6') ||
      (actual === 6 && !globalV6.check(address, 'ipv6'))
    )
      return egressDenied()
  }
}
export const normalizeExternalMcpEndpoint = (input: string): string => {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return egressDenied()
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    input.length > 2_048 ||
    /[\u0000-\u0020\u007f\\]/u.test(input) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== '443') ||
    hostname.endsWith('.') ||
    (!isIP(hostname) && (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/u.test(hostname)))
  )
    return egressDenied()
  if (isIP(hostname)) assertPublicAddresses([{ address: hostname, family: isIP(hostname) }])
  return url.href
}
const requestHeaders: Readonly<Record<string, true>> = {
  accept: true,
  'content-type': true,
  'mcp-session-id': true,
  'mcp-protocol-version': true,
  'mcp-method': true,
  'mcp-name': true,
  'last-event-id': true
}

const abortable = async <T>(work: () => T, signal: AbortSignal): Promise<Awaited<T>> => {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => {
    aborted.reject(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([Promise.resolve(work()), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const cancelBody = async (cancel: () => PromiseLike<unknown>): Promise<void> => {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new DOMException('External MCP cleanup timed out', 'TimeoutError')), EXTERNAL_MCP_LIMITS.cleanupMs)
  try {
    await abortable(cancel, deadline.signal).catch(() => {})
  } finally {
    clearTimeout(timer)
  }
}

/** A caller-owned network boundary. Both preflight and every actual socket lookup reject rebinding. */
export const createExternalMcpEndpointGuard = (options: {
  endpointUrl: string
  authorize: () => Promise<void>
  credential: () => Promise<string | null>
  signal?: AbortSignal
  resolve?: ExternalMcpResolver
  fetch?: ExternalMcpFetchImplementation
}): ExternalMcpEndpointGuard => {
  const endpoint = normalizeExternalMcpEndpoint(options.endpointUrl)
  const resolve: ExternalMcpResolver = options.resolve ?? lookup
  const lifetime = new AbortController()
  const requests = new AbortController()
  const cancellations = new Set<Promise<void>>()
  let closePromise: Promise<void> | undefined
  const dispatcher = new Agent({
    connections: 2,
    pipelining: 1,
    connect: {
      timeout: EXTERNAL_MCP_LIMITS.timeoutMs,
      lookup: (hostname, lookupOptions, callback) => {
        const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal
        void abortable(() => resolve(hostname, { all: true, verbatim: true }), signal).then(
          async addresses => {
            try {
              assertPublicAddresses(addresses)
              await abortable(options.authorize, signal)
              signal.throwIfAborted()
              if (lookupOptions.all) callback(null, [...addresses])
              else {
                const selected = lookupOptions.family ? addresses.find(entry => entry.family === lookupOptions.family) : addresses[0]
                if (!selected) return egressDenied()
                callback(null, selected.address, selected.family)
              }
            } catch (error) {
              callback(error instanceof Error ? error : new Error('External MCP DNS validation failed'), '', 0)
            }
          },
          () => callback(new AgentRepositoryError('EXTERNAL_MCP_EGRESS_DENIED', 'External MCP DNS resolution failed', 502), '', 0)
        )
      }
    }
  })
  const implementation = options.fetch ?? undiciFetch
  const guarded = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const inputUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
    if (normalizeExternalMcpEndpoint(inputUrl) !== endpoint || (typeof input !== 'string' && !(input instanceof URL))) return egressDenied()
    const method = (init?.method ?? 'GET').toUpperCase()
    // Only task cancellation gets the cleanup lane. The owner-scoped client checks
    // that this handle was created on this client; polling/result requests never do.
    let taskCancellation = false
    if (method === 'POST' && typeof init?.body === 'string') {
      try {
        const request: unknown = JSON.parse(init.body)
        taskCancellation = !!request && typeof request === 'object' && 'method' in request && request.method === 'tasks/cancel'
      } catch { /* The SDK owns JSON-RPC validation. */ }
    }
    if (!['POST', 'GET', 'DELETE'].includes(method) || (init?.body != null && typeof init.body !== 'string')) return egressDenied()
    if (typeof init?.body === 'string' && Buffer.byteLength(init.body) > EXTERNAL_MCP_LIMITS.requestBytes)
      fail('EXTERNAL_MCP_REQUEST_TOO_LARGE', 'External MCP request exceeds its byte limit', 400)
    const headers = new Headers(init?.headers)
    for (const [key, value] of headers)
      if (!Object.hasOwn(requestHeaders, key) || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) return egressDenied()
    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(new AgentRepositoryError('EXTERNAL_MCP_TIMEOUT', 'External MCP request timed out', 504)),
      taskCancellation ? EXTERNAL_MCP_LIMITS.cleanupMs : EXTERNAL_MCP_LIMITS.timeoutMs
    )
    const signal = AbortSignal.any([
      lifetime.signal,
      timeout.signal,
      ...(method === 'DELETE' || taskCancellation ? [] : [requests.signal]),
      ...(options.signal && !taskCancellation ? [options.signal] : []),
      ...(init?.signal ? [init.signal] : [])
    ])
    let returnedBody = false
    const cleanup = (): void => {
      clearTimeout(timer)
    }
    try {
      await abortable(options.authorize, signal)
      const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
      assertPublicAddresses(await abortable(() => resolve(hostname, { all: true, verbatim: true }), signal))
      const credential = await abortable(options.credential, signal)
      if (credential !== null) {
        if (!/^[\x21-\x7e]{1,8192}$/u.test(credential)) fail('EXTERNAL_MCP_CREDENTIAL_UNAVAILABLE', 'External MCP credential is unavailable', 503)
        headers.set('authorization', `Bearer ${credential}`)
      }
      // Recheck after asynchronous DNS/secret work and immediately before dispatch.
      await abortable(options.authorize, signal)
      const response = await abortable(
        () =>
          implementation(new URL(endpoint), {
            method,
            headers: [...headers],
            ...(typeof init?.body === 'string' ? { body: init.body } : {}),
            signal,
            redirect: 'manual',
            credentials: 'omit',
            dispatcher
          }),
        signal
      )
      if (response.status >= 300 && response.status < 400) {
        if (response.body) await cancelBody(() => response.body!.cancel())
        fail('EXTERNAL_MCP_REDIRECT_DENIED', 'External MCP redirects are not allowed', 502)
      }
      if (Number(response.headers.get('content-length') ?? 0) > EXTERNAL_MCP_LIMITS.responseBytes) {
        if (response.body) await cancelBody(() => response.body!.cancel())
        fail('EXTERNAL_MCP_RESPONSE_TOO_LARGE', 'External MCP response exceeds its byte limit', 502)
      }
      if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers: [...response.headers] })
      const reader = response.body.getReader()
      let total = 0,
        chunks = 0,
        finished = false
      let controller: ReadableStreamDefaultController<Uint8Array>
      const finish = (): void => {
        finished = true
        signal.removeEventListener('abort', onAbort)
        cleanup()
      }
      let cancellation: Promise<void> | undefined
      const cancel = (reason: unknown): Promise<void> => {
        if (cancellation) return cancellation
        finish()
        cancellation = cancelBody(() => reader.cancel(reason))
        cancellations.add(cancellation)
        void cancellation.finally(() => cancellations.delete(cancellation!))
        return cancellation
      }
      const onAbort = (): void => {
        if (finished) return
        void cancel(signal.reason)
        controller.error(signal.reason)
      }
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        },
        async pull(value) {
          if (finished) return
          try {
            const item = await abortable(() => reader.read(), signal)
            if (finished) return
            if (item.done) {
              finish()
              reader.releaseLock()
              value.close()
              return
            }
            total += item.value.byteLength
            if (total > EXTERNAL_MCP_LIMITS.responseBytes || ++chunks > 8_192)
              fail('EXTERNAL_MCP_RESPONSE_TOO_LARGE', 'External MCP response exceeds its byte limit', 502)
            value.enqueue(item.value)
          } catch (error) {
            if (!finished) {
              await cancel(error)
              value.error(error)
            }
          }
        },
        cancel
      })
      returnedBody = true
      return new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] })
    } catch (error) {
      if (error instanceof AgentRepositoryError || signal.aborted) throw signal.aborted ? signal.reason : error
      return fail('EXTERNAL_MCP_CONNECTION_FAILED', 'External MCP connection failed', 502)
    } finally {
      if (!returnedBody) cleanup()
    }
  }
  return {
    fetch: Object.assign(guarded, { preconnect: () => egressDenied() }),
    cancelRequests() {
      requests.abort(new DOMException('External MCP client closed', 'AbortError'))
    },
    close() {
      if (closePromise) return closePromise
      lifetime.abort(new DOMException('External MCP client closed', 'AbortError'))
      closePromise = (async () => {
        await dispatcher.destroy()
        await Promise.all(cancellations)
      })()
      return closePromise
    }
  }
}

const assertCatalogBounds = (catalog: Pick<AxMCPCatalogSnapshot, 'tools' | 'prompts' | 'resources' | 'resourceTemplates'>): void => {
  if (
    catalog.tools.length + catalog.prompts.length + catalog.resources.length + catalog.resourceTemplates.length > EXTERNAL_MCP_LIMITS.catalogEntries ||
    Buffer.byteLength(JSON.stringify(catalog)) > EXTERNAL_MCP_LIMITS.catalogBytes
  )
    fail('EXTERNAL_MCP_CATALOG_TOO_LARGE', 'External MCP catalog exceeds its limits', 502)
}
/** Installed Ax terminates legacy sessions without a deadline and logs raw failures. Keep only that lifecycle step host-owned. */
class OwnerScopedMcpTransport extends AxMCPStreamableHTTPTransport {
  readonly #endpoint: string
  readonly #guard: ExternalMcpEndpointGuard
  readonly #session: { id: string | undefined }
  #era: AxMCPEra | undefined
  #protocolVersion: string | undefined
  constructor(endpoint: string, guard: ExternalMcpEndpointGuard) {
    const session: { id: string | undefined } = { id: undefined }
    super(endpoint, {
      fetch: Object.assign(
        async (...args: Parameters<typeof globalThis.fetch>) => {
          const response = await guard.fetch(...args)
          const sessionId = response.headers.get('mcp-session-id')
          if (sessionId) session.id = sessionId
          return response
        },
        { preconnect: () => egressDenied() }
      ),
      maxRedirects: 0,
      legacySSEFallback: false,
      retry: false,
      timeoutMs: EXTERNAL_MCP_LIMITS.timeoutMs,
      maxResponseBytes: EXTERNAL_MCP_LIMITS.responseBytes
    })
    this.#endpoint = endpoint
    this.#guard = guard
    this.#session = session
  }
  override setEra(era: AxMCPEra): void {
    super.setEra(era)
    this.#era = era
  }
  override setProtocolVersion(protocolVersion: string): void {
    super.setProtocolVersion(protocolVersion)
    this.#protocolVersion = protocolVersion
  }
  override async terminateSession(): Promise<void> {
    const sessionId = this.#session.id
    this.#session.id = undefined
    if (this.#era === 'modern' || !sessionId) return
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new AgentRepositoryError('EXTERNAL_MCP_CLEANUP_TIMEOUT', 'External MCP session cleanup timed out', 504)),
      EXTERNAL_MCP_LIMITS.cleanupMs
    )
    try {
      const response = await this.#guard.fetch(this.#endpoint, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': sessionId,
          ...(this.#protocolVersion ? { 'mcp-protocol-version': this.#protocolVersion } : {})
        },
        signal: deadline.signal
      })
      if (response.body) await cancelBody(() => response.body!.cancel())
      if (!response.ok && response.status !== 405) fail('EXTERNAL_MCP_CLEANUP_FAILED', 'External MCP session cleanup failed', 502)
    } catch (error) {
      const code =
        error instanceof AgentRepositoryError
          ? error.code
          : error instanceof DOMException && error.name === 'AbortError'
            ? 'EXTERNAL_MCP_CANCELLED'
            : 'EXTERNAL_MCP_CLEANUP_FAILED'
      console.warn('External MCP session cleanup failed', code)
    } finally {
      clearTimeout(timer)
    }
  }
}

class OwnerScopedMcpClient extends AxMCPClient {
  readonly #authorize: () => Promise<void>
  readonly #guard: ExternalMcpEndpointGuard
  #closed = false
  #closePromise: Promise<void> | undefined
  readonly #taskCancellations = new Map<string, Promise<AxMCPTask | undefined>>()
  constructor(transport: AxMCPStreamableHTTPTransport, options: AxMCPClientOptions, authorize: () => Promise<void>, guard: ExternalMcpEndpointGuard) {
    super(transport, {
      ...options,
      authorizeToolCall: async () => {
        if (this.#closed) return denied()
        await authorize()
        return true
      }
    })
    this.#authorize = authorize
    this.#guard = guard
  }
  override async init(): Promise<void> {
    if (this.#closed) return denied()
    await this.#authorize()
    await super.init()
    assertCatalogBounds({ tools: this.getTools(), prompts: this.getPrompts(), resources: this.getResources(), resourceTemplates: this.getResourceTemplates() })
    await this.#authorize()
  }
  override async refresh(options?: Readonly<{ force?: boolean }>): Promise<void> {
    if (this.#closed) return denied()
    await this.#authorize()
    await super.refresh(options)
    assertCatalogBounds({ tools: this.getTools(), prompts: this.getPrompts(), resources: this.getResources(), resourceTemplates: this.getResourceTemplates() })
    await this.#authorize()
  }
  override async inspectCatalog(options?: Readonly<{ refresh?: boolean }>): Promise<AxMCPCatalogSnapshot> {
    const catalog = await super.inspectCatalog(options)
    await this.#authorize()
    return catalog
  }
  override cancelTask(taskId: string): Promise<AxMCPTask | undefined> {
    const pending = this.#taskCancellations.get(taskId)
    if (pending) return pending
    if (!this.getKnownTasks().some(task => task.taskId === taskId && (task.status === 'working' || task.status === 'input_required')))
      return Promise.reject(new AgentRepositoryError('EXTERNAL_MCP_ACCESS_DENIED', 'External MCP task is not owned by this invocation', 403))
    const cancellation = super.cancelTask(taskId)
    this.#taskCancellations.set(taskId, cancellation)
    return cancellation
  }
  override close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise
    this.#closed = true
    this.#guard.cancelRequests()
    // Session termination still uses live authority; local work is cancelled before any bounded DELETE.
    this.#closePromise = (async () => {
      try {
        // Native creation records handles before callbacks return. Cancel only this
        // owner's still-running tasks, with fresh authority and a bounded HTTP lane.
        await Promise.all(this.getKnownTasks()
          .filter(task => task.status === 'working' || task.status === 'input_required')
          .map(task => this.cancelTask(task.taskId).catch(() => {})))
        await super.close()
      } finally {
        await this.#guard.close()
      }
    })()
    return this.#closePromise
  }
}

export class ExternalMcpService {
  readonly #dependencies: ExternalMcpServiceDependencies
  constructor(dependencies: ExternalMcpServiceDependencies) {
    this.#dependencies = dependencies
  }
  #enabled(): void {
    if (!this.#dependencies.enabled()) fail('EXTERNAL_MCP_DISABLED', 'Outbound external MCP is disabled')
  }
  async #actor(db: Database, requester: ExternalMcpRequester, lock = false, runtime = false): Promise<Actor> {
    if (!Number.isSafeInteger(requester.id) || requester.id < 1 || requester.id === 2) return denied()
    const query = db<{ id: number; isActive: boolean | number; authVersion: number }>('users').where('id', requester.id)
    const user = await (lock ? query.forUpdate() : query).first('id', 'isActive', 'authVersion')
    if (
      !user ||
      !accountSessionIsCurrent(
        { id: requester.id, authVersion: runtime && requester.authVersion === undefined ? user.authVersion : requester.authVersion },
        { ...user, isActive: booleanValue(user.isActive) }
      )
    )
      return denied()
    const groups = (await db('userGroups as memberships')
      .join('groups as groups', 'groups.id', 'memberships.groupId')
      .where('memberships.userId', user.id)
      .select('groups.id', 'groups.permissions')) as { id: number; permissions: unknown }[]
    const permissions = [...new Set(groups.flatMap(group => permissionValues(group.permissions)))]
    if (!permissions.includes('use:agents') && !permissions.includes('manage:system')) return denied()
    return { id: user.id, authVersion: user.authVersion, groupIds: [...new Set(groups.map(group => group.id))].sort((a, b) => a - b), permissions }
  }
  async #admin(db: Database, requester: ExternalMcpRequester, lock = false): Promise<Actor> {
    const actor = await this.#actor(db, requester, lock)
    if (!actor.permissions.includes('manage:system')) return denied()
    return actor
  }
  async #personalStamp(db: Database, actor: Actor): Promise<string> {
    const policies = (await db('agentExternalMcpGroupPolicies')
      .whereIn('groupId', actor.groupIds)
      .where('allowPersonalEndpoints', true)
      .orderBy('groupId')
      .select('groupId', 'revision')) as { groupId: number; revision: number }[]
    if (!policies.length) return denied()
    return `${actor.groupIds.join(',')}|${policies.map(policy => `${policy.groupId}:${policy.revision}`).join(',')}`
  }
  async #allowed(db: Database, actor: Actor, row: ServerRow): Promise<AllowedServer> {
    this.#enabled()
    if (row.status !== 'enabled') return denied()
    if (row.scope === 'personal') {
      if (row.ownerId !== actor.id) return denied()
      return { row, stamp: await this.#personalStamp(db, actor) }
    }
    if (row.scope !== 'admin' || row.ownerId !== null) return denied()
    const grant = await db('agentExternalMcpGrants').where('serverId', row.id).whereIn('groupId', actor.groupIds).first('groupId')
    if (!grant) return denied()
    return { row, stamp: actor.groupIds.join(',') }
  }
  async #view(db: Database, row: ServerRow, grants = false): Promise<ExternalMcpServerView> {
    const groupIds = grants
      ? ((await db('agentExternalMcpGrants').where('serverId', row.id).orderBy('groupId').select('groupId')) as { groupId: number }[]).map(
          grant => grant.groupId
        )
      : []
    return {
      id: row.id,
      displayName: row.displayName,
      endpointUrl: row.endpointUrl,
      destinationHost: new URL(row.endpointUrl).hostname,
      namespace: namespaceFor(row.id),
      scope: row.scope,
      ownerId: row.ownerId,
      status: row.status,
      revision: row.revision,
      authMode: row.authMode,
      secretConfigured: row.secretReference !== null && (await this.#dependencies.secrets.has(row.secretReference, db)),
      groupIds,
      trust: 'untrusted',
      createdAt: dateValue(row.createdAt),
      updatedAt: dateValue(row.updatedAt)
    }
  }
  async #groups(tx: Knex.Transaction, ids: readonly number[]): Promise<number[]> {
    const normalized = [...new Set(ids)].sort((a, b) => a - b)
    if (normalized.length !== ids.length || normalized.some(id => !Number.isSafeInteger(id) || id < 1))
      fail('INVALID_EXTERNAL_MCP_GRANTS', 'Choose unique valid groups', 400)
    const rows = await tx('groups').whereIn('id', normalized).select('id')
    if (rows.length !== normalized.length) fail('INVALID_EXTERNAL_MCP_GRANTS', 'One or more selected groups are unavailable', 400)
    return normalized
  }
  async #secret(tx: Knex.Transaction, actorId: number, input: ExternalMcpServerInput, existing: string | null): Promise<string | null> {
    if (input.authMode === 'none') {
      if (input.secretValue != null) fail('INVALID_EXTERNAL_MCP_CREDENTIAL', 'Unauthenticated endpoints cannot configure a credential', 400)
      return null
    }
    if (input.secretValue === null) return fail('INVALID_EXTERNAL_MCP_CREDENTIAL', 'Bearer authentication requires a credential', 400)
    if (input.secretValue !== undefined) return this.#dependencies.secrets.store(input.secretValue, actorId, tx)
    if (!existing || !existing.startsWith('managed:') || !(await this.#dependencies.secrets.has(existing, tx)))
      fail('EXTERNAL_MCP_CREDENTIAL_REQUIRED', 'Configure this endpoint’s bearer credential', 400)
    return existing
  }
  async #create(requester: ExternalMcpRequester, raw: unknown, scope: 'admin' | 'personal'): Promise<ExternalMcpServerView> {
    const parsed = scope === 'admin' ? CreateAdminExternalMcpServerSchema.safeParse(raw) : ExternalMcpServerInputSchema.safeParse(raw)
    if (!parsed.success) return fail('INVALID_EXTERNAL_MCP_CONFIGURATION', 'Enter a valid external MCP configuration', 400)
    const input = parsed.data
    const endpointUrl = normalizeExternalMcpEndpoint(input.endpointUrl)
    return this.#dependencies.knex.transaction(async tx => {
      const actor = scope === 'admin' ? await this.#admin(tx, requester, true) : await this.#actor(tx, requester, true)
      if (scope === 'personal') {
        this.#enabled()
        await this.#personalStamp(tx, actor)
        const count = await tx('agentExternalMcpServers').where({ scope, ownerId: actor.id }).count<{ count: string }[]>({ count: '*' }).first()
        if (Number(count?.count) >= EXTERNAL_MCP_LIMITS.personalEndpoints)
          fail('EXTERNAL_MCP_PERSONAL_LIMIT', 'Personal external MCP endpoint limit reached', 409)
      }
      const groupIds = scope === 'admin' ? await this.#groups(tx, (input as CreateAdminExternalMcpServerInput).groupIds) : []
      const secretReference = await this.#secret(tx, actor.id, input, null)
      const now = new Date()
      const row: ServerRow = {
        id: randomUUID(),
        displayName: input.displayName,
        endpointUrl,
        scope,
        ownerId: scope === 'personal' ? actor.id : null,
        status: input.status,
        revision: 1,
        authMode: input.authMode,
        secretReference,
        createdAt: now,
        updatedAt: now
      }
      await tx('agentExternalMcpServers').insert({ ...row, createdBy: actor.id, updatedBy: actor.id })
      if (groupIds.length) await tx('agentExternalMcpGrants').insert(groupIds.map(groupId => ({ serverId: row.id, groupId })))
      return this.#view(tx, row, scope === 'admin')
    })
  }
  createAdmin(requester: ExternalMcpRequester, input: CreateAdminExternalMcpServerInput): Promise<ExternalMcpServerView> {
    return this.#create(requester, input, 'admin')
  }
  createPersonal(requester: ExternalMcpRequester, input: ExternalMcpServerInput): Promise<ExternalMcpServerView> {
    return this.#create(requester, input, 'personal')
  }
  async #owned(tx: Knex.Transaction, requester: ExternalMcpRequester, id: string, scope: 'admin' | 'personal'): Promise<{ actor: Actor; row: ServerRow }> {
    const actor = scope === 'admin' ? await this.#admin(tx, requester, true) : await this.#actor(tx, requester, true)
    if (scope === 'personal') {
      this.#enabled()
      await this.#personalStamp(tx, actor)
    }
    const row = await tx<ServerRow>('agentExternalMcpServers')
      .where({ id: idValue(id), scope, ...(scope === 'personal' ? { ownerId: actor.id } : {}) })
      .forUpdate()
      .first()
    if (!row) return denied()
    return { actor, row }
  }
  async #update(
    requester: ExternalMcpRequester,
    id: string,
    expectedRevision: number,
    raw: unknown,
    scope: 'admin' | 'personal'
  ): Promise<ExternalMcpServerView> {
    const parsed = ExternalMcpServerInputSchema.safeParse(raw)
    if (!parsed.success) return fail('INVALID_EXTERNAL_MCP_CONFIGURATION', 'Enter a valid external MCP configuration', 400)
    const input = parsed.data
    const endpointUrl = normalizeExternalMcpEndpoint(input.endpointUrl)
    return this.#dependencies.knex.transaction(async tx => {
      const { actor, row } = await this.#owned(tx, requester, id, scope)
      revision(expectedRevision, row.revision)
      // A credential may never cross destinations implicitly during an endpoint edit.
      if (endpointUrl !== row.endpointUrl && input.authMode === 'bearer' && input.secretValue === undefined)
        fail('EXTERNAL_MCP_CREDENTIAL_REQUIRED', 'Configure a new credential when changing the endpoint', 400)
      const secretReference = await this.#secret(tx, actor.id, input, row.secretReference)
      const updated = {
        ...row,
        displayName: input.displayName,
        endpointUrl,
        status: input.status,
        authMode: input.authMode,
        secretReference,
        revision: row.revision + 1,
        updatedAt: new Date()
      }
      await tx('agentExternalMcpServers').where('id', row.id).update({
        displayName: updated.displayName,
        endpointUrl,
        status: updated.status,
        authMode: updated.authMode,
        secretReference,
        revision: updated.revision,
        updatedAt: updated.updatedAt,
        updatedBy: actor.id
      })
      if (row.secretReference && row.secretReference !== secretReference) await this.#dependencies.secrets.delete(row.secretReference, tx)
      return this.#view(tx, updated, scope === 'admin')
    })
  }
  updateAdmin(requester: ExternalMcpRequester, id: string, expectedRevision: number, input: ExternalMcpServerInput): Promise<ExternalMcpServerView> {
    return this.#update(requester, id, expectedRevision, input, 'admin')
  }
  updatePersonal(requester: ExternalMcpRequester, id: string, expectedRevision: number, input: ExternalMcpServerInput): Promise<ExternalMcpServerView> {
    return this.#update(requester, id, expectedRevision, input, 'personal')
  }
  async #delete(requester: ExternalMcpRequester, id: string, expectedRevision: number, scope: 'admin' | 'personal'): Promise<void> {
    await this.#dependencies.knex.transaction(async tx => {
      const { row } = await this.#owned(tx, requester, id, scope)
      revision(expectedRevision, row.revision)
      await tx('agentExternalMcpGrants').where('serverId', row.id).delete()
      await tx('agentExternalMcpServers').where('id', row.id).delete()
      if (row.secretReference) await this.#dependencies.secrets.delete(row.secretReference, tx)
    })
  }
  deleteAdmin(requester: ExternalMcpRequester, id: string, expectedRevision: number): Promise<void> {
    return this.#delete(requester, id, expectedRevision, 'admin')
  }
  deletePersonal(requester: ExternalMcpRequester, id: string, expectedRevision: number): Promise<void> {
    return this.#delete(requester, id, expectedRevision, 'personal')
  }
  async setAdminGrants(
    requester: ExternalMcpRequester,
    id: string,
    expectedRevision: number,
    raw: { groupIds: readonly number[] }
  ): Promise<ExternalMcpServerView> {
    const parsed = ExternalMcpGrantsInputSchema.safeParse(raw)
    if (!parsed.success) return fail('INVALID_EXTERNAL_MCP_GRANTS', 'Choose valid group grants', 400)
    return this.#dependencies.knex.transaction(async tx => {
      const { actor, row } = await this.#owned(tx, requester, id, 'admin')
      revision(expectedRevision, row.revision)
      const ids = await this.#groups(tx, parsed.data.groupIds)
      await tx('agentExternalMcpGrants').where('serverId', row.id).delete()
      if (ids.length) await tx('agentExternalMcpGrants').insert(ids.map(groupId => ({ serverId: row.id, groupId })))
      const updated = { ...row, revision: row.revision + 1, updatedAt: new Date() }
      await tx('agentExternalMcpServers').where('id', row.id).update({ revision: updated.revision, updatedAt: updated.updatedAt, updatedBy: actor.id })
      return this.#view(tx, updated, true)
    })
  }
  async listAdmin(requester: ExternalMcpRequester): Promise<ExternalMcpServerView[]> {
    const db = this.#dependencies.knex
    await this.#admin(db, requester)
    const rows = await db<ServerRow>('agentExternalMcpServers').where('scope', 'admin').orderBy('createdAt').select('*')
    return Promise.all(rows.map(row => this.#view(db, row, true)))
  }
  async listPersonal(requester: ExternalMcpRequester): Promise<ExternalMcpServerView[]> {
    this.#enabled()
    const db = this.#dependencies.knex,
      actor = await this.#actor(db, requester)
    await this.#personalStamp(db, actor)
    const rows = await db<ServerRow>('agentExternalMcpServers').where({ scope: 'personal', ownerId: actor.id }).orderBy('createdAt').select('*')
    return Promise.all(rows.map(row => this.#view(db, row)))
  }
  async groupPolicies(requester: ExternalMcpRequester): Promise<ExternalMcpGroupPolicyView[]> {
    const db = this.#dependencies.knex
    await this.#admin(db, requester)
    const rows = (await db('groups as groups')
      .leftJoin('agentExternalMcpGroupPolicies as policies', 'policies.groupId', 'groups.id')
      .orderBy('groups.id')
      .select('groups.id as groupId', 'policies.allowPersonalEndpoints', 'policies.revision')) as {
      groupId: number
      allowPersonalEndpoints: boolean | number | null
      revision: number | null
    }[]
    return rows.map(row => ({ groupId: row.groupId, allowPersonalEndpoints: booleanValue(row.allowPersonalEndpoints), revision: row.revision ?? 0 }))
  }
  async setGroupPolicy(
    requester: ExternalMcpRequester,
    groupId: number,
    raw: { allowPersonalEndpoints: boolean },
    expectedRevision: number
  ): Promise<ExternalMcpGroupPolicyView> {
    const parsed = ExternalMcpGroupPolicyInputSchema.safeParse(raw)
    if (!parsed.success || !Number.isSafeInteger(groupId) || groupId < 1) return fail('INVALID_EXTERNAL_MCP_GROUP_POLICY', 'Choose a valid group policy', 400)
    return this.#dependencies.knex.transaction(async tx => {
      const actor = await this.#admin(tx, requester, true)
      if (!(await tx('groups').where('id', groupId).forUpdate().first('id'))) return denied()
      const existing = (await tx('agentExternalMcpGroupPolicies').where('groupId', groupId).first('revision')) as { revision: number } | undefined
      revision(expectedRevision, existing?.revision ?? 0)
      const value = {
        groupId,
        allowPersonalEndpoints: parsed.data.allowPersonalEndpoints,
        revision: (existing?.revision ?? 0) + 1,
        updatedBy: actor.id,
        updatedAt: new Date()
      }
      await tx('agentExternalMcpGroupPolicies').insert(value).onConflict('groupId').merge()
      return { groupId, allowPersonalEndpoints: value.allowPersonalEndpoints, revision: value.revision }
    })
  }
  async #available(db: Database, actor: Actor): Promise<AllowedServer[]> {
    const rows = await db<ServerRow>('agentExternalMcpServers')
      .where('status', 'enabled')
      .andWhere(query => query.where('scope', 'admin').orWhere({ scope: 'personal', ownerId: actor.id }))
      .orderBy('createdAt')
      .select('*')
    const allowed: AllowedServer[] = []
    for (const row of rows) {
      try {
        allowed.push(await this.#allowed(db, actor, row))
      } catch (error) {
        if (!(error instanceof AgentRepositoryError) || error.code !== 'EXTERNAL_MCP_ACCESS_DENIED') throw error
      }
    }
    return allowed
  }
  async listForUser(requester: ExternalMcpRequester): Promise<ExternalMcpServerView[]> {
    this.#enabled()
    const db = this.#dependencies.knex,
      actor = await this.#actor(db, requester)
    return Promise.all((await this.#available(db, actor)).map(({ row }) => this.#view(db, row)))
  }
  async openForUser(ownerId: number, options: { serverIds?: readonly string[]; signal?: AbortSignal; authVersion?: number } = {}): Promise<ExternalMcpLease> {
    this.#enabled()
    options.signal?.throwIfAborted()
    const db = this.#dependencies.knex
    const actor = await this.#actor(db, { id: ownerId, ...(options.authVersion === undefined ? {} : { authVersion: options.authVersion }) }, false, true)
    const available = await this.#available(db, actor)
    let selected = available
    if (options.serverIds) {
      if (new Set(options.serverIds).size !== options.serverIds.length) fail('INVALID_EXTERNAL_MCP_SELECTION', 'Choose unique external MCP endpoints', 400)
      selected = options.serverIds.map(id => available.find(entry => entry.row.id === idValue(id)) ?? denied())
    }
    if (selected.length > EXTERNAL_MCP_LIMITS.maxClients) fail('EXTERNAL_MCP_CLIENT_LIMIT', 'Choose at most sixteen external MCP endpoints for one run', 400)
    const clients: OwnerScopedMcpClient[] = []
    const views: ExternalMcpServerView[] = []
    try {
      for (const selection of selected) {
        const { row, stamp } = selection
        const authorize = async (): Promise<void> => {
          this.#enabled()
          const currentActor = await this.#actor(db, { id: ownerId, authVersion: actor.authVersion })
          const current = await db<ServerRow>('agentExternalMcpServers').where('id', row.id).first()
          if (
            !current ||
            current.revision !== row.revision ||
            current.endpointUrl !== row.endpointUrl ||
            current.secretReference !== row.secretReference ||
            current.authMode !== row.authMode ||
            current.scope !== row.scope ||
            current.ownerId !== row.ownerId
          )
            return denied()
          if ((await this.#allowed(db, currentActor, current)).stamp !== stamp) return denied()
        }
        const guard = createExternalMcpEndpointGuard({
          endpointUrl: row.endpointUrl,
          authorize,
          credential: async () => {
            if (row.authMode === 'none') return null
            if (!row.secretReference?.startsWith('managed:')) return fail('EXTERNAL_MCP_CREDENTIAL_UNAVAILABLE', 'External MCP credential is unavailable', 503)
            const value = await this.#dependencies.secrets.get(row.secretReference)
            if (value === null) return fail('EXTERNAL_MCP_CREDENTIAL_UNAVAILABLE', 'External MCP credential is unavailable', 503)
            return value
          },
          ...(options.signal ? { signal: options.signal } : {}),
          ...(this.#dependencies.resolve ? { resolve: this.#dependencies.resolve } : {}),
          ...(this.#dependencies.fetch ? { fetch: this.#dependencies.fetch } : {})
        })
        const transport = new OwnerScopedMcpTransport(row.endpointUrl, guard)
        const client = new OwnerScopedMcpClient(
          transport,
          {
            namespace: namespaceFor(row.id),
            era: 'auto',
            maxConcurrency: 2,
            maxInputRounds: 1,
            maxPaginationPages: EXTERNAL_MCP_LIMITS.catalogPages,
            sessionRecovery: 'none',
            readCache: false
          },
          authorize,
          guard
        )
        clients.push(client)
        views.push(await this.#view(db, row))
      }
      let closed = false
      let closePromise: Promise<void> | undefined
      const onAbort = (): void => {
        void lease.close().catch(() => {})
      }
      const lease: ExternalMcpLease = {
        clients,
        servers: views,
        inspectCatalog: async serverId => {
          if (closed) return denied()
          const index = selected.findIndex(entry => entry.row.id === serverId)
          if (index < 0) return denied()
          const server = views[index]!,
            client = clients[index]!
          const catalog = await client.inspectCatalog()
          return {
            attribution: {
              serverId: server.id,
              namespace: server.namespace,
              displayName: server.displayName,
              destinationHost: server.destinationHost,
              trust: 'untrusted',
              authority: 'external'
            },
            catalog
          }
        },
        close: () => {
          if (closePromise) return closePromise
          closed = true
          options.signal?.removeEventListener('abort', onAbort)
          closePromise = Promise.all(clients.map(client => client.close())).then(() => {})
          return closePromise
        }
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        await lease.close()
        options.signal.throwIfAborted()
      }
      return lease
    } catch (error) {
      await Promise.all(clients.map(client => client.close()))
      throw error
    }
  }
  async discoverForUser(requester: ExternalMcpRequester, serverId: string, options: { signal?: AbortSignal } = {}): Promise<ExternalMcpDiscovery> {
    // Authenticate the actual session before opening the internal owner-scoped runtime lifecycle.
    await this.#actor(this.#dependencies.knex, requester)
    const lease = await this.openForUser(requester.id, {
      serverIds: [serverId],
      ...options,
      ...(requester.authVersion === undefined ? {} : { authVersion: requester.authVersion })
    })
    try {
      return await lease.inspectCatalog(serverId)
    } finally {
      await lease.close()
    }
  }
}
