import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import { describeTlsCertificate, loadTlsMaterial, tlsCertificateAt } from '../../repositories/tls-material.ts'
import { tlsFixture } from './tls-fixture.ts'

let fixture: ReturnType<typeof tlsFixture>
beforeAll(() => {
  fixture = tlsFixture()
})
afterAll(() => fixture.close())
describe('TLS material validation', () => {
  it('describes actual public certificate identity and time-based validity without private material', () => {
    const issued = new X509Certificate(fixture.first.cert)
    const midpoint = new Date((new Date(issued.validFrom).getTime() + new Date(issued.validTo).getTime()) / 2)
    const cert = describeTlsCertificate(fixture.first.cert, midpoint)
    expect(cert.subjectAlternativeNames).toContain('DNS:wiki.example.test')
    expect(cert.key).toBe('RSA 2048 bits')
    expect(cert.validity).toBe('expiring')
    expect(tlsCertificateAt(cert, new Date(cert.validUntil)).validity).toBe('expired')
    expect(cert.validity).toBe('expiring')
    expect(describeTlsCertificate(fixture.first.cert, new Date(new Date(cert.validFrom).getTime() - 1000)).validity).toBe('not-yet-valid')
    expect(describeTlsCertificate(fixture.first.cert, new Date(cert.validUntil)).validity).toBe('expired')
    expect(cert.fingerprint256).not.toBe(describeTlsCertificate(fixture.second.cert).fingerprint256)
  })
  it('loads file and inline PEM with the same material identity', async () => {
    const file = await loadTlsMaterial({ key: fixture.first.keyPath, cert: fixture.first.certPath })
    const inline = await loadTlsMaterial({ inline: true, key: fixture.first.key, cert: fixture.first.cert })
    expect(file.key).toBe(inline.key)
    expect(file.certificate?.fingerprint256).toBe(inline.certificate?.fingerprint256)
    expect(file.options.minVersion).toBe('TLSv1.2')
    expect(file.source).toBe('file')
    expect(inline.source).toBe('inline')
  })
  it('validates password-protected PFX without pretending to have parsed its public certificate', async () => {
    const loaded = await loadTlsMaterial({ format: 'pfx', pfx: fixture.first.pfxPath, passphrase: 'fixture-password' })
    expect(loaded.format).toBe('pfx')
    expect(loaded.certificate).toBeNull()
    const passphrase = 'wrong-private-password'
    const error: unknown = await loadTlsMaterial({ format: 'pfx', pfx: fixture.first.pfxPath, passphrase }).then(
      () => null,
      error => error
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(passphrase)
    expect((error as Error).message).not.toContain(fixture.first.pfxPath)
  })
  it('rejects mismatched pairs and missing, empty, non-file or oversized material with a generic error', async () => {
    const empty = join(fixture.directory, 'empty'),
      large = join(fixture.directory, 'large')
    writeFileSync(empty, '')
    const oversizedKey = '\n'.repeat(4 * 1024 * 1024 + 1 - Buffer.byteLength(fixture.first.key)) + fixture.first.key
    // Dependency control: this is a valid matching PEM pair, not a parsing failure.
    createSecureContext({ key: oversizedKey, cert: fixture.first.cert })
    writeFileSync(large, oversizedKey)
    const candidates = [
      { inline: true, key: fixture.first.key, cert: fixture.second.cert },
      { key: join(fixture.directory, 'private-missing-path'), cert: fixture.first.certPath },
      { key: empty, cert: fixture.first.certPath },
      { key: fixture.directory, cert: fixture.first.certPath },
      { key: large, cert: fixture.first.certPath },
      { inline: true, key: oversizedKey, cert: fixture.first.cert }
    ]
    for (const config of candidates) {
      const error: unknown = await loadTlsMaterial(config).then(
        () => null,
        error => error
      )
      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).not.toContain(fixture.directory)
      expect(message).not.toContain(fixture.first.key)
      expect(message).not.toContain('PRIVATE KEY')
      expect(message).not.toContain('BEGIN CERTIFICATE')
    }
  })
})
