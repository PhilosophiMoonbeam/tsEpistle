import { z } from 'zod'

import { AGENT_TOOL_NAMES, type AgentActionDescriptor, type AgentActionName, type AgentFeatureFlagKey } from '../../../shared/agents/contracts.ts'
import { WikiLinePatchV1Schema, WikiLineSnapshotV1Schema } from '../patch/wiki-line-patch.ts'
import { KnowledgeProjectionViewSchema } from '../../knowledge/projection.ts'

export interface ActionDefinition {
  readonly descriptor: AgentActionDescriptor
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly requiredFlags: readonly AgentFeatureFlagKey[]
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
const PageSelector = z.union([
  strict({ id: PositiveId }),
  strict({ path: Path, locale: Locale })
])
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
  knowledge: KnowledgeProjectionViewSchema.nullable()
})
const PageSummary = BasePageSummary.extend({ citation: PageCitation })
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

export const ACTION_CATALOG = {
  'pages.search': {
    descriptor: descriptor('pages.search', 'Search pages', `Rank visible pages using authoritative source, deterministic knowledge projections, utility-enriched declared gaps, and the Wiki link graph. Natural-language queries are supported; use lifecycle filters to constrain trust and maintenance state. Results include match evidence and spelling suggestions; read promising pages with ${AGENT_TOOL_NAMES['pages.get']} before answering.`, 'read', ['read:pages'], both, readAnnotations),
    input: strict({ query: z.string().min(1).max(1000), locale: Locale.optional(), path: Path.optional(), knowledge: KnowledgeFilter.optional(), limit: z.number().int().min(1).max(20).default(10), offset: z.number().int().min(0).max(500).default(0) }),
    output: strict({
      results: z.array(SearchPageSummary).max(20),
      suggestions: z.array(z.string().min(1).max(1_000)).max(20),
      totalInWindow: z.number().int().nonnegative(),
      windowLimit: z.number().int().positive(),
      windowTruncated: z.boolean(),
      nextOffset: z.number().int().nonnegative().nullable()
    }),
    requiredFlags: baseFlags
  },
  'pages.searchTags': {
    descriptor: descriptor('pages.searchTags', 'Search tags', 'Find visible Wiki tags by partial name before using a precise tag in page discovery or authoring.', 'read', ['read:pages'], both, readAnnotations),
    input: strict({ query: z.string().min(1).max(255), limit: z.number().int().min(1).max(20).default(5) }),
    output: strict({ tags: z.array(z.string().min(1).max(255)).max(20) }),
    requiredFlags: baseFlags
  },
  'pages.listTags': {
    descriptor: descriptor('pages.listTags', 'List tags', 'Page through the visible Wiki tag taxonomy in stable name order.', 'read', ['read:pages'], both, readAnnotations),
    input: strict({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(5_000).default(0) }),
    output: strict({ tags: z.array(TagSummary).max(100), nextOffset: z.number().int().nonnegative().nullable() }),
    requiredFlags: baseFlags
  },
  'pages.discover': {
    descriptor: descriptor('pages.discover', 'Discover pages', `Browse visible pages structurally by locale, descendant path depth, exact tags, stable ordering, and projected lifecycle or trust state. Knowledge filters operate over a bounded 100-page candidate window. Narrow the path if the window is too broad, then read promising pages with ${AGENT_TOOL_NAMES['pages.get']}.`, 'read', ['read:pages'], both, readAnnotations),
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
    requiredFlags: baseFlags
  },
  'pages.get': {
    descriptor: descriptor('pages.get', 'Get page', 'Read one visible Wiki page by ID or locale and path, including the current deterministic and utility-enriched knowledge projection when ready.', 'read', ['read:pages'], both, readAnnotations),
    input: PageSelector,
    output: PageResult,
    requiredFlags: baseFlags
  },
  'pages.readForPatch': {
    descriptor: descriptor('pages.readForPatch', 'Read page for patch', 'Read a bounded hashline snapshot for an exact page source revision. On the initial read, set previousSnapshotToken to null; only reuse a non-null token returned by an earlier result for the same page.', 'read', ['read:pages'], both, readAnnotations),
    input: strict({
      pageId: PositiveId,
      ranges: z.array(strict({ startLine: PositiveId, endLine: PositiveId })).max(100).optional(),
      previousSnapshotToken: z.string().min(1).max(16_384).nullable().optional().describe(`Set null on the initial read. Only pass a non-null token returned by an earlier ${AGENT_TOOL_NAMES['pages.readForPatch']} result for this same page; never invent a token.`)
    }),
    output: WikiLineSnapshotV1Schema,
    requiredFlags: baseFlags
  },
  'pages.listRecent': {
    descriptor: descriptor('pages.listRecent', 'List recent pages', 'List recently changed pages visible to the current principal.', 'read', ['read:pages'], both, readAnnotations),
    input: strict({ locale: Locale.optional(), limit: z.number().int().min(1).max(20).default(10) }),
    output: strict({ pages: z.array(PageSummary).max(20) }),
    requiredFlags: baseFlags
  },
  'pages.listHistory': {
    descriptor: descriptor('pages.listHistory', 'List page history', 'List bounded version metadata for one visible page.', 'read', ['read:pages'], both, readAnnotations),
    input: strict({ pageId: PositiveId, limit: z.number().int().min(1).max(20).default(10) }),
    output: strict({ versions: z.array(strict({ id: PositiveId, sourceRevision: z.string().max(64), action: z.string().max(64), versionDate: z.string().max(32), authorName: BoundedTitle })).max(20) }),
    requiredFlags: baseFlags
  },
  'pages.getVersion': {
    descriptor: descriptor('pages.getVersion', 'Get page version', 'Read one historical version of a visible page.', 'read', ['read:pages'], both, readAnnotations),
    input: strict({ pageId: PositiveId, versionId: PositiveId }),
    output: PageResult.extend({ versionId: PositiveId, versionDate: z.string().max(32) }),
    requiredFlags: baseFlags
  },
  'pages.listLinks': {
    descriptor: descriptor('pages.listLinks', 'List page links', 'List bounded canonical outgoing internal Wiki page links from one visible page.', 'read', ['read:pages'], both, readAnnotations),
    input: strict({ pageId: PositiveId, limit: z.number().int().min(1).max(100).default(50) }),
    output: strict({ links: z.array(strict({ label: BoundedPathLike, target: BoundedPathLike, kind: z.literal('page') })).max(100), truncated: z.boolean() }),
    requiredFlags: baseFlags
  },
  'pages.related': {
    descriptor: descriptor('pages.related', 'Get related pages', `Traverse visible published pages connected by explicit internal Wiki links and backlinks. Start with cursor null, then pass each returned nextCursor unchanged until it is null. Read promising pages with ${AGENT_TOOL_NAMES['pages.get']} before relying on their content.`, 'read', ['read:pages'], both, readAnnotations),
    input: strict({ pageId: PositiveId, limit: z.number().int().min(1).max(100).default(20), cursor: z.string().min(1).max(4_096).nullable().default(null), maxDepth: z.number().int().min(1).max(32).optional() }),
    output: strict({ pages: z.array(RelatedPageSummary).max(100), nextCursor: z.string().min(1).max(4_096).nullable() }),
    requiredFlags: baseFlags
  },
  'skills.list': {
    descriptor: descriptor('skills.list', 'List approved skills', 'List approved skills visible to the current principal.', 'read', [], both, readAnnotations),
    input: EmptyInput,
    output: strict({ skills: z.array(strict({ name: z.string().max(64), description: BoundedDescription, versionId: Uuid, contentHash: ContentHash })).max(100) }),
    requiredFlags: skillFlags
  },
  'skills.read': {
    descriptor: descriptor('skills.read', 'Read approved skill resource', 'Read an exact resource from an immutable approved skill version.', 'read', [], both, readAnnotations),
    input: strict({ name: z.string().min(1).max(64), versionId: Uuid, path: z.string().min(1).max(512) }),
    output: strict({ name: z.string().max(64), versionId: Uuid, path: z.string().max(512), mediaType: z.string().max(255), contentHash: ContentHash, content: BoundedPageContent }),
    requiredFlags: skillFlags
  },
  'memory.manage': {
    descriptor: descriptor('memory.manage', 'Manage personal memory', 'Curate bounded user-specific memory for future conversations. Save durable user preferences to target user and stable environment, project, or workflow facts to target agent. Skip secrets, easily rediscovered facts, raw data, and conversation-only details. Use a unique oldText substring to replace or remove an entry.', 'reversible-write', [], agentOnly, applyAnnotations),
    input: z.discriminatedUnion('action', [
      strict({ action: z.literal('add'), target: MemoryTarget, content: MemoryContent }),
      strict({ action: z.literal('replace'), target: MemoryTarget, oldText: z.string().min(1).max(2_200), content: MemoryContent }),
      strict({ action: z.literal('remove'), target: MemoryTarget, oldText: z.string().min(1).max(2_200) })
    ]),
    output: MemoryResult,
    requiredFlags: baseFlags
  },
  'browser.navigate': {
    descriptor: descriptor('browser.navigate', 'Navigate browser', 'Navigate an isolated credential-free browser to an allowed public URL.', 'open-world-read', ['use:agent-browser'], agentOnly, browserAnnotations),
    input: strict({ url: z.url() }), output: BrowserObservation, requiredFlags: browserFlags
  },
  'browser.observe': {
    descriptor: descriptor('browser.observe', 'Observe browser', 'Observe the current isolated browser page with bounded accessibility references.', 'open-world-read', ['use:agent-browser'], agentOnly, browserAnnotations),
    input: EmptyInput, output: BrowserObservation, requiredFlags: browserFlags
  },
  'browser.act': {
    descriptor: descriptor('browser.act', 'Act in browser', 'Perform an allowlisted interaction against an observed browser reference.', 'open-world-read', ['use:agent-browser'], agentOnly, browserAnnotations),
    input: strict({ action: z.enum(['scrollIntoView', 'followLink']), ref: z.string().regex(/^e[1-9]\d{0,3}$/), documentEpoch: z.string().min(1).max(128) }), output: BrowserObservation, requiredFlags: browserFlags
  },
  'browser.extract': {
    descriptor: descriptor('browser.extract', 'Extract browser text', 'Extract bounded text from an observed browser reference.', 'open-world-read', ['use:agent-browser'], agentOnly, browserAnnotations),
    input: strict({ maxCharacters: z.number().int().min(1).max(20_000).default(8_000) }), output: strict({ url: z.url(), text: z.string().max(20_000), truncated: z.boolean() }), requiredFlags: browserFlags
  },
  'browser.screenshot': {
    descriptor: descriptor('browser.screenshot', 'Capture browser screenshot', 'Capture a bounded PNG artifact from the isolated browser.', 'open-world-read', ['use:agent-browser'], agentOnly, browserAnnotations),
    input: strict({ ref: z.string().max(128).optional() }), output: strict({ artifactId: Uuid, mimeType: z.literal('image/png'), width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384) }), requiredFlags: browserFlags
  },
  'pages.prepareCreate': {
    descriptor: descriptor('pages.prepareCreate', 'Prepare page creation', 'Validate and prepare an immutable Markdown page-create proposal without applying it before approval. First search and read potential duplicates or related pages; include canonical internal links and precise tags only for relationships supported by the new content. Author canonical GFM unless an approved skill requires supported extended syntax. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.', 'proposal', ['write:pages'], both, proposalAnnotations),
    input: strict({ path: Path, locale: Locale, title: z.string().min(1).max(255), description: z.string().max(1000), content: z.string().max(1_000_000).describe('Canonical Wiki Markdown source. Prefer the Visual Markdown-safe GFM subset and avoid raw HTML so human editors can round-trip the page.'), contentType: z.literal('markdown'), isPublished: z.boolean().default(true), tags: z.array(z.string().max(255)).max(100).default([]) }),
    output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.create.enabled']
  },
  'pages.preparePatch': {
    descriptor: descriptor('pages.preparePatch', 'Prepare page patch', 'Validate a strict hashline patch against an exact Markdown page snapshot while preserving undisclosed source and human-editor compatibility. When the change affects knowledge relationships, first search and read related pages, then maintain canonical internal links and precise tags without manufacturing retrieval signals. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.', 'proposal', ['write:pages'], both, proposalAnnotations),
    input: strict({ patch: WikiLinePatchV1Schema }), output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.patch.enabled']
  },
  'pages.prepareMove': {
    descriptor: descriptor('pages.prepareMove', 'Prepare page move', 'Prepare an immutable page move proposal against an exact revision. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.', 'proposal', ['write:pages'], both, proposalAnnotations),
    input: strict({ pageId: PositiveId, sourceRevision: z.string().max(64), destinationPath: Path, destinationLocale: Locale }), output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.move.enabled']
  },
  'pages.prepareRestore': {
    descriptor: descriptor('pages.prepareRestore', 'Prepare page restore', 'Prepare an immutable restore proposal from one authorized historical version. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.', 'proposal', ['write:pages'], both, proposalAnnotations),
    input: strict({ pageId: PositiveId, versionId: PositiveId, sourceRevision: z.string().max(64) }), output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.restore.enabled']
  },
  'pages.prepareDelete': {
    descriptor: descriptor('pages.prepareDelete', 'Prepare page deletion', 'Prepare an immutable destructive page deletion proposal. In Agent chat this waits for the human decision and applies the exact proposal automatically when approved.', 'destructive-write', ['delete:pages'], both, proposalAnnotations),
    input: strict({ pageId: PositiveId, sourceRevision: z.string().max(64), confirmationPath: Path }), output: ProposalResult,
    requiredFlags: [...proposalFlags, 'agents.writes.delete.enabled']
  },
  'pages.applyProposal': {
    descriptor: descriptor('pages.applyProposal', 'Apply approved proposal', 'Apply an approved proposal explicitly after live reauthorization. Agent chat preparation actions perform this step automatically; explicit invocation remains available for MCP and idempotent recovery.', 'reversible-write', [], both, applyAnnotations),
    input: strict({ proposalId: Uuid, approvalId: Uuid }),
    output: strict({ proposalId: Uuid, status: z.literal('applied'), resultHash: ContentHash, page: BasePageSummary.nullable() }),
    requiredFlags: proposalFlags
  }
} as const satisfies Record<AgentActionName, ActionDefinition>

export const actionDefinition = (name: AgentActionName): ActionDefinition => ACTION_CATALOG[name]
