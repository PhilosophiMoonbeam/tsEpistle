type RecordValue = Record<string, unknown>

const record = (value: unknown): RecordValue => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {})
const string = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const boolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isSafeInteger(entry)) : []
const optional = <T>(key: string, value: T | undefined): RecordValue => (value === undefined ? {} : { [key]: value })

const settings = (config: RecordValue): RecordValue => {
  const lang = record(config.lang)
  const banner = record(config.banner)
  const nav = record(config.nav)
  const theming = record(config.theming)
  const security = record(config.security)
  const uploads = record(config.uploads)
  const telemetry = record(config.telemetry)
  const editors = record(config.editors)
  const features = record(config.features)
  const search = record(config.search)
  return {
    format: 'portable-settings-v1',
    scope: 'Portable site presentation and module enablement only; credentials, signing material, session state, and provider configuration are excluded.',
    site: {
      ...optional('title', string(config.title)),
      ...optional('company', string(config.company)),
      ...optional('contentLicense', string(config.contentLicense)),
      ...optional('footerOverride', string(config.footerOverride)),
      ...optional('logoUrl', string(config.logoUrl))
    },
    language: {
      ...optional('code', string(lang.code)),
      ...optional('autoUpdate', boolean(lang.autoUpdate)),
      ...optional('namespaces', strings(lang.namespaces)),
      ...optional('namespacing', boolean(lang.namespacing)),
      ...optional('rtl', boolean(lang.rtl))
    },
    banner: {
      ...optional('isEnabled', boolean(banner.isEnabled)),
      ...optional('title', string(banner.title)),
      ...optional('content', string(banner.content))
    },
    navigation: {
      ...optional('mode', string(nav.mode)),
      ...optional('expandParent', boolean(nav.expandParent))
    },
    theming: {
      ...optional('theme', string(theming.theme)),
      ...optional('iconset', string(theming.iconset)),
      ...optional('darkMode', boolean(theming.darkMode)),
      ...optional('tocPosition', string(theming.tocPosition))
    },
    security: {
      ...optional('securityOpenRedirect', boolean(security.securityOpenRedirect)),
      ...optional('securityIframe', boolean(security.securityIframe)),
      ...optional('securityReferrerPolicy', boolean(security.securityReferrerPolicy)),
      ...optional('securityTrustProxy', boolean(security.securityTrustProxy)),
      ...optional('securitySRI', boolean(security.securitySRI)),
      ...optional('securityHSTS', boolean(security.securityHSTS)),
      ...optional('securityHSTSDuration', number(security.securityHSTSDuration)),
      ...optional('securityCSP', boolean(security.securityCSP)),
      ...optional('securityCSPDirectives', string(security.securityCSPDirectives))
    },
    uploads: {
      ...optional('maxFileSize', number(uploads.maxFileSize)),
      ...optional('maxFiles', number(uploads.maxFiles)),
      ...optional('scanSVG', boolean(uploads.scanSVG)),
      ...optional('forceDownload', boolean(uploads.forceDownload))
    },
    telemetry: { ...optional('isEnabled', boolean(telemetry.isEnabled)) },
    editors: { ...optional('available', strings(editors.available)) },
    features: {
      ...optional('featurePageRatings', boolean(features.featurePageRatings)),
      ...optional('featurePageComments', boolean(features.featurePageComments)),
      ...optional('featurePageCollaboration', boolean(features.featurePageCollaboration)),
      ...optional('featurePersonalWikis', boolean(features.featurePersonalWikis))
    },
    search: { ...optional('maxHits', number(search.maxHits)) }
  }
}

const moduleState = (row: unknown, fields: readonly string[] = []): RecordValue => {
  const source = record(row)
  const output: RecordValue = {
    ...optional('key', string(source.key)),
    ...optional('isEnabled', boolean(source.isEnabled))
  }
  for (const field of fields) {
    const value = source[field]
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) output[field] = value
  }
  return output
}

const authenticationState = (row: unknown): RecordValue => {
  const source = record(row)
  const domainWhitelist = record(source.domainWhitelist)
  const autoEnrollGroups = record(source.autoEnrollGroups)
  return {
    ...moduleState(source, ['selfRegistration', 'order', 'strategyKey', 'displayName']),
    domainWhitelist: strings(Array.isArray(source.domainWhitelist) ? source.domainWhitelist : domainWhitelist.v),
    autoEnrollGroups: numbers(Array.isArray(source.autoEnrollGroups) ? source.autoEnrollGroups : autoEnrollGroups.v)
  }
}

export const projectApiKeyExport = (row: unknown): RecordValue => {
  const source = record(row)
  return {
    ...optional('name', string(source.name)),
    ...optional('expiration', string(source.expiration)),
    ...optional('isRevoked', boolean(source.isRevoked)),
    ...optional('createdAt', string(source.createdAt)),
    ...optional('updatedAt', string(source.updatedAt)),
    ...optional('validUntil', string(source.validUntil))
  }
}

export const projectSettingsExport = (input: {
  config: RecordValue
  analytics: unknown[]
  authentication: unknown[]
  commentProviders: unknown[]
  renderers: unknown[]
  searchEngines: unknown[]
  storage: unknown[]
  apiKeys: unknown[]
}): RecordValue => ({
  ...settings(input.config),
  modules: {
    analytics: input.analytics.map(row => moduleState(row)),
    authentication: input.authentication.map(authenticationState),
    commentProviders: input.commentProviders.map(row => moduleState(row)),
    renderers: input.renderers.map(row => moduleState(row)),
    searchEngines: input.searchEngines.map(row => moduleState(row, ['level'])),
    storage: input.storage.map(row => moduleState(row, ['mode', 'syncInterval']))
  },
  apiKeys: input.apiKeys.map(projectApiKeyExport)
})

