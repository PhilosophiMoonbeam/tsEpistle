import { createPublicKey } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import type { MailCheckKind, MailCheckState } from '../../shared/mail-workspace.ts'

export const resolveMailDkimTxt = async (name: string): Promise<string[][]> => {
  const resolver = new Resolver({ timeout: 5000, tries: 1 })
  const deadline = setTimeout(() => resolver.cancel(), 7000)
  try {
    return await resolver.resolveTxt(name)
  } finally {
    clearTimeout(deadline)
  }
}
const publicKey = (value: string): string | null => {
  if (!/^[a-zA-Z0-9+/=\s]+$/.test(value) || value.length > 8192) return null
  for (const type of ['spki', 'pkcs1'] as const) {
    try {
      const key = createPublicKey({ key: Buffer.from(value.replace(/\s/g, ''), 'base64'), format: 'der', type })
      if (key.asymmetricKeyType !== 'rsa') return null
      return key.export({ format: 'der', type: 'spki' }).toString('base64')
    } catch {
      /* Accept either interoperable RSA public-key encoding. */
    }
  }
  return null
}
export const mailDkimDnsMatches = (records: string[][], expected: string): boolean => {
  // Multiple key records at one selector are ambiguous, even if one is correct.
  const candidates = records.filter(chunks => /(^|;)\s*p\s*=/.test(chunks.join('')))
  if (candidates.length !== 1 || candidates[0]!.join('').length > 16384) return false
  const entries = candidates[0]!
    .join('')
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      const equal = value.indexOf('=')
      return [value.slice(0, equal).trim(), value.slice(equal + 1).trim()]
    })
  if (entries.some(([key]) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key!))) return false
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false
  const tags: Record<string, string> = Object.fromEntries(entries)
  if ((tags.v !== undefined && tags.v !== 'DKIM1') || (tags.k !== undefined && tags.k !== 'rsa') || !tags.p) return false
  if (
    (tags.v !== undefined && entries[0]?.[0] !== 'v') ||
    (tags.h &&
      !tags.h
        .split(':')
        .map(value => value.trim())
        .includes('sha256')) ||
    (tags.s && !tags.s.split(':').some(value => ['email', '*'].includes(value.trim())))
  )
    return false
  const actual = publicKey(tags.p),
    wanted = publicKey(expected.split('p=')[1] ?? '')
  return actual !== null && wanted !== null && actual === wanted
}
export const mailDiagnosticFailure = (kind: MailCheckKind, error: unknown): { state: MailCheckState; summary: string } => {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
  if (kind === 'dkim')
    return {
      state: 'failed',
      summary: ['ENOTFOUND', 'ENODATA'].includes(String(code))
        ? 'No DKIM TXT record was found at this selector.'
        : 'The DNS lookup did not finish successfully. Check DNS availability and try a new check.'
    }
  if (code === 'EAUTH') return { state: 'failed', summary: 'The SMTP server rejected authentication. Review the saved username and password.' }
  if (code === 'ETLS') return { state: 'failed', summary: 'The SMTP TLS handshake or required upgrade failed. Review the TLS mode and certificate settings.' }
  if (code === 'EDNS' || code === 'ECONNECTION')
    return { state: 'failed', summary: 'A connection to the SMTP server could not be established. Check its hostname, port and network access.' }
  if (code === 'EENVELOPE') return { state: 'failed', summary: 'The SMTP server rejected the message sender or recipient.' }
  if (kind === 'test')
    return {
      state: 'uncertain',
      summary:
        'The test did not return a confirmed SMTP outcome. It may have been accepted. Check the recipient mailbox or provider logs before requesting another test.'
    }
  return { state: 'failed', summary: 'The SMTP connection check did not finish successfully. Review the transport settings and provider logs.' }
}
