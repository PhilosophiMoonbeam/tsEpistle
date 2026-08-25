/** @vitest-environment node */
import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import express from 'express'
import createKnex, { type Knex } from 'knex'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWikiMcpController } from '../../agents/mcp.ts'
import { decideProposal } from '../../agents/proposals/execution.ts'

const key = Buffer.alloc(32, 7)

const apiPrincipal = (): Express.User => ({
  id: 90,
  permissions: ['use:mcp', 'read:pages', 'read:history', 'write:pages', 'delete:pages'],
  groups: [3],
  ownershipUserId: null
})
const humanPrincipal = (): Express.User => ({
  id: 7,
  permissions: ['read:pages', 'read:history', 'write:pages', 'delete:pages'],
  groups: [3],
  ownershipUserId: 7
})
const postInitialize = (port: number, headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const request = httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/mcp',
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...headers
    }
  }, response => {
    response.resume()
    resolve(response.statusCode ?? 0)
  })
  request.on('error', reject)
  request.end(body)
})

const createProposalTables = async (db: Knex): Promise<void> => {
  await db.schema.createTable('agentProposals', table => {
    table.uuid('id').primary()
    table.string('sourceKind').notNullable()
    table.uuid('runId').nullable()
    table.uuid('sessionId').nullable()
    table.integer('requesterUserId').nullable()
    table.integer('requesterApiKeyId').nullable()
    table.uuid('requesterRequestId').notNullable()
    table.string('actionCallId').notNullable()
    table.string('actionName').notNullable()
    table.string('risk').notNullable()
    table.text('summary').notNullable()
    table.string('status').notNullable()
    table.text('input').nullable()
    table.string('inputHash').notNullable()
    table.integer('authorityVersion').notNullable()
    table.string('authoritySha256').notNullable()
    table.integer('pageId').nullable()
    table.bigInteger('baseSourceRevision').nullable()
    for (const name of ['baseLineEnding', 'baseRawSha256', 'baseCanonicalSha256', 'disclosedRangesSha256', 'patchFormat', 'patchSha256', 'resultRawSha256', 'resultCanonicalSha256', 'diffSha256'] as const) table.string(name).nullable()
    table.boolean('baseFinalNewline').nullable()
    table.integer('patchEngineVersion').nullable()
    table.text('patch').nullable()
    table.text('operation').notNullable()
    table.string('operationSha256').notNullable()
    table.integer('diffRendererVersion').nullable()
    table.text('diff').nullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('appliedAt').nullable()
    table.dateTime('contentPurgedAt').nullable()
    table.text('applyResult').nullable()
    table.unique(['runId', 'actionCallId'])
  })
  await db.schema.createTable('agentApprovals', table => {
    table.uuid('id').primary()
    table.uuid('proposalId').notNullable().unique()
    table.uuid('runId').nullable()
    table.integer('requesterUserId').nullable()
    table.integer('requesterApiKeyId').nullable()
    table.string('status').notNullable()
    table.string('inputHash').notNullable()
    table.integer('authorityVersion').notNullable()
    table.string('authoritySha256').notNullable()
    table.string('patchSha256').nullable()
    table.string('resultCanonicalSha256').nullable()
    table.string('diffSha256').nullable()
    table.string('operationSha256').notNullable()
    table.dateTime('requestedAt').notNullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('decidedAt').nullable()
    table.integer('approvedByUserId').nullable()
    table.text('decisionNote').nullable()
  })
  await db.schema.createTable('agentActionExecutions', table => {
    table.uuid('id').primary()
    table.uuid('proposalId').notNullable().unique()
    table.uuid('runId').nullable()
    table.string('actionName').notNullable()
    table.integer('requesterUserId').nullable()
    table.integer('requesterApiKeyId').nullable()
    table.integer('approvedByUserId').notNullable()
    table.string('idempotencyKey').notNullable().unique()
    table.uuid('leaseToken').nullable()
    table.string('status').notNullable()
    table.string('inputHash').notNullable()
    table.dateTime('startedAt').notNullable()
    table.dateTime('completedAt').nullable()
    table.text('result').nullable()
    table.text('error').nullable()
  })
}


