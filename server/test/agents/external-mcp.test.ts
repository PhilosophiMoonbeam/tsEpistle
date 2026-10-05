import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { AxMCPClient } from '@ax-llm/ax'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import {
  ExternalMcpService,
  createExternalMcpEndpointGuard,
  normalizeExternalMcpEndpoint,
  EXTERNAL_MCP_LIMITS,
  type ExternalMcpFetchImplementation,
  type ExternalMcpLease
} from '../../agents/external-mcp.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { up } from '../../db/migrations/tsepistle-000050-agent-external-mcp.ts'

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]
const admin = { id: 1, authVersion: 0 },
  owner = { id: 7, authVersion: 0 },
  other = { id: 8, authVersion: 0 }
const input = () => ({
  displayName: 'External research',
  endpointUrl: `https://mcp.example.com/${randomUUID()}`,
  status: 'enabled' as const,
  authMode: 'none' as const
})

// This is a credential-free remote protocol fixture, not an Ax client mock.
interface ProtocolFixture {
  readonly calls: { method: string; headers: Headers; params?: unknown }[]
  readonly fetch: ExternalMcpFetchImplementation
  setToolCount(count: number): void
  setTaskStatus(status: 'working' | 'completed'): void
}
const protocolFixture = (era: 'legacy' | 'modern' = 'modern', tasks = false): ProtocolFixture => {
  const calls: { method: string; headers: Headers; params?: unknown }[] = []
  let toolCount = 1
  let taskStatus: 'working' | 'completed' = 'working'
  const task = { taskId: 'owned-task', status: 'working', createdAt: '2026-08-17T00:00:00Z', lastUpdatedAt: '2026-08-17T00:00:00Z', ttl: 30_000, ttlMs: 30_000, pollInterval: 1, pollIntervalMs: 1 }
  const fetch: ExternalMcpFetchImplementation = async (_url, init) => {
    if (init.method === 'DELETE') {
      calls.push({ method: 'session/terminate', headers: new Headers(init.headers) })
      return new Response(null, { status: 204 })
    }
    const message = JSON.parse(String(init.body)) as { id?: string; method: string; params?: unknown }
    calls.push({ method: message.method, headers: new Headers(init.headers), params: message.params })
    if (!message.id) return new Response(null, { status: 202 })
    if (message.method === 'server/discover' && era === 'legacy')
      return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    let result: unknown
    switch (message.method) {
      case 'server/discover':
        result = {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {}, prompts: {}, resources: {}, ...(tasks ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {}) },
          ttlMs: 0,
          cacheScope: 'private'
        }
        break
      case 'initialize':
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {}, prompts: {}, resources: {}, ...(tasks ? { tasks: { requests: { tools: { call: {} } } } } : {}) },
          serverInfo: { name: 'Untrusted research', version: '1' }
        }
        break
      case 'tools/list':
        result = {
          resultType: 'complete',
          tools: Array.from({ length: toolCount }, (_, index) => ({
            name: index === 0 ? 'web_search' : `tool_${index}`,
            description: 'Public web search',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            ...(tasks && era === 'legacy' ? { execution: { taskSupport: 'required' } } : {})
          })),
          ttlMs: 0,
          cacheScope: 'private'
        }
        break
      case 'prompts/list':
        result = { resultType: 'complete', prompts: [{ name: 'research', description: 'Untrusted prompt' }], ttlMs: 0, cacheScope: 'private' }
        break
      case 'resources/list':
        result = {
          resultType: 'complete',
          resources: [{ uri: 'https://research.example.com/document', name: 'External document' }],
          ttlMs: 0,
          cacheScope: 'private'
        }
        break
      case 'resources/templates/list':
        result = { resultType: 'complete', resourceTemplates: [], ttlMs: 0, cacheScope: 'private' }
        break
      case 'tools/call':
        if (tasks) {
          result = era === 'legacy' ? { task } : { ...task, resultType: 'task' }
          break
        }
        result = {
          resultType: 'complete',
          content: [
            { type: 'text', text: 'External claim, not Wiki evidence' },
            { type: 'image', mimeType: 'image/png', data: 'AA==' }
          ],
          structuredContent: { source: 'external', result: ['https://research.example.com/document'] }
        }
        break
      case 'tasks/get':
        result = { ...task, status: taskStatus }
        break
      case 'tasks/result':
        result = { content: [{ type: 'text', text: 'Final task result' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }] }
        break
      case 'tasks/cancel':
        result = { ...task, status: 'cancelled' }
        break
      default:
        throw new Error(`Unexpected protocol method ${message.method}`)
    }
    return Response.json(
      { jsonrpc: '2.0', id: message.id, result },
      { headers: message.method === 'initialize' ? { 'mcp-session-id': 'credential-free-test-session' } : {} }
    )
  }
  return {
    calls,
    fetch,
    setTaskStatus: status => { taskStatus = status },
    setToolCount: (count: number) => {
      toolCount = count
    }
  }
}

