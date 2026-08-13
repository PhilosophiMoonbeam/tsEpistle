import { describe, expect, it, vi } from 'vitest'
import type { Entry } from 'ldapts'
import { LdapStrategy, type LdapClient, type LdapRequest } from './ldap-strategy.ts'

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

const createClient = (searchEntries: Entry[] = []): LdapClient => ({
  bind: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue({ searchEntries, searchReferences: [] }),
  unbind: vi.fn().mockResolvedValue(undefined)
} as unknown as LdapClient)

const createRequest = (email = 'alice', password = 'secret'): LdapRequest => ({
  body: { email, password },
  query: {},
  params: { strategy: 'ldap' }
} as LdapRequest)

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
    const adminClient = createClient()
    vi.mocked(adminClient.search)
      .mockResolvedValueOnce({ searchEntries: [userEntry], searchReferences: [] })
      .mockResolvedValueOnce({ searchEntries: [groupEntry], searchReferences: [] })
    const userClient = createClient()
    const clients = [adminClient, userClient]
    const clientFactory = vi.fn(() => clients.shift()!)
    const verified = deferred<Record<string, unknown>>()
    const strategy = new LdapStrategy({
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
        binaryAttributes: ['jpegPhoto']
      },
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
      clientFactory
    }, (_request, profile, done) => {
      verified.resolve(profile)
      done(null, { id: 'wiki-user' })
    })
    const success = vi.fn()
    Object.assign(strategy, { success, fail: vi.fn(), error: verified.reject })

    strategy.authenticate(createRequest('alice*)(uid=*)'))
    const profile = await verified.promise

    expect(adminClient.bind).toHaveBeenCalledWith('cn=reader,dc=example,dc=com', 'reader-secret')
    expect(adminClient.search).toHaveBeenNthCalledWith(1, 'ou=users,dc=example,dc=com', expect.objectContaining({
      filter: '(&(objectClass=person)(uid=alice\\2a\\29\\28uid=\\2a\\29))',
      explicitBufferAttributes: ['jpegPhoto']
    }))
    expect(userClient.bind).toHaveBeenCalledWith(userEntry.dn, 'secret')
    expect(adminClient.search).toHaveBeenNthCalledWith(2, 'ou=groups,dc=example,dc=com', expect.objectContaining({
      filter: '(member=uid=alice,ou=users,dc=example,dc=com)',
      attributes: ['name']
    }))
    expect(profile).toMatchObject({ _raw: { jpegPhoto: avatar }, _groups: [groupEntry] })
    expect(adminClient.unbind).toHaveBeenCalledOnce()
    expect(userClient.unbind).toHaveBeenCalledOnce()
    expect(success).toHaveBeenCalledWith({ id: 'wiki-user' }, undefined)
  })

  it('reports invalid credentials as an authentication failure and closes both clients', async () => {
    const userEntry: Entry = { dn: 'uid=alice,dc=example,dc=com', uid: 'alice' }
    const adminClient = createClient([userEntry])
    const invalidCredentials = Object.assign(new Error('LDAP error data 775, v2580'), { name: 'InvalidCredentialsError' })
    const userClient = createClient()
    vi.mocked(userClient.bind).mockRejectedValue(invalidCredentials)
    const clients = [adminClient, userClient]
    const failed = deferred<{ challenge: unknown, status: number | undefined }>()
    const strategy = new LdapStrategy({
      server: {
        url: 'ldap://ldap.example.com:389',
        searchBase: 'dc=example,dc=com',
        searchFilter: '(uid={{username}})'
      },
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
      clientFactory: () => clients.shift()!
    }, vi.fn())
    Object.assign(strategy, {
      success: vi.fn(),
      error: failed.reject,
      fail: (challenge: unknown, status?: number) => failed.resolve({ challenge, status })
    })

    strategy.authenticate(createRequest())
    await expect(failed.promise).resolves.toEqual({ challenge: { message: 'User account locked' }, status: 401 })
    expect(adminClient.unbind).toHaveBeenCalledOnce()
    expect(userClient.unbind).toHaveBeenCalledOnce()
  })

  it('rejects missing form credentials before opening an LDAP connection', async () => {
    const failed = deferred<{ challenge: unknown, status: number | undefined }>()
    const clientFactory = vi.fn()
    const strategy = new LdapStrategy({
      server: {
        url: 'ldap://ldap.example.com:389',
        searchBase: 'dc=example,dc=com',
        searchFilter: '(uid={{username}})'
      },
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
      clientFactory
    }, vi.fn())
    Object.assign(strategy, {
      success: vi.fn(),
      error: failed.reject,
      fail: (challenge: unknown, status?: number) => failed.resolve({ challenge, status })
    })

    strategy.authenticate(createRequest('', ''))
    await expect(failed.promise).resolves.toEqual({ challenge: { message: 'Missing credentials' }, status: 400 })
    expect(clientFactory).not.toHaveBeenCalled()
  })
})
