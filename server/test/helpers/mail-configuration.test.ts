import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { describe, it, expect } from '../bun-test.mts'
import { mailRuntimeConfiguration, mailDkimPublicRecord, mailConfigurationKey, mailRuntimeIssues } from '../../repositories/mail-configuration.ts'
describe('Mail signing configuration', () => {
  it('derives a DNS public key matching the private signing key and never returns private material', () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
      pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const config = mailRuntimeConfiguration({
      enabled: true,
      host: 'smtp.example.test',
      senderName: 'Wiki',
      senderEmail: 'wiki@example.test',
      useDKIM: true,
      dkimDomainName: 'example.test',
      dkimKeySelector: 'wiki',
      dkimPrivateKey: pem
    })
    expect(mailRuntimeIssues(config)).toEqual([])
    const record = mailDkimPublicRecord(config)!
    expect(record.name).toBe('wiki._domainkey.example.test')
    expect(record.bits).toBe(2048)
    const decoded = createPublicKey({ key: Buffer.from(record.value.split('p=')[1]!, 'base64'), format: 'der', type: 'spki' })
    expect(decoded.export({ format: 'pem', type: 'spki' })).toBe(pair.publicKey.export({ format: 'pem', type: 'spki' }))
    expect(JSON.stringify(record)).not.toContain(pem)
    expect(mailConfigurationKey(config)).not.toBe(mailConfigurationKey({ ...config, pass: 'changed' }))
  })
  it('rejects invalid and insufficient signing keys without exposing key contents', () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    for (const dkimPrivateKey of ['private-invalid-value', weak]) {
      const config = mailRuntimeConfiguration({ useDKIM: true, dkimDomainName: 'example.test', dkimKeySelector: 'wiki', dkimPrivateKey })
      expect(() => mailDkimPublicRecord(config)).toThrow('at least 2048 bits')
    }
    expect(mailDkimPublicRecord(mailRuntimeConfiguration({ useDKIM: false, dkimPrivateKey: 'retained inactive key' }))).toBeNull()
  })
})
