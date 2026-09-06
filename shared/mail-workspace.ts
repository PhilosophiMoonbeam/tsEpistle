import { z } from 'zod'

const line = z
  .string()
  .max(255)
  .refine(
    value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    'Use a single line without control characters.'
  )
export const MailPolicySchema = z
  .object({
    enabled: z.boolean(),
    senderName: line,
    senderEmail: line,
    replyTo: line,
    host: line,
    port: z.number().int().min(1).max(65535),
    name: line,
    tlsMode: z.enum(['implicit', 'starttls', 'opportunistic', 'plain']),
    verifySSL: z.boolean(),
    tlsServerName: line,
    user: line,
    useDKIM: z.boolean(),
    dkimDomainName: line,
    dkimKeySelector: line
  })
  .strict()
export type MailPolicy = z.infer<typeof MailPolicySchema>
export const MailSecretChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().min(1).max(65536) }).strict()
])
export const MailDraftSchema = z
  .object({
    policy: MailPolicySchema,
    secrets: z.object({ pass: MailSecretChangeSchema, dkimPrivateKey: MailSecretChangeSchema }).strict()
  })
  .strict()
export type MailDraft = z.infer<typeof MailDraftSchema>
export type MailSecretPresence = { pass: boolean; dkimPrivateKey: boolean }
export const mailRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
export const mailPolicyFromConfiguration = (value: unknown): MailPolicy => {
  const raw = mailRecord(value),
    text = (key: string) => (typeof raw[key] === 'string' ? raw[key] : '')
  const tlsMode = ['implicit', 'starttls', 'opportunistic', 'plain'].includes(String(raw.tlsMode))
    ? (raw.tlsMode as MailPolicy['tlsMode'])
    : raw.secure === true
      ? 'implicit'
      : 'opportunistic'
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : Boolean(text('host').trim()),
    senderName: text('senderName'),
    senderEmail: text('senderEmail'),
    replyTo: text('replyTo'),
    host: text('host'),
    port: typeof raw.port === 'number' ? raw.port : tlsMode === 'implicit' ? 465 : 587,
    name: text('name'),
    tlsMode,
    verifySSL: raw.verifySSL !== false,
    tlsServerName: text('tlsServerName'),
    user: text('user'),
    useDKIM: raw.useDKIM === true,
    dkimDomainName: text('dkimDomainName'),
    dkimKeySelector: text('dkimKeySelector')
  }
}
export const isMailAddress = (value: string): boolean => value.length <= 254 && /^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/.test(value)
export const isMailDomain = (value: string): boolean =>
  value.length <= 253 && value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
export const mailConfigurationIssues = (policy: MailPolicy, secrets: MailSecretPresence): string[] => {
  const issues: string[] = []
  if (!MailPolicySchema.safeParse(policy).success) issues.push('Check the field lengths, SMTP port and transport settings.')
  if (!policy.enabled) return issues
  if (!policy.senderName.trim()) issues.push('Sender name is required.')
  if (!isMailAddress(policy.senderEmail.trim())) issues.push('Enter a single sender email address.')
  if (policy.replyTo && !isMailAddress(policy.replyTo.trim())) issues.push('Enter a single reply-to email address or leave it empty.')
  if (!policy.host.trim() || /[\s/@?#]/.test(policy.host) || policy.host.includes('://'))
    issues.push('Enter an SMTP hostname or IP address, without a URL scheme or path.')
  if (policy.user && !secrets.pass) issues.push('Provide the SMTP password or clear the username for an unauthenticated relay.')
  if (policy.tlsServerName && !isMailDomain(policy.tlsServerName)) issues.push('Enter the hostname on the SMTP TLS certificate.')
  if (policy.useDKIM) {
    if (!isMailDomain(policy.dkimDomainName) || !policy.dkimDomainName.includes('.')) issues.push('Enter the DKIM signing domain.')
    if (!isMailDomain(policy.dkimKeySelector)) issues.push('Enter a DKIM selector using DNS labels.')
    if (!secrets.dkimPrivateKey) issues.push('Provide the DKIM private key.')
  }
  return issues
}

export const MAIL_TEMPLATES = [
  { key: 'account-verify', title: 'Account verification', description: 'Confirm an email address during registration.' },
  { key: 'account-reset-pwd', title: 'Password reset', description: 'Help an account holder reset their password.' },
  { key: 'account-welcome', title: 'Account invitation', description: 'Invite a new account holder to sign in.' },
  { key: 'page-watch', title: 'Watched page activity', description: 'Notify a subscriber about an accessible page change.' },
  { key: 'test', title: 'Delivery test', description: 'Send an explicitly requested administration test message.' }
] as const
export type MailTemplateKey = (typeof MAIL_TEMPLATES)[number]['key']

export const MailConfigurationEventSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  actorId: z.number().int().positive().nullable(),
  reason: z.string().max(1000),
  fields: z.array(z.string().max(100)).max(30)
})
export type MailConfigurationEvent = z.infer<typeof MailConfigurationEventSchema>
export interface MailConfigurationWorkspace {
  policy: MailPolicy
  secrets: MailSecretPresence
  fingerprint: string
  revision: string
  observedAt: string
  offline: boolean
  publicUrl: string
  issues: string[]
  dkimRecord: { name: string; value: string; bits: number } | null
  history: MailConfigurationEvent[]
}
