import { z } from 'zod'

export const LocaleCodeSchema = z.string().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Use a supported language code.').refine(code => { try { return Intl.getCanonicalLocales(code).length === 1 } catch { return false } }, 'Use a valid language code.')
export const LocalePolicySchema = z.object({
  locale: LocaleCodeSchema,
  autoUpdate: z.boolean(),
  namespacing: z.boolean(),
  namespaces: z.array(LocaleCodeSchema).max(100)
}).strict().transform(value => ({
  ...value,
  namespaces: [...new Set(value.namespacing ? [...value.namespaces, value.locale] : value.namespaces)].sort()
}))
export type LocalePolicy = z.output<typeof LocalePolicySchema>
export const localePolicyFromConfiguration = (configuration: Record<string, unknown>): LocalePolicy => {
  const lang = configuration.lang && typeof configuration.lang === 'object' ? configuration.lang as Record<string, unknown> : {}
  return LocalePolicySchema.parse({ locale: lang.code ?? 'en', autoUpdate: lang.autoUpdate !== false, namespacing: lang.namespacing === true, namespaces: Array.isArray(lang.namespaces) ? lang.namespaces : [] })
}
export const localeChangedFields = (before: LocalePolicy, after: LocalePolicy): string[] =>
  (['locale', 'namespacing', 'namespaces', 'autoUpdate'] as const).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
export const localeNavCacheKey = (revision: unknown): string =>
  typeof revision === 'string' && revision ? `nav:locales:${revision}` : 'nav:locales'
export const localeReadingPath = (policy: LocalePolicy, locale = policy.locale, path = 'home'): string =>
  `/${policy.namespacing || locale !== policy.locale ? locale + '/' : ''}${path}`

export const LocaleCatalogEntrySchema = z.object({
  code: LocaleCodeSchema,
  name: z.string().trim().min(1).max(160),
  nativeName: z.string().trim().min(1).max(160),
  isRTL: z.boolean(),
  availability: z.number().int().min(0).max(100),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional()
})
export type LocaleCatalogEntry = z.output<typeof LocaleCatalogEntrySchema>
export const MAX_LOCALE_FILE_BYTES = 8 * 1024 * 1024
export const LocaleFileChangesSchema = z.object({
  added: z.array(z.string().max(500)).max(30_000),
  changed: z.array(z.string().max(500)).max(30_000),
  removed: z.array(z.string().max(500)).max(30_000)
}).strict()
export const LocaleFileReviewSchema = z.object({
  id: z.string().uuid(),
  code: LocaleCodeSchema,
  name: z.string().min(1).max(160),
  nativeName: z.string().min(1).max(160),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().min(3).max(1000),
  expiresAt: z.string().datetime(),
  changes: LocaleFileChangesSchema
}).strict()
export type LocaleFileReview = z.output<typeof LocaleFileReviewSchema>

export const LocaleCatalogSchema = z.array(LocaleCatalogEntrySchema).max(300).superRefine((rows, context) => {
  if (new Set(rows.map(row => row.code)).size !== rows.length) context.addIssue({ code: 'custom', message: 'The language catalog contains duplicate codes.' })
})
export interface LocalePackage extends LocaleCatalogEntry {
  isInstalled: boolean
  installDate: string | null
  availableRemotely: boolean
  pages: number
  publishedPages: number
  linkedTranslations: number
  menuItems: number
}
export interface LocaleEvent {
  id: string
  actorId: number | null
  reason: string
  fields: string[]
  createdAt: string
  kind: 'settings' | 'install' | 'local' | 'catalog'
  jobId?: string
  code?: string
  appliedAt?: string
}
export interface LocaleOperation {
  id: string
  kind: 'install' | 'local' | 'catalog'
  code: string | null
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  attempts: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
  message: string | null
}
export interface LocaleWorkspace {
  policy: LocalePolicy
  fingerprint: string
  locales: LocalePackage[]
  history: LocaleEvent[]
  operations: LocaleOperation[]
  catalog: { observedAt: string | null; source: string | null; offline: boolean }
  localFileReview?: LocaleFileReview | null
  runtime: { state: 'applied' | 'needs-attention'; observedAt: string }
}
export interface LocaleWriteResult { activation: 'applied' | 'needs-attention' }
