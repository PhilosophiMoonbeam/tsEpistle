import tls from 'node:tls'
import { tlsFixture } from '../helpers/tls-fixture.ts'
import { inspectTlsEndpoint } from '../../repositories/tls-probe.ts'
let fixture, previousWiki
beforeAll(() => { fixture = tlsFixture() })
afterAll(() => fixture.close())
beforeEach(() => { previousWiki = global.WIKI })
afterEach(() => { global.WIKI = previousWiki; vi.unmockModule('../../graph/index.ts', import.meta.url); vi.restoreAllMocks() })
const setup = async () => {
  vi.mockModule('../../graph/index.ts', import.meta.url, () => ({ createGraphQLArtifacts: vi.fn() }))
  global.WIKI = {
    config: { bindIP: '127.0.0.1', ssl: { provider: 'custom', port: 0, format: 'pem', inline: true, key: fixture.first.key, cert: fixture.first.cert } },
    app: (_req, res) => res.end('wiki fixture'),
    collaboration: { install: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), error: vi.fn() }
  }
  const { default: createServers } = await vi.importFresh('../../core/servers.ts', import.meta.url)
  const core = createServers(global.WIKI)
  core.installGraphQLSubscriptions = vi.fn()
  core.disposeGraphQLSubscriptions = vi.fn().mockResolvedValue(undefined)
  await core.startHTTPS()
  const target = { host: '127.0.0.1', port: core.servers.https.address().port, servername: 'wiki.example.test' }
  return { core, target, wiki: global.WIKI }
}
const second = () => ({ inline: true, key: fixture.second.key, cert: fixture.second.cert })
describe('HTTPS certificate replacement with real TLS sockets', () => {
  it('keeps review non-disruptive and requires explicit restart acknowledgement on Bun before replacing certificate material', async () => {
    const { core, target, wiki } = await setup()
    const socket = tls.connect({ ...target, ca: fixture.first.cert })
    socket.on('error', () => {})
    try {
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })
      const before = await inspectTlsEndpoint(target)
      const original = core.inspectHttpsMaterial()
      expect(original.certificate.fingerprint256).toBe(before.certificate.fingerprint256)
      const pending = await core.prepareHttpsContext(second())
      expect((await inspectTlsEndpoint(target)).certificate.fingerprint256).toBe(before.certificate.fingerprint256)
      expect(pending.mode).toBe('listener-restart')
      await expect(pending.apply()).rejects.toThrow('connection interruption')
      expect(socket.destroyed).toBe(false)
      const response = new Promise((resolve, reject) => { socket.once('data', data => resolve(data.toString())); socket.once('error', reject) })
      socket.write('GET / HTTP/1.1\r\nHost: wiki.example.test\r\nConnection: keep-alive\r\n\r\n')
      expect(await response).toContain('wiki fixture')
      const closed = new Promise(resolve => socket.once('close', resolve))
      const applied = await pending.apply({ allowRestart: true })
      await closed
      expect(applied.revision).not.toBe(original.revision)
      const after = await inspectTlsEndpoint(target, { ca: fixture.second.cert })
      expect(after.trusted).toBe(true)
      expect(after.certificate.fingerprint256).toBe(applied.certificate.fingerprint256)
      expect(after.certificate.fingerprint256).not.toBe(before.certificate.fingerprint256)
      expect(socket.destroyed).toBe(true)
      expect(core.installGraphQLSubscriptions).toHaveBeenCalledTimes(2)
      expect(core.disposeGraphQLSubscriptions).toHaveBeenCalledTimes(1)
      expect(wiki.collaboration.dispose).toHaveBeenCalledTimes(1)
      await expect(pending.apply({ allowRestart: true })).rejects.toThrow('already been applied')
      applied.certificate.subject = 'changed by caller'
      expect(core.inspectHttpsMaterial().certificate.subject).not.toBe('changed by caller')
    } finally { socket.destroy(); await core.stopServers() }
  })
  it('preserves the working listener and its evidence when replacement material is invalid', async () => {
    const { core, target } = await setup()
    try {
      const original = core.inspectHttpsMaterial()
      await expect(core.prepareHttpsContext({ inline: true, key: fixture.first.key, cert: fixture.second.cert })).rejects.toThrow('could not be loaded or validated')
      expect(core.inspectHttpsMaterial()).toEqual(original)
      expect((await inspectTlsEndpoint(target, { ca: fixture.first.cert })).trusted).toBe(true)
    } finally { await core.stopServers() }
  })
  it('rejects a second prepared replacement after another replacement has won', async () => {
    const { core } = await setup()
    try {
      const [a, b] = await Promise.all([core.prepareHttpsContext(second()), core.prepareHttpsContext(second())])
      await a.apply({ allowRestart: true })
      await expect(b.apply({ allowRestart: true })).rejects.toThrow('changed')
    } finally { await core.stopServers() }
  })
  it('rejects deployment changes or a stopped listener after review', async () => {
    const { core, wiki } = await setup()
    try {
      const pending = await core.prepareHttpsContext(second())
      wiki.config.ssl.port = 12345
      await expect(pending.apply({ allowRestart: true })).rejects.toThrow('changed')
      const other = await core.prepareHttpsContext(second())
      await core.stopServers()
      await expect(other.apply({ allowRestart: true })).rejects.toThrow('changed')
      expect(core.inspectHttpsMaterial()).toBeNull()
      await expect(core.prepareHttpsContext()).rejects.toThrow('not running')
    } finally { await core.stopServers() }
  })
  it('releases HTTPS transports after a bind failure', async () => {
    const { core, wiki } = await setup()
    const occupiedPort = core.servers.https.address().port
    const occupied = core.servers.https
    const { default: createServers } = await vi.importFresh('../../core/servers.ts', import.meta.url)
    const other = createServers(wiki)
    other.installGraphQLSubscriptions = vi.fn()
    other.disposeGraphQLSubscriptions = vi.fn().mockResolvedValue(undefined)
    wiki.config.ssl.port = occupiedPort
    try {
      await expect(other.startHTTPS()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(other.servers.https).toBeNull()
      expect(other.inspectHttpsMaterial()).toBeNull()
      expect(other.disposeGraphQLSubscriptions).toHaveBeenCalledTimes(1)
      expect(wiki.collaboration.dispose).toHaveBeenCalledTimes(1)
      expect(occupied.listening).toBe(true)
    } finally { await other.stopServers(); await core.stopServers() }
  })
  it('serves PFX certificates and rotates them without exposing bundle contents', async () => {
    const { core, target } = await setup()
    try {
      const prepared = await core.prepareHttpsContext({ format: 'pfx', pfx: fixture.second.pfxPath, passphrase: 'fixture-password' })
      expect(prepared.certificate.subject).toContain('wiki.example.test')
      expect(await prepared.apply({ allowRestart: true })).toMatchObject({ format: 'pfx', source: 'file', certificate: expect.objectContaining({ subject: expect.stringContaining('wiki.example.test') }) })
      const result = await inspectTlsEndpoint(target, { ca: fixture.second.cert })
      expect(result.trusted).toBe(true)
      expect(result.certificate.subject).toContain('wiki.example.test')
    } finally { await core.stopServers() }
  })
  it('restores the previous certificate after replacement startup fails', async () => {
    const { core, target } = await setup()
    try {
      const before = core.inspectHttpsMaterial()
      const prepared = await core.prepareHttpsContext(second())
      const install = core.installGraphQLSubscriptions
      install.mockImplementationOnce(() => { throw new Error('fixture installation failure') })
      await expect(prepared.apply({ allowRestart: true })).rejects.toThrow('restored using its previous material')
      const after = await inspectTlsEndpoint(target, { ca: fixture.first.cert })
      expect(after.trusted).toBe(true)
      expect(after.certificate.fingerprint256).toBe(before.certificate.fingerprint256)
      expect(core.inspectHttpsMaterial().revision).not.toBe(before.revision)
    } finally { await core.stopServers() }
  })
  it('reports failed recovery without a fabricated active certificate', async () => {
    const { core } = await setup()
    try {
      const prepared = await core.prepareHttpsContext(second())
      core.installGraphQLSubscriptions.mockImplementation(() => { throw new Error('fixture installation failure') })
      await expect(prepared.apply({ allowRestart: true })).rejects.toThrow('Deployment recovery is required')
      expect(core.inspectHttpsMaterial()).toBeNull()
      expect(core.servers.https).toBeNull()
    } finally { await core.stopServers() }
  })
  it('finishes an in-progress replacement before shutting down all listeners', async () => {
    const { core } = await setup()
    const prepared = await core.prepareHttpsContext(second())
    let released, entered
    const enteredPromise = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { released = resolve })
    core.disposeGraphQLSubscriptions.mockImplementationOnce(async () => { entered(); await gate })
    const applying = prepared.apply({ allowRestart: true })
    await enteredPromise
    const stopping = core.stopServers()
    released()
    await applying
    await stopping
    expect(core.servers.https).toBeNull()
    expect(core.inspectHttpsMaterial()).toBeNull()
  })

})
