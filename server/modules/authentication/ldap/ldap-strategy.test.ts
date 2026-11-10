import { describe, expect, it, vi } from '../../../test/bun-test.mts'
import type { ClientOptions, Entry, SearchOptions, SearchResult } from 'ldapts'
import { LdapStrategy, type LdapClient, type LdapRequest, type LdapServerOptions } from './ldap-strategy.ts'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createClient = (searchEntries: Entry[] = [], groupPages: readonly (SearchResult | Error)[] = []) => {
  const client = {
    bind: vi.fn(async () => undefined),
    search: vi.fn(async (): Promise<SearchResult> => ({ searchEntries, searchReferences: [] })),
    searchPaginated: vi.fn(async function* (_baseDN: string, options?: SearchOptions) {
      for (const page of groupPages) {
        if (page instanceof Error) {
          // ldapts treats an explicit sizeLimit as permission to return truncated results.
          if (page.name === 'SizeLimitExceededError' && options?.sizeLimit !== undefined) return
          throw page
        }
        yield page
      }
    }),
    unbind: vi.fn(async () => undefined)
  }
  return client satisfies LdapClient
}

const createRequest = (email = 'alice', password = 'secret'): LdapRequest =>
  ({
    body: { email, password },
    query: {},
    params: { strategy: 'ldap' }
  }) as LdapRequest

type AuthenticationOutcome =
  | { kind: 'success'; profile: Record<string, unknown> }
  | { kind: 'fail'; challenge: unknown; status: number | undefined }
  | { kind: 'error'; error: Error }

const userEntry: Entry = { dn: 'uid=alice,ou=users,dc=example,dc=com', uid: 'alice' }
const groupPage = (searchEntries: Entry[] = [], searchReferences: string[] = []): SearchResult => ({
  searchEntries,
  searchReferences
})
const authenticateGroups = async ({
  entry = userEntry,
  pages = [groupPage()],
  userReferences = [],
  server = {}
}: {
  entry?: Entry | null
  pages?: readonly (SearchResult | Error)[]
  userReferences?: string[]
  server?: Partial<LdapServerOptions>
} = {}) => {
  const adminClient = createClient(entry ? [entry] : [], pages)
  // A non-paginated search sees only the first page, never the complete directory.
  const firstPage = pages[0]
  adminClient.search.mockResolvedValueOnce({
    searchEntries: entry ? [entry] : [],
    searchReferences: userReferences
  })
  if (firstPage instanceof Error) {
    adminClient.search.mockRejectedValueOnce(firstPage)
  } else {
    adminClient.search.mockResolvedValue(firstPage ?? groupPage())
  }
  const userClient = createClient()
  const clients = [adminClient, userClient]
  const clientFactory = vi.fn((_options: ClientOptions) => clients.shift()!)
  const result = deferred<AuthenticationOutcome>()
  const verify = vi.fn((_request: LdapRequest, profile: Record<string, unknown>, done: (error: Error | null, user?: Record<string, unknown>) => void) => {
    done(null, profile)
  })
  const strategy = new LdapStrategy(
    {
      server: {
        url: 'ldap://ldap.example.com:389',
        searchBase: 'ou=users,dc=example,dc=com',
        searchFilter: '(uid={{username}})',
        groupSearchBase: 'ou=groups,dc=example,dc=com',
        groupSearchFilter: '(member={{dn}})',
        ...server
      },
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
      clientFactory
    },
    verify
  )
  Object.assign(strategy, {
    success: (profile: Record<string, unknown>) => result.resolve({ kind: 'success', profile }),
    fail: (challenge: unknown, status?: number) => result.resolve({ kind: 'fail', challenge, status }),
    error: (error: Error) => result.resolve({ kind: 'error', error })
  })
  strategy.authenticate(createRequest())
  const outcome = await result.promise
  expect(adminClient.unbind).toHaveBeenCalledTimes(1)
  expect(userClient.unbind).toHaveBeenCalledTimes(clientFactory.mock.calls.length === 2 ? 1 : 0)
  return { outcome, verify, adminClient, userClient, clientFactory }
}

