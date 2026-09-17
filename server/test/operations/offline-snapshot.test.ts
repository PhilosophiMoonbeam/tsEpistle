import { afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { evaluateGroupAccess, type AccessPage, type PageRuleAuthority } from '../../helpers/group-access.ts'

const assertPageUnlocked = vi.fn(async () => {})
const protectedAssetRequiresUnlock = vi.fn(async () => false)
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({ assertPageUnlocked, pageRequiresUnlock: vi.fn(async () => false), protectedAssetRequiresUnlock }))

type SnapshotOperations = {
  getOfflineSnapshot(input: { id: number; requester?: unknown }): Promise<Record<string, unknown> & { content: { html: string } }>
}

type Query = {
  select: ReturnType<typeof vi.fn>
  where: ReturnType<typeof vi.fn>
  first: ReturnType<typeof vi.fn>
  join: ReturnType<typeof vi.fn>
  orderBy: ReturnType<typeof vi.fn>
  then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise<unknown>
}

let operations: SnapshotOperations
let page: Record<string, unknown>
let protectedPage = false
let guest: Record<string, unknown>
let usersQuery: ReturnType<typeof vi.fn>
let loadPageRuleAuthority: ReturnType<typeof vi.fn>
let transaction: ReturnType<typeof vi.fn>

const originalWiki = Reflect.get(globalThis, 'WIKI')

