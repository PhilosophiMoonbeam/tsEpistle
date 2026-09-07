const login = vi.fn()

vi.mockModule('../../operations/authentication.ts', import.meta.url, () => ({
  default: {
    getMetricsState: vi.fn(),
    listDefinitions: vi.fn(),
    listActive: vi.fn(),
    login,
    loginTfa: vi.fn(),
    loginChangePassword: vi.fn(),
    forgotPassword: vi.fn(),
    register: vi.fn(),
    setMetricsState: vi.fn(),
    regenerateCertificates: vi.fn()
  }
}))

describe('GraphQL LDAP diagnostics', () => {
  beforeEach(() => {
    login.mockReset().mockRejectedValue(new Error('LDAP fixture failure'))
  })

  it('reads the current LDAP diagnostic flag when a login fails instead of capturing its startup value', async () => {
    const config = { flags: { ldapdebug: false } }
    const logger = { warn: vi.fn() }
    const { default: createAuthenticationResolvers } = await vi.importFresh('../../graph/resolvers/authentication.ts', import.meta.url)
    const resolver = createAuthenticationResolvers({ ROOTPATH: '/fixture', config, logger })

    await resolver.AuthenticationMutation.login(null, { strategy: 'ldap' }, { req: {} })
    expect(logger.warn).not.toHaveBeenCalled()

    config.flags.ldapdebug = true
    await resolver.AuthenticationMutation.login(null, { strategy: 'ldap' }, { req: {} })
    expect(logger.warn).toHaveBeenCalledWith('LDAP LOGIN ERROR (c1): ', expect.any(Error))
  })
})
