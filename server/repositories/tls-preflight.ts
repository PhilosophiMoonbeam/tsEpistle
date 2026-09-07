import tls from 'node:tls'
import type { Socket } from 'node:net'
import { inspectTlsEndpoint } from './tls-probe.ts'
import { loadTlsMaterial, type TlsMaterial, type TlsMaterialConfiguration } from './tls-material.ts'

/** Resolve PFX public metadata through a bounded, loopback-only handshake. */
export const prepareTlsMaterial = async (configuration: TlsMaterialConfiguration): Promise<TlsMaterial> => {
  const material = await loadTlsMaterial(configuration)
  if (material.certificate) return material
  const sockets = new Set<Socket>()
  const server = tls.createServer(material.options)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Preflight listener is unavailable.')
    const evidence = await inspectTlsEndpoint({ host: '127.0.0.1', port: address.port, servername: '127.0.0.1' }, { timeoutMs: 3000 })
    if (!evidence.connected || !evidence.certificate) throw new Error('Preflight certificate is unavailable.')
    material.certificate = evidence.certificate
    return material
  } catch {
    throw new Error('The certificate bundle could not complete a local TLS preflight. Check its certificate, key and runtime compatibility.')
  } finally {
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