const queryFor = (value: unknown): Query => {
  const query = {
    select: vi.fn(),
    where: vi.fn(),
    first: vi.fn(),
    join: vi.fn(),
    orderBy: vi.fn(),
    then: (resolve: (result: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(value).then(resolve, reject)
  } as Query
  query.select.mockReturnValue(query)
  query.where.mockReturnValue(query)
  query.join.mockReturnValue(query)
  query.orderBy.mockReturnValue(query)
  query.first.mockResolvedValue(value)
  return query
}

const userLookupFor = (
  value: Record<string, unknown>
): Promise<Record<string, unknown>> & {
  withGraphJoined: ReturnType<typeof vi.fn>
  modifyGraph: ReturnType<typeof vi.fn>
} => {
  const lookup = Promise.resolve(value) as Promise<Record<string, unknown>> & {
    withGraphJoined: ReturnType<typeof vi.fn>
    modifyGraph: ReturnType<typeof vi.fn>
  }
  lookup.withGraphJoined = vi.fn(() => lookup)
  lookup.modifyGraph = vi.fn((_relation: string, callback: (builder: { select: ReturnType<typeof vi.fn> }) => void) => {
    callback({ select: vi.fn() })
    return lookup
  })
  return lookup
}

const basePage = (): Record<string, unknown> => ({
  id: 7,
  path: 'docs/alpha',
  localeCode: 'en',
  title: 'Alpha',
  description: 'Public page',
  visibility: 'public',
  ownerId: null,
  tags: [{ tag: 'safe' }],
  isPublished: true,
  publishStartDate: null,
  publishEndDate: null,
  contentType: 'markdown',
  editorKey: 'markdown',
  render: '<p>Readable offline content</p>',
  sourceRevision: '8',
  renderedSourceRevision: '8',
  extra: { customMetadata: 'must not be persisted' }
})
beforeEach(async () => {
  vi.resetModules()
  assertPageUnlocked.mockClear()
  protectedAssetRequiresUnlock.mockClear()
  page = basePage()
  protectedPage = false
  guest = {
    id: 2,
    isActive: true,
    groups: [],
    getGlobalPermissions: vi.fn(() => ['read:pages'])
  }
  usersQuery = vi.fn(() => ({ findById: vi.fn(() => userLookupFor(guest)) }))
  loadPageRuleAuthority = vi.fn(async (requester: Record<string, unknown>) => ({
    requester,
    permissions: ['read:pages'],
    groups: [
      {
        id: 1,
        pageRules: [{ match: 'TAG', path: 'safe', deny: false, roles: ['read:pages'] }]
      }
    ],
    tagAliases: { safe: 'safe' }
  }))

  transaction = vi.fn((table: string) => {
    if (table === 'pages') return queryFor(page)
    if (table === 'pageTags') return queryFor([{ tag: 'safe' }])
    if (table === 'pageAccessPasswords') return queryFor(protectedPage ? { pageId: 7 } : undefined)
    throw new Error(`Unexpected offline snapshot table: ${table}`)
  })
  const knex = {
    transaction: vi.fn(async (callback: (connection: typeof transaction) => Promise<unknown>) => callback(transaction))
  }
  globalThis.WIKI = {
    auth: {
      checkPageAccess: vi.fn(
        (requester: unknown, permissions: readonly string[], context: unknown, authority: PageRuleAuthority) =>
          requester === authority.requester &&
          evaluateGroupAccess(authority.permissions, permissions, authority.groups, context as AccessPage, authority.tagAliases, false).allowed
      ),
      loadPageRuleAuthority
    },
    config: { db: { type: 'postgres' }, host: 'https://wiki.example.test/', lang: { code: 'en' }, editors: { available: ['markdown'] } },
    data: {},
    models: {
      knex,
      users: { query: usersQuery },
      pages: {},
      tags: {},
      pageHistory: {}
    }
  } as unknown as typeof WIKI
  operations = (await vi.importFresh<{ default: SnapshotOperations }>('../../operations/pages.ts', import.meta.url)).default
  assertPageUnlocked.mockClear()
})

afterAll(() => {
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
})

describe('offline snapshot admission operations', () => {
  it('derives a guest-authorized exhaustive snapshot even when the caller is privileged', async () => {
    const administrator = { id: 1, permissions: ['manage:system', 'read:pages'] }

    const snapshot = await operations.getOfflineSnapshot({ id: 7, requester: administrator })

    expect(usersQuery).toHaveBeenCalledOnce()
    expect(usersQuery.mock.results[0]?.value.findById).toHaveBeenCalledWith(2)
    expect(loadPageRuleAuthority).toHaveBeenCalledWith(guest, transaction)
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      pageId: 7,
      locale: 'en',
      path: 'docs/alpha',
      canonicalPath: '/en/docs/alpha',
      sourceRevision: '8',
      contentType: 'sanitized-html-fragment',
      content: { html: '<p>Readable offline content</p>' },
      searchText: 'Readable offline content'
    })
    expect(Object.keys(snapshot).sort()).toEqual([
      'canonicalPath',
      'capturedAt',
      'content',
      'contentType',
      'description',
      'expiresAt',
      'integrity',
      'locale',
      'pageId',
      'path',
      'schemaVersion',
      'searchText',
      'sourceRevision',
      'title'
    ])
    expect(JSON.stringify(snapshot)).not.toContain('must not be persisted')
  })

  it.each([
    ['unknown', undefined],
    ['null', null],
    ['stale', '7'],
    ['malformed', 'not-a-revision']
  ])('denies %s rendered-source provenance', async (_label: string, renderedSourceRevision: unknown) => {
    page.renderedSourceRevision = renderedSourceRevision

    const failure = operations.getOfflineSnapshot({ id: 7 })
    const error = await failure.catch(value => value as Error)

    expect(error).toMatchObject({ status: 404, code: 'OFFLINE_PAGE_INELIGIBLE' })
  })

  it('resolves relative links from the configured page URL and canonicalizes safe navigation', async () => {
    page.render = [
      '<p>Links</p>',
      '<a href="beta">Sibling</a>',
      '<a href="../parent">Parent</a>',
      '<a href="?q=one#section">Query</a>',
      '<a href="#fragment">Fragment</a>',
      '<a href="https://external.example.test/api">External</a>',
      '<a href="mailto:reader@example.test">Mail</a>'
    ].join('')

    const snapshot = await operations.getOfflineSnapshot({ id: 7 })

    expect(snapshot.content.html).toContain('href="https://wiki.example.test/en/docs/beta"')
    expect(snapshot.content.html).toContain('href="https://wiki.example.test/en/parent"')
    expect(snapshot.content.html).toContain('href="https://wiki.example.test/en/docs/alpha?q=one#section"')
    expect(snapshot.content.html).toContain('href="https://wiki.example.test/en/docs/alpha#fragment"')
    expect(snapshot.content.html).toContain('href="https://external.example.test/api"')
    expect(snapshot.content.html).toContain('href="mailto:reader@example.test"')
    expect(snapshot.content.html).not.toContain('offline.invalid')
    expect(snapshot.content.html).not.toMatch(/<(?:img|script|iframe)\b/iu)
  })

  it.each([
    ['absolute', 'https://wiki.example.test/api/secret'],
    ['relative', '/api/secret'],
    ['encoded', '/%61pi/secret'],
    ['normalized', '/docs/../api/secret'],
    ['case-insensitive', '/API/secret']
  ])('rejects %s real-origin reserved links', async (_label: string, href: string) => {
    page.render = `<p><a href="${href}">Reserved</a></p>`

    const failure = operations.getOfflineSnapshot({ id: 7 })
    const error = await failure.catch(value => value as Error)

    expect(error).toMatchObject({ status: 404, code: 'OFFLINE_PAGE_INELIGIBLE' })
  })

  it.each([
    [
      'private pages',
      () => {
        page.visibility = 'private'
        page.ownerId = 1
      }
    ],
    [
      'protected pages',
      () => {
        protectedPage = true
      }
    ],
    [
      'custom script projections',
      () => {
        page.extra = { js: 'window.privateProjection = true' }
      }
    ],
    [
      'unpublished pages',
      () => {
        page.isPublished = false
      }
    ],
    [
      'unsupported editors',
      () => {
        page.editorKey = 'html'
      }
    ],
    [
      'rule-denied pages',
      () => {
        loadPageRuleAuthority.mockImplementation(async requester => ({
          requester,
          permissions: ['read:pages'],
          groups: [
            {
              id: 1,
              pageRules: [{ match: 'TAG', path: 'safe', deny: true, roles: ['read:pages'] }]
            }
          ],
          tagAliases: { safe: 'safe' }
        }))
      }
    ]
  ])('fails closed for %s without returning source material', async (_label: string, mutate: () => void) => {
    mutate()

    const failure = operations.getOfflineSnapshot({ id: 7, requester: { id: 1, permissions: ['manage:system'] } })
    const error = await failure.catch(value => value as Error)

    expect(error).toMatchObject({ status: 404, code: 'OFFLINE_PAGE_INELIGIBLE' })
    expect(String(error)).not.toContain('privateProjection')
  })

  it('uses the same eligibility error for an absent page', async () => {
    page = undefined as unknown as Record<string, unknown>

    const failure = operations.getOfflineSnapshot({ id: 7 })
    const error = await failure.catch(value => value as Error)

    expect(error).toMatchObject({ status: 404, code: 'OFFLINE_PAGE_INELIGIBLE' })
  })

  it('keeps unavailable guest authority on the infrastructure path', async () => {
    guest.isActive = false

    const failure = operations.getOfflineSnapshot({ id: 7 })
    const error = await failure.catch(value => value as Error)

    expect(error).toMatchObject({ code: 'OFFLINE_PAGE_AUTHORITY_UNAVAILABLE' })
    expect(error).not.toHaveProperty('status')
  })
})
