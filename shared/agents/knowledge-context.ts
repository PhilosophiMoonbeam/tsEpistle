import { z } from 'zod'

export const AGENT_ATTACHED_SOURCE_LIMIT = 8
export const AGENT_KNOWLEDGE_CONTEXT_BYTE_LIMIT = 24000

export const AgentSearchScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({ kind: z.literal('locale'), locale: z.string().min(1).max(35) }),
  z.strictObject({ kind: z.literal('section'), locale: z.string().min(1).max(35), path: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal('selected') })
])
export const AgentSourceIdentitySchema = z.strictObject({
  id: z.number().int().positive(), locale: z.string().min(1).max(35), path: z.string().min(1).max(1024)
})
export const AgentAttachedSourceSchema = AgentSourceIdentitySchema.extend({
  title: z.string().max(500), visibility: z.enum(['public', 'private']), sourceRevision: z.string().regex(/^[1-9]\d*$/).max(64)
})
export const AgentCurrentPageHintSchema = AgentSourceIdentitySchema.extend({
  observedUpdatedAt: z.iso.datetime({ offset: true })
})

// Page identity includes locale and path: an obsolete route must not silently dedupe
// against a newly authorized route. Revision remains attached to the selected source.
export const agentSourceIdentityKey = (source: z.infer<typeof AgentSourceIdentitySchema>): string =>
  JSON.stringify([source.id, source.locale, source.path])
const uniqueSources = (sources: readonly z.infer<typeof AgentSourceIdentitySchema>[]): boolean =>
  new Set(sources.map(agentSourceIdentityKey)).size === sources.length

export const AgentKnowledgeContextSchema = z.strictObject({
  scope: AgentSearchScopeSchema,
  sources: z.array(AgentAttachedSourceSchema).max(AGENT_ATTACHED_SOURCE_LIMIT)
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= AGENT_KNOWLEDGE_CONTEXT_BYTE_LIMIT, { message: 'Source context is too large' })
  .refine(value => value.scope.kind !== 'selected' || value.sources.length > 0, { message: 'Select at least one source for selected-page search' })
  .refine(value => uniqueSources(value.sources), { message: 'Attached sources must have distinct identities' })

export const AgentContextIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('draft'), ownerId: z.number().int().positive(), draftId: z.string().min(1).max(128), sessionId: z.string().min(1).max(128).nullable() }),
  z.strictObject({ kind: z.literal('session'), ownerId: z.number().int().positive(), sessionId: z.string().min(1).max(128) })
])
export const AgentSourceAccessSchema = z.enum(['accessible', 'unknown', 'stale', 'unavailable', 'error', 'offline'])

/**
 * Local projection only, not admission/evidence. `generation` is the existing client
 * workspace generation captured before async work, never a server lease token.
 * attachedSources contains committed rows only (including revision-bound restored
 * rows); pendingSources is an independent picker selection and never contributes
 * to the meter, request, or summary. Applying replaces the committed list atomically.
 * Historical overrides use origin=historical; explicit exclusion keeps hint=null
 * or included=false rather than falling back to the currently navigated page.
 * Access must be reauthorized by the server before use; selected hints are not citations.
 */
export const AgentSourceContextProjectionSchema = z.strictObject({
  identity: AgentContextIdentitySchema,
  generation: z.number().int().nonnegative(),
  scope: AgentSearchScopeSchema,
  attachedSources: z.array(z.strictObject({ source: AgentAttachedSourceSchema, access: AgentSourceAccessSchema })).max(AGENT_ATTACHED_SOURCE_LIMIT),
  pendingSources: z.array(AgentSourceIdentitySchema).max(AGENT_ATTACHED_SOURCE_LIMIT),
  currentPage: z.strictObject({
    included: z.boolean(), origin: z.enum(['navigation', 'historical']),
    hint: AgentCurrentPageHintSchema.nullable(), access: AgentSourceAccessSchema
  }),
  // Exact deduped union of accessible committed attachments and an accessible,
  // included current page; max9 is intentional and is not the attachment meter.
  accessibleIdentities: z.array(AgentSourceIdentitySchema).max(AGENT_ATTACHED_SOURCE_LIMIT + 1)
}).superRefine((value, ctx) => {
  const sources = value.attachedSources.map(row => row.source)
  if (!uniqueSources(sources) || !uniqueSources(value.pendingSources))
    ctx.addIssue({ code: 'custom', message: 'Source lists must have distinct identities' })
  const context = AgentKnowledgeContextSchema.safeParse({ scope: value.scope, sources })
  if (!context.success) ctx.addIssue({ code: 'custom', path: ['attachedSources'], message: 'Committed context violates the source scope or byte budget' })
  if (value.currentPage.included && value.currentPage.hint === null)
    ctx.addIssue({ code: 'custom', path: ['currentPage'], message: 'Included current page requires an identity' })
  const expected = new Set(value.attachedSources.filter(row => row.access === 'accessible').map(row => agentSourceIdentityKey(row.source)))
  if (value.currentPage.included && value.currentPage.hint && value.currentPage.access === 'accessible')
    expected.add(agentSourceIdentityKey(value.currentPage.hint))
  const actual = new Set(value.accessibleIdentities.map(agentSourceIdentityKey))
  if (actual.size !== value.accessibleIdentities.length || actual.size !== expected.size || [...actual].some(key => !expected.has(key)))
    ctx.addIssue({ code: 'custom', path: ['accessibleIdentities'], message: 'Accessible identities must equal the deduped authorized hint union' })
})

export type AgentKnowledgeContext = z.infer<typeof AgentKnowledgeContextSchema>
export type AgentSearchScope = z.infer<typeof AgentSearchScopeSchema>
export type AgentAttachedSource = z.infer<typeof AgentAttachedSourceSchema>
export type AgentSourceIdentity = z.infer<typeof AgentSourceIdentitySchema>
export type AgentContextIdentity = z.infer<typeof AgentContextIdentitySchema>
export type AgentSourceContextProjection = z.infer<typeof AgentSourceContextProjectionSchema>
