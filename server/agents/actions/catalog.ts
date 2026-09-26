import { z } from 'zod'

import { AGENT_TOOL_NAMES, type AgentActionDescriptor, type AgentActionName, type AgentFeatureFlagKey } from '../../../shared/agents/contracts.ts'
import { WikiLinePatchV1Schema, WikiLineSnapshotV1Schema } from '../patch/wiki-line-patch.ts'
import { KnowledgeProjectionViewSchema } from '../../knowledge/projection.ts'

export type ActionGroup = 'core' | 'explore' | 'history' | 'canonical' | 'authoring' | 'browser'

export type ActionOperationRole = 'locate' | 'enumerate' | 'read' | 'observe' | 'prepare' | 'apply' | 'generate' | 'manage'
export type ActionCapabilityOutputKind = 'candidate-lead' | 'verified-source' | 'transient-observation' | 'operation-receipt' | 'artifact'
export type ActionProviderPresentationFamily =
  | 'wiki.page-candidates'
  | 'wiki.taxonomy'
  | 'wiki.page'
  | 'wiki.okf'
  | 'wiki.patch-snapshot'
  | 'wiki.recent-source'
  | 'wiki.history'
  | 'wiki.historical-page'
  | 'wiki.links'
  | 'wiki.proposal'
  | 'skills.catalog'
  | 'skills.resource'
  | 'memory'
  | 'media.image'
  | 'media.video'
  | 'media.audio'
  | 'browser.document'
  | 'browser.extracted-text'
  | 'browser.screenshot'
  | 'structured-observation'
  | 'unclassified'
export type ActionCapabilityFreshnessKind =
  | 'candidate-metadata'
  | 'historical-candidate-metadata'
  | 'request-scoped-structured-observation'
  | 'revision-bound-current-source'
  | 'revision-bound-current-or-historical-source'
  | 'revision-bound-historical-source'
  | 'immutable-approved-resource'
  | 'volatile-browser-document'
  | 'volatile-browser-extraction'
  | 'captured-artifact'
  | 'operation-lifecycle-status'
  | 'generated-artifact'
  | 'computed-unverified'
  | 'unknown'
export type ActionCapabilityReuseEligibility =
  | 'never'
  | 'same-revision-and-live-authorization'
  | 'same-historical-version-and-live-authorization'
  | 'same-source-snapshot-only'
  | 'same-immutable-resource-identity'
export type ActionCapabilityEffectStatus =
  | 'none'
  | 'isolated-browser-state-change'
  | 'approval-continuation-may-apply'
  | 'approved-proposal-application'
  | 'persistent-memory-write'
  | 'external-provider-generation'
export type ActionCapabilityChargeableWork = 'none' | 'potential-provider-charge'

/**
 * Trusted catalog metadata for evidence shaping and provider presentation only.
 * ActionKernel admission still comes exclusively from the action descriptor,
 * required flags, and live authorization; this capability grants no authority.
 */
export interface ActionCapability {
  readonly operationRole: ActionOperationRole
  readonly outputKinds: readonly ActionCapabilityOutputKind[]
  readonly providerPresentationFamily: ActionProviderPresentationFamily
  readonly freshnessKind: ActionCapabilityFreshnessKind
  readonly reuseEligibility: ActionCapabilityReuseEligibility
  readonly effectStatus: ActionCapabilityEffectStatus
  readonly chargeableWork: ActionCapabilityChargeableWork
}

/** Fail closed for unclassified outputs: observations are neither evidence nor auto-reusable. */
export const UNKNOWN_ACTION_CAPABILITY = {
  operationRole: 'observe',
  outputKinds: ['transient-observation'],
  providerPresentationFamily: 'unclassified',
  freshnessKind: 'unknown',
  reuseEligibility: 'never',
  effectStatus: 'none',
  chargeableWork: 'none'
} as const satisfies ActionCapability

export interface ActionDefinition {
  readonly group: ActionGroup
  readonly descriptor: AgentActionDescriptor
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly requiredFlags: readonly AgentFeatureFlagKey[]
  readonly capability: ActionCapability
}

