import { createHash } from 'node:crypto'
const key = Buffer.from('fixture server public key'),
  fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
let connection, uncached, connect, readdir, constructorCalls
vi.mockModule('ssh2-promise', import.meta.url, () => ({
  default: function (config, disableCache) {
    constructorCalls++
    connection = config
    uncached = disableCache
    return { connect, sftp: () => ({ readdir }) }
  }
}))
beforeEach(() => {
  global.WIKI = { logger: { info: vi.fn(), warn: vi.fn() } }
  connection = null
  constructorCalls = 0
  connect = vi.fn().mockResolvedValue(undefined)
  readdir = vi.fn().mockResolvedValue([])
})
const config = () => ({
  host: 'storage.example.test',
  port: 22,
  username: 'wiki',
  authMode: 'password',
  password: 'fixture-password',
  basePath: '/wiki',
  hostKeyFingerprint: fingerprint
})
describe('SFTP storage connection configuration', () => {
  it('refuses a missing server identity before allocating or connecting a client', async () => {
    const plugin = (await vi.importFresh('../../modules/storage/sftp/storage.ts', import.meta.url)).default
    await expect(plugin.init.call({ config: { ...config(), hostKeyFingerprint: '' } })).rejects.toThrow('verified SHA256')
    expect(constructorCalls).toBe(0)
    expect(connect).not.toHaveBeenCalled()
  })
  it('passes the verified host-key check through the actual wrapper contract and checks the configured folder', async () => {
    const plugin = (await vi.importFresh('../../modules/storage/sftp/storage.ts', import.meta.url)).default
    await plugin.init.call({ config: config() })
    expect(connection.hostVerifier(key)).toBe(true)
    expect(connection.hostVerifier(Buffer.from('different server'))).toBe(false)
    expect(connection).toMatchObject({ host: 'storage.example.test', port: 22, username: 'wiki', password: 'fixture-password', reconnect: false })
    expect(connection.hostHash).toBeUndefined()
    expect(connection.privateKey).toBeUndefined()
    expect(uncached).toBe(true)
    expect(readdir).toHaveBeenCalledWith('/wiki')
  })
  it('does not forward an inactive password when private-key authentication is selected', async () => {
    const plugin = (await vi.importFresh('../../modules/storage/sftp/storage.ts', import.meta.url)).default
    await plugin.init.call({ config: { ...config(), authMode: 'privateKey', privateKey: 'fixture-private-key', passphrase: 'fixture-passphrase' } })
    expect(connection).toMatchObject({ privateKey: 'fixture-private-key', passphrase: 'fixture-passphrase' })
    expect(connection.password).toBeUndefined()
  })
})