describe('LDAP strategy', () => {
  it('escapes user input, verifies the user bind, and returns groups and binary attributes', async () => {
    const avatar = Buffer.from([1, 2, 3])
    const userEntry: Entry = {
      dn: 'uid=alice,ou=users,dc=example,dc=com',
      uid: 'alice',
      mail: 'alice@example.com',
      jpegPhoto: avatar
    }
    const groupEntry: Entry = { dn: 'cn=editors,ou=groups,dc=example,dc=com', name: 'editors' }
    const adminClient = createClient([userEntry], [groupPage([groupEntry])])
    const userClient = createClient()
    const clients = [adminClient, userClient]
    const clientFactory = vi.fn((_options: ClientOptions) => clients.shift()!)
    const verified = deferred<Record<string, unknown>>()
    const strategy = new LdapStrategy(
      {
        server: {
          url: 'ldaps://ldap.example.com:636',
          bindDn: 'cn=reader,dc=example,dc=com',
          bindCredentials: 'reader-secret',
          searchBase: 'ou=users,dc=example,dc=com',
          searchFilter: '(&(objectClass=person)(uid={{username}}))',
          groupSearchBase: 'ou=groups,dc=example,dc=com',
          groupSearchFilter: '(member={{dn}})',
          groupDnProperty: 'dn',
          groupSearchAttributes: ['name'],
          binaryAttributes: ['jpegPhoto'],
          tlsOptions: { rejectUnauthorized: true, servername: 'ldap.example.com' },
          timeout: 5000,
          connectTimeout: 3000
        },
        usernameField: 'email',
        passwordField: 'password',
        passReqToCallback: true,
        clientFactory
      },
      (_request, profile, done) => {
        verified.resolve(profile)
        done(null, { id: 'wiki-user' })
      }
    )
    const success = vi.fn()
    Object.assign(strategy, { success, fail: vi.fn(), error: verified.reject })

    strategy.authenticate(createRequest('alice*)(uid=*)'))
    const profile = await verified.promise

    expect(adminClient.bind).toHaveBeenCalledWith('cn=reader,dc=example,dc=com', 'reader-secret')
    expect(adminClient.search).toHaveBeenNthCalledWith(
      1,
      'ou=users,dc=example,dc=com',
      expect.objectContaining({
        filter: '(&(objectClass=person)(uid=alice\\2a\\29\\28uid=\\2a\\29))',
        explicitBufferAttributes: ['jpegPhoto']
      })
    )
    expect(userClient.bind).toHaveBeenCalledWith(userEntry.dn, 'secret')
    expect(adminClient.searchPaginated).toHaveBeenCalledWith(
      'ou=groups,dc=example,dc=com',
      expect.objectContaining({
        filter: '(member=uid=alice,ou=users,dc=example,dc=com)',
        attributes: ['name']
      })
    )
    expect(profile).toMatchObject({ _raw: { jpegPhoto: avatar }, _groups: [groupEntry] })
    expect(adminClient.unbind).toHaveBeenCalledTimes(1)
    expect(userClient.unbind).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith({ id: 'wiki-user' }, undefined)
    expect(clientFactory).toHaveBeenCalledTimes(2)
    for (const [options] of clientFactory.mock.calls) {
      expect(options).toMatchObject({
        url: 'ldaps://ldap.example.com:636',
        tlsOptions: { rejectUnauthorized: true, servername: 'ldap.example.com' },
        timeout: 5000,
        connectTimeout: 3000
      })
    }
  })

  it('returns every completed group page over the anonymous search connection', async () => {
    const editors: Entry = { dn: 'cn=editors,dc=example,dc=com', cn: 'editors' }
    const reviewers: Entry = { dn: 'cn=reviewers,dc=example,dc=com', cn: 'reviewers' }
    const { outcome, adminClient, userClient, clientFactory } = await authenticateGroups({
      pages: [groupPage([editors]), groupPage(), groupPage([reviewers])]
    })
    expect(outcome).toEqual({ kind: 'success', profile: { ...userEntry, _groups: [editors, reviewers] } })
    expect(adminClient.bind).not.toHaveBeenCalled()
    expect(userClient.bind).toHaveBeenCalledWith(userEntry.dn, 'secret')
    expect(userClient.search).not.toHaveBeenCalled()
    expect(userClient.searchPaginated).not.toHaveBeenCalled()
    expect(clientFactory).toHaveBeenCalledTimes(2)
  })

  it('accepts a completed empty group search as an authoritative empty membership', async () => {
    const { outcome, verify } = await authenticateGroups({ pages: [groupPage(), groupPage()] })
    expect(outcome).toEqual({ kind: 'success', profile: { ...userEntry, _groups: [] } })
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('leaves the group claim absent when group searching is not configured', async () => {
    const { outcome, verify, adminClient } = await authenticateGroups({
      server: { groupSearchBase: '', groupSearchFilter: '' }
    })
    expect(outcome).toEqual({ kind: 'success', profile: userEntry })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(adminClient.searchPaginated).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'one local user plus a referral', entry: userEntry },
    { label: 'only a referral', entry: null }
  ])('rejects an incomplete user search before password verification: $label', async ({ entry }) => {
    const { outcome, verify, userClient, clientFactory } = await authenticateGroups({
      entry,
      userReferences: ['ldap://other.example.com/ou=users,dc=example,dc=com']
    })
    expect(outcome).toMatchObject({ kind: 'error', error: expect.any(Error) })
    expect(verify).not.toHaveBeenCalled()
    expect(userClient.bind).not.toHaveBeenCalled()
    expect(clientFactory).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'first page', pages: [groupPage([], ['ldap://other.example.com/ou=groups'])] },
    {
      label: 'late page after local groups',
      pages: [groupPage([{ dn: 'cn=editors,dc=example,dc=com', cn: 'editors' }]), groupPage([], ['ldap://other.example.com/ou=groups'])]
    }
  ])('rejects group referrals without publishing partial membership: $label', async ({ pages }) => {
    const { outcome, verify, userClient } = await authenticateGroups({ pages })
    expect(outcome).toMatchObject({ kind: 'error', error: expect.any(Error) })
    expect(verify).not.toHaveBeenCalled()
    expect(userClient.bind).toHaveBeenCalledWith(userEntry.dn, 'secret')
  })

  it.each([
    new Error('LDAP connection closed while reading the next page'),
    Object.assign(new Error('LDAP server size limit exceeded'), { name: 'SizeLimitExceededError' })
  ])('does not publish partial groups when a later page fails: %j', async error => {
    const { outcome, verify } = await authenticateGroups({
      pages: [groupPage([{ dn: 'cn=editors,dc=example,dc=com', cn: 'editors' }]), error]
    })
    expect(outcome).toEqual({ kind: 'error', error })
    expect(verify).not.toHaveBeenCalled()
  })

  it.each([2000, 2001])('enforces the 2000 group ceiling across pages: %i entries', async count => {
    const entries: Entry[] = Array.from({ length: count }, (_, index) => ({
      dn: `cn=group-${index},dc=example,dc=com`,
      cn: `group-${index}`
    }))
    const { outcome, verify } = await authenticateGroups({
      pages: [groupPage(entries.slice(0, 1000)), groupPage(entries.slice(1000, 2000)), groupPage(entries.slice(2000))]
    })
    if (count === 2000) {
      expect(outcome).toEqual({ kind: 'success', profile: { ...userEntry, _groups: entries } })
      expect(verify).toHaveBeenCalledTimes(1)
    } else {
      expect(outcome).toMatchObject({ kind: 'error', error: expect.any(Error) })
      expect(verify).not.toHaveBeenCalled()
    }
  })

  const invalidPlaceholderCases: readonly { label: string; value: Entry[string] | undefined }[] = [
    { label: 'missing', value: undefined },
    { label: 'empty', value: '' },
    { label: 'binary', value: Buffer.from('alice') },
    { label: 'empty list', value: [] },
    { label: 'empty first value', value: [''] }
  ]
  it.each(invalidPlaceholderCases)('rejects $label values for each placeholder actually used by the group filter', async ({ value }) => {
    for (const placeholder of ['dn', 'username'] as const) {
      const entry: Entry = { ...userEntry }
      const field = placeholder === 'dn' ? 'employeeNumber' : 'uid'
      if (value === undefined) {
        Reflect.deleteProperty(entry, field)
      } else {
        entry[field] = value
      }
      const { outcome, verify, adminClient } = await authenticateGroups({
        entry,
        server: {
          groupSearchFilter: `(member={{${placeholder}}})`,
          groupDnProperty: 'employeeNumber'
        }
      })
      expect(outcome).toMatchObject({ kind: 'error', error: expect.any(Error) })
      expect(verify).not.toHaveBeenCalled()
      expect(adminClient.search).toHaveBeenCalledTimes(1)
      expect(adminClient.searchPaginated).not.toHaveBeenCalled()
    }
  })

  const placeholderCases: readonly { label: string; entry: Entry; filter: string; expected: string }[] = [
    {
      label: 'dn only without uid',
      entry: { dn: userEntry.dn, employeeNumber: 'alice*)(member=*)' },
      filter: '(member={{dn}})',
      expected: '(member=alice\\2a\\29\\28member=\\2a\\29)'
    },
    {
      label: 'username only without the configured DN property',
      entry: { dn: userEntry.dn, uid: ['alice*)(member=*)', 'ignored'] },
      filter: '(memberUid={{username}})',
      expected: '(memberUid=alice\\2a\\29\\28member=\\2a\\29)'
    },
    {
      label: 'constant filter without interpolation attributes',
      entry: { dn: userEntry.dn },
      filter: '(objectClass=groupOfNames)',
      expected: '(objectClass=groupOfNames)'
    },
    {
      label: 'literal placeholder text in the configured DN attribute',
      entry: { dn: userEntry.dn, employeeNumber: '{{username}}' },
      filter: '(member={{dn}})',
      expected: '(member={{username}})'
    }
  ]
  it.each(placeholderCases)('requires only used placeholders and escapes their values: $label', async ({ entry, filter, expected }) => {
    const group: Entry = { dn: 'cn=editors,dc=example,dc=com', cn: 'editors' }
    const { outcome, adminClient } = await authenticateGroups({
      entry,
      pages: [groupPage([group])],
      server: { groupSearchFilter: filter, groupDnProperty: 'employeeNumber' }
    })
    expect(outcome).toEqual({ kind: 'success', profile: { ...entry, _groups: [group] } })
    expect(adminClient.searchPaginated).toHaveBeenCalledWith('ou=groups,dc=example,dc=com', expect.objectContaining({ filter: expected }))
  })

  it('keeps a completed user-not-found result distinct from an incomplete directory search', async () => {
    const { outcome, verify, userClient } = await authenticateGroups({ entry: null })
    expect(outcome).toEqual({ kind: 'fail', challenge: { message: 'Invalid username/password' }, status: 401 })
    expect(verify).not.toHaveBeenCalled()
    expect(userClient.bind).not.toHaveBeenCalled()
  })

  it('reports invalid credentials as an authentication failure and closes both clients', async () => {
    const userEntry: Entry = { dn: 'uid=alice,dc=example,dc=com', uid: 'alice' }
    const adminClient = createClient([userEntry])
    const invalidCredentials = Object.assign(new Error('LDAP error data 775, v2580'), { name: 'InvalidCredentialsError' })
    const userClient = createClient()
    vi.mocked(userClient.bind).mockRejectedValue(invalidCredentials)
    const clients = [adminClient, userClient]
    const failed = deferred<{ challenge: unknown; status: number | undefined }>()
    const strategy = new LdapStrategy(
      {
        server: {
          url: 'ldap://ldap.example.com:389',
          searchBase: 'dc=example,dc=com',
          searchFilter: '(uid={{username}})'
        },
        usernameField: 'email',
        passwordField: 'password',
        passReqToCallback: true,
        clientFactory: () => clients.shift()!
      },
      vi.fn()
    )
    Object.assign(strategy, {
      success: vi.fn(),
      error: failed.reject,
      fail: (challenge: unknown, status?: number) => failed.resolve({ challenge, status })
    })

    strategy.authenticate(createRequest())
    expect(await failed.promise).toEqual({ challenge: { message: 'User account locked' }, status: 401 })
    expect(adminClient.unbind).toHaveBeenCalledTimes(1)
    expect(userClient.unbind).toHaveBeenCalledTimes(1)
  })

  it('rejects missing form credentials before opening an LDAP connection', async () => {
    const failed = deferred<{ challenge: unknown; status: number | undefined }>()
    const clientFactory = vi.fn()
    const strategy = new LdapStrategy(
      {
        server: {
          url: 'ldap://ldap.example.com:389',
          searchBase: 'dc=example,dc=com',
          searchFilter: '(uid={{username}})'
        },
        usernameField: 'email',
        passwordField: 'password',
        passReqToCallback: true,
        clientFactory
      },
      vi.fn()
    )
    Object.assign(strategy, {
      success: vi.fn(),
      error: failed.reject,
      fail: (challenge: unknown, status?: number) => failed.resolve({ challenge, status })
    })

    strategy.authenticate(createRequest('', ''))
    expect(await failed.promise).toEqual({ challenge: { message: 'Missing credentials' }, status: 400 })
    expect(clientFactory).not.toHaveBeenCalled()
  })

  it.each([
    { bindDn: ' \t ', bindCredentials: '', message: 'only whitespace' },
    { bindDn: '', bindCredentials: 'orphan', message: 'anonymous search requires empty' },
    { bindCredentials: 'orphan', message: 'anonymous search requires empty' },
    { bindDn: '', bindCredentials: ' ', message: 'anonymous search requires empty' },
    { bindDn: 'cn=reader', message: 'requires nonempty credentials' },
    { bindDn: 'cn=reader', bindCredentials: '', message: 'requires nonempty credentials' }
  ])('refuses ambiguous search identity before opening a connection: %j', ({ message, ...searchBind }) => {
    const clientFactory = vi.fn()
    expect(
      () =>
        new LdapStrategy(
          {
            server: {
              url: 'ldap://ldap.example.com:389',
              searchBase: 'dc=example,dc=com',
              searchFilter: '(uid={{username}})',
              ...searchBind
            },
            usernameField: 'email',
            passwordField: 'password',
            passReqToCallback: true,
            clientFactory
          },
          vi.fn()
        )
    ).toThrow(message)
    expect(clientFactory).not.toHaveBeenCalled()
  })
})