describe('Wiki MCP transport', () => {
  let db: Knex
  let server: ReturnType<express.Express['listen']>
  let client: Client | undefined
  let movePage: ReturnType<typeof vi.fn>
  let authorizeMutation: ReturnType<typeof vi.fn>
  let listRelated: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createProposalTables(db)
    movePage = vi.fn(async () => ({}))
    authorizeMutation = vi.fn(async () => {})
    listRelated = vi.fn(async input => Number(input.offset) === 0
      ? {
          pages: [{
            id: 43,
            path: 'docs/next',
            localeCode: 'en',
            title: 'Next',
            description: '',
            contentType: 'markdown',
            sourceRevision: '9',
            updatedAt: new Date('2026-08-25T00:00:00.000Z'),
            tags: [],
            distance: 1,
            direction: 'outgoing',
            viaPageId: 42
          }],
          truncated: true,
          nextOffset: 1
        }
      : { pages: [], truncated: false, nextOffset: null })
    const app = express()
    const mcpController = createWikiMcpController({
      knex: db,
      operations: {
        search: vi.fn(),
        searchTags: vi.fn(),
        listTags: vi.fn(),
        discover: vi.fn(),
        get: vi.fn(async () => ({ id: 42, path: 'docs/start', locale: 'en', title: 'Start', description: '', content: '# Start\n', contentType: 'markdown', sourceRevision: '8' })),
        getByPath: vi.fn(async () => ({ id: 42, path: 'docs/next', locale: 'en', title: 'Start', description: '', content: '# Start\n', contentType: 'markdown', sourceRevision: '9' })),
        listRecent: vi.fn(),
        getHistory: vi.fn(),
        getVersion: vi.fn(),
        listLinks: vi.fn(),
        listRelated,
        create: vi.fn(),
        update: vi.fn(),
        move: movePage,
        restore: vi.fn(),
        remove: vi.fn(),
        authorizeMutation
      },
      authenticate: (req, _res, next) => {
        const user = apiPrincipal()
        Reflect.set(req, 'user', user)
        Reflect.set(req, 'authContext', { kind: 'apiKey', apiKeyId: 9, groupId: 3, ownershipUserId: null, principal: user })
        Reflect.set(req, 'apiKeyAuth', {
          apiKeyId: 9,
          groupId: 3,
          mcpResource: 'http://127.0.0.1/mcp',
          mcpResourceVersion: 1,
          bearerToken: 'test-api-token'
        })
        next()
      },
      resolvePrincipal: async () => apiPrincipal(),
      resolveUser: async () => humanPrincipal(),
      config: {
        enabled: true,
        wikiPublicOrigin: 'http://127.0.0.1',
        agentsEnabled: true,
        skillsEnabled: true,
        proposalsEnabled: true,
        writesEnabled: true,
        writeCreateEnabled: true,
        writePatchEnabled: true,
        writeMoveEnabled: true,
        writeRestoreEnabled: true,
        writeDeleteEnabled: true,
        requestStateKeys: [key],
        snapshotSigningSecret: Buffer.alloc(32, 8)
      }
    })
    app.all('/mcp', mcpController)
    app.get('/health', (_req, res) => res.sendStatus(204))
    server = app.listen(0, '127.0.0.1')
    const listening = Promise.withResolvers<void>()
    server.once('listening', listening.resolve)
    await listening.promise
  })

  afterEach(async () => {
    await client?.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await db.destroy()
  })

  it('leaves non-MCP routes to the ordinary Wiki application', async () => {
    const port = (server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(204)
  })

  it('negotiates with the official modern client and advertises the admitted catalog', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client({ name: 'wiki-mcp-test', version: '1.0.0' }, {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' }
    })
    await client.connect(transport)
    const listed = await client.listTools()
    const names = listed.tools.map(tool => tool.name)
    expect(names).toContain('wiki_search_pages')
    expect(names).toContain('wiki_search_tags')
    expect(names).toContain('wiki_list_tags')
    expect(names).toContain('wiki_discover_pages')
    expect(names).toContain('wiki_get_related_pages')
    expect(names).toContain('wiki_read_skill')
    expect(names).toContain('wiki_prepare_page_patch')
    expect(names).toContain('wiki_apply_page_proposal')
    expect(names).not.toContain('browser_navigate')
    expect(new Set(names).size).toBe(names.length)

    await client.close()
    const legacyTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client({ name: 'wiki-mcp-legacy-test', version: '1.0.0' }, {
      capabilities: {},
      versionNegotiation: { mode: 'legacy' }
    })
    await client.connect(legacyTransport)
    const legacyNames = (await client.listTools()).tools.map(tool => tool.name)
    expect(legacyNames).toContain('wiki_prepare_page_patch')
    expect(legacyNames).not.toContain('wiki_apply_page_proposal')
  })

  it('continues related-page traversal across independent MCP requests', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client({ name: 'wiki-mcp-related-test', version: '1.0.0' }, {
      capabilities: {},
      versionNegotiation: { mode: 'auto' }
    })
    await client.connect(transport)
    const first = await client.callTool({
      name: 'wiki_get_related_pages',
      arguments: { pageId: 42, limit: 1, cursor: null }
    })
    const firstResult = JSON.parse(String(Reflect.get(first.content[0] ?? {}, 'text'))) as { pages: unknown[]; nextCursor: string | null }
    expect(firstResult).toMatchObject({ pages: [expect.objectContaining({ id: 43 })], nextCursor: expect.any(String) })
    const second = await client.callTool({
      name: 'wiki_get_related_pages',
      arguments: { pageId: 42, limit: 1, cursor: firstResult.nextCursor }
    })
    expect(JSON.parse(String(Reflect.get(second.content[0] ?? {}, 'text')))).toEqual({ pages: [], nextCursor: null })
    expect(listRelated).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }))
    expect(listRelated).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 1 }))
  })

  it('prepares and applies a proposal with API-key and live human authority', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client({ name: 'wiki-mcp-write-test', version: '1.0.0' }, {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false }
    })
    await client.connect(transport)
    const prepared = await client.callTool({
      name: 'wiki_prepare_page_move',
      arguments: {
        requestId: '00000000-0000-4000-8000-000000000099',
        pageId: 42,
        sourceRevision: '8',
        destinationPath: 'docs/next',
        destinationLocale: 'en'
      }
    })
    const preparedText = Reflect.get(prepared.content[0] ?? {}, 'text')
    expect(typeof preparedText).toBe('string')
    const proposalResult = JSON.parse(String(preparedText)) as { proposalId: string; approvalId: string; status: string }
    expect(proposalResult.status).toBe('pending')
    const pendingApply = await client.callTool({
      name: 'wiki_apply_page_proposal',
      arguments: {
        proposalId: proposalResult.proposalId,
        approvalId: proposalResult.approvalId
      }
    }, { allowInputRequired: true })
    expect(pendingApply).toMatchObject({ resultType: 'input_required', requestState: expect.stringMatching(/^v1\./) })

    await client.close()
    const retryTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client({ name: 'wiki-mcp-approval-retry-test', version: '1.0.0' }, {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' }
    })
    client.setRequestHandler('elicitation/create', async () => {
      await decideProposal(db, {
        proposalId: proposalResult.proposalId,
        approvalId: proposalResult.approvalId,
        userId: 7,
        decision: 'approved',
        authorize: async () => undefined
      })
      return { action: 'accept', content: { acknowledge: true } }
    })
    await client.connect(retryTransport)

    const applied = await client.callTool({
      name: 'wiki_apply_page_proposal',
      arguments: {
        proposalId: proposalResult.proposalId,
        approvalId: proposalResult.approvalId
      }
    })
    const appliedText = Reflect.get(applied.content[0] ?? {}, 'text')
    expect(JSON.parse(String(appliedText))).toMatchObject({ proposalId: proposalResult.proposalId, status: 'applied' })
    expect(movePage).toHaveBeenCalledOnce()
    expect(movePage).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ id: 42, destinationPath: 'docs/next' }),
      requester: expect.objectContaining({ id: 7 })
    }))
    expect(authorizeMutation.mock.calls.map(call => call[0].requester.id)).toEqual([90, 7, 90, 7])
  })

  it('rejects wrong Host and Origin values before authentication', async () => {
    const port = (server.address() as AddressInfo).port
    expect(await postInitialize(port, { host: 'wiki.example.test' })).toBe(403)
    expect(await postInitialize(port, { host: '127.0.0.1', origin: 'https://wiki.example.test' })).toBe(403)
  })
})
