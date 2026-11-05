import type { AgentCurrentPageHint } from '../../shared/agents/contracts.ts'
import type { WikiSource } from '../../shared/wiki-source.ts'

import {
  AgentSourceContextProjectionSchema,
  agentSourceIdentityKey,
  type AgentAttachedSource,
  type AgentContextIdentity,
  type AgentSearchScope,
  type AgentSourceContextProjection,
  type AgentSourceIdentity
} from '../../shared/agents/knowledge-context.ts'
export type { AgentSearchScope } from '../../shared/agents/knowledge-context.ts'
export interface AgentDraft {
  text: string
  mode: 'message' | 'goal'
  skillVersionIds: string[]
  sources: WikiSource[]
  /** Picker selections are not committed attachments and never enter a request. */
  pendingSources?: AgentSourceIdentity[]
  sourceAccess?: Record<string, AgentSourceContextProjection['attachedSources'][number]['access']>
  scope: AgentSearchScope
  includeCurrentPage: boolean
  /** Historical Review pins this draft's hint choice independently of route navigation. */
  currentPageOverride?: AgentCurrentPageHint | null
}
export const emptyAgentDraft = (): AgentDraft => ({
  text: '',
  mode: 'message',
  skillVersionIds: [],
  sources: [],
  scope: { kind: 'all' },
  includeCurrentPage: true
})

const projectAgentSource = ({ id, locale, path, title, visibility, sourceRevision }: AgentAttachedSource): AgentAttachedSource => ({
  id,
  locale,
  path,
  title,
  visibility,
  sourceRevision
})

// Capture meaningful composition without source content, access, or preview metadata.
// Route navigation is not a draft edit and must not change an unresolved command.
export const projectAgentDraftComposition = (draft: AgentDraft) => ({
  text: draft.text,
  mode: draft.mode,
  skillVersionIds: [...draft.skillVersionIds],
  scope: { ...draft.scope },
  sources: draft.sources.map(projectAgentSource),
  pendingSources: draft.pendingSources?.map(source => ({ ...source })) ?? [],
  includeCurrentPage: draft.includeCurrentPage,
  currentPageOverride: draft.currentPageOverride ? { ...draft.currentPageOverride } : draft.currentPageOverride
})

export const agentDraftCompositionKey = (draft: AgentDraft): string => JSON.stringify(projectAgentDraftComposition(draft))

export const projectAgentSourceContext = (
  draft: AgentDraft,
  identity: AgentContextIdentity,
  generation: number,
  navigationPage: AgentCurrentPageHint | null,
  access: 'accessible' | 'stale' | 'offline' = 'accessible'
): AgentSourceContextProjection | null => {
  const hint = draft.currentPageOverride === undefined ? navigationPage : draft.currentPageOverride
  const attachedSources = draft.sources.map(source => {
    const sourceAccess = draft.sourceAccess?.[agentSourceIdentityKey(source)] ?? 'accessible'
    return {
      source: projectAgentSource(source),
      access: sourceAccess === 'accessible' ? access : sourceAccess
    }
  })
  const currentPage = {
    included: draft.includeCurrentPage && hint !== null,
    origin: draft.currentPageOverride === undefined ? ('navigation' as const) : ('historical' as const),
    hint,
    access: access === 'accessible' && draft.currentPageOverride !== undefined ? ('unknown' as const) : access
  }
  const accessible = new Map<string, AgentSourceIdentity>()
  if (access === 'accessible') {
    for (const { source, access: sourceAccess } of attachedSources) {
      if (sourceAccess === 'accessible') accessible.set(agentSourceIdentityKey(source), { id: source.id, locale: source.locale, path: source.path })
    }
    if (currentPage.included && hint && currentPage.access === 'accessible')
      accessible.set(agentSourceIdentityKey(hint), { id: hint.id, locale: hint.locale, path: hint.path })
  }
  const projection = AgentSourceContextProjectionSchema.safeParse({
    identity,
    generation,
    scope: draft.scope,
    attachedSources,
    pendingSources: draft.pendingSources ?? [],
    currentPage,
    accessibleIdentities: [...accessible.values()]
  })
  return projection.success ? projection.data : null
}
