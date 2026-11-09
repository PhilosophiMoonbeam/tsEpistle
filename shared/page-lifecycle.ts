import { z } from 'zod'

export const PAGE_LIFECYCLE_LIMITS = Object.freeze({ version: 1, enabledSite: 100, enabledOwner: 20, targets: 1000, explicitIds: 100, tags: 10, effects: 4, days: 3650, batch: 25, concurrency: 4, tickMs: 60_000, leaseMs: 30_000, previewMs: 300_000, proposalMs: 7 * 86_400_000 })
export const PAGE_LIFECYCLE_DAY_MS = 86_400_000
const id = z.number().int().positive().safe().max(2147483647)
const ids = (maximum: number) => z.array(id).min(1).max(maximum).refine(values => new Set(values).size === values.length, 'IDs must be distinct').transform(values => [...values].sort((a, b) => a - b))
export const PageLifecyclePathSchema = z.string().min(1).max(1024).refine(value => value === value.normalize('NFC') && value === value.trim() && !/[\p{Cc}\\?"|<>:*#%]/u.test(value) && !value.startsWith('/') && !value.endsWith('/') && value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..') && !value.startsWith('_'), 'Choose a literal canonical public path')
export const PageLifecycleMovePathSchema = PageLifecyclePathSchema.refine(value => !/[. ]/.test(value), 'Use a path supported by the native reviewed move')
const locale = z.string().min(2).max(32).regex(/^[A-Za-z][A-Za-z0-9-]*$/)
export const PageLifecycleSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ids'), pageIds: ids(100) }),
  z.strictObject({ kind: z.literal('subtree'), localeCode: locale, normalizedRootPath: PageLifecyclePathSchema, allTagIds: ids(10).optional() }),
  z.strictObject({ kind: z.literal('tags'), localeCode: locale, allTagIds: ids(10) })
])
const days = z.number().int().min(1).max(3650)
export const PageLifecycleUtcSchema = z.string().refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Use an exact normalized ISO UTC timestamp')
export const PageLifecycleConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('body-inactive'), days }),
  z.strictObject({ kind: z.literal('comments-inactive'), days }),
  z.strictObject({ kind: z.literal('interval'), anchorAt: PageLifecycleUtcSchema, days })
])
export const PageLifecycleEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('add-tags'), tagIds: ids(10) }),
  z.strictObject({ kind: z.literal('set-notice'), text: z.string().min(1).max(1000).refine(value => value.trim().length > 0 && !value.includes('\u0000'), 'Enter literal notice text') }),
  z.strictObject({ kind: z.literal('propose-move'), destinationRootPath: PageLifecycleMovePathSchema, destinationLocale: z.literal('same'), template: z.enum(['original-relative-path', 'page-id']) }),
  z.strictObject({ kind: z.literal('notify'), audience: z.enum(['review-route', 'watchers']) })
])
export type PageLifecycleSelector = z.infer<typeof PageLifecycleSelectorSchema>
export type PageLifecycleCondition = z.infer<typeof PageLifecycleConditionSchema>
export type PageLifecycleEffect = z.infer<typeof PageLifecycleEffectSchema>
const effectOrder = ['add-tags', 'set-notice', 'propose-move', 'notify'] as const
export const PageLifecycleRuleDefinitionSchema = z.strictObject({
  version: z.literal(1),
  selector: PageLifecycleSelectorSchema,
  condition: PageLifecycleConditionSchema,
  effects: z.array(PageLifecycleEffectSchema).min(1).max(4).refine(values => new Set(values.map(effect => effect.kind)).size === values.length, 'Each effect may appear only once').transform(values => [...values].sort((a, b) => effectOrder.indexOf(a.kind) - effectOrder.indexOf(b.kind))),
  terminalPolicy: z.enum(['keep', 'retire-after-success'])
})
export type PageLifecycleRuleDefinition = z.infer<typeof PageLifecycleRuleDefinitionSchema>
export const PageLifecyclePreviewRequestSchema = z.strictObject({
  definition: PageLifecycleRuleDefinitionSchema,
  ruleId: z.uuid().optional(), expectedRevision: z.number().int().positive().safe().optional(),
  startObserving: z.boolean().default(false), runAgain: z.boolean().default(false),
  reown: z.boolean().default(false)
})
export const PageLifecycleSaveRequestSchema = PageLifecyclePreviewRequestSchema.extend({ previewToken: z.uuid(), unattendedConsent: z.literal(true), enabled: z.boolean() })
export type PageLifecyclePreviewRequest = z.infer<typeof PageLifecyclePreviewRequestSchema>
export type PageLifecycleSaveRequest = z.infer<typeof PageLifecycleSaveRequestSchema>
export type PageLifecycleOutcome = 'queued' | 'running' | 'applied' | 'skipped' | 'needs-review' | 'suspended' | 'partial' | 'failed' | 'cancelled' | 'coalesced'
export type PageLifecycleRuleStatus = 'enabled' | 'disabled' | 'suspended' | 'needs-attention' | 'retired' | 'cancelled'
export type PageLifecycleActionState = 'applied' | 'skipped' | 'proposed' | 'fulfilled' | 'failed' | 'suspended' | 'blocked' | 'cancelled' | 'expired' | 'refused'
export interface PageLifecycleClock {
  bodyEpoch: string; bodyAnchorAt: string | Date | null; bodyAnchorKind: 'known-change' | 'observed-baseline' | 'unknown'
  commentEpoch: string; commentAnchorAt: string | Date | null; commentAnchorKind: 'known-change' | 'observed-baseline' | 'unknown'
}
export type PageLifecycleDue = { state: 'unknown-clock' | 'not-due' } | { state: 'due'; conditionKey: string; epoch: string | null; cycleNo: number | null; dueAt: string }
export const pageLifecycleDue = (condition: PageLifecycleCondition, clock: PageLifecycleClock | null, now: Date): PageLifecycleDue => {
  const current = now.valueOf()
  if (!Number.isFinite(current)) return { state: 'unknown-clock' }
  const duration = condition.days * PAGE_LIFECYCLE_DAY_MS
  if (condition.kind === 'interval') {
    const parsed = PageLifecycleUtcSchema.safeParse(condition.anchorAt)
    if (!parsed.success) return { state: 'unknown-clock' }
    const anchor = Date.parse(parsed.data)
    if (current < anchor) return { state: 'not-due' }
    const cycleNo = Math.floor((current - anchor) / duration)
    if (!Number.isSafeInteger(cycleNo)) return { state: 'unknown-clock' }
    return { state: 'due', conditionKey: `interval:${cycleNo}`, epoch: null, cycleNo, dueAt: new Date(anchor + cycleNo * duration).toISOString() }
  }
  if (!clock) return { state: 'unknown-clock' }
  const body = condition.kind === 'body-inactive'
  const kind = body ? clock.bodyAnchorKind : clock.commentAnchorKind
  const epoch = body ? clock.bodyEpoch : clock.commentEpoch
  const value = body ? clock.bodyAnchorAt : clock.commentAnchorAt
  const anchor = value instanceof Date ? value.valueOf() : PageLifecycleUtcSchema.safeParse(value).success ? Date.parse(value as string) : NaN
  if (!['known-change', 'observed-baseline'].includes(kind) || !z.uuid().safeParse(epoch).success || !Number.isFinite(anchor) || anchor > current || !Number.isFinite(new Date(anchor + duration).valueOf())) return { state: 'unknown-clock' }
  const dueAt = anchor + duration
  return current >= dueAt ? { state: 'due', conditionKey: `${condition.kind}:${epoch}`, epoch, cycleNo: null, dueAt: new Date(dueAt).toISOString() } : { state: 'not-due' }
}
export interface PageLifecycleClockDisplay { clock: 'known-change' | 'observed-baseline' | 'unknown'; anchorAt: string | null; historicalAgeUnknown: boolean; due: PageLifecycleDue }
export const pageLifecycleClockDisplay = (condition: PageLifecycleCondition, clock: PageLifecycleClock | null, now: Date): PageLifecycleClockDisplay => {
  const due = pageLifecycleDue(condition, clock, now)
  if (condition.kind === 'interval') return { clock: due.state === 'unknown-clock' ? 'unknown' : 'known-change', anchorAt: condition.anchorAt, historicalAgeUnknown: false, due }
  const body = condition.kind === 'body-inactive', kind = clock ? body ? clock.bodyAnchorKind : clock.commentAnchorKind : 'unknown'
  const raw = clock ? body ? clock.bodyAnchorAt : clock.commentAnchorAt : null
  return { clock: due.state === 'unknown-clock' ? 'unknown' : kind, anchorAt: raw === null || !Number.isFinite(new Date(raw).valueOf()) ? null : new Date(raw).toISOString(), historicalAgeUnknown: kind === 'observed-baseline' || kind === 'unknown', due }
}
export const pageLifecycleSelectorMatches = (selector: PageLifecycleSelector, page: { id: number; path: string; localeCode: string; visibility: string; ownerId: number | null; tagIds: readonly number[] }): boolean => {
  if (selector.kind === 'ids') return selector.pageIds.includes(page.id)
  if (page.visibility !== 'public' || page.ownerId !== null || page.localeCode !== selector.localeCode) return false
  if (selector.kind === 'subtree' && page.path !== selector.normalizedRootPath && !page.path.startsWith(`${selector.normalizedRootPath}/`)) return false
  return (selector.allTagIds ?? []).every(tagId => page.tagIds.includes(tagId))
}
export const pageLifecycleOriginalRelativePath = (selector: PageLifecycleSelector, path: string): string => selector.kind === 'subtree' && path.startsWith(`${selector.normalizedRootPath}/`) ? path.slice(selector.normalizedRootPath.length + 1) : selector.kind === 'subtree' && path === selector.normalizedRootPath ? '' : path
export const pageLifecycleMoveDestination = (effect: Extract<PageLifecycleEffect, { kind: 'propose-move' }>, pageId: number, originalRelativePath: string): string => {
  const relativePath = effect.template === 'page-id' ? String(pageId) : originalRelativePath
  return PageLifecycleMovePathSchema.parse(relativePath.length === 0 ? effect.destinationRootPath : `${effect.destinationRootPath}/${relativePath}`)
}
export interface PageLifecyclePreviewPage extends PageLifecycleClockDisplay { pageId: number; sourceRevision: string; path: string; localeCode: string; protected: boolean; effects: Array<{ kind: PageLifecycleEffect['kind']; mode: 'unattended' | 'human-review'; destinationPath?: string; reason?: string }> }
export interface PageLifecyclePreview { previewToken: string; expiresAt: string; fingerprint: string; ruleId: string | null; expectedRevision: number | null; pages: PageLifecyclePreviewPage[]; startObserving: boolean; runAgain: boolean; warning: string | null }
