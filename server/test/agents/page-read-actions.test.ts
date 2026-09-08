import type { AgentKnowledgeContext } from '../../../shared/agents/knowledge-context.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

import { AGENT_FEATURE_FLAG_KEYS, type AgentActionName, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ActionKernel, createActionAuthority, type ActionAdmissionSnapshot } from '../../agents/actions/kernel.ts'
import { registerPageReadActions } from '../../agents/actions/page-reads.ts'
import type { KnowledgeProjectionView } from '../../knowledge/projection.ts'
import { parseOkfDocument } from '../../okf/format.ts'

const requestId = '00000000-0000-4000-8000-000000000001'
const actionCallId = '00000000-0000-4000-8000-000000000002'
const flags = Object.fromEntries(AGENT_FEATURE_FLAG_KEYS.map(flag => [flag, true])) as AgentFeatureFlags
const permissions = ['use:agents', 'read:pages', 'read:history']
const principal = { id: 7, permissions, groups: [3] } as Express.User
const auth = { kind: 'user', userId: 7, ownershipUserId: 7, principal } as const
const admission: ActionAdmissionSnapshot = {
  transport: 'agent',
  executionMode: 'agent',
  supportsTools: true,
  permissions,
  groupIds: [3],
  featureFlags: flags
}

const page = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  authorId: 7,
  localeCode: 'en',
  path: 'docs/start',
  title: 'Start',
  description: null,
  contentType: 'markdown',
  sourceRevision: '8',
  content: '# Start',
  updatedAt: new Date('2026-08-17T00:00:00.000Z'),
  visibility: 'public',
  ownerId: null,
  extra: { js: 'must-not-leak' },
  ...overrides
})
const validOkfMetadata = {
  type: 'Procedure',
  title: 'Stored title',
  description: 'Stored description',
  tags: ['stored-tag'],
  status: 'stable' as const,
  generated: { by: 'agent:test', at: '2026-08-15T00:00:00.000Z' },
  verified: { by: 'human:7', at: '2026-08-16T00:00:00.000Z' },
  'x-extension': { retained: true },
  'x-wiki': {
    namespace: 'operations',
    owner: 'platform',
    page_id: 999,
    source_revision: '1',
    visibility: 'private',
    knowledge: { state: 'stored' }
  }
}

const knowledgeProjection = (overrides: Partial<KnowledgeProjectionView> = {}): KnowledgeProjectionView => ({
  schemaVersion: 2,
  sourceRevision: '8',
  state: 'partial',
  conceptType: 'Procedure',
  summary: 'Operational deployment runbook.',
  tags: ['runbook'],
  searchTerms: ['deployment runbook'],
  entities: [{ name: 'Deployment', type: 'Process' }],
  relationships: [],
  openQuestions: [],
  lifecycle: {
    status: 'stable',
    trustTier: 'unverified',
    verification: 'unverified',
    stale: false,
    generatedAt: '2026-08-17T00:00:00.000Z',
    verifiedAt: null,
    staleAfter: null
  },
  missingFields: ['concept.relationships'],
  provenance: { deterministicVersion: 'wiki-knowledge-v2', utility: null },
  ...overrides
})

class PageNotFound extends Error {
  readonly code = 'PAGE_NOT_FOUND'
}

class PageLocked extends Error {
  readonly code = 'PAGE_LOCKED'
}

type KnowledgeDependency = NonNullable<Parameters<typeof registerPageReadActions>[1]['knowledge']>

