import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import tls, { type DetailedPeerCertificate, type TLSSocket } from 'node:tls'
import type { TlsConnectionEvidence } from '../../shared/tls-workspace.ts'
import { describeTlsCertificate } from './tls-material.ts'

export interface TlsProbeTarget {
  host: string
  port: number
  servername: string
}
const host = (value: string): boolean =>
  !!value && value.length <= 253 && (isIP(value) !== 0 || value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))
export const publicTlsTarget = (value: unknown): TlsProbeTarget | null => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value),
      hostname = url.hostname.replace(/^\[|\]$/g, ''),
      ascii = isIP(hostname) ? hostname : domainToASCII(hostname)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !host(ascii)) return null
    return { host: ascii, port: url.port ? Number(url.port) : 443, servername: ascii }
  } catch {
    return null
  }
}
/** Handshake only: no HTTP request, credentials, cookies or other application data. */
export const inspectTlsEndpoint = async (
  target: TlsProbeTarget,
  options: { timeoutMs?: number; ca?: string | Buffer; now?: () => Date } = {}
): Promise<TlsConnectionEvidence> => {
  if (!host(target.host) || !host(target.servername) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
    throw new Error('The configured TLS endpoint is invalid.')
  const timeout = Math.min(15000, Math.max(250, options.timeoutMs ?? 10000)),
    now = options.now ?? (() => new Date())
  return new Promise(resolve => {
    let socket: TLSSocket | undefined,
      completed = false
    const base = (): TlsConnectionEvidence => ({
      observedAt: now().toISOString(),
      endpoint: { ...target },
      connected: false,
      trusted: null,
      hostnameMatches: null,
      protocol: null,
      cipher: null,
      certificate: null,
      chain: [],
      summary: 'The TLS handshake did not complete. Check the configured endpoint, listener and network path.'
    })
    const finish = (result: TlsConnectionEvidence) => {
      if (completed) return
      completed = true
      clearTimeout(deadline)
      socket?.destroy()
      resolve(result)
    }
    const deadline = setTimeout(() => finish({ ...base(), summary: 'The TLS handshake timed out. No HTTP request was sent.' }), timeout)
    try {
      // Inspection must expose expired/untrusted certificates; trust is reported explicitly.
      socket = tls.connect({
        host: target.host,
        port: target.port,
        ...(isIP(target.servername) ? {} : { servername: target.servername }),
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        ...(options.ca ? { ca: options.ca } : {})
      })
      socket.once('error', () => finish(base()))
      socket.once('close', () => {
        if (!completed) finish(base())
      })
      socket.once('secureConnect', () => {
        try {
          const peer = socket!.getPeerCertificate(true),
            result = base()
          if (!peer?.raw?.length || peer.raw.length > 262144)
            return finish({ ...result, connected: true, summary: 'The endpoint completed TLS but did not provide a readable certificate.' })
          const leaf = new X509Certificate(peer.raw),
            matched = isIP(target.servername) ? !!leaf.checkIP(target.servername) : !!leaf.checkHost(target.servername)
          result.connected = true
          result.trusted = socket!.authorized
          result.hostnameMatches = matched
          result.protocol = socket!.getProtocol()
          const cipher = socket!.getCipher()
          result.cipher = cipher.standardName ?? cipher.name
          result.certificate = describeTlsCertificate(peer.raw, now())
          const seen = new Set<string>()
          let next: DetailedPeerCertificate | undefined = peer
          while (next?.raw && next.raw.length <= 262144 && result.chain.length < 8) {
            const item = describeTlsCertificate(next.raw, now())
            if (seen.has(item.fingerprint256)) break
            seen.add(item.fingerprint256)
            result.chain.push(item)
            next = next.issuerCertificate
          }
          result.summary = !matched
            ? 'The presented certificate does not match the configured hostname.'
            : !result.trusted
              ? 'TLS connected, but this application could not verify the certificate against its CA trust store.'
              : ['expired', 'not-yet-valid'].includes(result.certificate.validity)
                ? 'The certificate is outside its validity period.'
                : 'The TLS handshake, hostname and certificate trust checks succeeded. No HTTP request was sent.'
          finish(result)
        } catch {
          finish({ ...base(), connected: true, summary: 'TLS connected, but its certificate details could not be inspected.' })
        }
      })
    } catch {
      finish(base())
    }
  })
}
