export const DISCUSSION_SECRET_MASK = '********'
const hasUnsafeUrlCharacters = (value: string): boolean => [...value].some(character => character === '\\' || character.charCodeAt(0) <= 32)
export interface DiscussionProperty {
  type: string
  title?: string
  hint?: string
  default?: unknown
  enum?: string[]
  order?: number
  sensitive?: boolean
  multiline?: boolean
}
export interface DiscussionProviderSettings { key: string; isEnabled: boolean; config: Record<string, unknown> }
export interface DiscussionProvider extends DiscussionProviderSettings {
  title: string
  description: string
  website: string
  isAvailable: boolean
  external: boolean
  props: Record<string, DiscussionProperty>
}
export interface DiscussionPolicySnapshot { enabled: boolean; providers: DiscussionProvider[]; fingerprint: string }
export interface DiscussionIssue { provider: string; field: string; message: string }
export interface DiscussionWorkspace extends DiscussionPolicySnapshot {
  counts: { comments: number; visible: number; hidden: number; pages: number; closedPages: number }
  runtime: { provider: string | null; antiSpam: { state: 'off' | 'verified' | 'unverified' | 'unavailable'; checkedAt: string | null } }
}
export const discussionProviderTitle = (provider: Pick<DiscussionProvider, 'key' | 'title'>): string => provider.key === 'default' ? 'Built-in discussions' : provider.title
export const discussionSettings = (providers: DiscussionProvider[]): DiscussionProviderSettings[] => providers.map(({ key, isEnabled, config, props }) => ({ key, isEnabled, config: Object.fromEntries(Object.entries(config).filter(([field]) => Object.hasOwn(props, field))) }))
export const discussionIssues = (providers: DiscussionProvider[]): DiscussionIssue[] => {
  const issues: DiscussionIssue[] = [], enabled = providers.filter(provider => provider.isEnabled)
  if (enabled.length !== 1) issues.push({ provider: '', field: '', message: 'Choose exactly one discussion provider.' })
  for (const provider of providers) {
    const title = discussionProviderTitle(provider)
    if (provider.isEnabled && !provider.isAvailable) issues.push({ provider: provider.key, field: '', message: `${title} is not available in this deployment.` })
    for (const field of Object.keys(provider.config)) if (!Object.hasOwn(provider.props, field)) issues.push({ provider: provider.key, field, message: `${title} contains an unsupported setting.` })
    for (const [field, prop] of Object.entries(provider.props)) {
      const value = provider.config[field], label = `${title} · ${prop.title || field}`
      if ((prop.type === 'boolean' && typeof value !== 'boolean') || (prop.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) || (prop.type === 'string' && typeof value !== 'string')) issues.push({ provider: provider.key, field, message: `${label} requires a ${prop.type} value.` })
      else if (prop.enum && !prop.enum.includes(String(value))) issues.push({ provider: provider.key, field, message: `${label} must use one of the listed options.` })
      else if (typeof value === 'string' && value.length > 2000) issues.push({ provider: provider.key, field, message: `${label} must be at most 2,000 characters.` })
    }
    if (provider.key === 'default') {
      if (!Number.isSafeInteger(provider.config.minDelay) || Number(provider.config.minDelay) < 0 || Number(provider.config.minDelay) > 86400) issues.push({ provider: provider.key, field: 'minDelay', message: 'Post delay must be a whole number from 0 to 86,400 seconds.' })
      const key = provider.config.akismet
      if (typeof key === 'string' && key && key !== DISCUSSION_SECRET_MASK && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(key)) issues.push({ provider: provider.key, field: 'akismet', message: 'Enter an Akismet API key without spaces, URL syntax or punctuation.' })
    }
    const urlFields: Record<string, readonly string[]> = {
      artalk: ['server'],
      comentario: ['instanceUrl'],
      commento: ['instanceUrl'],
      discourse: ['discourseUrl'],
      isso: ['server'],
      remark42: ['host'],
      waline: ['serverURL', 'clientUrl', 'styleUrl']
    }
    for (const field of urlFields[provider.key] ?? []) {
      const raw = String(provider.config[field] ?? '')
      if (!provider.isEnabled && !raw) continue
      try {
        const url = new URL(raw)
        const fileUrl = provider.key === 'waline' && ['clientUrl', 'styleUrl'].includes(field)
        if (hasUnsafeUrlCharacters(raw) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (fileUrl && (url.protocol !== 'https:' || url.pathname.endsWith('/')))) throw new Error()
      } catch {
        issues.push({ provider: provider.key, field, message: `${title} needs an ${provider.key === 'waline' && ['clientUrl', 'styleUrl'].includes(field) ? 'HTTPS file' : 'HTTP or HTTPS base'} URL without credentials, whitespace, a query or a fragment.` })
      }
    }
    if (provider.isEnabled && provider.key === 'disqus' && (typeof provider.config.accountName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,49}$/i.test(provider.config.accountName))) issues.push({ provider: provider.key, field: 'accountName', message: 'Enter a Disqus shortname using up to 50 letters, numbers or hyphens.' })
    if (provider.isEnabled && provider.key === 'giscus') {
      if (typeof provider.config.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(provider.config.repo)) issues.push({ provider: provider.key, field: 'repo', message: 'Enter a public repository in owner/name form.' })
      if (typeof provider.config.repoId !== 'string' || !/^R_[A-Za-z0-9_-]+$/.test(provider.config.repoId)) issues.push({ provider: provider.key, field: 'repoId', message: 'Enter the repository ID generated by giscus.app.' })
      if (typeof provider.config.categoryId !== 'string' || !/^DIC_[A-Za-z0-9_-]+$/.test(provider.config.categoryId)) issues.push({ provider: provider.key, field: 'categoryId', message: 'Enter the category ID generated by giscus.app.' })
    }
    if (provider.isEnabled && provider.key === 'hyvortalk' && (!Number.isSafeInteger(provider.config.websiteId) || Number(provider.config.websiteId) < 1)) issues.push({ provider: provider.key, field: 'websiteId', message: 'Enter a positive Hyvor Talk website ID.' })
    if (provider.isEnabled && provider.key === 'remark42' && (!Number.isSafeInteger(provider.config.maxShownComments) || Number(provider.config.maxShownComments) < 1 || Number(provider.config.maxShownComments) > 100)) issues.push({ provider: provider.key, field: 'maxShownComments', message: 'Comments shown must be a whole number from 1 to 100.' })
  }
  return issues
}
export interface DiscussionPage {
  id: number
  title: string
  path: string
  locale: string
  visibility: 'public' | 'private'
}
export interface ModerationRecord {
  id: number
  excerpt: string
  authorId: number | null
  authorName: string
  createdAt: string
  updatedAt: string
  isHidden: boolean
  page: DiscussionPage
}
export interface DiscussionHistoryEntry { id: number; action: 'hide' | 'restore' | 'close' | 'reopen'; reason: string; actorId: number | null; createdAt: string }
export interface ModerationInspection extends ModerationRecord {
  content: string
  authorEmail: string
  authorIP: string
  moderationReason: string
  moderatedAt: string | null
  moderatedBy: number | null
  fingerprint: string
  history: DiscussionHistoryEntry[]
}
export interface ModerationInventory { items: ModerationRecord[]; total: number; limit: number; offset: number }
export interface PageDiscussionPolicy { page: DiscussionPage; closed: boolean; reason: string; updatedBy: number | null; updatedAt: string | null; fingerprint: string; history: DiscussionHistoryEntry[] }
