import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import type { SMTPTransportOptions } from 'nodemailer'
import { mailPolicyFromConfiguration, mailRecord, mailConfigurationIssues, isMailDomain, type MailPolicy } from '../../shared/mail-workspace.ts'

export interface MailRuntimeConfiguration extends MailPolicy {
  pass: string
  dkimPrivateKey: string
}
export const mailRuntimeConfiguration = (value: unknown): MailRuntimeConfiguration => {
  const raw = mailRecord(value)
  return {
    ...mailPolicyFromConfiguration(raw),
    pass: typeof raw.pass === 'string' ? raw.pass : '',
    dkimPrivateKey: typeof raw.dkimPrivateKey === 'string' ? raw.dkimPrivateKey : ''
  }
}
export const mailConfigurationKey = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(mailRuntimeConfiguration(value)))
    .digest('hex')
export const mailDkimPublicRecord = (value: MailRuntimeConfiguration, includeInactive = false): { name: string; value: string; bits: number } | null => {
  if (!value.useDKIM && (!includeInactive || !value.dkimPrivateKey)) return null
  if (!isMailDomain(value.dkimDomainName) || !value.dkimDomainName.includes('.') || !isMailDomain(value.dkimKeySelector))
    throw new Error('Enter the DKIM signing domain and selector before generating DNS instructions.')
  try {
    const key = createPrivateKey(value.dkimPrivateKey)
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('Unsupported key')
    // Matches RFC 6376 Appendix C's OpenSSL -pubout format; see erratum 3017.
    const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')
    return {
      name: `${value.dkimKeySelector}._domainkey.${value.dkimDomainName}`,
      value: `v=DKIM1; k=rsa; p=${publicKey}`,
      bits: key.asymmetricKeyDetails!.modulusLength!
    }
  } catch {
    throw new Error('Use an unencrypted RSA DKIM private key with at least 2048 bits.')
  }
}
export const mailRuntimeIssues = (value: MailRuntimeConfiguration): string[] => {
  const issues = mailConfigurationIssues(mailPolicyFromConfiguration(value), { pass: Boolean(value.pass), dkimPrivateKey: Boolean(value.dkimPrivateKey) })
  if (value.enabled && value.useDKIM && value.dkimPrivateKey) {
    try {
      mailDkimPublicRecord(value)
    } catch (error) {
      issues.push((error as Error).message)
    }
  }
  return issues
}
export const mailTransportOptions = (value: MailRuntimeConfiguration): SMTPTransportOptions => ({
  host: value.host.trim(),
  port: value.port,
  ...(value.name.trim() ? { name: value.name.trim() } : {}),
  secure: value.tlsMode === 'implicit',
  requireTLS: value.tlsMode === 'starttls',
  ignoreTLS: value.tlsMode === 'plain',
  tls: { rejectUnauthorized: value.verifySSL, minVersion: 'TLSv1.2', ...(value.tlsServerName ? { servername: value.tlsServerName } : {}) },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  dnsTimeout: 15000,
  ...(value.user ? { auth: { user: value.user, pass: value.pass } } : {}),
  ...(value.useDKIM ? { dkim: { domainName: value.dkimDomainName, keySelector: value.dkimKeySelector, privateKey: value.dkimPrivateKey } } : {})
})
