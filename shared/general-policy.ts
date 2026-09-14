import { disabledSiteBanner, validateSiteBanner, type SiteBannerConfig } from './site-banner.ts'
import { isUserDateFormat, isUserTimeFormat, isUserTimezone, userPresentationDefaults, type UserPresentationDefaults } from './user-presentation.ts'

export interface GeneralPolicy {
  host: string
  title: string
  company: string
  contentLicense: string
  footerOverride: string
  description: string
  robots: string[]
  banner: SiteBannerConfig
  pageExtensions: string[]
  editFab: boolean
  editMenuBar: boolean
  editMenuBtn: boolean
  editMenuExternalBtn: boolean
  editMenuExternalName: string
  editMenuExternalIcon: string
  editMenuExternalUrl: string
  userDefaults: UserPresentationDefaults
}

export const generalPolicyDefaults: GeneralPolicy = {
  host: '',
  title: 'tsEpistle',
  company: '',
  contentLicense: '',
  footerOverride: '',
  description: '',
  robots: ['index', 'follow'],
  banner: disabledSiteBanner(),
  pageExtensions: ['md', 'html', 'txt'],
  editFab: true,
  editMenuBar: true,
  editMenuBtn: true,
  editMenuExternalBtn: false,
  editMenuExternalName: 'Edit on GitHub',
  editMenuExternalIcon: 'mdi-github',
  editMenuExternalUrl: '',
  userDefaults: { ...userPresentationDefaults }
}

export const generalFieldLabels: Record<keyof GeneralPolicy, string> = {
  host: 'Public address',
  title: 'Workspace name',
  company: 'Organization',
  contentLicense: 'Content license',
  footerOverride: 'Footer',
  description: 'Search description',
  robots: 'Search indexing',
  banner: 'Announcement',
  pageExtensions: 'Page URL extensions',
  editFab: 'Floating edit button',
  editMenuBar: 'Page action bar',
  editMenuBtn: 'Edit action',
  editMenuExternalBtn: 'External source action',
  editMenuExternalName: 'External action label',
  editMenuExternalIcon: 'External action icon',
  editMenuExternalUrl: 'External source URL',
  userDefaults: 'New account presentation defaults'
}

export interface GeneralPolicyEvent {
  id: string
  actorId: number | null
  reason: string
  fields: string[]
  createdAt: string
}

export interface GeneralWorkspace {
  policy: GeneralPolicy
  fingerprint: string
  history: GeneralPolicyEvent[]
  runtime: { state: 'applied' | 'needs-attention'; observedAt: string }
}

export interface GeneralWriteResult {
  activation: 'applied' | 'needs-attention'
}

const hasControls = (text: string) =>
  [...text].some(character => {
    const code = character.charCodeAt(0)
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127
  })

const licenses = ['', 'alr', 'cc0', 'ccby', 'ccbysa', 'ccbynd', 'ccbync', 'ccbyncsa', 'ccbyncnd']