const person = (value: unknown): RecordValue | null => {
  const source = record(value)
  const id = number(source.id)
  const name = string(source.name)
  if (id === undefined || name === undefined) return null
  return { id, name }
}

export const projectUserExport = (row: unknown): RecordValue => {
  const source = record(row)
  const provider = record(source.provider)
  return {
    ...optional('id', number(source.id)),
    ...optional('name', string(source.name)),
    ...optional('email', string(source.email)),
    ...optional('providerKey', string(source.providerKey)),
    ...optional('jobTitle', string(source.jobTitle)),
    ...optional('location', string(source.location)),
    ...optional('pictureUrl', string(source.pictureUrl)),
    ...optional('timezone', string(source.timezone)),
    ...optional('dateFormat', string(source.dateFormat)),
    ...optional('appearance', string(source.appearance)),
    ...optional('fontFamily', string(source.fontFamily)),
    ...optional('isSystem', boolean(source.isSystem)),
    ...optional('isActive', boolean(source.isActive)),
    ...optional('isVerified', boolean(source.isVerified)),
    ...optional('createdAt', string(source.createdAt)),
    ...optional('updatedAt', string(source.updatedAt)),
    groups: Array.isArray(source.groups) ? source.groups.map(person).filter((group): group is RecordValue => group !== null) : [],
    provider: {
      ...optional('key', string(provider.key)),
      ...optional('strategyKey', string(provider.strategyKey)),
      ...optional('displayName', string(provider.displayName))
    }
  }
}

export const projectPageExport = (row: unknown): RecordValue | null => {
  const source = record(row)
  if (source.visibility !== 'public') return null
  return {
    ...optional('id', number(source.id)),
    ...optional('path', string(source.path)),
    ...optional('localeCode', string(source.localeCode)),
    ...optional('title', string(source.title)),
    ...optional('description', string(source.description)),
    ...optional('content', string(source.content)),
    ...optional('contentType', string(source.contentType)),
    ...optional('editorKey', string(source.editorKey)),
    ...optional('extra', source.extra),
    ...optional('isPublished', boolean(source.isPublished)),
    ...optional('publishStartDate', string(source.publishStartDate)),
    ...optional('publishEndDate', string(source.publishEndDate)),
    ...optional('sourceRevision', string(source.sourceRevision) ?? number(source.sourceRevision)),
    ...optional('createdAt', string(source.createdAt)),
    ...optional('updatedAt', string(source.updatedAt)),
    author: person(source.author),
    creator: person(source.creator),
    tags: Array.isArray(source.tags)
      ? source.tags.map(tag => ({ ...optional('tag', string(record(tag).tag)), ...optional('title', string(record(tag).title)) }))
      : []
  }
}

export const projectHistoryExport = (row: unknown): RecordValue | null => {
  const source = record(row)
  if (source.visibility !== 'public') return null
  return {
    ...optional('id', number(source.id)),
    ...optional('pageId', number(source.pageId)),
    ...optional('authorId', number(source.authorId)),
    ...optional('authorName', string(source.authorName)),
    ...optional('path', string(source.path)),
    ...optional('localeCode', string(source.localeCode)),
    ...optional('title', string(source.title)),
    ...optional('description', string(source.description)),
    ...optional('content', string(source.content)),
    ...optional('contentType', string(source.contentType)),
    ...optional('editorKey', string(source.editorKey)),
    ...optional('extra', source.extra),
    ...optional('isPublished', boolean(source.isPublished)),
    ...optional('publishStartDate', string(source.publishStartDate)),
    ...optional('publishEndDate', string(source.publishEndDate)),
    ...optional('action', string(source.action)),
    ...optional('versionDate', string(source.versionDate)),
    ...optional('sourceRevision', string(source.sourceRevision) ?? number(source.sourceRevision)),
    ...optional('createdAt', string(source.createdAt)),
    author: person(source.author),
    tags: Array.isArray(source.tags)
      ? source.tags.map(tag => ({ ...optional('tag', string(record(tag).tag)), ...optional('title', string(record(tag).title)) }))
      : []
  }
}

export const projectCommentExport = (row: unknown): RecordValue | null => {
  const source = record(row)
  const page = record(source.page)
  if (page.visibility !== 'public') return null
  return {
    ...optional('id', number(source.id)),
    ...optional('pageId', number(source.pageId)),
    ...optional('replyTo', number(source.replyTo)),
    ...optional('content', string(source.content)),
    ...optional('render', string(source.render)),
    ...optional('name', string(source.name)),
    ...optional('authorId', number(source.authorId)),
    ...optional('isHidden', boolean(source.isHidden)),
    ...optional('createdAt', string(source.createdAt)),
    ...optional('updatedAt', string(source.updatedAt)),
    author: person(source.author),
    page: {
      ...optional('id', number(page.id)),
      ...optional('path', string(page.path)),
      ...optional('localeCode', string(page.localeCode)),
      ...optional('title', string(page.title))
    }
  }
}

export const projectGroupExport = (row: unknown): RecordValue => {
  const source = record(row)
  return {
    ...optional('id', number(source.id)),
    ...optional('name', string(source.name)),
    ...optional('description', string(source.description)),
    ...optional('isSystem', boolean(source.isSystem)),
    ...optional('redirectOnLogin', string(source.redirectOnLogin)),
    ...optional('createdAt', string(source.createdAt)),
    ...optional('updatedAt', string(source.updatedAt)),
    permissions: strings(source.permissions),
    pageRules: Array.isArray(source.pageRules) ? source.pageRules.map(record) : []
  }
}
