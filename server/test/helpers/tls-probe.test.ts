import tls from 'node:tls'
import net from 'node:net'
import type { Socket } from 'node:net'
import { inspectTlsEndpoint, publicTlsTarget } from '../../repositories/tls-probe.ts'
import { tlsFixture } from './tls-fixture.ts'

let fixture: ReturnType<typeof tlsFixture>
beforeAll(() => {
  fixture = tlsFixture()
})
afterAll(() => fixture.close())
const listen = async (server: net.Server) => {
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: (server.address() as net.AddressInfo).port,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
describe('TLS evidence from an actual handshake', () => {
  it('accepts only a configured HTTPS origin, including explicit ports and IPv6', () => {
    expect(publicTlsTarget('https://wiki.example.test:10443')).toEqual({ host: 'wiki.example.test', servername: 'wiki.example.test', port: 10443 })
    expect(publicTlsTarget('https://[::1]')).toEqual({ host: '::1', servername: '::1', port: 443 })
    for (const value of [
      'http://wiki.example.test',
      'https://user:secret@wiki.example.test',
      'https://wiki.example.test/path',
      'https://wiki.example.test?secret=x',
      'https://wiki.example.test/#x',
      '/wiki',
      null
    ])
      expect(publicTlsTarget(value)).toBeNull()
  })
  it('reports trusted and untrusted chains separately and sends no application data', async () => {
    let bytes = 0
    const server = tls.createServer({ key: fixture.first.key, cert: fixture.first.cert }, socket =>
      socket.on('data', data => {
        bytes += data.length
      })
    )
    const live = await listen(server),
      target = { host: '127.0.0.1', port: live.port, servername: 'wiki.example.test' }
    try {
      const untrusted = await inspectTlsEndpoint(target),
        trusted = await inspectTlsEndpoint(target, { ca: fixture.first.cert })
      expect(untrusted).toMatchObject({ connected: true, trusted: false, hostnameMatches: true })
      expect(trusted).toMatchObject({ connected: true, trusted: true, hostnameMatches: true })
      expect(trusted.protocol).toMatch(/^TLSv1\.[23]$/)
      expect(trusted.certificate?.subject).toContain('wiki.example.test')
      expect(trusted.chain).toHaveLength(1)
      expect(JSON.stringify(trusted)).not.toContain('PRIVATE KEY')
      expect(bytes).toBe(0)
    } finally {
      await live.close()
    }
  })
  it('detects hostname mismatch even with an explicitly trusted issuer', async () => {
    const live = await listen(tls.createServer({ key: fixture.first.key, cert: fixture.first.cert }))
    try {
      const result = await inspectTlsEndpoint({ host: '127.0.0.1', port: live.port, servername: 'wrong.example.test' }, { ca: fixture.first.cert })
      expect(result.connected).toBe(true)
      expect(result.hostnameMatches).toBe(false)
      expect(result.summary).toContain('does not match')
    } finally {
      await live.close()
    }
  })
  it('checks IP subject alternative names without using an IP as SNI', async () => {
    const live = await listen(tls.createServer({ key: fixture.first.key, cert: fixture.first.cert }))
    try {
      expect(await inspectTlsEndpoint({ host: '127.0.0.1', port: live.port, servername: '127.0.0.1' }, { ca: fixture.first.cert })).toMatchObject({
        connected: true,
        trusted: true,
        hostnameMatches: true
      })
    } finally {
      await live.close()
    }
  })
  it('bounds a stalled handshake and releases its client socket', async () => {
    const live = await listen(net.createServer())
    try {
      const result = await inspectTlsEndpoint({ host: '127.0.0.1', port: live.port, servername: 'wiki.example.test' }, { timeoutMs: 250 })
      expect(result).toMatchObject({ connected: false, trusted: null, certificate: null })
      expect(result.summary).toContain('timed out')
    } finally {
      await live.close()
    }
  })
})
