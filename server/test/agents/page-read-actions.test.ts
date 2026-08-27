import { describe, expect, it, vi } from 'vitest'

import { AGENT_FEATURE_FLAG_KEYS, type AgentActionName, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ActionKernel, createActionAuthority, type ActionAdmissionSnapshot } from '../../agents/actions/kernel.ts'
import { registerPageReadActions } from '../../agents/actions/page-reads.ts'

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

class PageNotFound extends Error {
  readonly code = 'PAGE_NOT_FOUND'
}

const setup = (overrides: Partial<{
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
}> = {}) => {
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
  registerPageReadActions(kernel, { operations, resolveRequester, snapshotSigningSecret: Buffer.alloc(32, 3) })
  const execute = (name: AgentActionName, input: unknown) => kernel.execute({
    authority: createActionAuthority(name, requestId, auth, admission),
    actionCallId,
    input,
    signal: new AbortController().signal,
    refreshAdmission: async () => admission
  })
  return { execute, operations, resolveRequester }
}

describe('permission-safe page read actions', () => {
  it('returns bounded hydrated search results without protected model fields', async () => {
    const { execute, operations } = setup({
      search: vi.fn(async () => ({
        results: [
          { path: 'docs/start', locale: 'en', visibility: 'public', tags: ['runbook'], score: 12.5, matchedFields: ['tag', 'graph'] },
          { path: 'private/notes', locale: 'en', visibility: 'private' },
          { path: 'deleted', locale: 'en', visibility: 'public' }
        ],
        suggestions: ['notes'],
        totalHits: 3,
        windowLimit: 150,
        windowTruncated: true
      })),
      getByPath: async input => {
        if (input.path === 'deleted') throw new PageNotFound()
        return input.visibility === 'private'
          ? page({ id: 43, path: 'private/notes', visibility: 'private', ownerId: 7, sourceRevision: 2 })
          : page()
      }
    })
    await expect(execute('pages.search', { query: 'notes', path: 'docs', limit: 3, offset: 0 })).resolves.toEqual({
      results: [
        { id: 42, locale: 'en', path: 'docs/start', title: 'Start', description: '', contentType: 'markdown', sourceRevision: '8', citation: { evidenceId: 'page:42', label: 'Start', href: '/en/docs/start' }, tags: ['runbook'], score: 12.5, matchedFields: ['tag', 'graph'] },
        { id: 43, locale: 'en', path: 'private/notes', title: 'Start', description: '', contentType: 'markdown', sourceRevision: '2', citation: { evidenceId: 'page:43', label: 'Start', href: '/_private/en/private/notes' }, tags: [], score: 0, matchedFields: [] }
      ],
      suggestions: ['notes'],
      totalInWindow: 3,
      windowLimit: 150,
      windowTruncated: true,
      nextOffset: null
    })
    expect(operations.search).toHaveBeenCalledWith(expect.objectContaining({ requester: principal, path: 'docs', limit: 3 }))
  })

  it('searches and pages the visible tag taxonomy', async () => {
    const { execute, operations } = setup({
      searchTags: vi.fn(async () => ['runbook', 'release']),
      listTags: vi.fn(async () => [
        { tag: 'Runbook', title: 'Operational runbooks' },
        { tag: 'Release', title: null }
      ])
    })
    await expect(execute('pages.searchTags', { query: 'run', limit: 1 })).resolves.toEqual({ tags: ['runbook'] })
    await expect(execute('pages.listTags', { limit: 1, offset: 0 })).resolves.toEqual({
      tags: [{ tag: 'Release', title: null }],
      nextOffset: 1
    })
    expect(operations.searchTags).toHaveBeenCalledWith({ query: 'run', limit: 1, requester: principal })
    expect(operations.listTags).toHaveBeenCalledWith(principal)
  })

  it('hydrates structured path and tag discovery results', async () => {
    const { execute, operations } = setup({
      discover: vi.fn(async () => ({
        pages: [{
          id: 42,
          locale: 'en',
          path: 'docs/start',
          title: 'Start',
          description: null,
          updatedAt: new Date('2026-08-17T00:00:00.000Z'),
          tags: ['Runbook']
        }],
        totalInWindow: 1,
        windowLimit: 5_000,
        nextOffset: null
      }))
    })
    await expect(execute('pages.discover', { locale: 'en', path: 'docs', tags: ['runbook'], limit: 10, offset: 0 })).resolves.toEqual({
      pages: [{
        id: 42,
        locale: 'en',
        path: 'docs/start',
        title: 'Start',
        description: '',
        contentType: 'markdown',
        sourceRevision: '8',
        citation: { evidenceId: 'page:42', label: 'Start', href: '/en/docs/start' },
        tags: ['runbook'],
        updatedAt: '2026-08-17T00:00:00.000Z'
      }],
      totalInWindow: 1,
      windowLimit: 5_000,
      nextOffset: null
    })
    expect(operations.discover).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', path: 'docs', depth: 1, order: 'path', requester: principal }))
  })

  it('exposes canonical rendered heading anchors as precise citation destinations', async () => {
    const toc = JSON.stringify([{
      title: 'Start',
      anchor: '#start',
      children: [{ title: 'Installation', anchor: '#installation', children: [] }]
    }])
    const { execute } = setup({ get: async () => page({ toc }) })

    await expect(execute('pages.get', { id: 42 })).resolves.toMatchObject({
      citation: { evidenceId: 'page:42', label: 'Start', href: '/en/docs/start' },
      citationSections: [
        { evidenceId: 'page:42:section:1', label: 'Start', href: '/en/docs/start#start' },
        { evidenceId: 'page:42:section:2', label: 'Start › Installation', href: '/en/docs/start#installation' }
      ]
    })
  })

  it('exports visible Markdown pages as deterministic OKF concepts with trust metadata', async () => {
    const { execute } = setup({
      get: async () => page({
        content: '# Start\n\nSee [Next](/en/docs/next).\n',
        tags: [{ tag: 'runbook' }],
        extra: {
          okf: {
            type: 'Reference',
            status: 'stable',
            generated: { by: 'process:import', at: '2026-08-16T00:00:00.000Z' },
            verified: { by: 'human:7', at: '2026-08-17T00:00:00.000Z' },
            producer_extension: { retained: true }
          }
        }
      })
    })

    const result = await execute('pages.getOkf', { id: 42 }) as Record<string, unknown>
    expect(result).toMatchObject({
      id: 42,
      locale: 'en',
      path: 'docs/start',
      sourceRevision: '8',
      version: '0.2',
      conceptId: 'en/docs/start',
      filePath: 'en/docs/start.md',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      metadata: expect.objectContaining({ producer_extension: { retained: true } }),
      trust: {
        trustTier: 'human-reviewed',
        verification: 'current',
        status: 'stable',
        stale: false,
        generatedAt: '2026-08-16T00:00:00.000Z',
        verifiedAt: '2026-08-17T00:00:00.000Z'
      }
    })
    expect(String(result.markdown)).toContain('[Next](/en/docs/next.md)')
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
    const getByPath = vi.fn(async () => { throw denied })
    const { execute } = setup({ getByPath })
    await expect(execute('pages.get', { path: 'private/notes', locale: 'en' })).rejects.toBe(denied)
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
        getByPath: async () => { throw denied },
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
    await expect(kernel.execute({
      authority: createActionAuthority('pages.get', requestId, apiAuth, apiAdmission),
      actionCallId,
      input: { id: 42 },
      signal: new AbortController().signal,
      refreshAdmission: async () => apiAdmission
    })).rejects.toBe(denied)
    expect(get).toHaveBeenCalledOnce()
  })

  it('accepts an explicit null continuation token for an initial patch snapshot', async () => {
    const { execute } = setup({ get: async () => page({ content: 'one\ntwo\n' }) })
    await expect(execute('pages.readForPatch', { pageId: 42, previousSnapshotToken: null })).resolves.toMatchObject({
      version: 'wiki-line-snapshot-v1',
      disclosed: [{ startLine: 1, endLine: 2 }]
    })
  })

  it('issues signed bounded patch snapshots and unions disclosures for the same request', async () => {
    const source = 'one\ntwo\nthree\n'
    const { execute } = setup({ get: async () => page({ content: source }) })
    const first = await execute('pages.readForPatch', { pageId: 42, ranges: [{ startLine: 1, endLine: 1 }] }) as {
      snapshotToken: string
      documentTag: string
      disclosed: Array<{ startLine: number; endLine: number }>
    }
    expect(first).toMatchObject({
      version: 'wiki-line-snapshot-v1',
      documentTag: expect.stringMatching(/^[a-f0-9]{12}$/),
      disclosed: [{ startLine: 1, endLine: 1 }]
    })
    const second = await execute('pages.readForPatch', {
      pageId: 42,
      ranges: [{ startLine: 3, endLine: 3 }],
      previousSnapshotToken: first.snapshotToken
    }) as { disclosed: Array<{ startLine: number; endLine: number }> }
    expect(second.disclosed.map(range => [range.startLine, range.endLine])).toEqual([[1, 1], [3, 3]])
  })

  it('rejects patch snapshots for non-Markdown pages', async () => {
    const { execute } = setup({ get: async () => page({ contentType: 'html' }) })
    await expect(execute('pages.readForPatch', { pageId: 42 })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' })
  })
  it('hydrates recent pages, applies locale and caller bounds, and preserves authorization requester', async () => {
    const { execute, operations } = setup({
      listRecent: vi.fn(async () => [{ id: 42 }, { id: 43 }]),
      get: async input => input.id === 42 ? page() : page({ id: 43, localeCode: 'fr', path: 'fr/start' })
    })
    await expect(execute('pages.listRecent', { locale: 'en', limit: 2 })).resolves.toEqual({
      pages: [{ id: 42, locale: 'en', path: 'docs/start', title: 'Start', description: '', contentType: 'markdown', sourceRevision: '8', citation: { evidenceId: 'page:42', label: 'Start', href: '/en/docs/start' } }]
    })
    expect(operations.listRecent).toHaveBeenCalledWith(principal)
  })

  it('maps source-revision history and exact historical page content', async () => {
    const { execute } = setup({
      getHistory: async () => ({ trail: [{ versionId: 9, sourceRevision: '6', actionType: 'edit', versionDate: '2026-08-16T00:00:00.000Z', authorName: 'Editor' }], total: 1 }),
      getVersion: async () => page({ id: undefined, pageId: 42, sourceRevision: 6, versionDate: '2026-08-16T00:00:00.000Z' })
    })
    await expect(execute('pages.listHistory', { pageId: 42, limit: 10 })).resolves.toEqual({
      versions: [{ id: 9, sourceRevision: '6', action: 'edit', versionDate: '2026-08-16T00:00:00.000Z', authorName: 'Editor' }]
    })
    await expect(execute('pages.getVersion', { pageId: 42, versionId: 9 })).resolves.toMatchObject({
      id: 42,
      versionId: 9,
      sourceRevision: '6',
      content: '# Start',
      citation: { evidenceId: 'page:42', label: 'Start', href: '/en/docs/start?v=9' }
    })
  })

  it('lists only bounded authorized link rows for the requested page', async () => {
    const { execute } = setup({
      listLinks: async () => [{ id: 42, links: ['en/docs/next', 'https://example.test/reference'] }]
    })
    await expect(execute('pages.listLinks', { pageId: 42, limit: 1 })).resolves.toEqual({
      links: [{ label: 'en/docs/next', target: 'en/docs/next', kind: 'page' }],
      truncated: true
    })
  })

  it('continues cited graph traversal with a principal-bound opaque cursor', async () => {
    const { execute, operations } = setup({
      listRelated: vi.fn(async input => Number(input.offset) === 0
        ? {
            pages: [page({
              id: 43,
              path: 'docs/next',
              title: 'Next',
              tags: [{ tag: 'Runbook' }],
              distance: 2,
              direction: 'incoming',
              viaPageId: 41
            })],
            truncated: true,
            nextOffset: 1
          }
        : { pages: [], truncated: false, nextOffset: null })
    })
    const first = await execute('pages.related', { pageId: 42, limit: 1, cursor: null }) as {
      pages: Array<Record<string, unknown>>
      nextCursor: string | null
    }
    expect(first).toEqual({
      pages: [{
        id: 43,
        locale: 'en',
        path: 'docs/next',
        title: 'Next',
        description: '',
        contentType: 'markdown',
        sourceRevision: '8',
        citation: { evidenceId: 'page:43', label: 'Next', href: '/en/docs/next' },
        tags: ['runbook'],
        distance: 2,
        direction: 'incoming',
        viaPageId: 41
      }],
      nextCursor: expect.any(String)
    })
    await expect(execute('pages.related', { pageId: 42, limit: 1, cursor: first.nextCursor })).resolves.toEqual({
      pages: [],
      nextCursor: null
    })
    await expect(execute('pages.related', { pageId: 42, limit: 1, cursor: `${first.nextCursor}x` })).rejects.toMatchObject({ code: 'INVALID_RELATED_CURSOR' })
    expect(operations.listRelated).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageId: 42, limit: 1, offset: 0, requester: principal }))
    expect(operations.listRelated).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageId: 42, limit: 1, offset: 1, requester: principal }))
  })
})