export const externalSourceUrl = (template: string, filename: string): string => {
  if (!template || /[\\\s]/.test(template) || hasControls(template)) return ''
  const candidate = template.replaceAll('{filename}', filename.split('/').map(encodeURIComponent).join('/'))
  try {
    const url = new URL(candidate)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

export const validateGeneralPolicy = (input: unknown): { ok: true; value: GeneralPolicy } | { ok: false; issues: string[] } => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, issues: ['Workspace settings must be an object.'] }
  const value = input as Record<string, unknown>,
    issues: string[] = [],
    out = structuredClone(generalPolicyDefaults)
  if (Object.keys(value).some(key => !Object.hasOwn(generalPolicyDefaults, key))) issues.push('Workspace settings contain unsupported fields.')
  for (const [key, limit] of Object.entries({
    host: 255,
    title: 50,
    company: 255,
    footerOverride: 8000,
    description: 1000,
    editMenuExternalName: 80,
    editMenuExternalIcon: 100,
    editMenuExternalUrl: 2000
  })) {
    const text = value[key]
    if (typeof text !== 'string' || text.length > limit || hasControls(text)) {
      issues.push(`${generalFieldLabels[key as keyof GeneralPolicy]} must be text of at most ${limit} characters.`)
      continue
    }
    Reflect.set(out, key, text.trim())
  }
  try {
    const url = new URL(out.host)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      /[\\\s]/.test(out.host)
    )
      throw new Error('Invalid origin')
    out.host = url.origin
  } catch {
    issues.push('Public address must be an HTTP(S) origin without a path, query or credentials.')
  }
  if (!out.title || /[<>"\r\n]/.test(out.title)) issues.push('Workspace name is required and cannot contain line breaks or < > ".')
  if (typeof value.contentLicense !== 'string' || !licenses.includes(value.contentLicense)) issues.push('Choose a supported content license.')
  else out.contentLicense = value.contentLicense
  for (const key of ['editFab', 'editMenuBar', 'editMenuBtn', 'editMenuExternalBtn'] as const) {
    if (typeof value[key] !== 'boolean') issues.push(`${generalFieldLabels[key]} must be on or off.`)
    else out[key] = value[key]
  }
  if (!Array.isArray(value.robots) || value.robots.some(item => !['index', 'noindex', 'follow', 'nofollow'].includes(item)))
    issues.push('Choose supported search indexing directives.')
  else {
    out.robots = [...new Set(value.robots as string[])].sort()
    if ((out.robots.includes('index') && out.robots.includes('noindex')) || (out.robots.includes('follow') && out.robots.includes('nofollow')))
      issues.push('Search indexing directives cannot contradict each other.')
  }
  if (
    !Array.isArray(value.pageExtensions) ||
    value.pageExtensions.length > 30 ||
    value.pageExtensions.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9]{1,16}$/.test(item))
  )
    issues.push('Use up to 30 page extensions, each 1–16 letters or digits without a dot.')
  else out.pageExtensions = [...new Set((value.pageExtensions as string[]).map(item => item.toLowerCase()))].sort()
  const banner = validateSiteBanner(value.banner)
  if (!banner.ok) issues.push(banner.message)
  else out.banner = banner.value
  if (!Object.hasOwn(value, 'userDefaults') || !value.userDefaults || typeof value.userDefaults !== 'object' || Array.isArray(value.userDefaults)) {
    issues.push(`${generalFieldLabels.userDefaults} must be an object.`)
  } else {
    const defaults = value.userDefaults as Record<string, unknown>
    if (Object.keys(defaults).some(key => !['timezone', 'dateFormat', 'timeFormat'].includes(key)))
      issues.push(`${generalFieldLabels.userDefaults} contain unsupported fields.`)
    if (!isUserTimezone(defaults.timezone)) issues.push('The default time zone must be a valid IANA time zone.')
    if (!isUserDateFormat(defaults.dateFormat)) issues.push('The default date format is not supported.')
    if (!isUserTimeFormat(defaults.timeFormat)) issues.push('The default time format must be locale, 12h or 24h.')
    if (isUserTimezone(defaults.timezone) && isUserDateFormat(defaults.dateFormat) && isUserTimeFormat(defaults.timeFormat))
      out.userDefaults = { timezone: defaults.timezone, dateFormat: defaults.dateFormat, timeFormat: defaults.timeFormat }
  }
  if (out.editMenuExternalUrl && !externalSourceUrl(out.editMenuExternalUrl, 'example/page.md'))
    issues.push('External source URL must use HTTP(S) without credentials or spaces.')
  if (out.editMenuExternalIcon && !/^mdi-[a-z0-9-]+$/.test(out.editMenuExternalIcon)) issues.push('Use an mdi- icon name for the external action.')
  if (out.editMenuBar && out.editMenuExternalBtn && (!out.editMenuExternalName || !out.editMenuExternalUrl))
    issues.push('An enabled external source action requires a label and URL.')
  return issues.length ? { ok: false, issues } : { ok: true, value: out }
}

export const generalChangedFields = (before: GeneralPolicy, after: GeneralPolicy): Array<keyof GeneralPolicy> =>
  (Object.keys(generalPolicyDefaults) as Array<keyof GeneralPolicy>).filter(key => {
    const normalize = (value: GeneralPolicy[keyof GeneralPolicy]) => (Array.isArray(value) ? [...new Set(value)].sort() : value)
    return JSON.stringify(normalize(before[key])) !== JSON.stringify(normalize(after[key]))
  })
