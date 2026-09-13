import { z } from 'zod'

const ExcludedPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(value => !/[?#\\]/.test(value) && ![...value].some(char => char.charCodeAt(0) < 32), 'Use a page path without a query, fragment or backslash.')
  .transform(value => value.replace(/^\/+|\/+$/g, '') || '/')
export const AnalyticsPolicySchema = z
  .object({
    localEnabled: z.boolean(),
    externalEnabled: z.boolean(),
    audience: z.enum(['everyone', 'anonymous', 'signed-in']),
    excludeAdministrators: z.boolean(),
    respectPrivacySignals: z.boolean(),
    excludedPaths: z.array(ExcludedPathSchema).max(50),
    retentionDays: z.union([z.literal(30), z.literal(90), z.literal(365)])
  })
  .strict()
  .transform(value => ({ ...value, excludedPaths: [...new Set(value.excludedPaths)].sort() }))
export type AnalyticsPolicy = z.output<typeof AnalyticsPolicySchema>
export const analyticsPolicyFromConfiguration = (configuration: Record<string, unknown>, hasEnabledProviders = false): AnalyticsPolicy => {
  const raw =
    configuration.analyticsPolicy && typeof configuration.analyticsPolicy === 'object' ? (configuration.analyticsPolicy as Record<string, unknown>) : {}
  return AnalyticsPolicySchema.parse({
    localEnabled: raw.localEnabled === true,
    externalEnabled: raw.externalEnabled === undefined ? hasEnabledProviders : raw.externalEnabled === true,
    audience: raw.audience ?? 'everyone',
    excludeAdministrators: raw.excludeAdministrators !== false,
    respectPrivacySignals: raw.respectPrivacySignals !== false,
    excludedPaths: raw.excludedPaths ?? [],
    retentionDays: raw.retentionDays ?? 90
  })
}
export const analyticsChangedFields = (before: AnalyticsPolicy, after: AnalyticsPolicy): string[] =>
  (Object.keys(before) as (keyof AnalyticsPolicy)[]).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))

export interface AnalyticsRequestContext {
  method: string
  reader: boolean
  published: boolean
  visibility: 'public' | 'private'
  protected: boolean
  path: string
  signedIn: boolean
  administrator: boolean
  privacySignal: boolean
  prefetch: boolean
  offline: boolean
}
export interface AnalyticsDecision {
  local: boolean
  external: boolean
  reason: string
}
export const decideAnalyticsCollection = (policy: AnalyticsPolicy, request: AnalyticsRequestContext): AnalyticsDecision => {
  const excluded = (reason: string): AnalyticsDecision => ({ local: false, external: false, reason })
  if (request.method !== 'GET' || request.prefetch) return excluded('Only completed reader GET responses are eligible; prefetch is excluded.')
  if (!request.reader || !request.published || request.visibility !== 'public' || request.protected)
    return excluded('Only published, shared reader pages without a page password are eligible.')
  if (policy.respectPrivacySignals && request.privacySignal) return excluded('The request sends a Do Not Track or Global Privacy Control signal.')
  if (policy.excludeAdministrators && request.administrator) return excluded('System administrators are excluded.')
  if ((policy.audience === 'anonymous' && request.signedIn) || (policy.audience === 'signed-in' && !request.signedIn))
    return excluded('The reader is outside the selected audience.')
  if (policy.excludedPaths.some(prefix => prefix === '/' || request.path === prefix || request.path.startsWith(prefix + '/')))
    return excluded('The page matches an excluded path or section.')
  const external = policy.externalEnabled && !request.offline
  return {
    local: policy.localEnabled,
    external,
    reason:
      !policy.localEnabled && !external
        ? request.offline && policy.externalEnabled
          ? 'Offline mode suspends external integrations.'
          : 'Collection is paused.'
        : request.offline && policy.externalEnabled
          ? 'Eligible for local counts; offline mode suspends external integrations.'
          : 'Eligible under the saved collection policy.'
  }
}
export interface AnalyticsField {
  key: string
  title: string
  hint: string
  kind: 'text' | 'url' | 'number' | 'hostname' | 'boolean'
  optional: boolean
  default: string
}
export interface AnalyticsProviderDefinition {
  key: string
  title: string
  description: string
  website: string
  category: 'traffic' | 'replay' | 'performance' | 'tags'
  capabilities: string[]
  compatibility: string
  fields: AnalyticsField[]
}
export interface AnalyticsProviderDraft {
  key: string
  isEnabled: boolean
  config: Record<string, string>
}
export interface AnalyticsProvider extends AnalyticsProviderDefinition, AnalyticsProviderDraft {
  isAvailable: boolean
  issues: string[]
  destinations: string[]
}
export interface AnalyticsEvent {
  id: string
  actorId: number | null
  createdAt: string
  reason: string
  fields: string[]
  providers: string[]
  kind: 'settings' | 'erase'
  erasedRows?: number
}
export interface AnalyticsInsights {
  from: string
  through: string
  observedAt: string
  totalResponses: number
  pages: number
  daily: Array<{ day: string; responses: number }>
  topPages: Array<{ id: number; locale: string; path: string; title: string; responses: number }>
}
export interface AnalyticsWorkspace {
  policy: AnalyticsPolicy
  fingerprint: string
  revision: string
  providers: AnalyticsProvider[]
  history: AnalyticsEvent[]
  offline: boolean
  observedAt: string
  insights: AnalyticsInsights
}
