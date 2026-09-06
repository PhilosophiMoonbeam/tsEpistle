import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect } from '../bun-test.mts'
import { mailDkimDnsMatches, mailDiagnosticFailure } from '../../repositories/mail-diagnostics.ts'
describe('Mail diagnostic evidence', () => {
  it('matches chunked RSA public records in either common encoding and rejects ambiguous selectors', () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
      spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      pkcs1 = pair.publicKey.export({ format: 'der', type: 'pkcs1' }).toString('base64')
    const expected = `v=DKIM1; k=rsa; p=${spki}`
    expect(mailDkimDnsMatches([[expected.slice(0, 200), expected.slice(200)]], expected)).toBe(true)
    expect(mailDkimDnsMatches([[`v=DKIM1; k=rsa; p=${pkcs1}`]], expected)).toBe(true)
    expect(mailDkimDnsMatches([[expected], [expected]], expected)).toBe(false)
    expect(mailDkimDnsMatches([[`v=DKIM1; p = ${spki}`]], expected)).toBe(true)
    expect(mailDkimDnsMatches([[`v=DKIM1; h=sha1; p=${spki}`]], expected)).toBe(false)
    expect(mailDkimDnsMatches([[`v=DKIM1; s=other; p=${spki}`]], expected)).toBe(false)
    for (const record of ['v=DKIM1; p=', `v=DKIM1; k=ed25519; p=${spki}`, `v=DKIM1; p=${spki}; p=${spki}`, 'v=DKIM1; p=not-a-key'])
      expect(mailDkimDnsMatches([[record]], expected)).toBe(false)
  })
  it('never projects provider errors and distinguishes a definite refusal from an uncertain test', () => {
    for (const code of ['EAUTH', 'ETLS', 'EDNS', 'ECONNECTION', 'EENVELOPE']) {
      const result = mailDiagnosticFailure('test', { code, message: 'smtp-password and private recipient details' })
      expect(result.state).toBe('failed')
      expect(JSON.stringify(result)).not.toContain('smtp-password')
    }
    expect(mailDiagnosticFailure('test', { code: 'ESOCKET' }).state).toBe('uncertain')
    expect(mailDiagnosticFailure('connection', { code: 'ESOCKET' }).state).toBe('failed')
    expect(mailDiagnosticFailure('dkim', { code: 'ENODATA' }).summary).toContain('No DKIM TXT record')
  })
})
