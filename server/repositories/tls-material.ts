import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, X509Certificate } from 'node:crypto'
import { createSecureContext, type SecureContextOptions } from 'node:tls'
import type { TlsCertificateEvidence } from '../../shared/tls-workspace.ts'

export interface TlsMaterialConfiguration {
  format?: string
  inline?: boolean
  key?: string
  cert?: string
  pfx?: string
  passphrase?: string | null
  dhparam?: string | null
}
export interface TlsMaterial {
  options: SecureContextOptions
  /** Internal material identity, including private material. Never return through an API. */
  key: string
  certificate: TlsCertificateEvidence | null
  source: 'inline' | 'file'
  format: 'pem' | 'pfx'
}
const maximumBytes = 4 * 1024 * 1024
const read = async (value: string | undefined, inline: boolean): Promise<Buffer> => {
  if (!value) throw new Error('TLS certificate material is incomplete.')
  if (inline) {
    if (Buffer.byteLength(value) > maximumBytes) throw new Error('TLS certificate material exceeds the supported size.')
    return Buffer.from(value)
  }
  const handle = await fs.open(value, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) throw new Error('Unsupported certificate material')
    // Read no more than the bound even if the file grows after stat().
    const buffer = Buffer.alloc(maximumBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!part.bytesRead) break
      bytesRead += part.bytesRead
    }
    if (!bytesRead || bytesRead > maximumBytes) throw new Error('Unsupported certificate material')
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}
const text = (value: string | undefined, max = 16384): string => (value ?? '').slice(0, max)
export const tlsCertificateAt = (certificate: TlsCertificateEvidence, now = new Date()): TlsCertificateEvidence => {
  const from = new Date(certificate.validFrom),
    until = new Date(certificate.validUntil)
  const daysRemaining = Math.floor((until.getTime() - now.getTime()) / 86400000)
  return { ...certificate, daysRemaining, validity: from > now ? 'not-yet-valid' : until <= now ? 'expired' : daysRemaining <= 30 ? 'expiring' : 'valid' }
}
export const describeTlsCertificate = (value: Buffer | string, now = new Date()): TlsCertificateEvidence => {
  const certificate = new X509Certificate(value),
    from = new Date(certificate.validFrom),
    until = new Date(certificate.validTo)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime())) throw new Error('Certificate dates could not be read.')
  const daysRemaining = Math.floor((until.getTime() - now.getTime()) / 86400000),
    key = certificate.publicKey
  const details = key.asymmetricKeyDetails
  return {
    fingerprint256: certificate.fingerprint256,
    serialNumber: text(certificate.serialNumber, 256),
    subject: text(certificate.subject),
    issuer: text(certificate.issuer),
    subjectAlternativeNames: text(certificate.subjectAltName),
    validFrom: from.toISOString(),
    validUntil: until.toISOString(),
    validity: from > now ? 'not-yet-valid' : until <= now ? 'expired' : daysRemaining <= 30 ? 'expiring' : 'valid',
    daysRemaining,
    key:
      key.asymmetricKeyType === 'rsa'
        ? `RSA ${details?.modulusLength ?? 'unknown'} bits`
        : key.asymmetricKeyType === 'ec'
          ? `EC ${details?.namedCurve ?? 'unknown curve'}`
          : String(key.asymmetricKeyType ?? 'Unknown'),
    isCertificateAuthority: certificate.ca
  }
}
export const loadTlsMaterial = async (configuration: TlsMaterialConfiguration): Promise<TlsMaterial> => {
  const config = { ...configuration },
    inline = config.inline === true
  if (!['pem', 'pfx'].includes(config.format ?? 'pem')) throw new Error('Choose PEM or PFX certificate material in deployment configuration.')
  const options: SecureContextOptions = { minVersion: 'TLSv1.2' }
  try {
    if ((config.format ?? 'pem') === 'pem') {
      const [key, cert] = await Promise.all([read(config.key, inline), read(config.cert, inline)])
      options.key = key
      options.cert = cert
    } else options.pfx = await read(config.pfx, inline)
    if (config.passphrase) options.passphrase = config.passphrase
    if (config.dhparam) options.dhparam = config.dhparam
    // Validate the complete pair/bundle before touching a live server context.
    createSecureContext(options)
    const digest = createHash('sha256')
    for (const field of ['key', 'cert', 'pfx', 'passphrase', 'dhparam', 'minVersion'] as const) {
      const value = options[field],
        buffer = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value))
      digest.update(field + ':' + buffer.byteLength + ':').update(buffer)
    }
    return {
      options,
      key: digest.digest('hex'),
      certificate: options.cert ? describeTlsCertificate(options.cert as Buffer) : null,
      source: inline ? 'inline' : 'file',
      format: (config.format ?? 'pem') as 'pem' | 'pfx'
    }
  } catch {
    throw new Error('TLS material could not be loaded or validated. Check the configured files, certificate/key match, bundle format and passphrase.')
  }
}