const strict = z.strictObject
const PositiveId = z.number().int().positive()
const Uuid = z.uuid()
const Locale = z.string().min(2).max(35)
const Path = z.string().min(1).max(1024)
const ContentHash = z.string().regex(/^[a-f0-9]{64}$/)
const BoundedTitle = z.string().max(255)
const BoundedDescription = z.string().max(2_000)
const BoundedPageContent = z.string().max(1_048_576)
const BoundedPathLike = z.string().max(4_096)
const EmptyInput = strict({})
const MemoryTarget = z.enum(['agent', 'user'])
const MemoryContent = z.string().min(1).max(2_200)
const MemoryResult = strict({
  changed: z.boolean(),
  message: z.string().max(512),
  target: MemoryTarget,
  entries: z.array(z.string().max(2_200)).max(64),
  characters: z.number().int().nonnegative().max(2_200),
  limit: z.number().int().positive().max(2_200)
})
const KnowledgeFilter = strict({
  state: z.enum(['complete', 'partial']).optional(),
  lifecycleStatus: z.enum(['draft', 'stable', 'deprecated']).optional(),
  trustTier: z.enum(['unverified', 'machine-confirmed', 'human-reviewed']).optional(),
  stale: z.boolean().optional(),
  conceptType: z.string().min(1).max(128).optional()
})
const PageSelector = z.union([strict({ id: PositiveId }), strict({ path: Path, locale: Locale })])
const AuthorityTrust = strict({
  trustTier: z.enum(['unverified', 'machine-confirmed', 'human-reviewed']),
  verification: z.enum(['unverified', 'current', 'outdated']),
  status: z.enum(['draft', 'stable', 'deprecated']),
  stale: z.boolean(),
  generatedAt: z.string().max(32).nullable(),
  verifiedAt: z.string().max(32).nullable()
})
const PageAuthority = z.discriminatedUnion('state', [
  strict({ state: z.literal('valid'), metadata: z.record(z.string(), z.unknown()), trust: AuthorityTrust }),
  strict({ state: z.literal('missing'), metadata: z.null(), trust: z.null() }),
  strict({ state: z.literal('invalid'), metadata: z.null(), trust: z.null() })
])
const OkfResourceUri = z.string().regex(/^wiki:\/\/pages\/[1-9][0-9]*\/versions\/(?:current|[1-9][0-9]*)\/revisions\/[1-9][0-9]*\/okf$/u)
const OkfPageSelector = z.union([PageSelector, strict({ pageId: PositiveId, versionId: PositiveId })])
const OkfCitation = strict({
  evidenceId: z.string().min(1).max(128),
  kind: z.literal('page'),
  label: z.string().min(1).max(512),
  href: z.string().min(1).max(2_048)
})
const PageCitation = strict({
  evidenceId: z.string().min(1).max(128),
  label: z.string().min(1).max(512),
  href: z.string().min(1).max(2_048)
})
const BasePageSummary = strict({
  id: PositiveId,
  locale: Locale,
  path: Path,
  title: BoundedTitle,
  description: BoundedDescription,
  contentType: z.string().max(128),
  sourceRevision: z.string().max(64),
  authority: PageAuthority,
  okfResourceUri: OkfResourceUri,
  knowledge: KnowledgeProjectionViewSchema.nullable()
})
const AppliedPageSummary = strict({
  id: PositiveId,
  locale: Locale,
  path: Path,
  title: BoundedTitle,
  description: BoundedDescription,
  contentType: z.string().max(128),
  sourceRevision: z.string().max(64),
  knowledge: KnowledgeProjectionViewSchema.nullable()
})
const PageSummary = BasePageSummary.extend({ citation: PageCitation })
const RecentPageEvidenceCitation = strict({
  evidenceId: z.string().min(1).max(128),
  label: z.string().min(1).max(512),
  href: z.string().min(1).max(2_048)
})
const RecentPageEvidence = strict({
  id: PositiveId,
  locale: Locale,
  path: Path,
  title: BoundedTitle,
  contentType: z.string().max(128),
  sourceRevision: z.string().max(64),
  updatedAt: z.string().max(32),
  content: z.string().max(2_048),
  sourceContentCharacters: z.number().int().nonnegative().max(1_048_576),
  contentTruncated: z.boolean(),
  citation: RecentPageEvidenceCitation
})
const SearchPageSummary = PageSummary.extend({
  tags: z.array(z.string().min(1).max(255)).max(50),
  score: z.number().finite().nonnegative(),
  matchedFields: z.array(z.enum(['title', 'tag', 'path', 'description', 'content', 'graph', 'knowledge'])).max(7)
})
const DiscoveryPageSummary = PageSummary.extend({
  tags: z.array(z.string().min(1).max(255)).max(50),
  updatedAt: z.string().max(32)
})
const TagSummary = strict({ tag: z.string().min(1).max(255), title: BoundedTitle.nullable() })
const RelatedPageSummary = PageSummary.extend({
  tags: z.array(z.string().min(1).max(255)).max(50),
  distance: z.number().int().positive().max(32),
  direction: z.enum(['incoming', 'outgoing', 'bidirectional']),
  viaPageId: PositiveId
})
const PageResult = PageSummary.extend({
  content: BoundedPageContent,
  updatedAt: z.string().max(32),
  citationSections: z.array(PageCitation).max(99)
})
const OkfPageResult = strict({
  pageId: PositiveId,
  versionId: PositiveId.nullable(),
  sourceRevision: z.string().regex(/^[1-9][0-9]*$/u),
  resourceUri: OkfResourceUri,
  conceptId: z.string().min(1).max(1_100),
  filePath: z.string().min(1).max(4_096),
  sha256: ContentHash,
  mediaType: z.literal('text/markdown'),
  document: BoundedPageContent,
  authority: strict({ state: z.literal('valid'), metadata: z.record(z.string(), z.unknown()), trust: AuthorityTrust }),
  knowledge: KnowledgeProjectionViewSchema.nullable(),
  citation: OkfCitation
})
const ProposalResult = strict({
  proposalId: Uuid,
  approvalId: Uuid,
  actionName: z.string().max(128),
  status: z.enum(['pending', 'approved', 'applied', 'denied', 'expired', 'cancelled']),
  inputHash: ContentHash,
  diffHash: ContentHash.nullable(),
  summary: z.string().max(4_000),
  expiresAt: z.string().max(32)
})
const BrowserObservation = strict({
  contextId: z.string().min(1).max(128),
  documentEpoch: z.string().min(1).max(128),
  url: z.url(),
  title: BoundedTitle,
  text: z.string().max(50_012),
  refs: z.array(strict({ ref: z.string().max(128), role: z.string().max(128), name: z.string().max(1_000), href: z.url().nullable() })).max(200),
  observedAt: z.iso.datetime()
})

