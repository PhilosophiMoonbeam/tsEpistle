import { beforeEach, describe, expect, it, vi } from 'vitest'
const listPageIndexCandidates = vi.hoisted(() => vi.fn())
vi.mock('../../repositories/page-index.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../repositories/page-index.ts')>()
  return { ...actual, listPageIndexCandidates }
})


const rows = [
  {
    id: 1,
    path: 'guide/intro',
    localeCode: 'en',
    title: 'Introduction',
    description: 'Start here',
    visibility: 'public',
    ownerId: null,
    updatedAt: new Date('2026-08-14T00:00:00.000Z'),
    tags: [{ tag: 'docs' }]
  },
  {
    id: 2,
    path: 'guide/private',
    localeCode: 'en',
    title: 'Private notes',
    description: null,
    visibility: 'private',
    ownerId: 7,
    updatedAt: new Date('2026-08-15T00:00:00.000Z'),
    tags: []
  },
  {
    id: 3,
    path: 'guide/secret',
    localeCode: 'en',
    title: 'Denied by rule',
    description: null,
    visibility: 'public',
    ownerId: null,
    updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    tags: [{ tag: 'secret' }]
  },
  {
    id: 4,
    path: 'guide/deep/topic',
    localeCode: 'en',
    title: 'Deep topic',
    description: null,
    visibility: 'public',
    ownerId: null,
    updatedAt: new Date('2026-08-13T00:00:00.000Z'),
    tags: []
  },
  {
    id: 5,
    path: 'elsewhere/page',
    localeCode: 'en',
    title: 'Elsewhere',
    description: null,
    visibility: 'public',
    ownerId: null,
    updatedAt: new Date('2026-08-12T00:00:00.000Z'),
    tags: []
  }
]

const queryBuilder = () => {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {}
  builder.where = vi.fn((...args: unknown[]) => {
    if (typeof args[0] === 'function') args[0](builder)
    return builder
  })
  builder.whereRaw = vi.fn().mockReturnValue(builder)
  builder.orWhere = vi.fn().mockReturnValue(builder)
  builder.orderBy = vi.fn().mockReturnValue(builder)
  builder.limit = vi.fn().mockReturnValue(builder)
  return builder
}


describe('page index operation', () => {
  beforeEach(() => {
    vi.resetModules()
    listPageIndexCandidates.mockReset()
  })

  it('filters ownership, page rules, path, and depth before applying the result limit', async () => {
    const builder = queryBuilder()
    const knex = vi.fn()
    listPageIndexCandidates.mockImplementation(async (_knex, input) => {
      input.scope(builder)
      return rows
    })
    Reflect.set(globalThis, 'WIKI', {
      auth: {
        checkAccess: vi.fn((user: { permissions?: string[] } | undefined, permissions: string[], context?: { path?: string }) =>
          permissions.includes('manage:system')
            ? Boolean(user?.permissions?.includes('manage:system'))
            : context?.path !== 'guide/secret'
        )
      },
      models: { knex }
    })
    const operations = (await import('../../operations/pages.ts')).default

    const result = await operations.listIndex({
      requester: { id: 7, permissions: ['read:pages'] },
      path: 'guide',
      locale: 'en',
      depth: 0,
      order: 'title',
      limit: 20
    })

    expect(result).toEqual([
      expect.objectContaining({ id: 1, title: 'Introduction', href: '/en/guide/intro' }),
      expect.objectContaining({ id: 2, title: 'Private notes', href: '/_private/en/guide/private' })
    ])
    expect(listPageIndexCandidates).toHaveBeenCalledWith(knex, expect.objectContaining({
      locale: 'en',
      path: 'guide',
      limit: 5_001
    }))
    expect(builder.where).toHaveBeenCalledWith(expect.any(Function))
    expect(builder.where).toHaveBeenCalledWith('pages.visibility', 'public')
    expect(builder.orWhere).toHaveBeenCalledWith({ 'pages.visibility': 'private', 'pages.ownerId': 7 })
  })

  it('includes bounded descendants and never exposes another owner’s private page', async () => {
    listPageIndexCandidates.mockResolvedValue(rows)
    Reflect.set(globalThis, 'WIKI', {
      auth: { checkAccess: vi.fn((_user, permissions: string[]) => !permissions.includes('manage:system')) },
      models: { knex: vi.fn() }
    })
    const operations = (await import('../../operations/pages.ts')).default

    const result = await operations.listIndex({
      requester: { id: 9, permissions: ['read:pages'] },
      path: 'guide',
      locale: 'en',
      depth: 1,
      order: 'path',
      limit: 2
    })

    expect(result.map(item => item.path)).toEqual(['guide/deep/topic', 'guide/intro'])
    expect(result.some(item => item.path === 'guide/private')).toBe(false)
    expect(result.some(item => item.path === 'elsewhere/page')).toBe(false)
  })

  it('rejects a query that reaches the 5,001-candidate repository ceiling', async () => {
    const candidates = Array.from({ length: 5_001 }, (_, index) => ({
      ...rows[0],
      id: index + 1,
      path: `guide/page-${index + 1}`
    }))
    listPageIndexCandidates.mockResolvedValue(candidates)
    Reflect.set(globalThis, 'WIKI', {
      auth: { checkAccess: vi.fn(() => true) },
      models: { knex: vi.fn() }
    })
    const operations = (await import('../../operations/pages.ts')).default

    await expect(operations.listIndex({
      requester: { id: 7, permissions: ['read:pages'] },
      path: 'guide',
      locale: 'en',
      depth: 0,
      order: 'path',
      limit: 200
    })).rejects.toMatchObject({ name: 'PAGE_INDEX_TOO_BROAD', status: 422 })
  })

  it.each([
    [{ path: 'guide', locale: 'en', depth: 6, order: 'path', limit: 20 }, /depth must not exceed 5/],
    [{ path: 'guide', locale: 'en', depth: 0, order: 'random', limit: 20 }, /order must be/],
    [{ path: 'guide', locale: 'en', depth: 0, order: 'path', limit: 201 }, /limit must not exceed 200/]
  ])('rejects unbounded query controls', async (input, diagnostic) => {
    listPageIndexCandidates.mockResolvedValue(rows)
    Reflect.set(globalThis, 'WIKI', {
      auth: { checkAccess: vi.fn(() => true) },
      models: { knex: vi.fn() }
    })
    const operations = (await import('../../operations/pages.ts')).default

    await expect(operations.listIndex({ requester: { id: 7 }, ...input })).rejects.toThrow(diagnostic)
  })
})
