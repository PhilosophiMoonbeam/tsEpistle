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
// Real loopback handshakes need event-based waits; the clock only bounds a lost event or broken production deadline.
const bounded = async <T>(promise: Promise<T>, observation: string): Promise<T> => {
  let watchdog: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`Timed out waiting for ${observation}`)), 2000)
      })
    ])
  } finally {
    clearTimeout(watchdog)
  }
}
const connectionClosed = (server: net.Server): Promise<void> => {
  const closed = Promise.withResolvers<void>()
  server.once('connection', socket => socket.once('close', closed.resolve))
  return closed.promise
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
      const untrustedClosed = connectionClosed(server)
      const untrusted = await bounded(inspectTlsEndpoint(target), 'untrusted handshake')
      await bounded(untrustedClosed, 'untrusted connection close')
      const trustedClosed = connectionClosed(server)
      const trusted = await bounded(inspectTlsEndpoint(target, { ca: fixture.first.cert }), 'trusted handshake')
      await bounded(trustedClosed, 'trusted connection close')
      expect(untrusted).toMatchObject({ connected: true, trusted: false, hostnameMatches: true })
      expect(trusted).toMatchObject({ connected: true, trusted: true, hostnameMatches: true })
      expect(trusted.protocol).toMatch(/^TLSv1\.[23]$/)
      expect(trusted.certificate?.subject).toContain('wiki.example.test')
      expect(trusted.chain).toHaveLength(1)
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
    } finally {
      await live.close()
    }
  })
  it('checks IP subject alternative names without using an IP as SNI', async () => {
    const server = tls.createServer({ key: fixture.first.key, cert: fixture.first.cert })
    const live = await listen(server)
    try {
      const ipSni = Promise.withResolvers<tls.TLSSocket['servername']>()
      server.once('secureConnection', socket => ipSni.resolve(socket.servername))
      expect(await inspectTlsEndpoint({ host: '127.0.0.1', port: live.port, servername: '127.0.0.1' }, { ca: fixture.first.cert })).toMatchObject({
        connected: true,
        trusted: true,
        hostnameMatches: true
      })
      expect(await bounded(ipSni.promise, 'IP handshake SNI observation')).toBeFalsy()
      const dnsSni = Promise.withResolvers<tls.TLSSocket['servername']>()
      server.once('secureConnection', socket => dnsSni.resolve(socket.servername))
      expect(await inspectTlsEndpoint({ host: '127.0.0.1', port: live.port, servername: 'wiki.example.test' }, { ca: fixture.first.cert })).toMatchObject({
        connected: true,
        trusted: true,
        hostnameMatches: true
      })
      expect(await bounded(dnsSni.promise, 'DNS handshake SNI observation')).toBe('wiki.example.test')
    } finally {
      await live.close()
    }
  })
  it('bounds a stalled handshake and releases its client socket', async () => {
    const server = net.createServer(socket => socket.resume())
    const live = await listen(server)
    try {
      const closed = connectionClosed(server)
      const result = await bounded(
        inspectTlsEndpoint({ host: '127.0.0.1', port: live.port, servername: 'wiki.example.test' }, { timeoutMs: 250 }),
        'stalled handshake completion'
      )
      expect(result).toMatchObject({ connected: false, trusted: null, certificate: null })
      await bounded(closed, 'stalled client socket close before teardown')
    } finally {
      await live.close()
    }
  })
})
