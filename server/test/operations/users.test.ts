import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const adminWorkspace = () => ({ id: 10, fingerprint: 'reviewed-version', profile: { name: 'User', email: 'user@example.test', location: '', jobTitle: '', timezone: 'UTC', groups: [2] }, capabilities: { edit: true }, isActive: true })
const accountStore = { inspect: vi.fn(), updateProfile: vi.fn() }
vi.mockModule('../../operations/account-administration.ts', import.meta.url, () => ({ accountAdministration: () => accountStore }))
class AuthRequired extends Error {}
class AuthAccountBanned extends Error {}
class AuthAccountNotVerified extends Error {}
class AuthProviderInvalid extends Error {}
class AuthPasswordInvalid extends Error {}
class InputInvalid extends Error {}

const requester = { id: 10, ownershipUserId: 10 } as Express.User

const installWiki = (overrides: Record<string, unknown> = {}) => {
  const lifecycle: string[] = []
  const revokeUserTokens = vi.fn((_input: { id: number; kind: 'u' }) => {
    lifecycle.push('revoke-local')
  })
  const emit = vi.fn((_event: string, _input?: Record<string, unknown>) => {
    lifecycle.push('revoke-peer')
  })
  const updateUser = vi.fn(async () => {
    lifecycle.push('commit')
    return true
  })
  const refreshToken = vi.fn(async () => {
    lifecycle.push('refresh')
    return { token: 'replacement-jwt' }
  })
  const user = {
    id: 10,
    email: 'user@example.test',
    name: 'User',
    providerKey: 'local',
    providerId: null,
    password: '',
    tfaSecret: '',
    isActive: true,
    isVerified: true,
    createdAt: null,
    updatedAt: null,
    lastLoginAt: null,
    verifyPassword: vi.fn(async () => true),
    $relatedQuery: vi.fn()
  }
  const findById = vi.fn(async () => user)
  const wiki = {
    Error: { AuthRequired, AuthAccountBanned, AuthAccountNotVerified, AuthProviderInvalid, AuthPasswordInvalid, InputInvalid },
    auth: {
      strategies: {},
      checkAssignUserToGroupAccess: vi.fn(async () => true),
      revokeUserTokens
    },
    config: { host: 'https://wiki.example.test', metrics: { isEnabled: false } },
    configSvc: { saveToDb: vi.fn() },
    data: { authentication: [] },
    events: { outbound: { emit } },
    metrics: { init: vi.fn() },
    models: {
      knex: {},
      authentication: {},
      pages: { query: vi.fn() },
      users: {
        query: () => ({ findById }),
        createNewUser: vi.fn(),
        deleteUser: vi.fn(),
        login: vi.fn(),
        loginTFA: vi.fn(),
        loginChangePassword: vi.fn(),
        loginForgotPassword: vi.fn(),
        register: vi.fn(),
        resetPassword: vi.fn(),
        sendWelcomeEmail: vi.fn(),
        updateUser,
        verifyEmail: vi.fn(),
        refreshToken
      }
    },
    ...overrides
  }
  Reflect.set(global, 'WIKI', wiki)
  return { emit, findById, lifecycle, refreshToken, revokeUserTokens, updateUser, user, wiki }
}

beforeEach(() => {
  vi.resetModules()
  accountStore.inspect.mockReset().mockResolvedValue(adminWorkspace())
  accountStore.updateProfile.mockReset().mockResolvedValue(adminWorkspace())
})