const descriptor = (
  name: AgentActionName,
  title: string,
  description: string,
  risk: AgentActionDescriptor['risk'],
  requiredPermissions: readonly string[],
  exposure: AgentActionDescriptor['exposure'],
  annotations: AgentActionDescriptor['annotations']
): AgentActionDescriptor => ({ name, title, description, risk, requiredPermissions, exposure, annotations })

const readAnnotations = { idempotent: true, openWorld: false, sideEffects: false } as const
const proposalAnnotations = { idempotent: true, openWorld: false, sideEffects: false } as const
const browserAnnotations = { idempotent: false, openWorld: true, sideEffects: false } as const
const applyAnnotations = { idempotent: false, openWorld: false, sideEffects: true } as const
const both = { agent: true, mcp: true } as const
const agentOnly = { agent: true, mcp: false } as const
const baseFlags = ['agents.enabled'] as const
const skillFlags = ['agents.enabled', 'agents.skills.enabled'] as const
const browserFlags = ['agents.enabled', 'agents.browser.enabled'] as const
const proposalFlags = ['agents.enabled', 'agents.proposals.enabled', 'agents.writes.enabled'] as const
const defineActionCapability = (
  operationRole: ActionOperationRole,
  outputKind: ActionCapabilityOutputKind,
  providerPresentationFamily: ActionProviderPresentationFamily,
  freshnessKind: ActionCapabilityFreshnessKind,
  reuseEligibility: ActionCapabilityReuseEligibility,
  effectStatus: ActionCapabilityEffectStatus,
  chargeableWork: ActionCapabilityChargeableWork
): ActionCapability => ({
  operationRole,
  outputKinds: [outputKind],
  providerPresentationFamily,
  freshnessKind,
  reuseEligibility,
  effectStatus,
  chargeableWork
})

