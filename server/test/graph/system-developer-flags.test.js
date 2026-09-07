let store

vi.mockModule('../../operations/developer-flags.ts', import.meta.url, () => ({ getDeveloperFlagsWorkspaceStore: () => store }))
vi.mockModule('../../operations/system.ts', import.meta.url, () => ({
  default: { getInfo: vi.fn(), getExportStatus: vi.fn(), resetTelemetryClientId: vi.fn(), setTelemetry: vi.fn() }
}))
vi.mockModule('../../operations/import-v1.ts', import.meta.url, () => ({ default: { importUsers: vi.fn() } }))

describe('GraphQL developer flag compatibility adapter', () => {
  beforeEach(async () => {
    store = { legacyList: vi.fn().mockResolvedValue([{ key: 'ldapdebug', value: false }, { key: 'sqllog', value: false }]) }
  })

  it('keeps the legacy read projection but retires unreviewed writes', async () => {
    const { default: resolvers } = await vi.importFresh('../../graph/resolvers/system.ts', import.meta.url)
    const req = {
      user: { id: 1, ownershipUserId: null, groups: [1], authVersion: 2 },
      apiKeyAuth: { apiKeyId: 9, groupId: 1, expiresAt: 1234567890, bearerToken: 'private-api-token' }
    }
    const requester = { user: req.user, apiKey: { id: 9, groupId: 1, expiresAt: 1234567890 } }

    await expect(resolvers.SystemQuery.flags(null, {}, { req })).resolves.toEqual([{ key: 'ldapdebug', value: false }, { key: 'sqllog', value: false }])
    const result = await resolvers.SystemMutation.updateFlags(null, { flags: [{ key: 'ldapdebug', value: false }, { key: 'sqllog', value: false }] }, { req })

    expect(store.legacyList).toHaveBeenCalledWith(requester)
    expect(result).toEqual({
      responseResult: expect.objectContaining({ succeeded: false, message: expect.stringContaining('reviewed workspace') })
    })
    expect(JSON.stringify(result)).not.toContain('private-api-token')
  })
})