describe('user authority revocation', () => {
  it('revokes local and peer JWT authorization after an administrative group commit', async () => {
    const { emit, lifecycle, revokeUserTokens, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    accountStore.updateProfile.mockImplementationOnce(async () => { lifecycle.push('commit'); return adminWorkspace() })
    await operations.default.update({ requester, input: { id: 10, groups: [3] } })

    expect(accountStore.updateProfile).toHaveBeenCalledWith(requester, 10, expect.objectContaining({ fingerprint: 'reviewed-version', profile: expect.objectContaining({ groups: [3] }) }))
    expect(updateUser).not.toHaveBeenCalled()
    expect(lifecycle).toEqual(['commit', 'revoke-local', 'revoke-peer'])
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
    expect(emit).toHaveBeenCalledWith('addAuthRevoke', { id: 10, kind: 'u' })
  })

  it('does not revoke when reconciliation committed without changing authority', async () => {
    const { revokeUserTokens, updateUser } = installWiki()
    updateUser.mockResolvedValueOnce(false)
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await operations.default.update({ requester, input: { id: 10, name: 'User' } })

    expect(revokeUserTokens).not.toHaveBeenCalled()
  })

  it('revokes prior sessions after a self-service password commit and before issuing the replacement cookie', async () => {
    const { lifecycle, revokeUserTokens } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)
    const response = { cookie: vi.fn(), set: vi.fn() }

    await expect(operations.default.changePassword({ requester, current: 'old-password', newPassword: 'new-password', response })).resolves.toBeUndefined()

    expect(lifecycle).toEqual(['commit', 'revoke-local', 'revoke-peer', 'refresh'])
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
    expect(response.cookie).toHaveBeenCalledWith('jwt', 'replacement-jwt', expect.any(Object))
  })
})
describe('self-service profile identity', () => {
  it.each([
    ['an API principal', { id: 1, ownershipUserId: null, permissions: ['manage:system'] }],
    ['a guest principal', { id: 2, ownershipUserId: null }],
    ['an inconsistent principal', { id: 10, ownershipUserId: 11 }]
  ])('rejects %s before querying or issuing a cookie across profile transports', async (_label, profileRequester) => {
    const { findById, refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)
    const response = { cookie: vi.fn(), set: vi.fn() }
    const input = { name: 'Changed', location: '', jobTitle: '', timezone: 'UTC', dateFormat: '', appearance: 'light' }

    await expect(operations.default.getProfile(profileRequester as Express.User)).rejects.toBeInstanceOf(AuthRequired)
    await expect(operations.default.updateProfile({ requester: profileRequester as Express.User, input, response })).rejects.toBeInstanceOf(AuthRequired)
    await expect(operations.default.updateProfilePreferences({ requester: profileRequester as Express.User, input: { appearance: 'dark' }, response })).rejects.toBeInstanceOf(AuthRequired)
    await expect(operations.default.changePassword({ requester: profileRequester, current: 'old-password', newPassword: 'new-password', response })).rejects.toBeInstanceOf(AuthRequired)

    expect(findById).not.toHaveBeenCalled()
    expect(updateUser).not.toHaveBeenCalled()
    expect(refreshToken).not.toHaveBeenCalled()
    expect(response.cookie).not.toHaveBeenCalled()
  })

  it('allows an ordinary human principal to update only that principal and refresh its cookie', async () => {
    const { findById, refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)
    const response = { cookie: vi.fn(), set: vi.fn() }

    await expect(operations.default.updateProfile({
      requester,
      input: { name: 'Changed', location: '', jobTitle: '', timezone: 'UTC', dateFormat: '', appearance: 'light' },
      response
    })).resolves.toBeUndefined()

    expect(findById).toHaveBeenCalledWith(10)
    expect(updateUser).toHaveBeenCalledWith({
      id: 10,
      name: 'Changed',
      jobTitle: '',
      location: '',
      timezone: 'UTC',
      dateFormat: '',
      appearance: 'light'
    })
    expect(refreshToken).toHaveBeenCalledWith(10)
    expect(response.cookie).toHaveBeenCalledWith('jwt', 'replacement-jwt', expect.any(Object))
  })
})
describe('profile preferences operation', () => {
  it.each([
    ['appearance', { appearance: 'dark' }],
    ['font family', { fontFamily: 'roboto-flex' }],
    ['editorial blend', { fontFamily: 'blend' }]
  ])('updates an independent %s preference and refreshes the session cookie', async (_label, input) => {
    const { refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)
    const response = { cookie: vi.fn(), set: vi.fn() }

    await expect(operations.default.updateProfilePreferences({ requester, input, response })).resolves.toBeUndefined()

    expect(updateUser).toHaveBeenCalledWith({ id: 10, ...input })
    expect(refreshToken).toHaveBeenCalledWith(10)
    expect(response.cookie).toHaveBeenCalledWith('jwt', 'replacement-jwt', expect.any(Object))
  })

  it('updates a combined preference patch exactly', async () => {
    const { refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)
    const response = { cookie: vi.fn(), set: vi.fn() }
    const input = { appearance: 'light', fontFamily: 'newsreader' }

    await expect(operations.default.updateProfilePreferences({ requester, input, response })).resolves.toBeUndefined()

    expect(updateUser).toHaveBeenCalledWith({ id: 10, ...input })
    expect(refreshToken).toHaveBeenCalledWith(10)
    expect(response.cookie).toHaveBeenCalledWith('jwt', 'replacement-jwt', expect.any(Object))
  })

  it.each([
    ['unknown keys', { appearance: 'dark', name: 'must not update' }],
    ['an empty patch', {}],
    ['an invalid appearance', { appearance: 'sepia' }],
    ['an invalid font family', { fontFamily: 'serif' }],
    ['the removed readingGutter field as an unknown payload key', { readingGutter: 'orbits' }]
  ])('rejects %s before persistence', async (_label, input) => {
    const { refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await expect(operations.default.updateProfilePreferences({ requester, input })).rejects.toBeInstanceOf(InputInvalid)

    expect(updateUser).not.toHaveBeenCalled()
    expect(refreshToken).not.toHaveBeenCalled()
  })
})
describe('account credential operation revocation', () => {
  it('revokes mandatory-change session authority after commit without leaking internal fields', async () => {
    const { emit, lifecycle, revokeUserTokens, wiki } = installWiki()
    wiki.models.users.loginChangePassword = vi.fn(async () => {
      lifecycle.push('commit')
      return { jwt: 'replacement-jwt', userId: 10 }
    })
    const operations = await vi.importFresh('../../operations/authentication.ts', import.meta.url)
    const response = { cookie: vi.fn(), set: vi.fn() }

    await expect(operations.default.loginChangePassword({ continuationToken: 'token', newPassword: 'new-password' }, { req: {}, res: response })).resolves.toEqual({
      authenticated: true
    })

    expect(response.cookie).toHaveBeenCalledWith('jwt', 'replacement-jwt', expect.any(Object))
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
    expect(emit).toHaveBeenCalledWith('addAuthRevoke', { id: 10, kind: 'u' })
    expect(lifecycle).toEqual(['commit', 'revoke-local', 'revoke-peer'])
  })

  it('revokes reset-password JWT authority only after the protected mutation commits', async () => {
    const { lifecycle, revokeUserTokens, wiki } = installWiki()
    wiki.models.users.resetPassword = vi.fn(async () => {
      lifecycle.push('commit')
      return 10
    })
    const operations = await vi.importFresh('../../operations/authentication.ts', import.meta.url)

    await operations.default.resetPassword({ token: 'token', newPassword: 'new-password' })

    expect(lifecycle).toEqual(['commit', 'revoke-local', 'revoke-peer'])
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
  })

  it('does not revoke when reset-password persistence fails', async () => {
    const { revokeUserTokens, wiki } = installWiki()
    wiki.models.users.resetPassword = vi.fn(async () => {
      throw new Error('forced mutation failure')
    })
    const operations = await vi.importFresh('../../operations/authentication.ts', import.meta.url)

    await expect(operations.default.resetPassword({ token: 'token', newPassword: 'new-password' })).rejects.toThrow('forced mutation failure')

    expect(revokeUserTokens).not.toHaveBeenCalled()
  })
})