export const ACTION_CATALOG = {
  'pages.search': {
    descriptor: descriptor(
      'pages.search',
      'Search pages',
      `Find visible candidate pages using distinctive subject/entity terms or a natural-language query. Optional locale, path, lifecycle, trust, or knowledge filters can hide relevant or historical pages. Scores, matches, summaries, trust, and lifecycle are bounded navigation hints, not answer evidence, authorization, or proof of absence. Read relevant candidates with ${AGENT_TOOL_NAMES['pages.get']}({id: result.id}) before broadening; search again for an unresolved question, not to increase the result count. Use only an exact positive numeric result.id for candidate reads, never a path, href, citation, URI, revision, title, or version ID. A user-supplied raw stored path plus locale is a separate direct lookup. Reads reauthorize current content; disclose omitted or not_executed results without inferred access or automatic retries.`,
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'core',
    input: strict({
      query: z.string().min(1).max(1000),
      locale: Locale.optional(),
      path: Path.optional(),
      knowledge: KnowledgeFilter.optional(),
      limit: z.number().int().min(1).max(20).default(10),
      offset: z.number().int().min(0).max(500).default(0)
    }),
    output: strict({
      results: z.array(SearchPageSummary).max(20),
      suggestions: z.array(z.string().min(1).max(1_000)).max(20),
      totalInWindow: z.number().int().nonnegative(),
      windowLimit: z.number().int().positive(),
      windowTruncated: z.boolean(),
      nextOffset: z.number().int().nonnegative().nullable()
    }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('locate', 'candidate-lead', 'wiki.page-candidates', 'candidate-metadata', 'never', 'none', 'none')
  },
  'pages.searchTags': {
    descriptor: descriptor(
      'pages.searchTags',
      'Search tags',
      'Find visible Wiki tags by partial name before using a precise tag in page discovery or authoring.',
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'explore',
    input: strict({ query: z.string().min(1).max(255), limit: z.number().int().min(1).max(20).default(5) }),
    output: strict({ tags: z.array(z.string().min(1).max(255)).max(20) }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('locate', 'candidate-lead', 'wiki.taxonomy', 'request-scoped-structured-observation', 'never', 'none', 'none')
  },
  'pages.listTags': {
    descriptor: descriptor(
      'pages.listTags',
      'List tags',
      'Page through the visible Wiki tag taxonomy in stable name order.',
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'explore',
    input: strict({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(5_000).default(0) }),
    output: strict({ tags: z.array(TagSummary).max(100), nextOffset: z.number().int().nonnegative().nullable() }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('enumerate', 'candidate-lead', 'wiki.taxonomy', 'request-scoped-structured-observation', 'never', 'none', 'none')
  },
  'pages.discover': {
    descriptor: descriptor(
      'pages.discover',
      'Discover pages',
      `Browse a known locale, descendant path, exact-tag, lifecycle, or trust slice for a specific unresolved need; this is not an automatic search fallback. Knowledge filters cover a bounded 100-page candidate window, so narrow an overly broad path. Rows are navigation metadata, not answer evidence or proof of absence. Read chosen pages with ${AGENT_TOOL_NAMES['pages.get']}({id: result.id}), using only an exact positive numeric ID, never a displayed path, URI, citation, revision, title, or version ID. A direct path lookup needs the user's raw stored path and separate locale; reads reauthorize current content. Omitted or not_executed reads do not establish absence or access.`,
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'explore',
    input: strict({
      locale: Locale,
      path: z.string().max(1_024).default(''),
      depth: z.number().int().min(0).max(5).default(1).describe('Additional nested levels below direct children; 0 returns direct children only.'),
      tags: z.array(z.string().min(1).max(255)).max(20).default([]),
      knowledge: KnowledgeFilter.optional(),
      order: z.enum(['path', 'title', 'updated']).default('path'),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).max(5_000).default(0)
    }),
    output: strict({
      pages: z.array(DiscoveryPageSummary).max(100),
      totalInWindow: z.number().int().nonnegative(),
      windowLimit: z.number().int().positive(),
      nextOffset: z.number().int().nonnegative().nullable()
    }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('enumerate', 'candidate-lead', 'wiki.page-candidates', 'candidate-metadata', 'never', 'none', 'none')
  },
  'pages.get': {
    descriptor: descriptor(
      'pages.get',
      'Get page',
      `Read a visible current Wiki page by exact positive numeric ID, or a user-supplied raw stored path with separate locale. From search, discovery, recent, or related results use ${AGENT_TOOL_NAMES['pages.get']}({id: result.id}), not a displayed path, locale, href, citation, URI, revision, title, or history version ID. The read reauthorizes current content; reuse delivered evidence for wording repairs only while its source and access remain valid. Omitted or not_executed reads supply no evidence; do not infer access or retry automatically.`,
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'core',
    input: PageSelector,
    output: PageResult,
    requiredFlags: baseFlags,
    capability: defineActionCapability('read', 'verified-source', 'wiki.page', 'revision-bound-current-source', 'same-revision-and-live-authorization', 'none', 'none')
  },
  'pages.getOkf': {
    descriptor: descriptor(
      'pages.getOkf',
      'Get canonical OKF page',
      `Read a lossless, revision-bound canonical Open Knowledge Format document for one authorized Markdown page. Use ${AGENT_TOOL_NAMES['pages.getOkf']} when an immutable interoperability resource or authority metadata is needed.`,
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'canonical',
    input: OkfPageSelector,
    output: OkfPageResult,
    requiredFlags: baseFlags,
    capability: defineActionCapability('read', 'verified-source', 'wiki.okf', 'revision-bound-current-or-historical-source', 'same-revision-and-live-authorization', 'none', 'none')
  },
  'pages.readForPatch': {
    descriptor: descriptor(
      'pages.readForPatch',
      'Read page for patch',
      'Read a bounded hashline snapshot for an exact page source revision. On the initial read, set previousSnapshotToken to null; only reuse a non-null token returned by an earlier result for the same page.',
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'authoring',
    input: strict({
      pageId: PositiveId,
      ranges: z
        .array(strict({ startLine: PositiveId, endLine: PositiveId }))
        .max(100)
        .optional(),
      previousSnapshotToken: z
        .string()
        .min(1)
        .max(16_384)
        .nullable()
        .optional()
        .describe(
          `Set null on the initial read. Only pass a non-null token returned by an earlier ${AGENT_TOOL_NAMES['pages.readForPatch']} result for this same page; never invent a token.`
        )
    }),
    output: WikiLineSnapshotV1Schema,
    requiredFlags: baseFlags,
    capability: defineActionCapability('read', 'verified-source', 'wiki.patch-snapshot', 'revision-bound-current-source', 'same-source-snapshot-only', 'none', 'none')
  },
  'pages.listRecent': {
    descriptor: descriptor(
      'pages.listRecent',
      'List recent page evidence',
      'Return a bounded, current-source evidence excerpt for each recently changed page visible to the current principal. Each returned citation is page-level evidence for the exact source revision and excerpt included in that row; contentTruncated is explicit when the source exceeds the bounded prefix. Rows are still subject to provider capacity and may be omitted from context without changing their authorization or revision semantics.',
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'core',
    input: strict({ locale: Locale.optional(), limit: z.number().int().min(1).max(20).default(10) }),
    output: strict({
      kind: z.literal('recent-page-evidence'),
      requestedLimit: z.number().int().min(1).max(20),
      exhausted: z.boolean(),
      pages: z.array(RecentPageEvidence).max(20)
    }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('enumerate', 'verified-source', 'wiki.recent-source', 'revision-bound-current-source', 'never', 'none', 'none')
  },
  'pages.listHistory': {
    descriptor: descriptor(
      'pages.listHistory',
      'List page history',
      'List bounded version metadata for one visible page.',
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'history',
    input: strict({ pageId: PositiveId, limit: z.number().int().min(1).max(20).default(10) }),
    output: strict({
      versions: z
        .array(
          strict({
            id: PositiveId,
            sourceRevision: z.string().max(64),
            resourceUri: OkfResourceUri,
            action: z.string().max(64),
            versionDate: z.string().max(32),
            authorName: BoundedTitle
          })
        )
        .max(20)
    }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('enumerate', 'candidate-lead', 'wiki.history', 'historical-candidate-metadata', 'never', 'none', 'none')
  },
  'pages.getVersion': {
    descriptor: descriptor(
      'pages.getVersion',
      'Get page version',
      'Read one historical version of a visible page.',
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'history',
    input: strict({ pageId: PositiveId, versionId: PositiveId }),
    output: PageResult.extend({ versionId: PositiveId, versionDate: z.string().max(32) }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('read', 'verified-source', 'wiki.historical-page', 'revision-bound-historical-source', 'same-historical-version-and-live-authorization', 'none', 'none')
  },
  'pages.listLinks': {
    descriptor: descriptor(
      'pages.listLinks',
      'List page links',
      'List bounded canonical outgoing internal Wiki page links from one visible page.',
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'explore',
    input: strict({ pageId: PositiveId, limit: z.number().int().min(1).max(100).default(50) }),
    output: strict({ links: z.array(strict({ label: BoundedPathLike, target: BoundedPathLike, kind: z.literal('page') })).max(100), truncated: z.boolean() }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('enumerate', 'candidate-lead', 'wiki.links', 'candidate-metadata', 'never', 'none', 'none')
  },
  'pages.related': {
    descriptor: descriptor(
      'pages.related',
      'Get related pages',
      `Traverse visible published pages connected by explicit internal Wiki links and backlinks. Start with cursor null; pass each returned nextCursor unchanged until it is null. Results are candidate metadata only, not read evidence or authorization. After results, read each chosen page with ${AGENT_TOOL_NAMES['pages.get']}({id: result.id}), copying the positive numeric ID exactly. Never guess, stringify, or substitute a result's path/locale, href, citation/evidenceId, okfResourceUri, sourceRevision, title, or history versionId. Use a path/locale selector only for a user-supplied raw stored path and separate locale. The direct read reauthorizes current content. If a read is reported omitted or not_executed, disclose the gap and synthesize only from delivered reads; do not retry automatically or infer access.`,
      'read',
      ['read:pages'],
      both,
      readAnnotations
    ),
    group: 'explore',
    input: strict({
      pageId: PositiveId,
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(4_096).nullable().default(null),
      maxDepth: z.number().int().min(1).max(32).optional()
    }),
    output: strict({ pages: z.array(RelatedPageSummary).max(100), nextCursor: z.string().min(1).max(4_096).nullable() }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('enumerate', 'candidate-lead', 'wiki.page-candidates', 'candidate-metadata', 'never', 'none', 'none')
  },
  'skills.list': {
    descriptor: descriptor('skills.list', 'List approved skills', 'List approved skills visible to the current principal.', 'read', [], both, readAnnotations),
    group: 'core',
    input: EmptyInput,
    output: strict({
      skills: z.array(strict({ name: z.string().max(64), description: BoundedDescription, versionId: Uuid, contentHash: ContentHash })).max(100)
    }),
    requiredFlags: skillFlags,
    capability: defineActionCapability('enumerate', 'candidate-lead', 'skills.catalog', 'candidate-metadata', 'never', 'none', 'none')
  },
  'skills.read': {
    descriptor: descriptor(
      'skills.read',
      'Read approved skill resource',
      'Read an exact resource from an immutable approved skill version.',
      'read',
      [],
      both,
      readAnnotations
    ),
    group: 'core',
    input: strict({ name: z.string().min(1).max(64), versionId: Uuid, path: z.string().min(1).max(512) }),
    output: strict({
      name: z.string().max(64),
      versionId: Uuid,
      path: z.string().max(512),
      mediaType: z.string().max(255),
      contentHash: ContentHash,
      content: BoundedPageContent
    }),
    requiredFlags: skillFlags,
    capability: defineActionCapability('read', 'verified-source', 'skills.resource', 'immutable-approved-resource', 'same-immutable-resource-identity', 'none', 'none')
  },
  'memory.manage': {
    descriptor: descriptor(
      'memory.manage',
      'Manage personal memory',
      'Curate bounded user-specific memory for future conversations. To add a durable user preference call with {"action":"add","target":"user","content":"..."}; use target agent for stable environment, project or workflow facts. For replace or remove supply a unique oldText substring instead of content when removing. Never use text or newText argument keys. Skip secrets, easily rediscovered facts, raw data, and conversation-only details.',
      'reversible-write',
      [],
      agentOnly,
      applyAnnotations
    ),
    group: 'core',
    input: z.discriminatedUnion('action', [
      strict({ action: z.literal('add'), target: MemoryTarget, content: MemoryContent }),
      strict({ action: z.literal('replace'), target: MemoryTarget, oldText: z.string().min(1).max(2_200), content: MemoryContent }),
      strict({ action: z.literal('remove'), target: MemoryTarget, oldText: z.string().min(1).max(2_200) })
    ]),
    output: MemoryResult,
    requiredFlags: baseFlags,
    capability: defineActionCapability('manage', 'operation-receipt', 'memory', 'operation-lifecycle-status', 'never', 'persistent-memory-write', 'none')
  },
  'media.generateImage': {
    descriptor: descriptor(
      'media.generateImage',
      'Create an image',
      'Generate an image or edit images attached to this conversation. Use only when the user requests an image. Supply a complete visual prompt and optional attachment IDs from the conversation. The resulting image is displayed directly in chat; do not invent a URL.',
      'read',
      [],
      agentOnly,
      readAnnotations
    ),
    group: 'core',
    input: strict({ prompt: z.string().trim().min(1).max(16_000), attachmentIds: z.array(Uuid).max(4).optional() }),
    output: strict({ generated: z.literal(true), count: z.number().int().min(1).max(4) }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('generate', 'artifact', 'media.image', 'generated-artifact', 'never', 'external-provider-generation', 'potential-provider-charge')
  },
  'media.generateVideo': {
    descriptor: descriptor('media.generateVideo', 'Create a video', 'Generate one short landscape video from a complete prompt and optional image attachment IDs. Use only when the user requests video generation. The clip appears directly in chat. Do not claim to edit or extend an existing video.', 'read', [], agentOnly, readAnnotations),
    group: 'core',
    input: strict({ prompt: z.string().trim().min(1).max(16_000), attachmentIds: z.array(Uuid).max(4).optional() }),
    output: strict({ generated: z.literal(true), count: z.literal(1) }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('generate', 'artifact', 'media.video', 'generated-artifact', 'never', 'external-provider-generation', 'potential-provider-charge')
  },
  'media.generateMusic': {
    descriptor: descriptor('media.generateMusic', 'Create music', 'Generate one new song or instrumental composition from a complete musical prompt and optional image attachment IDs. Use only when the user requests music generation. Include requested lyrics in the prompt. Audio appears directly in chat; editing existing audio is not supported.', 'read', [], agentOnly, readAnnotations),
    group: 'core',
    input: strict({ prompt: z.string().trim().min(1).max(16_000), attachmentIds: z.array(Uuid).max(4).optional() }),
    output: strict({ generated: z.literal(true), count: z.literal(1) }),
    requiredFlags: baseFlags,
    capability: defineActionCapability('generate', 'artifact', 'media.audio', 'generated-artifact', 'never', 'external-provider-generation', 'potential-provider-charge')
  },
  'browser.navigate': {
    descriptor: descriptor(
      'browser.navigate',
      'Navigate browser',
      'Navigate an isolated credential-free browser to an allowed public URL.',
      'open-world-read',
      ['use:agent-browser'],
      agentOnly,
      browserAnnotations
    ),
    group: 'browser',
    input: strict({ url: z.url() }),
    output: BrowserObservation,
    requiredFlags: browserFlags,
    capability: defineActionCapability('observe', 'transient-observation', 'browser.document', 'volatile-browser-document', 'never', 'isolated-browser-state-change', 'none')
  },
  'browser.observe': {
    descriptor: descriptor(
      'browser.observe',
      'Observe browser',
      'Observe the current isolated browser page with bounded accessibility references.',
      'open-world-read',
      ['use:agent-browser'],
      agentOnly,
      browserAnnotations
    ),
    group: 'browser',
    input: EmptyInput,
    output: BrowserObservation,
    requiredFlags: browserFlags,
    capability: defineActionCapability('observe', 'transient-observation', 'browser.document', 'volatile-browser-document', 'never', 'none', 'none')
  },
  'browser.act': {
    descriptor: descriptor(
      'browser.act',
      'Act in browser',
      'Perform an allowlisted interaction against an observed browser reference.',
      'open-world-read',
      ['use:agent-browser'],
      agentOnly,
      browserAnnotations
    ),
    group: 'browser',
    input: strict({ action: z.enum(['scrollIntoView', 'followLink']), ref: z.string().regex(/^e[1-9]\d{0,3}$/), documentEpoch: z.string().min(1).max(128) }),
    output: BrowserObservation,
    requiredFlags: browserFlags,
    capability: defineActionCapability('observe', 'transient-observation', 'browser.document', 'volatile-browser-document', 'never', 'isolated-browser-state-change', 'none')
  },
  'browser.extract': {
    descriptor: descriptor(
      'browser.extract',
      'Extract browser text',
      'Extract bounded text from an observed browser reference.',
      'open-world-read',
      ['use:agent-browser'],
      agentOnly,
      browserAnnotations
    ),
    group: 'browser',
    input: strict({ maxCharacters: z.number().int().min(1).max(20_000).default(8_000) }),
    output: strict({ url: z.url(), text: z.string().max(20_000), truncated: z.boolean() }),
    requiredFlags: browserFlags,
    capability: defineActionCapability('observe', 'transient-observation', 'browser.extracted-text', 'volatile-browser-extraction', 'never', 'none', 'none')
  },
  'browser.screenshot': {
    descriptor: descriptor(
      'browser.screenshot',
      'Capture browser screenshot',
      'Capture a bounded PNG artifact from the isolated browser.',
      'open-world-read',
      ['use:agent-browser'],
      agentOnly,
      browserAnnotations
    ),
    group: 'browser',
    input: strict({ ref: z.string().max(128).optional() }),
    output: strict({
      artifactId: Uuid,
      mimeType: z.literal('image/png'),
      width: z.number().int().positive().max(16_384),
      height: z.number().int().positive().max(16_384)
    }),
    requiredFlags: browserFlags,
    capability: defineActionCapability('observe', 'artifact', 'browser.screenshot', 'captured-artifact', 'never', 'none', 'none')
  },
  'pages.prepareCreate': {
    descriptor: descriptor(
      'pages.prepareCreate',
      'Prepare page creation',
      'Validate and prepare an immutable Markdown page-create proposal without applying it before approval. First search and read potential duplicates or related pages; include canonical internal links and precise tags only for relationships supported by the new content. Author canonical GFM unless an approved skill requires supported extended syntax. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.',
      'proposal',
      ['write:pages'],
      both,
      proposalAnnotations
    ),
    group: 'authoring',
    input: strict({
      path: Path,
      locale: Locale,
      title: z.string().min(1).max(255),
      description: z.string().max(1000),
      content: z
        .string()
        .max(1_000_000)
        .describe('Canonical Wiki Markdown source. Prefer the Visual Markdown-safe GFM subset and avoid raw HTML so human editors can round-trip the page.'),
      contentType: z.literal('markdown'),
      isPublished: z.boolean().default(true),
      tags: z.array(z.string().max(255)).max(100).default([])
    }),
    output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.create.enabled'],
    capability: defineActionCapability('prepare', 'operation-receipt', 'wiki.proposal', 'operation-lifecycle-status', 'never', 'approval-continuation-may-apply', 'none')
  },
  'pages.preparePatch': {
    descriptor: descriptor(
      'pages.preparePatch',
      'Prepare page patch',
      'Validate a strict hashline patch against an exact Markdown page snapshot while preserving undisclosed source and human-editor compatibility. When the change affects knowledge relationships, first search and read related pages, then maintain canonical internal links and precise tags without manufacturing retrieval signals. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.',
      'proposal',
      ['write:pages'],
      both,
      proposalAnnotations
    ),
    group: 'authoring',
    input: strict({ patch: WikiLinePatchV1Schema }),
    output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.patch.enabled'],
    capability: defineActionCapability('prepare', 'operation-receipt', 'wiki.proposal', 'operation-lifecycle-status', 'never', 'approval-continuation-may-apply', 'none')
  },
  'pages.prepareMove': {
    descriptor: descriptor(
      'pages.prepareMove',
      'Prepare page move',
      'Prepare an immutable page move proposal against an exact revision. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.',
      'proposal',
      ['write:pages'],
      both,
      proposalAnnotations
    ),
    group: 'authoring',
    input: strict({ pageId: PositiveId, sourceRevision: z.string().max(64), destinationPath: Path, destinationLocale: Locale }),
    output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.move.enabled'],
    capability: defineActionCapability('prepare', 'operation-receipt', 'wiki.proposal', 'operation-lifecycle-status', 'never', 'approval-continuation-may-apply', 'none')
  },
  'pages.prepareRestore': {
    descriptor: descriptor(
      'pages.prepareRestore',
      'Prepare page restore',
      'Prepare an immutable restore proposal from one authorized historical version. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.',
      'proposal',
      ['write:pages'],
      both,
      proposalAnnotations
    ),
    group: 'authoring',
    input: strict({ pageId: PositiveId, versionId: PositiveId, sourceRevision: z.string().max(64) }),
    output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.restore.enabled'],
    capability: defineActionCapability('prepare', 'operation-receipt', 'wiki.proposal', 'operation-lifecycle-status', 'never', 'approval-continuation-may-apply', 'none')
  },
  'pages.prepareDelete': {
    descriptor: descriptor(
      'pages.prepareDelete',
      'Prepare page deletion',
      'Prepare an immutable destructive page deletion proposal. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.',
      'destructive-write',
      ['delete:pages'],
      both,
      proposalAnnotations
    ),
    group: 'authoring',
    input: strict({ pageId: PositiveId, sourceRevision: z.string().max(64), confirmationPath: Path }),
    output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.delete.enabled'],
    capability: defineActionCapability('prepare', 'operation-receipt', 'wiki.proposal', 'operation-lifecycle-status', 'never', 'approval-continuation-may-apply', 'none')
  },
  'pages.applyProposal': {
    descriptor: descriptor(
      'pages.applyProposal',
      'Apply approved proposal',
      'Apply an approved proposal explicitly after live reauthorization. Agent chat preparation actions perform this step automatically; explicit invocation remains available for MCP and idempotent recovery.',
      'reversible-write',
      [],
      both,
      applyAnnotations
    ),
    group: 'authoring',
    input: strict({ proposalId: Uuid, approvalId: Uuid }),
    output: strict({ proposalId: Uuid, status: z.literal('applied'), resultHash: ContentHash, page: AppliedPageSummary.nullable() }),
    requiredFlags: proposalFlags,
    capability: defineActionCapability('apply', 'operation-receipt', 'wiki.proposal', 'operation-lifecycle-status', 'never', 'approved-proposal-application', 'none')
  }
} as const satisfies Record<AgentActionName, ActionDefinition>

export const actionDefinition = (name: AgentActionName): ActionDefinition => ACTION_CATALOG[name]