const setup = (
  overrides: Partial<{
    search: (input: Record<string, unknown>) => Promise<unknown>
    searchTags: (input: Record<string, unknown>) => Promise<unknown>
    listTags: (requester?: Express.User) => Promise<unknown>
    discover: (input: Record<string, unknown>) => Promise<unknown>
    get: (input: Record<string, unknown>) => Promise<unknown>
    getByPath: (input: Record<string, unknown>) => Promise<unknown>
    listRecent: (requester?: Express.User) => Promise<unknown>
    getHistory: (input: Record<string, unknown>) => Promise<unknown>
    getVersion: (input: Record<string, unknown>) => Promise<unknown>
    listLinks: (input: Record<string, unknown>) => Promise<unknown>
    listRelated: (input: Record<string, unknown>) => Promise<unknown>
  }> = {},
  knowledge?: KnowledgeDependency
) => {
  const operations = {
    search: vi.fn(async () => ({ results: [], suggestions: [], totalHits: 0, windowLimit: 150, windowTruncated: false })),
    searchTags: vi.fn(async () => []),
    listTags: vi.fn(async () => []),
    discover: vi.fn(async () => ({ pages: [], totalInWindow: 0, windowLimit: 5_000, nextOffset: null })),
    get: vi.fn(async () => page()),
    getByPath: vi.fn(async () => page()),
    listRecent: vi.fn(async () => []),
    getHistory: vi.fn(async () => ({ trail: [], total: 0 })),
    getVersion: vi.fn(async () => null),
    listLinks: vi.fn(async () => []),
    listRelated: vi.fn(async () => ({ pages: [], truncated: false, nextOffset: null })),
    ...overrides
  }
  const resolveRequester = vi.fn(async () => principal)
  const kernel = new ActionKernel()
  registerPageReadActions(kernel, { operations, resolveRequester, snapshotSigningSecret: Buffer.alloc(32, 3), ...(knowledge ? { knowledge } : {}) })
  const execute = (name: AgentActionName, input: unknown, knowledgeContext?: AgentKnowledgeContext) =>
    kernel.execute({
      authority: createActionAuthority(name, requestId, auth, admission),
      actionCallId,
      input,
      ...(knowledgeContext ? { knowledgeContext } : {}),
      signal: new AbortController().signal,
      refreshAdmission: async () => admission
    })
  return { execute, operations, resolveRequester }
}