describe('external MCP owner-scoped native clients', () => {
  let db: Knex, service: ExternalMcpService, vault: DatabaseAgentSecretRegistry
  let protocol: ProtocolFixture, enabled: boolean
  const leases: ExternalMcpLease[] = []
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.text('permissions').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable()
      table.integer('groupId').notNullable()
      table.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('agentProviderSecrets', table => {
      table.uuid('id').primary()
      table.string('keyId').notNullable()
      table.string('algorithm').notNullable()
      table.binary('nonce').notNullable()
      table.binary('ciphertext').notNullable()
      table.binary('authTag').notNullable()
      table.integer('createdBy').notNullable()
      table.timestamp('createdAt').notNullable()
    })
    await up(db)
    await db('users').insert([1, 7, 8, 9].map(id => ({ id, isActive: true, authVersion: 0 })))
    await db('groups').insert([
      { id: 10, permissions: JSON.stringify(['manage:system']) },
      { id: 20, permissions: JSON.stringify(['use:agents']) },
      { id: 30, permissions: JSON.stringify(['use:agents']) }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 10 },
      { userId: 7, groupId: 20 },
      { userId: 8, groupId: 30 },
      { userId: 9, groupId: 20 }
    ])
    vault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } })
    protocol = protocolFixture()
    enabled = true
    service = new ExternalMcpService({ knex: db, secrets: vault, enabled: () => enabled, resolve: publicResolver, fetch: (...args) => protocol.fetch(...args) })
  })
  afterEach(async () => {
    await Promise.all(leases.splice(0).map(lease => lease.close()))
    await db.destroy()
  })

  it.each(['legacy', 'modern'] as const)('discovers %s catalogs natively and retains attributed raw multimodal results', async era => {
    protocol = protocolFixture(era)
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    expect(lease.clients[0]).toBeInstanceOf(AxMCPClient)
    const discovery = await lease.inspectCatalog(server.id)
    expect(discovery.attribution).toMatchObject({ serverId: server.id, namespace: server.namespace, trust: 'untrusted', authority: 'external' })
    expect(discovery.catalog.tools.map(tool => tool.name)).toEqual(['web_search'])
    expect(discovery.catalog.prompts[0]?.name).toBe('research')
    expect(discovery.catalog.resources[0]?.uri).toBe('https://research.example.com/document')
    const result = await lease.clients[0]!.callTool('web_search', { query: 'some topic' })
    expect(result).toMatchObject({
      content: [
        { type: 'text', text: 'External claim, not Wiki evidence' },
        { type: 'image', mimeType: 'image/png', data: 'AA==' }
      ],
      structuredContent: { source: 'external' }
    })
    expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(1)
    await lease.close()
    await lease.close()
    if (era === 'legacy') expect(protocol.calls.filter(call => call.method === 'session/terminate')).toHaveLength(1)
    const requestsAfterClose = protocol.calls.length
    await expect(lease.clients[0]!.inspectCatalog()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toHaveLength(requestsAfterClose)
  })

  it.each(['legacy', 'modern'] as const)('admin grants deny %s discovery, invocation, cached reads and cleanup after revocation', async era => {
    protocol = protocolFixture(era)
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    expect(await service.listForUser(other)).toEqual([])
    await expect(service.discoverForUser(other, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toEqual([])
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const requestsBeforeRevocation = protocol.calls.length
    await service.setAdminGrants(admin, server.id, server.revision, { groupIds: [30] })
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(lease.inspectCatalog(server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(lease.clients[0]!.listTools()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toHaveLength(requestsBeforeRevocation)
    await lease.close()
    expect(protocol.calls).toHaveLength(requestsBeforeRevocation)
    expect(await service.listForUser(owner)).toEqual([])
  })

  it('personal creation needs live group permission and owners cannot discover, edit or delete each other’s configurations', async () => {
    await expect(service.createPersonal(owner, input())).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    await service.setGroupPolicy(admin, 30, { allowPersonalEndpoints: true }, 0)
    const server = await service.createPersonal(owner, input())
    expect(await service.listPersonal(other)).toEqual([])
    await expect(service.discoverForUser(other, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(service.updatePersonal(other, server.id, server.revision, input())).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(service.deletePersonal(other, server.id, server.revision)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toEqual([])
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const count = protocol.calls.length
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: false }, 1)
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    expect(protocol.calls).toHaveLength(count)
  })

  it.each(['membership', 'account', 'session', 'server', 'switch'] as const)(
    'revoking %s after discovery prevents actual native tool invocation',
    async change => {
      const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
      const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
      leases.push(lease)
      await lease.inspectCatalog(server.id)
      const count = protocol.calls.length
      if (change === 'membership') await db('userGroups').where({ userId: 7, groupId: 20 }).delete()
      if (change === 'account') await db('users').where('id', 7).update({ isActive: false })
      if (change === 'session') await db('users').where('id', 7).update({ authVersion: 1 })
      if (change === 'server') await db('agentExternalMcpServers').where('id', server.id).update({ status: 'disabled' })
      if (change === 'switch') enabled = false
      await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toMatchObject({ status: 403 })
      expect(protocol.calls).toHaveLength(count)
      await lease.close()
      expect(protocol.calls).toHaveLength(count)
    }
  )

  it('never accepts another credential reference, redacts secrets, and prevents implicit forwarding to a changed endpoint', async () => {
    const reference = await db.transaction(tx => vault.store('other-provider-private-key', admin.id, tx))
    await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
    await expect(service.createPersonal(owner, { ...input(), authMode: 'bearer', secretReference: reference } as never)).rejects.toMatchObject({
      code: 'INVALID_EXTERNAL_MCP_CONFIGURATION'
    })
    const values = { ...input(), authMode: 'bearer' as const, secretValue: 'own-mcp-private-key' }
    const server = await service.createPersonal(owner, values)
    const serialized = JSON.stringify([server, await service.listPersonal(owner), await service.listForUser(owner)])
    expect(serialized).not.toContain('private-key')
    expect(serialized).not.toContain('managed:')
    expect(server.secretConfigured).toBe(true)
    const lease = await service.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    expect(protocol.calls.every(call => call.headers.get('authorization') === 'Bearer own-mcp-private-key')).toBe(true)
    const { secretValue: _secretValue, ...withoutSecret } = values
    await expect(
      service.updatePersonal(owner, server.id, server.revision, { ...withoutSecret, endpointUrl: 'https://different.example.com/mcp' })
    ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_CREDENTIAL_REQUIRED' })
    const row = await db('agentExternalMcpServers').where('id', server.id).first('secretReference')
    await service.deletePersonal(owner, server.id, server.revision)
    expect(await vault.has(row.secretReference)).toBe(false)
    expect(await vault.get(reference)).toBe('other-provider-private-key')
  })

  it('rejects stale revisions, forged admin claims, and catalogs beyond bounded entries', async () => {
    await expect(
      service.createAdmin({ ...owner, groups: [10], permissions: ['manage:system'] } as never, { ...input(), groupIds: [20] })
    ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    await expect(service.setAdminGrants(admin, server.id, 0, { groupIds: [30] })).rejects.toMatchObject({ code: 'EXTERNAL_MCP_REVISION_CHANGED' })
    protocol.setToolCount(EXTERNAL_MCP_LIMITS.catalogEntries + 1)
    await expect(service.discoverForUser(owner, server.id)).rejects.toMatchObject({ code: 'EXTERNAL_MCP_CATALOG_TOO_LARGE' })
    expect(await service.listForUser(owner)).toHaveLength(1)
  })

  it('uses the bounded native task cleanup lane on abort and isolates task handles by owner and endpoint', async () => {
    protocol = protocolFixture('legacy', true)
    const server = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    const second = await service.createAdmin(admin, { ...input(), groupIds: [20] })
    const controller = new AbortController()
    const lease = await service.openForUser(owner.id, { serverIds: [server.id], signal: controller.signal })
    const independent = await service.openForUser(9, { serverIds: [server.id] })
    const anotherServer = await service.openForUser(owner.id, { serverIds: [second.id] })
    leases.push(lease, independent, anotherServer)
    for (const selected of [lease, independent, anotherServer]) await selected.clients[0]!.inspectCatalog()
    const client = lease.clients[0]!
    await client.callToolTask('web_search', {})
    expect(client.getKnownTasks()).toMatchObject([{ taskId: 'owned-task', status: 'working' }])
    await expect(independent.clients[0]!.cancelTask('owned-task')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    await expect(anotherServer.clients[0]!.cancelTask('owned-task')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    controller.abort(new DOMException('User cancelled', 'AbortError'))
    await lease.close()
    expect(protocol.calls.filter(call => call.method === 'tasks/cancel')).toHaveLength(1)
    expect(client.getKnownTasks()).toMatchObject([{ taskId: 'owned-task', status: 'cancelled' }])
    expect(independent.clients[0]!.getKnownTasks()).toEqual([])
    const independentTask = await independent.clients[0]!.callToolTask('web_search', {})
    expect(independentTask.task.status).toBe('working')
  })

  it.each(['membership', 'account', 'session', 'server', 'switch', 'grants', 'personal-policy', 'endpoint'] as const)(
    'reauthorizes legacy task polls, final result and abort cleanup after %s revocation without replay',
    async change => {
      protocol = protocolFixture('legacy', true)
      await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: true }, 0)
      const personal = change === 'personal-policy'
      const server = personal
        ? await service.createPersonal(owner, input())
        : await service.createAdmin(admin, { ...input(), groupIds: [20] })
      const controller = new AbortController()
      const lease = await service.openForUser(owner.id, { serverIds: [server.id], signal: controller.signal })
      leases.push(lease)
      const client = lease.clients[0]!
      await client.inspectCatalog()
      await client.callToolTask('web_search', {})
      expect(await client.getTask('owned-task')).toHaveProperty('status', 'working')
      protocol.setTaskStatus('completed')
      expect(await client.getTask('owned-task')).toHaveProperty('status', 'completed')
      expect(await client.getTaskResult('owned-task')).toHaveProperty('content.1.type', 'image')
      // A second actual task is left working so close must attempt cancellation.
      await client.callToolTask('web_search', {})
      const count = protocol.calls.length
      if (change === 'membership') await db('userGroups').where({ userId: 7, groupId: 20 }).delete()
      if (change === 'account') await db('users').where('id', 7).update({ isActive: false })
      if (change === 'session') await db('users').where('id', 7).update({ authVersion: 1 })
      if (change === 'server') await db('agentExternalMcpServers').where('id', server.id).update({ status: 'disabled' })
      if (change === 'switch') enabled = false
      if (change === 'grants') await service.setAdminGrants(admin, server.id, server.revision, { groupIds: [30] })
      if (change === 'personal-policy') await service.setGroupPolicy(admin, 20, { allowPersonalEndpoints: false }, 1)
      if (change === 'endpoint') await db('agentExternalMcpServers').where('id', server.id).update({ endpointUrl: 'https://other.example.com/mcp', revision: 2 })
      const denial = change === 'switch' ? 'EXTERNAL_MCP_DISABLED' : 'EXTERNAL_MCP_ACCESS_DENIED'
      await expect(client.getTask('owned-task')).rejects.toMatchObject({ code: denial })
      await expect(client.getTaskResult('owned-task')).rejects.toMatchObject({ code: denial })
      controller.abort(new DOMException('Cancelled', 'AbortError'))
      await lease.close()
      expect(protocol.calls).toHaveLength(count)
      expect(protocol.calls.filter(call => call.method === 'tools/call')).toHaveLength(2)
    }
  )

  it.each(['legacy', 'modern'] as const)('cancels an in-flight %s invocation promptly without closing another owner lease', async era => {
    protocol = protocolFixture(era)
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    let networkRequests = 0
    let interruptedInvocation = false
    const cancellable = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        networkRequests++
        if (init.method === 'DELETE') return protocol.fetch(url, init)
        const request = JSON.parse(String(init.body)) as { method: string }
        if (request.method !== 'tools/call' || interruptedInvocation) return protocol.fetch(url, init)
        interruptedInvocation = true
        const pending = Promise.withResolvers<Response>()
        const onAbort = (): void => {
          cancelled.resolve()
          pending.reject(init.signal?.reason)
        }
        init.signal?.addEventListener('abort', onAbort, { once: true })
        if (init.signal?.aborted) onAbort()
        started.resolve()
        try {
          return await pending.promise
        } finally {
          init.signal?.removeEventListener('abort', onAbort)
        }
      }
    })
    const server = await cancellable.createAdmin(admin, { ...input(), groupIds: [20] })
    const lease = await cancellable.openForUser(owner.id, { serverIds: [server.id], signal: controller.signal })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const independent = await cancellable.openForUser(9, { serverIds: [server.id] })
    leases.push(independent)
    await independent.inspectCatalog(server.id)
    const count = networkRequests
    const pending = lease.clients[0]!.callTool('web_search', {})
    const rejection = pending.catch((error: unknown) => error)
    await started.promise
    controller.abort(new DOMException('User cancelled', 'AbortError'))
    expect(await rejection).toHaveProperty('name', 'AbortError')
    await cancelled.promise
    await lease.close()
    expect(networkRequests).toBe(count + 1)
    await expect(lease.clients[0]!.inspectCatalog()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_ACCESS_DENIED' })
    const independentResult = await independent.clients[0]!.callTool('web_search', {})
    expect(independentResult).toHaveProperty('structuredContent.source', 'external')
    expect(networkRequests).toBe(count + 2)
  })

  it('bounds legacy session cleanup, cancels active invocation and shares the pending close promise', async () => {
    protocol = protocolFixture('legacy')
    const toolStarted = Promise.withResolvers<void>()
    const deleteStarted = Promise.withResolvers<void>()
    const deleteAborted = Promise.withResolvers<void>()
    let deletes = 0
    const bounded = new ExternalMcpService({
      knex: db,
      secrets: vault,
      enabled: () => true,
      resolve: publicResolver,
      fetch: async (url, init) => {
        const terminating = init.method === 'DELETE'
        const request = terminating ? undefined : (JSON.parse(String(init.body)) as { method: string })
        if (!terminating && request?.method !== 'tools/call') return protocol.fetch(url, init)
        const pending = Promise.withResolvers<Response>()
        const onAbort = (): void => {
          if (terminating) deleteAborted.resolve()
          pending.reject(init.signal?.reason)
        }
        init.signal?.addEventListener('abort', onAbort, { once: true })
        if (init.signal?.aborted) onAbort()
        if (terminating) {
          deletes++
          deleteStarted.resolve()
        } else toolStarted.resolve()
        try {
          return await pending.promise
        } finally {
          init.signal?.removeEventListener('abort', onAbort)
        }
      }
    })
    const server = await bounded.createAdmin(admin, { ...input(), groupIds: [20] })
    const lease = await bounded.openForUser(owner.id, { serverIds: [server.id] })
    leases.push(lease)
    await lease.inspectCatalog(server.id)
    const invocation = lease.clients[0]!.callTool('web_search', {}).catch((error: unknown) => error)
    await toolStarted.promise
    const firstClose = lease.close()
    const secondClose = lease.close()
    expect(secondClose).toBe(firstClose)
    expect(await invocation).toHaveProperty('name', 'AbortError')
    await deleteStarted.promise
    await deleteAborted.promise
    await Promise.all([firstClose, secondClose])
    expect(deletes).toBe(1)
    await expect(lease.clients[0]!.callTool('web_search', {})).rejects.toHaveProperty('code', 'EXTERNAL_MCP_ACCESS_DENIED')
    expect(deletes).toBe(1)
  })
})

describe('external MCP untrusted endpoint boundary', () => {
  it.each([
    'http://public.example.com/mcp',
    'https://localhost/mcp',
    'https://metadata.internal/mcp',
    'https://169.254.169.254/mcp',
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://[::ffff:93.184.216.34]/mcp',
    'https://[fc00::1]/mcp',
    'https://[fe80::1]/mcp',
    'https://user:password@public.example.com/mcp',
    'https://public.example.com:8443/mcp',
    'https://public.example.com/mcp?token=secret'
  ])('rejects prohibited endpoint %s before any network', endpoint => {
    expect(() => normalizeExternalMcpEndpoint(endpoint)).toThrow()
  })

  it.each(['10.0.0.1', '169.254.169.254', '::ffff:93.184.216.34', 'fd00::1', 'fe80::1'])('rejects DNS answer %s without calling HTTP', async address => {
    let dispatched = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      fetch: async () => {
        dispatched = true
        return Response.json({})
      }
    })
    try {
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_EGRESS_DENIED' })
      expect(dispatched).toBe(false)
    } finally {
      await guard.close()
    }
  })

  it('pins and revalidates DNS at the actual Undici connection, rejecting a public-to-private rebind', async () => {
    let resolutions = 0
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://rebind.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: async () => [{ address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
    })
    try {
      await expect(guard.fetch('https://rebind.example.com/mcp', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 502 })
      expect(resolutions).toBe(2)
    } finally {
      await guard.close()
    }
  })

  it('denies redirects without following them or crossing bearer credentials and denies arbitrary headers', async () => {
    let calls = 0,
      cancelled = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => 'test-private-bearer',
      resolve: publicResolver,
      fetch: async (url, init) => {
        calls++
        expect(url.href).toBe('https://public.example.com/mcp')
        expect(init.redirect).toBe('manual')
        expect(init.credentials).toBe('omit')
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-private-bearer')
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            }
          }),
          { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }
        )
      }
    })
    try {
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_REDIRECT_DENIED' })
      expect(calls).toBe(1)
      expect(cancelled).toBe(true)
      await expect(
        guard.fetch('https://public.example.com/mcp', { headers: { cookie: 'wiki-session', authorization: 'stolen-credential' } })
      ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_EGRESS_DENIED' })
      await expect(guard.fetch('https://elsewhere.example.com/mcp')).rejects.toMatchObject({ code: 'EXTERNAL_MCP_EGRESS_DENIED' })
      expect(calls).toBe(1)
    } finally {
      await guard.close()
    }
  })

  it('bounds request and streaming response bytes, and closes/cancels an outstanding body', async () => {
    let calls = 0,
      cancelled = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: publicResolver,
      fetch: async () => {
        calls++
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(EXTERNAL_MCP_LIMITS.responseBytes + 1))
            },
            cancel() {
              cancelled = true
            }
          })
        )
      }
    })
    try {
      await expect(
        guard.fetch('https://public.example.com/mcp', { method: 'POST', body: 'x'.repeat(EXTERNAL_MCP_LIMITS.requestBytes + 1) })
      ).rejects.toMatchObject({ code: 'EXTERNAL_MCP_REQUEST_TOO_LARGE' })
      expect(calls).toBe(0)
      const response = await guard.fetch('https://public.example.com/mcp')
      await expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'EXTERNAL_MCP_RESPONSE_TOO_LARGE' })
      expect(cancelled).toBe(true)
      await guard.close()
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toHaveProperty('name', 'AbortError')
      expect(calls).toBe(1)
    } finally {
      await guard.close()
    }
  })

  it('bounds byte-limit rejection and local close when a response body never acknowledges cancellation', async () => {
    const cancellationStarted = Promise.withResolvers<void>()
    const cancellationFinished = Promise.withResolvers<void>()
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: publicResolver,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(EXTERNAL_MCP_LIMITS.responseBytes + 1))
            },
            cancel() {
              cancellationStarted.resolve()
              return cancellationFinished.promise
            }
          })
        )
    })
    try {
      const response = await guard.fetch('https://public.example.com/mcp')
      const rejection = response.arrayBuffer().catch((error: unknown) => error)
      await cancellationStarted.promise
      const closing = guard.close()
      expect(await rejection).toHaveProperty('code', 'EXTERNAL_MCP_RESPONSE_TOO_LARGE')
      await closing
      await expect(guard.fetch('https://public.example.com/mcp')).rejects.toHaveProperty('name', 'AbortError')
    } finally {
      cancellationFinished.resolve()
      await guard.close()
    }
  })

  it('propagates caller cancellation during DNS without dispatching a request', async () => {
    const controller = new AbortController()
    let dispatched = false
    const resolving = Promise.withResolvers<void>()
    const unresolved = Promise.withResolvers<readonly { address: string; family: number }[]>()
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      signal: controller.signal,
      authorize: async () => {},
      credential: async () => null,
      resolve: async () => {
        resolving.resolve()
        return unresolved.promise
      },
      fetch: async () => {
        dispatched = true
        return Response.json({})
      }
    })
    try {
      const pending = guard.fetch('https://public.example.com/mcp')
      await resolving.promise
      controller.abort(new DOMException('User cancelled', 'AbortError'))
      await expect(pending).rejects.toHaveProperty('name', 'AbortError')
      expect(dispatched).toBe(false)
    } finally {
      unresolved.resolve([{ address: '93.184.216.34', family: 4 }])
      await guard.close()
    }
  })

  it('enforces the request deadline even when DNS never finishes', async () => {
    vi.useFakeTimers()
    const resolving = Promise.withResolvers<void>()
    const unresolved = Promise.withResolvers<readonly { address: string; family: number }[]>()
    let dispatched = false
    const guard = createExternalMcpEndpointGuard({
      endpointUrl: 'https://public.example.com/mcp',
      authorize: async () => {},
      credential: async () => null,
      resolve: async () => {
        resolving.resolve()
        return unresolved.promise
      },
      fetch: async () => {
        dispatched = true
        return Response.json({})
      }
    })
    try {
      const pending = guard.fetch('https://public.example.com/mcp')
      const rejection = pending.catch((error: unknown) => error)
      await resolving.promise
      await vi.advanceTimersByTimeAsync(EXTERNAL_MCP_LIMITS.timeoutMs)
      expect(await rejection).toHaveProperty('code', 'EXTERNAL_MCP_TIMEOUT')
      expect(dispatched).toBe(false)
    } finally {
      unresolved.resolve([{ address: '93.184.216.34', family: 4 }])
      await guard.close()
      vi.useRealTimers()
    }
  })
})
