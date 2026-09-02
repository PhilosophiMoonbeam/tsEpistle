import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

class AuthRequired extends Error {}
class AuthAccountBanned extends Error {}
class AuthAccountNotVerified extends Error {}
class AuthProviderInvalid extends Error {}
class AuthPasswordInvalid extends Error {}
class InputInvalid extends Error {}

const requester = { id: 10 } as Express.User

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
  const wiki = {
    Error: { AuthRequired, AuthAccountBanned, AuthAccountNotVerified, AuthProviderInvalid, AuthPasswordInvalid, InputInvalid },
    auth: {
      strategies: {},
      checkAssignUserToGroupAccess: vi.fn(async () => true),
      revokeUserTokens
    },
    config: { metrics: { isEnabled: false }, theming: { gutterCustomCss: '' } },
    configSvc: { saveToDb: vi.fn() },
    data: { authentication: [] },
    events: { outbound: { emit } },
    metrics: { init: vi.fn() },
    models: {
      knex: {},
      authentication: {},
      pages: { query: vi.fn() },
      users: {
        query: () => ({ findById: async () => user }),
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
  return { emit, lifecycle, refreshToken, revokeUserTokens, updateUser, user, wiki }
}

beforeEach(() => {
  vi.resetModules()
})

describe('user authority revocation', () => {
  it('revokes local and peer JWT authorization after an administrative group commit', async () => {
    const { emit, lifecycle, revokeUserTokens, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await operations.default.update({ requester, input: { id: 10, groups: [3] } })

    expect(updateUser).toHaveBeenCalledWith({ id: 10, groups: [3] })
    expect(lifecycle).toEqual(['commit', 'revoke-local', 'revoke-peer'])
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
    expect(emit).toHaveBeenCalledWith('addAuthRevoke', { id: 10, kind: 'u' })
  })

  it('does not revoke when reconciliation committed without changing authority', async () => {
    const { revokeUserTokens, updateUser } = installWiki()
    updateUser.mockResolvedValueOnce(false)
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await operations.default.update({ requester, input: { id: 10, name: 'Renamed' } })

    expect(revokeUserTokens).not.toHaveBeenCalled()
  })

  it('revokes prior JWTs after a self-service password commit and before issuing the replacement', async () => {
    const { lifecycle, revokeUserTokens } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await expect(operations.default.changePassword({ requester, current: 'old-password', newPassword: 'new-password' })).resolves.toBe('replacement-jwt')

    expect(lifecycle).toEqual(['commit', 'revoke-local', 'revoke-peer', 'refresh'])
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
  })
})
describe('profile preferences operation', () => {
  it.each([
    ['appearance', { appearance: 'dark' }],
    ['font family', { fontFamily: 'roboto-flex' }],
    ['reading gutter', { readingGutter: 'orbits' }]
  ])('updates an independent %s preference and refreshes the JWT by user id', async (_label, input) => {
    const { refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await expect(operations.default.updateProfilePreferences({ requester, input })).resolves.toBe('replacement-jwt')

    expect(updateUser).toHaveBeenCalledWith({ id: 10, ...input })
    expect(refreshToken).toHaveBeenCalledWith(10)
  })

  it('updates a combined preference patch exactly', async () => {
    const { refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)
    const input = { appearance: 'light', fontFamily: 'newsreader', readingGutter: 'laurel' }

    await expect(operations.default.updateProfilePreferences({ requester, input })).resolves.toBe('replacement-jwt')

    expect(updateUser).toHaveBeenCalledWith({ id: 10, ...input })
    expect(refreshToken).toHaveBeenCalledWith(10)
  })

  it.each([
    ['unknown keys', { appearance: 'dark', name: 'must not update' }],
    ['an empty patch', {}],
    ['an invalid appearance', { appearance: 'sepia' }],
    ['an invalid font family', { fontFamily: 'serif' }],
    ['an invalid reading gutter', { readingGutter: 'marble' }]
  ])('rejects %s before persistence', async (_label, input) => {
    const { refreshToken, updateUser } = installWiki()
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await expect(operations.default.updateProfilePreferences({ requester, input })).rejects.toBeInstanceOf(InputInvalid)

    expect(updateUser).not.toHaveBeenCalled()
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it.each(['   ', '.contents { display: none; }'])('rejects custom gutters when normalized server CSS is unavailable', async gutterCustomCss => {
    const { refreshToken, updateUser } = installWiki({ config: { metrics: { isEnabled: false }, theming: { gutterCustomCss } } })
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await expect(operations.default.updateProfilePreferences({ requester, input: { readingGutter: 'custom' } })).rejects.toBeInstanceOf(InputInvalid)

    expect(updateUser).not.toHaveBeenCalled()
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it('accepts custom gutters when normalized server CSS is configured', async () => {
    const { refreshToken, updateUser } = installWiki({
      config: { metrics: { isEnabled: false }, theming: { gutterCustomCss: '  background: linear-gradient(red, transparent);  ' } }
    })
    const operations = await vi.importFresh('../../operations/users.ts', import.meta.url)

    await expect(operations.default.updateProfilePreferences({ requester, input: { readingGutter: 'custom' } })).resolves.toBe('replacement-jwt')

    expect(updateUser).toHaveBeenCalledWith({ id: 10, readingGutter: 'custom' })
    expect(refreshToken).toHaveBeenCalledWith(10)
  })
})

describe('account credential operation revocation', () => {
  it('revokes mandatory-change JWT authority after commit without leaking the internal user id', async () => {
    const { emit, lifecycle, revokeUserTokens, wiki } = installWiki()
    wiki.models.users.loginChangePassword = vi.fn(async () => {
      lifecycle.push('commit')
      return { jwt: 'replacement-jwt', userId: 10 }
    })
    const operations = await vi.importFresh('../../operations/authentication.ts', import.meta.url)

    await expect(operations.default.loginChangePassword({ continuationToken: 'token', newPassword: 'new-password' }, {})).resolves.toEqual({
      jwt: 'replacement-jwt'
    })

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