describe('permission-safe page read actions', () => {
  it('applies the user-selected scope even when the model requests a broader search', async () => {
    const { execute, operations } = setup()
    await execute(
      'pages.search',
      { query: 'guide', locale: 'fr', path: 'elsewhere', limit: 5, offset: 0 },
      { scope: { kind: 'section', locale: 'en', path: 'docs' }, sources: [] }
    )
    expect(operations.search).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', path: 'docs' }))
    await execute(
      'pages.search',
      { query: 'guide', limit: 5, offset: 0 },
      { scope: { kind: 'selected' }, sources: [{ id: 42, locale: 'en', path: 'docs/start', title: 'Start', visibility: 'public', sourceRevision: '8' }] }
    )
    expect(operations.search).toHaveBeenLastCalledWith(expect.objectContaining({ pageIds: [42] }))
  })

  it('returns bounded current search candidates without protected model fields', async () => {
    const { execute } = setup({
      search: vi.fn(async () => ({
        results: [
          {
            id: 42,
            sourceRevision: '8',
            path: 'docs/start',
            locale: 'en',
            visibility: 'public',
            tags: ['runbook'],
            score: 12.5,
            matchedFields: ['tag', 'graph']
          },
          {
            id: 43,
            sourceRevision: '2',
            path: 'private/notes',
            locale: 'en',
            visibility: 'private',
            matchedFields: ['title', 'tag', 'path', 'description', 'content', 'graph', 'knowledge']
          },
          { id: 44, sourceRevision: '1', path: 'deleted', locale: 'en', visibility: 'public' }
        ],
        suggestions: ['notes'],
        totalHits: 3,
        windowLimit: 150,
        windowTruncated: true
      })),
      get: async input => {
        if (input.id === 44) throw new PageNotFound()
        return input.id === 43 ? page({ id: 43, path: 'private/notes', visibility: 'private', ownerId: 7, sourceRevision: 2 }) : page()
      }
    })
    expect(await execute('pages.search', { query: 'notes', path: 'docs', limit: 3, offset: 0 })).toEqual({
      results: [
        {
          id: 42,
          locale: 'en',
          path: 'docs/start',
          title: 'Start',
          description: '',
          contentType: 'markdown',
          sourceRevision: '8',
          authority: { state: 'missing', metadata: null, trust: null },
          okfResourceUri: 'wiki://pages/42/versions/current/revisions/8/okf',
          citation: { evidenceId: 'page:42:revision:8', label: 'Start', href: '/en/docs/start' },
          tags: ['runbook'],
          score: 12.5,
          matchedFields: ['tag', 'graph'],
          knowledge: null
        },
        {
          id: 43,
          locale: 'en',
          path: 'private/notes',
          title: 'Start',
          description: '',
          contentType: 'markdown',
          sourceRevision: '2',
          authority: { state: 'missing', metadata: null, trust: null },
          okfResourceUri: 'wiki://pages/43/versions/current/revisions/2/okf',
          citation: { evidenceId: 'page:43:revision:2', label: 'Start', href: '/_private/en/private/notes' },
          tags: [],
          score: 0,
          matchedFields: ['title', 'tag', 'path', 'description', 'content', 'graph', 'knowledge'],
          knowledge: null
        }
      ],
      suggestions: ['notes'],
      totalInWindow: 2,
      windowLimit: 150,
      windowTruncated: true,
      nextOffset: null
    })
  })

  it('uses the unified search order, skips locked candidates, and attaches only revision-matched knowledge', async () => {
    const currentProjection = knowledgeProjection()
    const staleProjection = knowledgeProjection({ sourceRevision: '7' })
    const knowledge: KnowledgeDependency = {
      getCurrent: vi.fn(async () => currentProjection),
      getRevision: vi.fn(async () => currentProjection),
      getCurrentMany: vi.fn(
        async () =>
          new Map([
            [42, currentProjection],
            [43, staleProjection]
          ])
      )
    }
    const { execute } = setup(
      {
        search: vi.fn(async () => ({
          results: [
            {
              id: 42,
              sourceRevision: '8',
              locale: 'en',
              path: 'docs/knowledge',
              visibility: 'public',
              tags: ['runbook'],
              score: 9,
              matchedFields: ['knowledge']
            },
            { id: 43, sourceRevision: '8', locale: 'en', path: 'docs/lexical', visibility: 'public', tags: [], score: 8, matchedFields: ['title'] },
            { id: 44, sourceRevision: '8', locale: 'en', path: 'docs/locked', visibility: 'public', tags: [], score: 7, matchedFields: ['title'] },
            { id: 45, sourceRevision: '8', locale: 'en', path: 'docs/replaced', visibility: 'public', tags: [], score: 6, matchedFields: ['title'] },
            { id: 46, sourceRevision: '8', locale: 'en', path: 'docs/visibility', visibility: 'public', tags: [], score: 5, matchedFields: ['title'] }
          ],
          suggestions: [],
          totalHits: 5,
          windowLimit: 100,
          windowTruncated: false
        })),
        get: async input => {
          if (input.id === 44) throw new PageLocked()
          if (input.id === 45) return page({ id: 45, path: 'docs/replaced', sourceRevision: '9' })
          if (input.id === 46) return page({ id: 46, path: 'docs/visibility', visibility: 'private' })
          return page({ id: input.id, path: input.id === 42 ? 'docs/knowledge' : 'docs/lexical' })
        }
      },
      knowledge
    )

    const response = (await execute('pages.search', { query: 'deployment', limit: 10, offset: 0 })) as {
      results: Array<{ id: number; matchedFields: string[]; knowledge: KnowledgeProjectionView | null }>
    }
    expect(response.results.map(result => result.id)).toEqual([42, 43])
    expect(response.results[0]).toMatchObject({ matchedFields: ['knowledge'], knowledge: currentProjection })
    expect(response.results[1]).toMatchObject({ matchedFields: ['title'], knowledge: null })
  })

  it('attaches matching knowledge and preserves internal hydration failures', async () => {
    const projection = knowledgeProjection()
    const knowledge: KnowledgeDependency = {
      getCurrent: vi.fn(async () => projection),
      getRevision: vi.fn(async () => projection),
      getCurrentMany: vi.fn(async () => new Map([[42, projection]]))
    }
    const searchResult = {
      id: 42,
      sourceRevision: '8',
      locale: 'en',
      path: 'docs/start',
      visibility: 'public',
      tags: [],
      score: 7,
      matchedFields: ['knowledge']
    }
    const { execute } = setup(
      { search: vi.fn(async () => ({ results: [searchResult], suggestions: [], totalHits: 1, windowLimit: 100, windowTruncated: false })) },
      knowledge
    )

    expect(
      await execute('pages.search', {
        query: 'deployment',
        knowledge: { state: 'partial', conceptType: 'Procedure' },
        limit: 10,
        offset: 0
      })
    ).toMatchObject({ results: [{ id: 42, matchedFields: ['knowledge'], knowledge: projection }] })

    const failure = new Error('database unavailable')
    const broken = setup({
      search: async () => ({ results: [searchResult], suggestions: [], totalHits: 1, windowLimit: 100, windowTruncated: false }),
      get: async () => {
        throw failure
      }
    })
    await expect(Promise.resolve(broken.execute('pages.search', { query: 'deployment', limit: 10, offset: 0 }))).rejects.toBe(failure)
  })

  it('searches and pages the visible tag taxonomy', async () => {
    const { execute, operations } = setup({
      searchTags: vi.fn(async () => ['runbook', 'release']),
      listTags: vi.fn(async () => [
        { tag: 'Runbook', title: 'Operational runbooks' },
        { tag: 'Release', title: null }
      ])
    })
    expect(await execute('pages.searchTags', { query: 'run', limit: 1 })).toEqual({ tags: ['runbook'] })
    expect(await execute('pages.listTags', { limit: 1, offset: 0 })).toEqual({
      tags: [{ tag: 'Release', title: null }],
      nextOffset: 1
    })
    expect(operations.searchTags).toHaveBeenCalledWith({ query: 'run', limit: 1, requester: principal })
    expect(operations.listTags).toHaveBeenCalledWith(principal)
  })

  it('hydrates structured path and tag discovery results', async () => {
    const { execute, operations } = setup({
      discover: vi.fn(async () => ({
        pages: [
          {
            id: 42,
            locale: 'en',
            path: 'docs/start',
            title: 'Start',
            description: null,
            updatedAt: new Date('2026-08-17T00:00:00.000Z'),
            tags: ['Runbook']
          }
        ],
        totalInWindow: 1,
        windowLimit: 5_000,
        nextOffset: null
      }))
    })
    expect(await execute('pages.discover', { locale: 'en', path: 'docs', tags: ['runbook'], limit: 10, offset: 0 })).toEqual({
      pages: [
        {
          id: 42,
          locale: 'en',
          path: 'docs/start',
          title: 'Start',
          description: '',
          contentType: 'markdown',
          sourceRevision: '8',
          authority: { state: 'missing', metadata: null, trust: null },
          okfResourceUri: 'wiki://pages/42/versions/current/revisions/8/okf',
          citation: { evidenceId: 'page:42:revision:8', label: 'Start', href: '/en/docs/start' },
          tags: ['runbook'],
          updatedAt: '2026-08-17T00:00:00.000Z',
          knowledge: null
        }
      ],
      totalInWindow: 1,
      windowLimit: 5_000,
      nextOffset: null
    })
    expect(operations.discover).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', path: 'docs', depth: 1, order: 'path', requester: principal }))
  })

  it('skips locked discovery and recent candidates while direct reads remain explicit', async () => {
    const locked = new PageLocked()
    const { execute } = setup({
      discover: async () => ({
        pages: [
          { id: 42, locale: 'en', path: 'docs/locked', title: 'Locked', description: null, updatedAt: new Date(), tags: [] },
          { id: 43, locale: 'en', path: 'docs/visible', title: 'Visible', description: null, updatedAt: new Date(), tags: [] }
        ],
        totalInWindow: 2,
        windowLimit: 100,
        nextOffset: null
      }),
      listRecent: async () => [{ id: 42 }, { id: 43 }],
      get: async input => {
        if (input.id === 42) throw locked
        return page({ id: 43, path: 'docs/visible' })
      }
    })

    await expect(Promise.resolve(execute('pages.get', { id: 42 }))).rejects.toBe(locked)
    expect((await execute('pages.discover', { locale: 'en', path: 'docs', tags: [], limit: 10, offset: 0 })).pages).toHaveLength(1)
    expect((await execute('pages.listRecent', { limit: 10 })).pages).toMatchObject([{ id: 43, path: 'docs/visible' }])
  })

  it('exposes canonical rendered heading anchors as precise citation destinations', async () => {
    const toc = JSON.stringify([
      {
        title: 'Start',
        anchor: '#start',
        children: [{ title: 'Installation', anchor: '#installation', children: [] }]
      }
    ])
    const { execute } = setup({ get: async () => page({ toc }) })

    expect(await execute('pages.get', { id: 42 })).toMatchObject({
      authority: { state: 'missing', metadata: null, trust: null },
      okfResourceUri: 'wiki://pages/42/versions/current/revisions/8/okf',
      citation: { evidenceId: 'page:42:revision:8', label: 'Start', href: '/en/docs/start' },
      citationSections: [
        { evidenceId: 'page:42:revision:8:section:1', label: 'Start', href: '/en/docs/start#start' },
        { evidenceId: 'page:42:revision:8:section:2', label: 'Start › Installation', href: '/en/docs/start#installation' }
      ]
    })
  })

  it('serializes valid current and historical OKF authority as distinct revision resources', async () => {
    const currentProjection = knowledgeProjection()
    const historicalProjection = knowledgeProjection({
      sourceRevision: '6',
      summary: 'Archived deployment runbook.'
    })
    const knowledge: KnowledgeDependency = {
      getCurrent: vi.fn(async () => currentProjection),
      getRevision: vi.fn(async () => historicalProjection),
      getCurrentMany: vi.fn(async () => new Map())
    }
    const { execute, operations } = setup(
      {
        get: async () =>
          page({
            description: 'Current deployment instructions',
            tags: ['Runbook'],
            content: '# Start\n\nCurrent instructions.\n',
            extra: { okf: validOkfMetadata }
          }),
        getVersion: vi.fn(async () =>
          page({
            id: undefined,
            pageId: 42,
            title: 'Archived Start',
            description: 'Archived deployment instructions',
            sourceRevision: '6',
            tags: [{ tag: 'Archive' }],
            content: '# Archived Start\n\nArchived instructions.\n',
            extra: { okf: validOkfMetadata }
          })
        )
      },
      knowledge
    )
    type OkfResult = {
      pageId: number
      versionId: number | null
      sourceRevision: string
      resourceUri: string
      document: string
      authority: unknown
      knowledge: KnowledgeProjectionView | null
      citation: { evidenceId: string }
    }

    const current = (await execute('pages.getOkf', { id: 42 })) as OkfResult
    expect(current).toMatchObject({
      pageId: 42,
      versionId: null,
      sourceRevision: '8',
      resourceUri: 'wiki://pages/42/versions/current/revisions/8/okf',
      authority: {
        state: 'valid',
        metadata: validOkfMetadata,
        trust: {
          trustTier: 'human-reviewed',
          verification: 'current',
          status: 'stable',
          stale: false,
          generatedAt: '2026-08-15T00:00:00.000Z',
          verifiedAt: '2026-08-16T00:00:00.000Z'
        }
      },
      knowledge: currentProjection,
      citation: { evidenceId: 'page:42:revision:8' }
    })
    const parsedCurrent = parseOkfDocument(current.document)
    expect(parsedCurrent.metadata).toMatchObject({
      type: 'Procedure',
      title: 'Start',
      description: 'Current deployment instructions',
      tags: ['runbook'],
      status: 'stable',
      'x-extension': { retained: true }
    })
    expect(parsedCurrent.metadata['x-wiki']).toEqual({
      namespace: 'operations',
      owner: 'platform',
      page_id: 42,
      source_revision: '8',
      visibility: 'public',
      knowledge: currentProjection
    })
    expect(parsedCurrent.body).toContain('Current instructions.')

    const historical = (await execute('pages.getOkf', { pageId: 42, versionId: 9 })) as OkfResult
    expect(historical).toMatchObject({
      pageId: 42,
      versionId: 9,
      sourceRevision: '6',
      resourceUri: 'wiki://pages/42/versions/9/revisions/6/okf',
      authority: { state: 'valid', metadata: validOkfMetadata },
      knowledge: historicalProjection,
      citation: { evidenceId: 'page:42:revision:6' }
    })
    const parsedHistorical = parseOkfDocument(historical.document)
    expect(parsedHistorical.metadata['x-wiki']).toEqual({
      namespace: 'operations',
      owner: 'platform',
      page_id: 42,
      source_revision: '6',
      visibility: 'public',
      knowledge: historicalProjection
    })
    expect(parsedHistorical.body).toContain('Archived instructions.')
    expect(historical.resourceUri).not.toBe(current.resourceUri)
    expect(historical.document).not.toBe(current.document)
    expect(historical.citation.evidenceId).not.toBe(current.citation.evidenceId)
    expect(operations.getVersion).toHaveBeenCalledWith({ pageId: 42, versionId: 9, requester: principal })
  })

  it('rejects pages whose stored OKF authority is missing or invalid', async () => {
    const missing = setup({ get: async () => page({ extra: {} }) })
    const invalid = setup({ get: async () => page({ extra: { okf: { type: '' } } }) })

    await expect(Promise.resolve(missing.execute('pages.getOkf', { id: 42 }))).rejects.toMatchObject({
      code: 'INVALID_OKF_AUTHORITY',
      message: 'Cannot serialize page with missing OKF authority'
    })
    await expect(Promise.resolve(invalid.execute('pages.getOkf', { id: 42 }))).rejects.toMatchObject({
      code: 'INVALID_OKF_AUTHORITY',
      message: 'Cannot serialize page with invalid OKF authority'
    })
  })

  it('prefers the caller-owned private page for path identity and falls back only on not-found', async () => {
    const getByPath = vi.fn(async input => {
      if (input.visibility === 'private') return page({ id: 44, visibility: 'private', ownerId: 7, path: input.path })
      return page({ path: input.path })
    })
    const { execute } = setup({ getByPath })
    const result = await execute('pages.get', { path: 'docs/start', locale: 'en' })
    expect(result).toMatchObject({ id: 44, path: 'docs/start', content: '# Start' })
    expect(getByPath).toHaveBeenCalledTimes(1)
  })

  it('does not mask authorization or storage failures as a public lookup', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'PAGE_FORBIDDEN' })
    const getByPath = vi.fn(async () => {
      throw denied
    })
    const { execute } = setup({ getByPath })
    await expect(Promise.resolve(execute('pages.get', { path: 'private/notes', locale: 'en' }))).rejects.toBe(denied)
    expect(getByPath).toHaveBeenCalledTimes(1)
  })

  it('preserves API-key principal authorization failures for private pages', async () => {
    const apiPrincipal = { id: 9, permissions: ['use:mcp', 'read:pages'], groups: [6] } as Express.User
    const denied = Object.assign(new Error('private page is not visible to this API key'), { code: 'PAGE_FORBIDDEN' })
    const get = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.requester).toBe(apiPrincipal)
      throw denied
    })
    const kernel = new ActionKernel()
    registerPageReadActions(kernel, {
      operations: {
        search: async () => ({ results: [], suggestions: [], totalHits: 0, windowLimit: 100, windowTruncated: false }),
        searchTags: async () => [],
        listTags: async () => [],
        discover: async () => ({ pages: [], totalInWindow: 0, windowLimit: 5_000, nextOffset: null }),
        get,
        getByPath: async () => {
          throw denied
        },
        listRecent: async () => [],
        getHistory: async () => ({ trail: [], total: 0 }),
        getVersion: async () => null,
        listLinks: async () => [],
        listRelated: async () => ({ pages: [], truncated: false, nextOffset: null })
      },
      resolveRequester: async () => apiPrincipal,
      snapshotSigningSecret: Buffer.alloc(32, 4)
    })
    const apiAdmission = { ...admission, transport: 'mcp' as const, permissions: ['use:mcp', 'read:pages'], groupIds: [6] }
    const apiAuth = { kind: 'apiKey', apiKeyId: 11, groupId: 6, ownershipUserId: null, principal: apiPrincipal } as const
    await expect(
      Promise.resolve(
        kernel.execute({
          authority: createActionAuthority('pages.get', requestId, apiAuth, apiAdmission),
          actionCallId,
          input: { id: 42 },
          signal: new AbortController().signal,
          refreshAdmission: async () => apiAdmission
        })
      )
    ).rejects.toBe(denied)
    expect(get).toHaveBeenCalledOnce()
  })

  it('accepts an explicit null continuation token for an initial patch snapshot', async () => {
    const { execute } = setup({ get: async () => page({ content: 'one\ntwo\n' }) })
    expect(await execute('pages.readForPatch', { pageId: 42, previousSnapshotToken: null })).toMatchObject({
      version: 'wiki-line-snapshot-v1',
      disclosed: [{ startLine: 1, endLine: 2 }]
    })
  })

  it('issues signed bounded patch snapshots and unions disclosures for the same request', async () => {
    const source = 'one\ntwo\nthree\n'
    const { execute } = setup({ get: async () => page({ content: source }) })
    const first = (await execute('pages.readForPatch', { pageId: 42, ranges: [{ startLine: 1, endLine: 1 }] })) as {
      snapshotToken: string
      documentTag: string
      disclosed: Array<{ startLine: number; endLine: number }>
    }
    expect(first).toMatchObject({
      version: 'wiki-line-snapshot-v1',
      documentTag: expect.stringMatching(/^[a-f0-9]{12}$/),
      disclosed: [{ startLine: 1, endLine: 1 }]
    })
    const second = (await execute('pages.readForPatch', {
      pageId: 42,
      ranges: [{ startLine: 3, endLine: 3 }],
      previousSnapshotToken: first.snapshotToken
    })) as { disclosed: Array<{ startLine: number; endLine: number }> }
    expect(second.disclosed.map(range => [range.startLine, range.endLine])).toEqual([
      [1, 1],
      [3, 3]
    ])
  })

  it('rejects patch snapshots for non-Markdown pages', async () => {
    const { execute } = setup({ get: async () => page({ contentType: 'html' }) })
    await expect(Promise.resolve(execute('pages.readForPatch', { pageId: 42 }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' })
  })
  it('hydrates recent pages, applies locale and caller bounds, and preserves authorization requester', async () => {
    const { execute, operations } = setup({
      listRecent: vi.fn(async () => [{ id: 42 }, { id: 43 }]),
      get: async input => (input.id === 42 ? page() : page({ id: 43, localeCode: 'fr', path: 'fr/start' }))
    })
    expect(await execute('pages.listRecent', { locale: 'en', limit: 2 })).toEqual({
      pages: [
        {
          id: 42,
          locale: 'en',
          path: 'docs/start',
          title: 'Start',
          description: '',
          contentType: 'markdown',
          sourceRevision: '8',
          authority: { state: 'missing', metadata: null, trust: null },
          okfResourceUri: 'wiki://pages/42/versions/current/revisions/8/okf',
          citation: { evidenceId: 'page:42:revision:8', label: 'Start', href: '/en/docs/start' },
          knowledge: null
        }
      ]
    })
    expect(operations.listRecent).toHaveBeenCalledWith(principal)
  })

  it('maps source-revision history and exact historical page content', async () => {
    const { execute } = setup({
      getHistory: async () => ({
        trail: [{ versionId: 9, sourceRevision: '6', actionType: 'edit', versionDate: '2026-08-16T00:00:00.000Z', authorName: 'Editor' }],
        total: 1
      }),
      getVersion: async () => page({ id: undefined, pageId: 42, sourceRevision: 6, versionDate: '2026-08-16T00:00:00.000Z' })
    })
    expect(await execute('pages.listHistory', { pageId: 42, limit: 10 })).toEqual({
      versions: [
        {
          id: 9,
          sourceRevision: '6',
          resourceUri: 'wiki://pages/42/versions/9/revisions/6/okf',
          action: 'edit',
          versionDate: '2026-08-16T00:00:00.000Z',
          authorName: 'Editor'
        }
      ]
    })
    expect(await execute('pages.getVersion', { pageId: 42, versionId: 9 })).toMatchObject({
      id: 42,
      versionId: 9,
      sourceRevision: '6',
      content: '# Start',
      authority: { state: 'missing', metadata: null, trust: null },
      okfResourceUri: 'wiki://pages/42/versions/9/revisions/6/okf',
      citation: { evidenceId: 'page:42:revision:6', label: 'Start', href: '/en/docs/start?v=9' }
    })
  })

  it('lists only bounded authorized link rows for the requested page', async () => {
    const { execute } = setup({
      listLinks: async () => [{ id: 42, links: ['en/docs/next', 'https://example.test/reference'] }]
    })
    expect(await execute('pages.listLinks', { pageId: 42, limit: 1 })).toEqual({
      links: [{ label: 'en/docs/next', target: 'en/docs/next', kind: 'page' }],
      truncated: true
    })
  })

  it('continues cited graph traversal with a principal-bound opaque cursor', async () => {
    const { execute, operations } = setup({
      get: async input => page(Number(input.id) === 43 ? { id: 43, path: 'docs/next', title: 'Next', tags: [{ tag: 'Runbook' }] } : {}),
      listRelated: vi.fn(async input =>
        Number(input.offset) === 0
          ? {
              pages: [
                page({
                  id: 43,
                  path: 'docs/next',
                  title: 'Next',
                  tags: [{ tag: 'Runbook' }],
                  distance: 2,
                  direction: 'incoming',
                  viaPageId: 41
                })
              ],
              truncated: true,
              nextOffset: 1
            }
          : { pages: [], truncated: false, nextOffset: null }
      )
    })
    const first = (await execute('pages.related', { pageId: 42, limit: 1, cursor: null })) as {
      pages: Array<Record<string, unknown>>
      nextCursor: string | null
    }
    expect(first).toEqual({
      pages: [
        {
          id: 43,
          locale: 'en',
          path: 'docs/next',
          title: 'Next',
          description: '',
          contentType: 'markdown',
          sourceRevision: '8',
          authority: { state: 'missing', metadata: null, trust: null },
          okfResourceUri: 'wiki://pages/43/versions/current/revisions/8/okf',
          citation: { evidenceId: 'page:43:revision:8', label: 'Next', href: '/en/docs/next' },
          tags: ['runbook'],
          distance: 2,
          direction: 'incoming',
          viaPageId: 41,
          knowledge: null
        }
      ],
      nextCursor: expect.any(String)
    })
    expect(await execute('pages.related', { pageId: 42, limit: 1, cursor: first.nextCursor })).toEqual({
      pages: [],
      nextCursor: null
    })
    await expect(Promise.resolve(execute('pages.related', { pageId: 42, limit: 1, cursor: `${first.nextCursor}x` }))).rejects.toMatchObject({
      code: 'INVALID_RELATED_CURSOR'
    })
    expect(operations.listRelated).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageId: 42, limit: 1, offset: 0, requester: principal }))
    expect(operations.listRelated).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageId: 42, limit: 1, offset: 1, requester: principal }))
  })

  it('skips locked related candidates before loading their derived knowledge', async () => {
    const getCurrentMany = vi.fn(async () => new Map([[43, knowledgeProjection({ sourceRevision: '8' })]]))
    const { execute } = setup(
      {
        get: async () => {
          throw new PageLocked()
        },
        listRelated: async () => ({
          pages: [
            page({
              id: 43,
              path: 'docs/protected',
              title: 'Protected',
              distance: 1,
              direction: 'outgoing',
              viaPageId: 42
            })
          ],
          truncated: false,
          nextOffset: null
        })
      },
      { getCurrent: async () => null, getRevision: async () => null, getCurrentMany }
    )

    expect(await execute('pages.related', { pageId: 42, limit: 1, cursor: null })).toEqual({ pages: [], nextCursor: null })
    expect(getCurrentMany).toHaveBeenCalledWith([])
  })

  it('fences stale related candidates before loading their derived knowledge', async () => {
    const getCurrentMany = vi.fn(async () => new Map([[43, knowledgeProjection({ sourceRevision: '9' })]]))
    const { execute } = setup(
      {
        get: async () => page({ id: 43, path: 'docs/next', title: 'Next', sourceRevision: '9' }),
        listRelated: async () => ({
          pages: [
            page({
              id: 43,
              path: 'docs/next',
              title: 'Next',
              sourceRevision: '8',
              distance: 1,
              direction: 'outgoing',
              viaPageId: 42
            })
          ],
          truncated: false,
          nextOffset: null
        })
      },
      { getCurrent: async () => null, getRevision: async () => null, getCurrentMany }
    )

    expect(await execute('pages.related', { pageId: 42, limit: 1, cursor: null })).toEqual({ pages: [], nextCursor: null })
    expect(getCurrentMany).toHaveBeenCalledWith([])
  })
})
