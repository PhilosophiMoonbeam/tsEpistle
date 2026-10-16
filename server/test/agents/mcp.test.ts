import type { AddressInfo } from 'node:net'
import { request as httpRequest } from 'node:http'
import express, { type RequestHandler } from 'express'
import createKnex, { type Knex } from 'knex'
import { Client, CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from '../bun-test.mts'

import { createWikiMcpController } from '../../agents/mcp.ts'
import type { WikiLineSnapshotV1 } from '../../agents/patch/wiki-line-patch.ts'
import { decideProposal } from '../../agents/proposals/execution.ts'
import { up as createKnowledgeProjectionStore } from '../../db/migrations/2.5.152.ts'
import { up as createKnowledgeSearchStore } from '../../db/migrations/tsepistle-000027-knowledge-search.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { knowledgeSearchText, projectPageKnowledge } from '../../knowledge/projection.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import errors from '../../helpers/error.ts'
import { OKF_PRODUCER_CONTEXT } from '../../okf/mutation-context.ts'

const key = Buffer.alloc(32, 7)
const writeToolNames = [
  'wiki_prepare_page_create',
  'wiki_prepare_page_patch',
  'wiki_prepare_page_move',
  'wiki_prepare_page_restore',
  'wiki_prepare_page_delete',
  'wiki_apply_page_proposal'
] as const
const validOkfMetadata = {
  type: 'Reference',
  status: 'stable' as const,
  generated: { by: 'mcp:fixture', at: '2026-08-24T00:00:00.000Z' },
  verified: { by: 'human:7', at: '2026-08-25T00:00:00.000Z' },
  'x-fixture': { retained: true },
  'x-wiki': { namespace: 'docs' }
}
const validOkfExtra = { okf: validOkfMetadata }
const publicPage = {
  id: 42,
  authorId: 7,
  path: 'docs/start',
  locale: 'en',
  title: 'Start',
  description: 'Projected knowledge summary',
  content: '# Start\n',
  contentType: 'markdown',
  sourceRevision: '8',
  updatedAt: '2026-08-25T00:00:00.000Z',
  visibility: 'public' as const,
  tags: [],
  extra: validOkfExtra
}

const apiPrincipal = (apiKeyId = 9, groupId = 3): Express.User =>
  createApiPrincipal(apiKeyId, groupId, ['use:mcp', 'read:pages', 'read:history', 'write:pages', 'delete:pages'])
const humanPrincipal = (): Express.User => ({
  id: 7,
  permissions: ['read:pages', 'read:history', 'write:pages', 'delete:pages'],
  groups: [3],
  ownershipUserId: 7
})
const postInitialize = (port: number, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const request = httpRequest(
      {
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
      },
      response => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )
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
    for (const name of [
      'baseLineEnding',
      'baseRawSha256',
      'baseCanonicalSha256',
      'disclosedRangesSha256',
      'patchFormat',
      'patchSha256',
      'resultRawSha256',
      'resultCanonicalSha256',
      'diffSha256'
    ] as const)
      table.string(name).nullable()
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
  type ActiveApiKey = {
    readonly apiKeyId: number
    readonly groupId: number
    readonly bearerToken: string
  }

  let db: Knex
  let server: ReturnType<express.Express['listen']>
  let client: Client | undefined
  let getPage: Mock<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>
  let getPageByPath: Mock<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>
  let createPage: Mock<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>
  let removePage: Mock<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>
  let movePage: ReturnType<typeof vi.fn>
  let authorizeMutation: ReturnType<typeof vi.fn>
  let listRelated: ReturnType<typeof vi.fn>
  let activeApiKey: ActiveApiKey | null
  let personalMcpAccess: 'read-only' | 'read-write' | undefined
  let requesterPermissions: string[] | undefined
  let skillsEnabled: boolean
  let approver: Express.User | null
  let authenticate: RequestHandler
  const postModernTool = async (params: Record<string, unknown>, capabilities: unknown = { elicitation: { form: {} } }) => {
    const port = (server.address() as AddressInfo).port
    const protocolVersion = client?.getNegotiatedProtocolVersion()
    if (protocolVersion === undefined || client?.getProtocolEra() !== 'modern') throw new Error('Manual continuation requires a connected modern client')
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'MCP-Protocol-Version': protocolVersion,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': String(params.name),
        authorization: `Bearer ${activeApiKey?.bearerToken ?? 'test-api-token'}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'manual-continuation',
        method: 'tools/call',
        params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: protocolVersion, [CLIENT_CAPABILITIES_META_KEY]: capabilities } }
      })
    })
    return (await response.json()) as {
      result?: { resultType?: string; requestState?: string; isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] }
      error?: { code: number; message: string }
    }
  }
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createProposalTables(db)
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.bigInteger('sourceRevision').notNullable()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.string('visibility').notNullable()
      table.boolean('isSearchable').notNullable()
      table.string('contentType').notNullable()
      table.text('content').notNullable()
      table.string('title').notNullable()
      table.string('description').notNullable()
      table.integer('authorId').notNullable()
      table.text('extra').notNullable()
      table.integer('ownerId').nullable()
      table.dateTime('updatedAt').notNullable()
    })
    const { locale, tags, extra, ...storedPage } = publicPage
    await db('pages').insert({
      ...storedPage,
      localeCode: locale,
      isSearchable: true,
      ownerId: null,
      extra: canonicalJson(extra)
    })
    await db.schema.createTable('tags', table => {
      table.integer('id').primary()
      table.string('tag').notNullable()
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable()
      table.integer('tagId').notNullable()
      table.primary(['pageId', 'tagId'])
    })
    await createKnowledgeProjectionStore(db)
    await createKnowledgeSearchStore(db)
    const projection = projectPageKnowledge({
      pageId: publicPage.id,
      sourceRevision: publicPage.sourceRevision,
      locale,
      path: publicPage.path,
      visibility: publicPage.visibility,
      contentType: publicPage.contentType,
      content: publicPage.content,
      title: publicPage.title,
      description: publicPage.description,
      tags,
      updatedAt: publicPage.updatedAt,
      authorId: publicPage.authorId,
      metadata: validOkfMetadata
    })
    await db('pageKnowledgeProjections').insert({
      pageId: 42,
      sourceRevision: '8',
      sourceSha256: projection.source.sha256,
      schemaVersion: projection.version,
      deterministicVersion: projection.provenance.deterministicVersion,
      state: projection.completeness.state,
      enrichmentState: 'unavailable',
      conceptType: projection.concept.type,
      summary: projection.concept.summary,
      searchText: knowledgeSearchText(projection),
      lifecycleStatus: projection.lifecycle.status,
      trustTier: projection.lifecycle.trustTier,
      verification: projection.lifecycle.verification,
      staleAfter: null,
      projection: canonicalJson(projection)
    })
    movePage = vi.fn(async () => ({}))
    createPage = vi.fn(async () => ({}))
    removePage = vi.fn(async () => ({}))
    activeApiKey = { apiKeyId: 9, groupId: 3, bearerToken: 'test-api-token' }
    personalMcpAccess = undefined
    requesterPermissions = undefined
    skillsEnabled = true
    approver = humanPrincipal()
    authorizeMutation = vi.fn(async () => {})
    listRelated = vi.fn(async input => {
      const pages = [
        {
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
        },
        {
          id: 44,
          path: 'docs/following',
          localeCode: 'en',
          title: 'Following',
          description: '',
          contentType: 'markdown',
          sourceRevision: '10',
          updatedAt: new Date('2026-08-26T00:00:00.000Z'),
          tags: [],
          distance: 2,
          direction: 'outgoing',
          viaPageId: 43
        }
      ]
      const offset = Number(input.offset)
      const page = pages[offset]
      return page
        ? { pages: [page], truncated: offset + 1 < pages.length, nextOffset: offset + 1 < pages.length ? offset + 1 : null }
        : { pages: [], truncated: false, nextOffset: null }
    })
    getPage = vi.fn(async input => {
      const id = Number(input.id)
      const page =
        id === 43
          ? { id: 43, path: 'docs/next', title: 'Next', content: '# Next\n', sourceRevision: '9', updatedAt: '2026-08-25T00:00:00.000Z' }
          : id === 44
            ? { id: 44, path: 'docs/following', title: 'Following', content: '# Following\n', sourceRevision: '10', updatedAt: '2026-08-26T00:00:00.000Z' }
            : publicPage
      return {
        ...publicPage,
        description: '',
        ...page
      }
    })
    getPageByPath = vi.fn(async input => {
      if (input.path !== publicPage.path || input.locale !== publicPage.locale || input.visibility !== publicPage.visibility) throw new errors.PageNotFound()
      return publicPage
    })
    const app = express()
    const principalFor = (apiKeyId: number, groupId: number): Express.User => {
      const principal = { ...apiPrincipal(apiKeyId, groupId), ...(requesterPermissions === undefined ? {} : { permissions: requesterPermissions }) }
      return personalMcpAccess === undefined
        ? principal
        : { ...principal, personalMcpAccess, ownershipUserId: 7, permissions: [...principal.permissions!, 'manage:system'] }
    }
    authenticate = vi.fn((req, _res, next) => {
      if (activeApiKey === null) {
        Reflect.set(req, 'authContext', { kind: 'guest', userId: 2, ownershipUserId: null, principal: null })
        next()
        return
      }
      const user = principalFor(activeApiKey.apiKeyId, activeApiKey.groupId)
      Reflect.set(req, 'user', user)
      Reflect.set(req, 'authContext', {
        kind: 'apiKey',
        apiKeyId: activeApiKey.apiKeyId,
        groupId: activeApiKey.groupId,
        ownershipUserId: null,
        principal: user
      })
      Reflect.set(req, 'apiKeyAuth', {
        apiKeyId: activeApiKey.apiKeyId,
        groupId: activeApiKey.groupId,
        mcpResource: 'http://127.0.0.1/mcp',
        mcpResourceVersion: 1,
        bearerToken: activeApiKey.bearerToken
      })
      next()
    })
    const mcpController = createWikiMcpController({
      knex: db,
      operations: {
        search: vi.fn(),
        searchTags: vi.fn(),
        listTags: vi.fn(),
        discover: vi.fn(),
        get: getPage,
        getByPath: getPageByPath,
        getHistory: vi.fn(),
        getVersion: vi.fn(async input => ({
          id: 42,
          versionId: Number(input.versionId),
          authorId: 7,
          path: 'docs/start',
          locale: 'en',
          title: 'Start historical',
          description: '',
          content: '# Start historical\n',
          contentType: 'markdown',
          sourceRevision: String(Number(input.versionId) + 7),
          updatedAt: '2026-08-25T00:00:00.000Z',
          visibility: 'public',
          tags: [],
          extra: validOkfExtra
        })),
        listRecent: vi.fn(),
        listLinks: vi.fn(),
        listRelated,
        create: createPage,
        update: vi.fn(),
        move: movePage,
        restore: vi.fn(),
        remove: removePage,
        authorizeMutation
      },
      resolvePrincipal: async (apiKeyId, groupId) => principalFor(apiKeyId, groupId),
      resolveUser: async () => approver as Express.User,
      config: {
        enabled: true,
        wikiPublicOrigin: 'http://127.0.0.1',
        agentsEnabled: true,
        get skillsEnabled() {
          return skillsEnabled
        },
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
    app.all('/mcp', authenticate, mcpController)
    server = app.listen(0, '127.0.0.1')
    const listening = Promise.withResolvers<void>()
    server.once('listening', listening.resolve)
    await listening.promise
  })

  afterEach(async () => {
    await client?.close()
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    await db.destroy()
  })

  it.each(['explicit-form', 'implicit-form', 'both-modes', 'personal-read-write'] as const)('advertises all admitted writes for a modern %s continuation client', async mode => {
    if (mode === 'personal-read-write') personalMcpAccess = 'read-write'
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-test', version: '1.0.0' },
      {
        capabilities: { elicitation: mode === 'implicit-form' ? {} : mode === 'both-modes' ? { form: {}, url: {} } : { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
    await client.connect(transport)
    expect(authenticate).toHaveBeenCalledTimes(1)
    const listed = await client.listTools()
    const names = listed.tools.map(tool => tool.name)
    expect(names).toContain('wiki_search_pages')
    expect(names).toContain('wiki_search_tags')
    expect(names).toContain('wiki_list_tags')
    expect(names).toContain('wiki_discover_pages')
    expect(names).toContain('wiki_get_related_pages')
    expect(names).toContain('wiki_get_page_okf')
    expect(names).not.toContain('wiki_prepare_okf_import')
    expect(names).toContain('wiki_read_skill')
    for (const name of writeToolNames) expect(names).toContain(name)
    expect(names).not.toContain('wiki_browser_navigate')
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(['read-only', 'read-write'] as const)('admits an admin-only personal %s owner without escalating its key scope', async access => {
    personalMcpAccess = access
    requesterPermissions = ['manage:system']
    skillsEnabled = false
    const port = (server.address() as AddressInfo).port
    client = new Client(
      { name: 'wiki-mcp-personal-admin-test', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } }
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { authProvider: { token: async () => 'test-api-token' } })
    )
    const names = (await client.listTools()).tools.map(tool => tool.name)
    expect(names).toContain('wiki_get_page')
    expect(names).toContain('wiki_get_page_okf')
    for (const name of writeToolNames) {
      expect(names.includes(name)).toBe(access === 'read-write')
    }
    expect(await client.callTool({ name: 'wiki_get_page', arguments: { id: 42 } })).toMatchObject({
      structuredContent: { id: 42, sourceRevision: '8' }
    })
    expect(await client.readResource({ uri: 'wiki://pages/42/versions/current/revisions/8/okf' })).toMatchObject({
      contents: [expect.objectContaining({ text: expect.stringContaining('# Start') })]
    })
    const prepare = {
      name: 'wiki_prepare_page_move',
      arguments: {
        requestId: '00000000-0000-4000-8000-000000000114',
        pageId: 42,
        sourceRevision: '8',
        destinationPath: 'docs/next',
        destinationLocale: 'en'
      }
    }
    if (access === 'read-write') {
      const prepared = await client.callTool(prepare)
      expect(prepared.isError).not.toBe(true)
      expect(prepared.structuredContent).toMatchObject({ status: 'pending' })
      expect(await db('agentProposals')).toEqual([
        expect.objectContaining({ requesterApiKeyId: 9, requesterUserId: null, status: 'pending' })
      ])
    } else {
      const denied = await client.callTool(prepare).catch((error: unknown) => error)
      expect(denied).toBeInstanceOf(Error)
      expect((denied as Error).message).toContain('not found')
      expect(await db('agentProposals')).toEqual([])
    }
    expect(await db('agentActionExecutions')).toEqual([])
    expect(movePage).not.toHaveBeenCalled()
  })

  it.each(['modern-use-only', 'legacy-use-only', 'modern-service-admin', 'legacy-service-admin'] as const)(
    'serves an empty readable MCP catalog without escalating %s credentials',
    async mode => {
      requesterPermissions = [mode.endsWith('service-admin') ? 'manage:system' : 'use:mcp']
      skillsEnabled = false
      const port = (server.address() as AddressInfo).port
      client = new Client(
        { name: 'wiki-mcp-empty-catalog-test', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: mode.startsWith('legacy') ? 'legacy' : 'auto' } }
      )
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { authProvider: { token: async () => 'test-api-token' } })
      )
      expect(await client.listTools()).toMatchObject({ tools: [] })
      expect(await client.listResources()).toMatchObject({ resources: [] })
      expect(await client.listResourceTemplates()).toMatchObject({ resourceTemplates: [] })
      const deniedTool = await client.callTool({ name: 'wiki_get_page', arguments: { id: 42 } }).catch((error: unknown) => error)
      expect(deniedTool).toBeInstanceOf(Error)
      expect((deniedTool as Error).message).toContain('not found')
      const deniedResource = await client
        .readResource({ uri: 'wiki://pages/42/versions/current/revisions/8/okf' })
        .catch((error: unknown) => error)
      expect(deniedResource).toBeInstanceOf(Error)
      expect((deniedResource as Error).message).toContain('not found')
      expect(getPage).not.toHaveBeenCalled()
      expect(await db('agentProposals')).toEqual([])
      expect(await db('agentActionExecutions')).toEqual([])
    }
  )

  it.each(['modern-none', 'modern-url-only', 'modern-forged-hint', 'legacy-none', 'legacy-form', 'personal-read-only'] as const)(
    'keeps reads and resources but neither advertises nor executes writes for %s',
    async mode => {
      const legacy = mode.startsWith('legacy')
      if (mode === 'personal-read-only') personalMcpAccess = 'read-only'
      const port = (server.address() as AddressInfo).port
      client = new Client(
        // A capable-sounding client name is not an authorization signal.
        { name: 'wiki-mcp-form-input-required-client', version: '999.0.0' },
        {
          capabilities:
            mode === 'modern-url-only'
              ? { elicitation: { url: {} } }
              : mode === 'legacy-form' || mode === 'personal-read-only'
                ? { elicitation: { form: {} } }
                : mode === 'modern-forged-hint'
                  ? { experimental: { inputRequired: {}, 'wiki/approvalContinuation': { supported: true } } }
                  : {},
          versionNegotiation: { mode: legacy ? 'legacy' : 'auto' }
        }
      )
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { authProvider: { token: async () => 'test-api-token' } })
      )
      expect(client.getProtocolEra()).toBe(legacy ? 'legacy' : 'modern')
      const names = (await client.listTools()).tools.map(tool => tool.name)
      for (const name of writeToolNames) expect(names).not.toContain(name)
      expect(names).toContain('wiki_get_page')
      expect(names).toContain('wiki_read_page_for_patch')
      expect(names).toContain('wiki_read_skill')
      const read = await client.callTool({ name: 'wiki_get_page_okf', arguments: { id: 42 } })
      expect(read.isError).not.toBe(true)
      expect(await client.readResource({ uri: 'wiki://pages/42/versions/current/revisions/8/okf' })).toMatchObject({
        contents: [expect.objectContaining({ uri: 'wiki://pages/42/versions/current/revisions/8/okf', text: expect.stringContaining('# Start') })]
      })
      expect(await client.listResourceTemplates()).toMatchObject({
        resourceTemplates: expect.arrayContaining([expect.objectContaining({ uriTemplate: 'wiki://skills/{name}/{version}/{+path}' })])
      })
      const patchRead = await client.callTool({ name: 'wiki_read_page_for_patch', arguments: { pageId: 42, previousSnapshotToken: null } })
      expect(patchRead.isError).not.toBe(true)
      const snapshot = patchRead.structuredContent as unknown as WikiLineSnapshotV1
      const line = snapshot.disclosed[0]!.lines[0]!
      const requestId = '00000000-0000-4000-8000-000000000110'
      const calls = [
        {
          name: 'wiki_prepare_page_create',
          arguments: { requestId, path: 'docs/new', locale: 'en', title: 'New', description: '', content: '# New\n', contentType: 'markdown' }
        },
        {
          name: 'wiki_prepare_page_patch',
          arguments: {
            requestId,
            patch: {
              version: 'wiki-line-patch-v1',
              snapshotToken: snapshot.snapshotToken,
              baseDocumentTag: snapshot.documentTag,
              resultFinalNewline: snapshot.finalNewline,
              operations: [
                {
                  kind: 'replace',
                  range: { start: { line: line.number, tag: line.tag }, end: { line: line.number, tag: line.tag } },
                  lines: ['# Changed']
                }
              ]
            }
          }
        },
        {
          name: 'wiki_prepare_page_move',
          arguments: { requestId, pageId: 42, sourceRevision: '8', destinationPath: 'docs/next', destinationLocale: 'en' }
        },
        { name: 'wiki_prepare_page_restore', arguments: { requestId, pageId: 42, versionId: 1, sourceRevision: '8' } },
        { name: 'wiki_prepare_page_delete', arguments: { requestId, pageId: 42, sourceRevision: '8', confirmationPath: 'docs/start' } },
        {
          name: 'wiki_apply_page_proposal',
          arguments: { proposalId: '00000000-0000-4000-8000-000000000111', approvalId: '00000000-0000-4000-8000-000000000112' }
        }
      ]
      for (const call of calls) {
        const denied = await client.callTool(call).catch((error: unknown) => error)
        if (legacy || mode === 'personal-read-only') {
          expect(denied).toBeInstanceOf(Error)
          expect((denied as Error).message).toContain('not found')
        } else {
          expect(denied).toMatchObject({ isError: true })
          const content = Reflect.get(denied as object, 'content') as { text: string }[]
          expect(JSON.parse(content[0]!.text)).toMatchObject({ code: 'APPROVAL_CONTINUATION_REQUIRED' })
        }
      }
      expect(await db('agentProposals')).toEqual([])
      expect(await db('agentApprovals')).toEqual([])
      expect(await db('agentActionExecutions')).toEqual([])
      expect(authorizeMutation).not.toHaveBeenCalled()
      expect(createPage).not.toHaveBeenCalled()
      expect(movePage).not.toHaveBeenCalled()
      expect(removePage).not.toHaveBeenCalled()
    }
  )

  it('rejects modern requests when the protocol-version header is missing', async () => {
    const port = (server.address() as AddressInfo).port
    let omitProtocolVersion = false
    let missingHeaderResponse: { status: number; body: unknown } | undefined
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' },
      fetch: async (input, init) => {
        if (!omitProtocolVersion) return fetch(input, init)
        const headers = new Headers(init?.headers)
        headers.delete('MCP-Protocol-Version')
        const response = await fetch(input, { ...init, headers })
        missingHeaderResponse = { status: response.status, body: await response.clone().json() }
        return response
      }
    })
    client = new Client({ name: 'wiki-mcp-missing-version-header-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    await client.connect(transport)
    expect(client.getProtocolEra()).toBe('modern')

    omitProtocolVersion = true
    const result = await client.listTools().catch((error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect(missingHeaderResponse).toMatchObject({ status: 400, body: { error: { code: -32020 } } })
  })

  it('does not authenticate a rejected guest MCP request twice', async () => {
    authenticate.mockImplementation((req, _res, next) => {
      Reflect.set(req, 'authContext', { kind: 'guest', userId: 2, ownershipUserId: null, principal: null })
      next()
    })
    const port = (server.address() as AddressInfo).port

    expect(await postInitialize(port, { host: '127.0.0.1' })).toBe(401)
    expect(authenticate).toHaveBeenCalledOnce()
  })

  it('publishes visible pages through the OKF resource template', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-okf-test', version: '1.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' }
      }
    )
    await client.connect(transport)

    expect(await client.listResourceTemplates()).toMatchObject({
      resourceTemplates: expect.arrayContaining([
        expect.objectContaining({
          uriTemplate: 'wiki://pages/{pageId}/versions/{version}/revisions/{sourceRevision}/okf',
          mimeType: 'text/markdown'
        })
      ])
    })
    const pageResult = await client.callTool({ name: 'wiki_get_page', arguments: { path: 'docs/start', locale: 'en' } })
    expect(pageResult.isError).not.toBe(true)
    expect(pageResult.structuredContent).toMatchObject({
      id: 42,
      sourceRevision: '8',
      knowledge: { state: 'complete', conceptType: 'Reference', summary: 'Projected knowledge summary' },
      authority: {
        state: 'valid',
        metadata: validOkfMetadata,
        trust: {
          trustTier: 'human-reviewed',
          verification: 'current',
          status: 'stable',
          stale: false,
          generatedAt: '2026-08-24T00:00:00.000Z',
          verifiedAt: '2026-08-25T00:00:00.000Z'
        }
      },
      okfResourceUri: 'wiki://pages/42/versions/current/revisions/8/okf'
    })
    expect(pageResult.structuredContent).toMatchObject({
      citation: { evidenceId: 'page:42:revision:8', label: 'Start', href: '/en/docs/start' },
      citationSections: []
    })
    const okfResult = await client.callTool({ name: 'wiki_get_page_okf', arguments: { id: 42 } })
    expect(okfResult.isError).not.toBe(true)
    const okf = okfResult.structuredContent as {
      readonly document: string
      readonly resourceUri: string
      readonly sourceRevision: string
      readonly authority: unknown
      readonly knowledge: unknown
      readonly sha256: string
    }
    expect(okf).toMatchObject({
      pageId: 42,
      versionId: null,
      sourceRevision: '8',
      resourceUri: 'wiki://pages/42/versions/current/revisions/8/okf',
      conceptId: 'en/docs/start',
      filePath: 'en/docs/start.md',
      mediaType: 'text/markdown',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      authority: { state: 'valid', metadata: validOkfMetadata },
      knowledge: { state: 'complete', conceptType: 'Reference', summary: 'Projected knowledge summary' }
    })
    expect(okf.document).toContain('x-wiki:')
    expect(okf.document).toContain('state: complete')
    expect(okf.document).toContain('summary: Projected knowledge summary')
    const resource = await client.readResource({ uri: okf.resourceUri })
    expect(resource.contents).toHaveLength(1)
    const resourceContent = resource.contents[0]!
    expect(resourceContent).toMatchObject({
      uri: okf.resourceUri,
      mimeType: 'text/markdown',
      text: okf.document,
      _meta: {
        authority: okf.authority,
        knowledge: okf.knowledge,
        sha256: okf.sha256,
        pageId: 42,
        versionId: null,
        sourceRevision: '8',
        cacheScope: 'private',
        private: true,
        noCache: true
      }
    })
  })

  it('continues related-page traversal across independent MCP requests', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-related-test', version: '1.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' }
      }
    )
    await client.connect(transport)
    const first = await client.callTool({
      name: 'wiki_get_related_pages',
      arguments: { pageId: 42, limit: 1, cursor: null }
    })
    const firstResult = JSON.parse(String(Reflect.get(first.content[0] ?? {}, 'text'))) as { pages: Array<{ id?: unknown }>; nextCursor: string | null }
    expect(firstResult.pages).toEqual([expect.objectContaining({ id: 43, sourceRevision: '9', path: 'docs/next', locale: 'en' })])
    expect(typeof firstResult.nextCursor).toBe('string')
    const second = await client.callTool({
      name: 'wiki_get_related_pages',
      arguments: { pageId: 42, limit: 1, cursor: firstResult.nextCursor }
    })
    expect(JSON.parse(String(Reflect.get(second.content[0] ?? {}, 'text')))).toEqual({
      pages: [expect.objectContaining({ id: 44, sourceRevision: '10', path: 'docs/following', locale: 'en' })],
      nextCursor: null
    })
    expect(listRelated).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0 }))
    expect(listRelated).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 1 }))
  })

  it.each(['full', 'continued'] as const)('prepares a pending patch proposal from a %s snapshot across independent modern MCP requests', async mode => {
    const source = '# Start\n\nContext.\n\nKeep this section.\n\nReplicas: 17\n'
    getPage.mockResolvedValue({ ...publicPage, content: source })
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-patch-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
    await client.connect(transport)
    expect(client.getProtocolEra()).toBe('modern')

    const first = await client.callTool({
      name: 'wiki_read_page_for_patch',
      arguments: {
        pageId: 42,
        previousSnapshotToken: null,
        ...(mode === 'continued' ? { ranges: [{ startLine: 1, endLine: 1 }] } : {})
      }
    })
    expect(first.isError).not.toBe(true)
    let snapshot = first.structuredContent as unknown as WikiLineSnapshotV1
    if (mode === 'continued') {
      expect(snapshot.disclosed.map(range => [range.startLine, range.endLine])).toEqual([[1, 1]])
      const continued = await client.callTool({
        name: 'wiki_read_page_for_patch',
        arguments: {
          pageId: 42,
          ranges: [{ startLine: 7, endLine: 7 }],
          previousSnapshotToken: snapshot.snapshotToken
        }
      })
      expect(continued.isError).not.toBe(true)
      snapshot = continued.structuredContent as unknown as WikiLineSnapshotV1
      expect(snapshot.disclosed.map(range => [range.startLine, range.endLine])).toEqual([
        [1, 1],
        [7, 7]
      ])
    }
    const line = snapshot.disclosed.flatMap(range => range.lines).find(item => item.number === 7)!
    expect(line.text).toBe('Replicas: 17')
    const prepared = await client.callTool({
      name: 'wiki_prepare_page_patch',
      arguments: {
        requestId: '00000000-0000-4000-8000-000000000103',
        patch: {
          version: 'wiki-line-patch-v1',
          snapshotToken: snapshot.snapshotToken,
          baseDocumentTag: snapshot.documentTag,
          resultFinalNewline: snapshot.finalNewline,
          operations: [
            {
              kind: 'replace',
              range: { start: { line: line.number, tag: line.tag }, end: { line: line.number, tag: line.tag } },
              lines: ['Replicas: 19']
            }
          ]
        }
      }
    })
    expect(prepared.isError).not.toBe(true)
    expect(prepared.structuredContent).toMatchObject({
      actionName: 'pages.preparePatch',
      status: 'pending',
      diffHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
    })
    const result = prepared.structuredContent as { proposalId: string; approvalId: string }
    const proposal = await db('agentProposals').where({ id: result.proposalId }).first()
    expect(proposal).toMatchObject({
      sourceKind: 'mcp',
      requesterApiKeyId: 9,
      requesterRequestId: '00000000-0000-4000-8000-000000000103',
      actionName: 'pages.preparePatch',
      pageId: 42,
      status: 'pending',
      patchFormat: 'wiki-line-patch-v1'
    })
    expect(proposal.diff).toContain('-Replicas: 17\n+Replicas: 19\n')
    expect(JSON.parse(proposal.operation)).toMatchObject({
      kind: 'patch',
      operationInput: { id: 42, content: '# Start\n\nContext.\n\nKeep this section.\n\nReplicas: 19\n', expectedSourceRevision: '8' }
    })
    expect(await db('agentApprovals').where({ id: result.approvalId, proposalId: result.proposalId }).first()).toMatchObject({
      status: 'pending',
      requesterApiKeyId: 9
    })
    expect(await db('agentActionExecutions')).toEqual([])
    expect(authorizeMutation).not.toHaveBeenCalled()
  })

  it('prepares and applies a proposal with API-key and live human authority', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-write-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: false }
      }
    )
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
    const pendingApply = await client.callTool(
      {
        name: 'wiki_apply_page_proposal',
        arguments: {
          proposalId: proposalResult.proposalId,
          approvalId: proposalResult.approvalId
        }
      },
      { allowInputRequired: true }
    )
    expect(Reflect.get(pendingApply, 'resultType')).toBe('input_required')
    const requestState = Reflect.get(pendingApply, 'requestState')
    expect(typeof requestState).toBe('string')
    expect(requestState as string).toMatch(/^v1\./)
    const continuation = {
      name: 'wiki_apply_page_proposal',
      arguments: { proposalId: proposalResult.proposalId, approvalId: proposalResult.approvalId },
      requestState,
      inputResponses: { approval: { action: 'accept', content: { acknowledge: true } } }
    }
    const beforeUntrustedRetries = { proposals: await db('agentProposals'), approvals: await db('agentApprovals') }
    // A signed continuation plus the client's acknowledgement is not human approval.
    expect(await postModernTool(continuation)).toMatchObject({ result: { resultType: 'input_required' } })
    expect(await postModernTool({ ...continuation, requestState: 'v1.forged-request-state' })).toMatchObject({ error: { code: -32602 } })
    // Capability support is rechecked on the retry, not inherited from listing/preparation.
    const withoutCapability = await postModernTool(continuation, {})
    expect(withoutCapability.result?.isError).toBe(true)
    expect(JSON.parse(withoutCapability.result!.content![0]!.text)).toMatchObject({ code: 'APPROVAL_CONTINUATION_REQUIRED' })
    expect(await postModernTool(continuation, { elicitation: { form: true } })).toMatchObject({ error: { code: -32602 } })
    activeApiKey = { apiKeyId: 10, groupId: 3, bearerToken: 'other-api-token' }
    const otherKeyRetry = await postModernTool(continuation)
    activeApiKey = { apiKeyId: 9, groupId: 3, bearerToken: 'test-api-token' }
    expect(otherKeyRetry).toMatchObject({ error: { code: -32602 } })
    expect({ proposals: await db('agentProposals'), approvals: await db('agentApprovals') }).toEqual(beforeUntrustedRetries)
    expect(await db('agentActionExecutions')).toEqual([])
    expect(movePage).not.toHaveBeenCalled()

    await client.close()
    const retryTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-approval-retry-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
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
    expect(movePage).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ id: 42, destinationPath: 'docs/next' }),
        [OKF_PRODUCER_CONTEXT]: expect.stringMatching(/^mcp:/u)
      })
    )
    expect(
      await db('agentProposals')
        .where({ id: proposalResult.proposalId })
        .first('sourceKind', 'requesterUserId', 'requesterApiKeyId', 'requesterRequestId', 'status')
    ).toMatchObject({
      sourceKind: 'mcp',
      requesterUserId: null,
      requesterApiKeyId: 9,
      requesterRequestId: '00000000-0000-4000-8000-000000000099',
      status: 'applied'
    })
    expect(
      await db('agentApprovals').where({ proposalId: proposalResult.proposalId }).first('requesterUserId', 'requesterApiKeyId', 'status', 'approvedByUserId')
    ).toMatchObject({
      requesterUserId: null,
      requesterApiKeyId: 9,
      status: 'approved',
      approvedByUserId: 7
    })
    expect(
      await db('agentActionExecutions')
        .where({ proposalId: proposalResult.proposalId })
        .first('requesterUserId', 'requesterApiKeyId', 'approvedByUserId', 'status')
    ).toMatchObject({
      requesterUserId: null,
      requesterApiKeyId: 9,
      approvedByUserId: 7,
      status: 'committed'
    })
    const replayed = await postModernTool(continuation)
    expect(replayed.result?.structuredContent).toEqual(applied.structuredContent)
    expect(movePage).toHaveBeenCalledOnce()
    expect(await db('agentActionExecutions')).toHaveLength(1)
  })

  it.each(['human-denial', 'client-decline'] as const)('does not apply a proposal after %s during modern continuation', async decision => {
    const port = (server.address() as AddressInfo).port
    client = new Client(
      { name: 'wiki-mcp-denial-test', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } }
    )
    let proposal: { proposalId: string; approvalId: string }
    client.setRequestHandler('elicitation/create', async () => {
      if (decision === 'human-denial') {
        await decideProposal(db, { ...proposal, userId: 7, decision: 'denied', authorize: async () => undefined })
      }
      return { action: 'accept', content: { acknowledge: decision !== 'client-decline' } }
    })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { authProvider: { token: async () => 'test-api-token' } })
    )
    const prepared = await client.callTool({
      name: 'wiki_prepare_page_move',
      arguments: {
        requestId: '00000000-0000-4000-8000-000000000113',
        pageId: 42,
        sourceRevision: '8',
        destinationPath: 'docs/next',
        destinationLocale: 'en'
      }
    })
    expect(prepared.isError).not.toBe(true)
    const preparedProposal = prepared.structuredContent as { proposalId: string; approvalId: string }
    proposal = { proposalId: preparedProposal.proposalId, approvalId: preparedProposal.approvalId }
    const denied = await client.callTool({ name: 'wiki_apply_page_proposal', arguments: proposal })
    expect(denied.isError).not.toBe(true)
    expect(denied.structuredContent).toMatchObject({
      proposalId: proposal.proposalId,
      status: decision === 'human-denial' ? 'denied' : 'declined',
      applied: false
    })
    expect(await db('agentProposals').where({ id: proposal.proposalId }).first('status')).toEqual({
      status: decision === 'human-denial' ? 'denied' : 'pending'
    })
    expect(await db('agentActionExecutions')).toEqual([])
    expect(authorizeMutation).not.toHaveBeenCalled()
    expect(movePage).not.toHaveBeenCalled()
  })

  it.each(['create', 'delete'] as const)('recovers an applied %s receipt on a fresh modern MCP client without another approval or mutation', async kind => {
    const createdPage = { ...publicPage, id: 131, path: 'docs/created', title: 'Created', content: '# Created\n', sourceRevision: '1' }
    let requesterReadRevoked = false
    if (kind === 'create') {
      let created = false
      getPageByPath.mockImplementation(async input => {
        if (!created || input.path !== createdPage.path || input.locale !== createdPage.locale || input.visibility !== createdPage.visibility)
          throw new errors.PageNotFound()
        if (requesterReadRevoked && typeof input.requester === 'object' && input.requester !== null && Reflect.get(input.requester, 'ownershipUserId') === null)
          throw new errors.PageNotFound()
        return createdPage
      })
      getPage.mockImplementation(async input => {
        if (!created || input.id !== createdPage.id) throw new errors.PageNotFound()
        if (requesterReadRevoked && typeof input.requester === 'object' && input.requester !== null && Reflect.get(input.requester, 'ownershipUserId') === null)
          throw new errors.PageNotFound()
        return createdPage
      })
      createPage.mockImplementation(async () => {
        created = true
        return createdPage
      })
    } else {
      removePage.mockImplementation(async () => {
        getPage.mockRejectedValue(new errors.PageNotFound())
        return {}
      })
    }
    const port = (server.address() as AddressInfo).port
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`)
    client = new Client(
      { name: 'wiki-mcp-completed-prepare-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: false }
      }
    )
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        authProvider: { token: async () => 'test-api-token' }
      })
    )
    expect(client.getProtocolEra()).toBe('modern')
    const prepared = await client.callTool(
      kind === 'create'
        ? {
            name: 'wiki_prepare_page_create',
            arguments: {
              requestId: '00000000-0000-4000-8000-000000000105',
              path: createdPage.path,
              locale: createdPage.locale,
              title: createdPage.title,
              description: createdPage.description,
              content: createdPage.content,
              contentType: createdPage.contentType,
              tags: []
            }
          }
        : {
            name: 'wiki_prepare_page_delete',
            arguments: {
              requestId: '00000000-0000-4000-8000-000000000106',
              pageId: publicPage.id,
              sourceRevision: publicPage.sourceRevision,
              confirmationPath: publicPage.path
            }
          }
    )
    expect(prepared.isError).not.toBe(true)
    expect(prepared.structuredContent).toMatchObject({ status: 'pending' })
    const proposal = prepared.structuredContent as { proposalId: string; approvalId: string }
    const applyCall = {
      name: 'wiki_apply_page_proposal',
      arguments: { proposalId: proposal.proposalId, approvalId: proposal.approvalId }
    }
    const pending = await client.callTool(applyCall, { allowInputRequired: true })
    expect(pending).toMatchObject({
      resultType: 'input_required',
      requestState: expect.stringMatching(/^v1\./),
      inputRequests: { approval: expect.objectContaining({ method: 'elicitation/create' }) }
    })
    expect(await db('agentActionExecutions')).toEqual([])
    expect(createPage).not.toHaveBeenCalled()
    expect(removePage).not.toHaveBeenCalled()
    await decideProposal(db, {
      proposalId: proposal.proposalId,
      approvalId: proposal.approvalId,
      userId: 7,
      decision: 'approved',
      authorize: async () => undefined
    })
    const withoutContinuation = await client.callTool(applyCall, { allowInputRequired: true })
    expect(withoutContinuation).toMatchObject({ resultType: 'input_required', requestState: expect.stringMatching(/^v1\./) })
    expect(await db('agentActionExecutions')).toEqual([])
    expect(createPage).not.toHaveBeenCalled()
    expect(removePage).not.toHaveBeenCalled()
    await client.close()

    client = new Client(
      { name: 'wiki-mcp-completed-apply-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
    const acknowledge = vi.fn(async () => ({ action: 'accept' as const, content: { acknowledge: true } }))
    client.setRequestHandler('elicitation/create', acknowledge)
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        authProvider: { token: async () => 'test-api-token' }
      })
    )
    const applied = await client.callTool(applyCall)
    expect(applied.isError).not.toBe(true)
    expect(applied.structuredContent).toMatchObject({
      proposalId: proposal.proposalId,
      status: 'applied',
      resultHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      page: kind === 'delete' ? null : expect.objectContaining({ id: createdPage.id, path: createdPage.path, sourceRevision: '1' })
    })
    expect(acknowledge).toHaveBeenCalledOnce()
    const beforeRecovery = {
      proposals: await db('agentProposals'),
      approvals: await db('agentApprovals'),
      executions: await db('agentActionExecutions')
    }
    expect(beforeRecovery.proposals).toEqual([expect.objectContaining({ id: proposal.proposalId, status: 'applied' })])
    expect(beforeRecovery.approvals).toEqual([expect.objectContaining({ id: proposal.approvalId, status: 'approved', approvedByUserId: 7 })])
    expect(beforeRecovery.executions).toEqual([expect.objectContaining({ proposalId: proposal.proposalId, status: 'committed' })])
    const authorizationCalls = authorizeMutation.mock.calls.length
    await client.close()

    client = new Client(
      { name: 'wiki-mcp-completed-recovery-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: false }
      }
    )
    const unexpectedElicitation = vi.fn(async () => ({ action: 'cancel' as const }))
    client.setRequestHandler('elicitation/create', unexpectedElicitation)
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        authProvider: { token: async () => 'test-api-token' }
      })
    )
    expect(client.getProtocolEra()).toBe('modern')
    const recovered = await client.callTool(applyCall, { allowInputRequired: true })
    expect(recovered.isError).not.toBe(true)
    expect(recovered.structuredContent).toEqual(applied.structuredContent)
    expect(Reflect.get(recovered, 'resultType')).not.toBe('input_required')
    expect(unexpectedElicitation).not.toHaveBeenCalled()
    if (kind === 'create') {
      requesterReadRevoked = true
      const offered = await client.listTools()
      expect(offered.tools.map(tool => tool.name)).toContain('wiki_apply_page_proposal')
      const denied = await client.callTool(applyCall, { allowInputRequired: true })
      expect(denied.isError).toBe(true)
      expect(denied.structuredContent).toBeUndefined()
      const serialized = JSON.stringify(denied)
      for (const secret of [createdPage.path, createdPage.title, createdPage.description, createdPage.content]) {
        if (secret.length > 0) expect(serialized).not.toContain(secret)
      }
      // The human still has access: only the actual API-key reader was revoked.
      await expect(
        getPageByPath({ path: createdPage.path, locale: createdPage.locale, visibility: createdPage.visibility, requester: humanPrincipal() })
      ).resolves.toEqual(createdPage)
      requesterReadRevoked = false
      const restored = await client.callTool(applyCall, { allowInputRequired: true })
      expect(restored.isError).not.toBe(true)
      expect(restored.structuredContent).toEqual(applied.structuredContent)
      expect(Reflect.get(restored, 'resultType')).not.toBe('input_required')
    }
    expect(unexpectedElicitation).not.toHaveBeenCalled()
    expect(kind === 'create' ? createPage : removePage).toHaveBeenCalledOnce()
    expect(kind === 'create' ? removePage : createPage).not.toHaveBeenCalled()
    expect(authorizeMutation).toHaveBeenCalledTimes(authorizationCalls)
    expect({
      proposals: await db('agentProposals'),
      approvals: await db('agentApprovals'),
      executions: await db('agentActionExecutions')
    }).toEqual(beforeRecovery)
  })

  it('keeps patch snapshots and proposals bound to their exact API key even in the same group', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-key-scope-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
    await client.connect(transport)
    const read = await client.callTool({
      name: 'wiki_read_page_for_patch',
      arguments: { pageId: 42, previousSnapshotToken: null }
    })
    expect(read.isError).not.toBe(true)
    const snapshot = read.structuredContent as unknown as WikiLineSnapshotV1
    const continuationInput = {
      pageId: 42,
      ranges: [{ startLine: 1, endLine: 1 }],
      previousSnapshotToken: snapshot.snapshotToken
    }
    const continued = await client.callTool({
      name: 'wiki_read_page_for_patch',
      arguments: continuationInput
    })
    expect(continued.isError).not.toBe(true)
    expect(continued.structuredContent).toMatchObject({
      page: snapshot.page,
      revision: snapshot.revision,
      documentTag: snapshot.documentTag,
      disclosed: snapshot.disclosed
    })
    const line = snapshot.disclosed[0]!.lines[0]!
    const patch = {
      version: 'wiki-line-patch-v1',
      snapshotToken: snapshot.snapshotToken,
      baseDocumentTag: snapshot.documentTag,
      resultFinalNewline: snapshot.finalNewline,
      operations: [
        {
          kind: 'replace',
          range: { start: { line: line.number, tag: line.tag }, end: { line: line.number, tag: line.tag } },
          lines: ['# Start revised']
        }
      ]
    }
    const prepared = await client.callTool({
      name: 'wiki_prepare_page_patch',
      arguments: { requestId: '00000000-0000-4000-8000-000000000100', patch }
    })
    expect(prepared.isError).not.toBe(true)
    expect(prepared.structuredContent).toMatchObject({ status: 'pending' })
    const proposalResult = JSON.parse(String(Reflect.get(prepared.content[0] ?? {}, 'text'))) as { proposalId: string; approvalId: string }
    const before = {
      proposal: await db('agentProposals')
        .where({ id: proposalResult.proposalId })
        .first('sourceKind', 'requesterUserId', 'requesterApiKeyId', 'requesterRequestId', 'status', 'inputHash', 'operationSha256'),
      approval: await db('agentApprovals')
        .where({ proposalId: proposalResult.proposalId })
        .first('requesterUserId', 'requesterApiKeyId', 'status', 'inputHash', 'operationSha256', 'approvedByUserId')
    }

    await client.close()
    activeApiKey = { apiKeyId: 10, groupId: 3, bearerToken: 'other-api-token' }
    const otherTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'other-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-other-key-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
    await client.connect(otherTransport)
    const deniedRead = await client.callTool({
      name: 'wiki_read_page_for_patch',
      arguments: continuationInput
    })
    expect(deniedRead.isError).toBe(true)
    expect(JSON.parse(String(Reflect.get(deniedRead.content[0] ?? {}, 'text')))).toMatchObject({
      code: 'MCP_ACTION_FAILED'
    })
    const deniedPrepare = await client.callTool({
      name: 'wiki_prepare_page_patch',
      arguments: { requestId: '00000000-0000-4000-8000-000000000104', patch }
    })
    expect(deniedPrepare.isError).toBe(true)
    expect(JSON.parse(String(Reflect.get(deniedPrepare.content[0] ?? {}, 'text')))).toMatchObject({
      code: 'MCP_ACTION_FAILED'
    })
    const denied = await client.callTool({
      name: 'wiki_apply_page_proposal',
      arguments: {
        proposalId: proposalResult.proposalId,
        approvalId: proposalResult.approvalId
      }
    })
    expect(denied).toMatchObject({ isError: true })
    expect({
      proposal: await db('agentProposals')
        .where({ id: proposalResult.proposalId })
        .first('sourceKind', 'requesterUserId', 'requesterApiKeyId', 'requesterRequestId', 'status', 'inputHash', 'operationSha256'),
      approval: await db('agentApprovals')
        .where({ proposalId: proposalResult.proposalId })
        .first('requesterUserId', 'requesterApiKeyId', 'status', 'inputHash', 'operationSha256', 'approvedByUserId')
    }).toEqual(before)
    expect(await db('agentProposals').pluck('id')).toEqual([proposalResult.proposalId])
    expect(await db('agentActionExecutions')).toEqual([])
    expect(authorizeMutation).not.toHaveBeenCalled()
    expect(movePage).not.toHaveBeenCalled()
  })

  it('denies a revoked API key without changing pending proposal persistence', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-revoked-key-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
    await client.connect(transport)
    const prepared = await client.callTool({
      name: 'wiki_prepare_page_move',
      arguments: {
        requestId: '00000000-0000-4000-8000-000000000101',
        pageId: 42,
        sourceRevision: '8',
        destinationPath: 'docs/next',
        destinationLocale: 'en'
      }
    })
    const proposalResult = JSON.parse(String(Reflect.get(prepared.content[0] ?? {}, 'text'))) as { proposalId: string; approvalId: string }
    const before = {
      proposal: await db('agentProposals')
        .where({ id: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256'),
      approval: await db('agentApprovals')
        .where({ proposalId: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256', 'approvedByUserId')
    }

    activeApiKey = null
    const denied = await client
      .callTool({
        name: 'wiki_apply_page_proposal',
        arguments: {
          proposalId: proposalResult.proposalId,
          approvalId: proposalResult.approvalId
        }
      })
      .catch(error => error)
    expect(denied).toBeInstanceOf(Error)
    activeApiKey = { apiKeyId: 9, groupId: 3, bearerToken: 'test-api-token' }
    expect({
      proposal: await db('agentProposals')
        .where({ id: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256'),
      approval: await db('agentApprovals')
        .where({ proposalId: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256', 'approvedByUserId')
    }).toEqual(before)
    expect(movePage).not.toHaveBeenCalled()
  })

  it('denies a revoked human approver without changing approved proposal persistence', async () => {
    const port = (server.address() as AddressInfo).port
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      authProvider: { token: async () => 'test-api-token' }
    })
    client = new Client(
      { name: 'wiki-mcp-revoked-approver-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'auto' }
      }
    )
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { acknowledge: true } }))
    await client.connect(transport)
    const prepared = await client.callTool({
      name: 'wiki_prepare_page_move',
      arguments: {
        requestId: '00000000-0000-4000-8000-000000000102',
        pageId: 42,
        sourceRevision: '8',
        destinationPath: 'docs/next',
        destinationLocale: 'en'
      }
    })
    const proposalResult = JSON.parse(String(Reflect.get(prepared.content[0] ?? {}, 'text'))) as { proposalId: string; approvalId: string }
    await decideProposal(db, {
      proposalId: proposalResult.proposalId,
      approvalId: proposalResult.approvalId,
      userId: 7,
      decision: 'approved',
      authorize: async () => undefined
    })
    const before = {
      proposal: await db('agentProposals')
        .where({ id: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256'),
      approval: await db('agentApprovals')
        .where({ proposalId: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256', 'approvedByUserId')
    }

    approver = null
    const denied = await client.callTool({
      name: 'wiki_apply_page_proposal',
      arguments: {
        proposalId: proposalResult.proposalId,
        approvalId: proposalResult.approvalId
      }
    })
    expect(denied).toMatchObject({ isError: true })
    expect(JSON.parse(String(Reflect.get(denied.content[0] ?? {}, 'text')))).toMatchObject({ code: 'APPROVER_UNAVAILABLE' })
    expect({
      proposal: await db('agentProposals')
        .where({ id: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256'),
      approval: await db('agentApprovals')
        .where({ proposalId: proposalResult.proposalId })
        .first('status', 'requesterUserId', 'requesterApiKeyId', 'inputHash', 'operationSha256', 'approvedByUserId')
    }).toEqual(before)
    expect(movePage).not.toHaveBeenCalled()
  })

  it('rejects wrong Host and Origin values after route-boundary authentication', async () => {
    const port = (server.address() as AddressInfo).port
    expect(await postInitialize(port, { host: 'wiki.example.test' })).toBe(403)
    expect(await postInitialize(port, { host: '127.0.0.1', origin: 'https://wiki.example.test' })).toBe(403)
    expect(authenticate).toHaveBeenCalledTimes(2)
  })
})
