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

export type MailPageWatchAction =
  | 'created'
  | 'updated'
  | 'restored'
  | 'moved'
  | 'deleted'
  | 'changed-visibility'
  | 'transferred-ownership'
  | 'changed'

/** Non-translated values interpolated into a fixed template by the mail runtime. */
export interface MailTemplateData {
  buttonLink?: string
  actorName?: string
  action?: MailPageWatchAction
  pageTitle?: string
  url?: string
}

export const MAIL_TEMPLATES = [
  {
    key: 'account-verify',
    title: 'Account verification',
    description: 'Confirm an email address during registration.',
    translationKey: 'welcome.verify',
    messageKeys: { preheader: 'body', content: 'body', buttonText: 'action' },
    messages: {
      subject: 'Confirm your email address — {{siteTitle}}',
      preheader: 'An account was created for this address on {{siteTitle}}. Confirm that it is yours to finish signing up.',
      kicker: '',
      title: 'Confirm your email address',
      content: 'An account was created for this address on {{siteTitle}}. Confirm that it is yours to finish signing up.',
      buttonText: 'Confirm my email address',
      expiry: 'This link is valid for 24 hours. If you did not create this account, you can ignore this message.',
      footer: 'You are receiving this because an account was created for this address on {{siteTitle}}.'
    },
    htmlText: {
      'Confirm your email': 'kicker',
      'This link confirms your account email address. If you did not register, you can ignore this message.': 'footer'
    }
  },
  {
    key: 'account-reset-pwd',
    title: 'Password reset',
    description: 'Help an account holder reset their password.',
    translationKey: 'resetPwd',
    messageKeys: { preheader: 'body', content: 'body', buttonText: 'action' },
    messages: {
      subject: 'Reset your password — {{siteTitle}}',
      preheader: 'Somebody asked to reset the password for your account on {{siteTitle}}.',
      kicker: '',
      title: 'Reset your password',
      content: 'Somebody asked to reset the password for your account on {{siteTitle}}.',
      buttonText: 'Choose a new password',
      expiry: 'This link is valid for 24 hours and can only be used once. If you did not ask for this, nothing has changed and you can ignore this message.',
      footer: 'You are receiving this because a password reset was requested for this address on {{siteTitle}}.'
    },
    htmlText: {
      'Account recovery': 'kicker',
      'If you did not request a password reset, you can ignore this message. Your password has not been changed.': 'footer'
    }
  },
  {
    key: 'account-welcome',
    title: 'Account invitation',
    description: 'Invite a new account holder to sign in.',
    translationKey: 'welcome',
    messageKeys: { preheader: 'body', title: 'subject', content: 'body', buttonText: 'action' },
    messages: {
      subject: 'Welcome to {{siteTitle}}',
      preheader: 'Your account on {{siteTitle}} is ready. You can sign in at any time.',
      kicker: '',
      title: 'Welcome to {{siteTitle}}',
      content: 'Your account on {{siteTitle}} is ready. You can sign in at any time.',
      buttonText: 'Go to the wiki',
      footer: 'You are receiving this because an account was created for this address on {{siteTitle}}.'
    },
    htmlText: {
      'You are invited': 'kicker',
      'Use your configured sign-in method to access the workspace. Your administrator can help if you have trouble signing in.': 'footer'
    }
  },
  {
    key: 'page-watch',
    title: 'Watched page activity',
    description: 'Notify a subscriber about an accessible page change.',
    translationKey: 'pageWatch',
    messages: {
      subject: '{{event}} — {{pageTitle}} — {{siteTitle}}',
      preheader: '{{event}}',
      kicker: '',
      content: '{{event}}',
      buttonText: 'Open page',
      footer: 'You receive these updates because you watch this page. Manage your notification preferences in the workspace.'
    },
    actions: {
      created: { key: 'pageWatch.actions.created', english: '{{actor}} created this page' },
      updated: { key: 'common.watchEventUpdated', english: '{{actor}} updated this page' },
      restored: { key: 'common.watchEventRestored', english: '{{actor}} restored this page' },
      moved: { key: 'common.watchEventMoved', english: '{{actor}} moved this page' },
      deleted: { key: 'common.watchEventDeleted', english: '{{actor}} deleted this page' },
      'changed-visibility': { key: 'common.watchEventVisibilityChanged', english: '{{actor}} changed visibility for this page' },
      'transferred-ownership': { key: 'common.watchEventOwnershipTransferred', english: '{{actor}} transferred ownership of this page' },
      changed: { key: 'common.watchEventChanged', english: '{{actor}} changed this page' }
    },
    htmlText: {
      'Watched page activity': 'kicker',
      '<strong><%- actorName %></strong> <%- action %> this page.': 'content',
      'Open page': 'buttonText',
      'You receive these updates because you watch this page. Manage your notification preferences in the workspace.': 'footer'
    }
  },
  {
    key: 'test',
    title: 'Delivery test',
    description: 'Send an explicitly requested administration test message.',
    translationKey: 'test',
    messageKeys: { preheader: 'body', introduction: 'body' },
    messages: {
      subject: 'Test email — {{siteTitle}}',
      preheader: 'If you are reading it, {{siteName}} can send mail through the SMTP server it is configured with.',
      kicker: '',
      title: 'This is a test email',
      introduction: 'If you are reading it, {{siteName}} can send mail through the SMTP server it is configured with.',
      confirmation: 'Receiving this message confirms that this test reached your mailbox. Future messages may still be affected by provider policy, filtering, or changes to the configuration.',
      footer: 'You are receiving this because somebody sent a test email from the administration area.'
    },
    htmlText: {
      'Delivery check': 'kicker',
      'A message from your workspace': 'title',
      'An administrator requested this test of the mail configuration for <strong><%- siteTitle %></strong>.': 'introduction',
      '<p style="margin:0;font-size:15px;line-height:1.75">Receiving this message confirms that this test reached your mailbox. Future messages may still be affected by provider policy, filtering, or changes to the configuration.</p>': 'confirmation',
      'No account action is required.': 'footer'
    }
  }
] as const
export type MailTemplateKey = (typeof MAIL_TEMPLATES)[number]['key']

export interface MailTemplatePreview {
  key: MailTemplateKey
  title: string
  description: string
  html: string
  text: string
  subject: string
}

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

export type MailCheckKind = 'connection' | 'dkim' | 'test'
export type MailCheckState = 'running' | 'succeeded' | 'failed' | 'uncertain'
export interface MailCheck {
  id: string
  kind: MailCheckKind
  state: MailCheckState
  actorId: number | null
  recipient: string | null
  configurationRevision: string
  createdAt: string
  completedAt: string | null
  summary: string
}
export interface MailWorkspace extends MailConfigurationWorkspace {
  runtime: {
    allocated: boolean
    settingsCurrent: boolean
    offline: boolean
    state: 'disabled' | 'invalid' | 'ready'
  }
  checks: MailCheck[]
}
export const MailCheckRequestSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().uuid(), kind: z.literal('connection'), fingerprint: z.string().length(64) }).strict(),
  z.object({ id: z.string().uuid(), kind: z.literal('dkim'), fingerprint: z.string().length(64) }).strict(),
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal('test'),
      fingerprint: z.string().length(64),
      recipient: z.string().trim().refine(isMailAddress, 'Enter a single recipient email address.'),
      confirmSend: z.literal(true),
      acknowledgedUncertainId: z.string().uuid().optional()
    })
    .strict()
])
export type MailCheckRequest = z.infer<typeof MailCheckRequestSchema>
