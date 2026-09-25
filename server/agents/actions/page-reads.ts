import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import type { RequestAuthContext, AgentActionName } from '../../../shared/agents/contracts.ts'
import type { AgentKnowledgeContext } from '../../../shared/agents/knowledge-context.ts'
import type { PageOperationScope } from '../../operations/pages.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { type ActionAuthority, ActionKernel, ActionKernelError } from './kernel.ts'
import { actionDefinition } from './catalog.ts'
import { issueWikiLineSnapshot, inspectWikiLineSnapshotToken, validateWikiMarkdownSource } from '../patch/wiki-line-patch.ts'
import type { KnowledgeProjectionView } from '../../knowledge/projection.ts'
import type { KnowledgeDiscoveryFilter } from '../../knowledge/lifecycle.ts'
import { okfResourceUri, pageAuthority, serializeCanonicalOkfPage, type CanonicalOkfPageDocument, type PageAuthority } from '../okf.ts'
const SEARCH_CANDIDATE_WINDOW_LIMIT = 100
const SearchMatchFieldSchema = z.enum(['title', 'tag', 'path', 'description', 'content', 'graph', 'knowledge'])
const PageRowSchema = z.looseObject({
  id: z.coerce.number().int().positive().optional(),
  pageId: z.coerce.number().int().positive().optional(),
  versionId: z.coerce.number().int().positive().optional(),
  locale: z.string().optional(),
  localeCode: z.string().optional(),
  path: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  contentType: z.string(),
  sourceRevision: z.union([z.string(), z.number()]),
  authorId: z.coerce.number().int().positive().optional(),
  content: z.string().optional(),
  updatedAt: z.union([z.string(), z.date()]),
  visibility: z.enum(['public', 'private']).optional(),
  tags: z.array(z.union([z.string(), z.looseObject({ tag: z.string() })])).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  toc: z.unknown().optional()
})
const SearchResponseSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      id: z.coerce.number().int().positive(),
      sourceRevision: z.union([z.string(), z.number()]),
      path: z.string(),
      locale: z.string(),
      visibility: z.enum(['public', 'private']).optional(),
      tags: z.array(z.string()).max(50).default([]),
      score: z.number().finite().nonnegative().default(0),
      matchedFields: z.array(SearchMatchFieldSchema).max(7).default([])
    })
  ),
  suggestions: z.array(z.string()).max(20),
  totalHits: z.coerce.number().int().nonnegative(),
  windowLimit: z.coerce.number().int().positive(),
  windowTruncated: z.boolean()
})
const TagRowSchema = z.looseObject({ tag: z.string(), title: z.string().nullish() })
const DiscoveryResponseSchema = z.strictObject({
  pages: z
    .array(
      z.looseObject({
        id: z.coerce.number().int().positive(),
        locale: z.string(),
        path: z.string(),
        title: z.string(),
        description: z.string().nullish(),
        updatedAt: z.union([z.string(), z.date()]),
        tags: z.array(z.string()).max(50)
      })
    )
    .max(100),
  totalInWindow: z.coerce.number().int().nonnegative(),
  windowLimit: z.coerce.number().int().positive(),
  nextOffset: z.coerce.number().int().nonnegative().nullable()
})
const RecentPageCitationSchema = z.strictObject({
  evidenceId: z.string().min(1).max(128),
  label: z.string().min(1).max(512),
  href: z.string().min(1).max(2_048)
})
const RecentPageEvidenceSchema = z.strictObject({
  id: z.number().int().positive(),
  locale: z.string().min(2).max(35),
  path: z.string().min(1).max(1_024),
  title: z.string().max(255),
  contentType: z.string().max(128),
  sourceRevision: z.string().max(64),
  updatedAt: z.string().max(32),
  content: z.string().max(2_048),
  sourceContentCharacters: z.number().int().nonnegative().max(1_048_576),
  contentTruncated: z.boolean(),
  citation: RecentPageCitationSchema
})
const RecentResponseSchema = z.strictObject({
  kind: z.literal('recent-page-evidence'),
  requestedLimit: z.number().int().min(1).max(20),
  exhausted: z.boolean(),
  pages: z.array(RecentPageEvidenceSchema).max(20)
})
const HistorySchema = z.looseObject({
  trail: z.array(
    z.looseObject({
      versionId: z.coerce.number().int().positive(),
      sourceRevision: z.union([z.string(), z.number()]),
      actionType: z.string(),
      versionDate: z.union([z.string(), z.date()]),
      authorName: z.string()
    })
  ),
  total: z.coerce.number().int().nonnegative()
})
const LinksSchema = z.array(
  z.looseObject({
    id: z.coerce.number().int().positive(),
    links: z.array(z.string())
  })
)
const RelatedResponseSchema = z.strictObject({
  pages: z
    .array(
      PageRowSchema.extend({
        distance: z.coerce.number().int().positive().max(32),
        direction: z.enum(['incoming', 'outgoing', 'bidirectional']),
        viaPageId: z.coerce.number().int().positive()
      })
    )
    .max(100),
  truncated: z.boolean(),
  nextOffset: z.coerce.number().int().nonnegative().nullable()
})

interface PageOperations {
  search(input: Record<string, unknown>): Promise<unknown>
  searchTags(input: Record<string, unknown>): Promise<unknown>
  listTags(input?: Express.User | Record<string, unknown>): Promise<unknown>
  discover(input: Record<string, unknown>): Promise<unknown>
  get(input: Record<string, unknown>): Promise<unknown>
  getByPath(input: Record<string, unknown>): Promise<unknown>
  listRecent(input: Record<string, unknown>): Promise<unknown>
  getHistory(input: Record<string, unknown>): Promise<unknown>
  getVersion(input: Record<string, unknown>): Promise<unknown>
  listLinks(input: Record<string, unknown>): Promise<unknown>
  listRelated(input: Record<string, unknown>): Promise<unknown>
}

export interface PageReadActionDependencies {
  readonly operations: PageOperations
  readonly resolveRequester: (authority: ActionAuthority) => Promise<Express.User>
  readonly snapshotSigningSecret: Uint8Array
  readonly knowledge?: {
    getCurrent(pageId: number): Promise<KnowledgeProjectionView | null>
    getRevision(pageId: number, sourceRevision: string): Promise<KnowledgeProjectionView | null>
    getCurrentMany(pageIds: readonly number[]): Promise<ReadonlyMap<number, KnowledgeProjectionView>>
  }
}

type PageGetInput = { readonly id: number } | { readonly path: string; readonly locale: string }
interface SearchInput {
  readonly query: string
  readonly locale?: string
  readonly path?: string
  readonly limit: number
  readonly offset: number
  readonly knowledge?: KnowledgeDiscoveryFilter
}
interface SearchTagsInput {
  readonly query: string
  readonly limit: number
}
interface ListTagsInput {
  readonly limit: number
  readonly offset: number
}
interface DiscoverInput {
  readonly locale: string
  readonly path: string
  readonly depth: number
  readonly tags: readonly string[]
  readonly order: 'path' | 'title' | 'updated'
  readonly limit: number
  readonly offset: number
  readonly knowledge?: KnowledgeDiscoveryFilter
}
interface PatchReadInput {
  readonly pageId: number
  readonly ranges?: readonly { readonly startLine: number; readonly endLine: number }[]
  readonly previousSnapshotToken?: string
}
type OkfInput = PageGetInput | { readonly pageId: number; readonly versionId: number }
interface RecentInput {
  readonly locale?: string
  readonly limit: number
}
interface HistoryInput {
  readonly pageId: number
  readonly limit: number
}
interface VersionInput {
  readonly pageId: number
  readonly versionId: number
}
interface LinksInput {
  readonly pageId: number
  readonly limit: number
}
interface RelatedInput {
  readonly pageId: number
  readonly limit: number
  readonly cursor: string | null
  readonly maxDepth?: number
}

const operationFailure = (message: string): ActionKernelError => new ActionKernelError('INVALID_PAGE_RESULT', message, 500)
interface CitationSection {
  readonly titlePath: readonly string[]
  readonly anchor: string
}

const tocSections = (value: unknown): readonly CitationSection[] => {
  let root = value
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root)
    } catch {
      return []
    }
  }
  if (!Array.isArray(root)) return []
  const sections: CitationSection[] = []
  const visit = (nodes: readonly unknown[], parents: readonly string[], depth: number): void => {
    if (depth > 6 || sections.length >= 99) return
    for (const value of nodes) {
      if (sections.length >= 99 || typeof value !== 'object' || value === null) break
      const node = value as Record<string, unknown>
      const title = typeof node.title === 'string' ? node.title.trim() : ''
      const anchor = typeof node.anchor === 'string' ? node.anchor : ''
      const titlePath = title ? [...parents, title] : parents
      if (title && anchor.startsWith('#') && !anchor.includes('\n')) sections.push({ titlePath, anchor })
      if (Array.isArray(node.children)) visit(node.children, titlePath, depth + 1)
    }
  }
  visit(root, [], 1)
  return sections
}

const boundedCitationLabel = (value: string): string => (value.length <= 512 ? value : `${value.slice(0, 511)}…`)

const versionedCitationHref = (href: string, versionId: number): string => {
  const anchorIndex = href.indexOf('#')
  return anchorIndex < 0 ? `${href}?v=${versionId}` : `${href.slice(0, anchorIndex)}?v=${versionId}${href.slice(anchorIndex)}`
}

const pageCitation = (row: z.infer<typeof PageRowSchema>, id: number, locale: string, versionId: number | null) => {
  const rawHref = `${row.visibility === 'private' ? '/_private' : ''}/${locale}/${row.path}`
  const href = versionId === null ? rawHref : versionedCitationHref(rawHref, versionId)
  const citationTitle = row.title.trim() || row.path
  const revision = String(row.sourceRevision)
  const evidenceId = versionId === null ? `page:${id}:revision:${revision}` : `page:${id}:version:${versionId}:revision:${revision}`
  return {
    citation: { evidenceId, label: citationTitle, href },
    citationSections: tocSections(row.toc).flatMap((section, index) => {
      const sectionHref = `${rawHref}${section.anchor}`
      const versionedSectionHref = versionId === null ? sectionHref : versionedCitationHref(sectionHref, versionId)
      const titlePath = section.titlePath[0] === citationTitle ? section.titlePath.slice(1) : section.titlePath
      return versionedSectionHref.length <= 2_048
        ? [
            {
              evidenceId: `${evidenceId}:section:${index + 1}`,
              label: boundedCitationLabel([citationTitle, ...titlePath].join(' › ')),
              href: versionedSectionHref
            }
          ]
        : []
    })
  }
}

const parsePage = (value: unknown, includeContent: boolean, versionId: number | null = null): ParsedPage => {
  const parsed = PageRowSchema.safeParse(value)
  if (!parsed.success || (includeContent && parsed.data.content === undefined)) throw operationFailure('Page operation returned an invalid bounded result')
  const row = parsed.data
  const id = row.id ?? row.pageId
  const locale = row.locale ?? row.localeCode
  if (
    !id ||
    !locale ||
    (row.id !== undefined && row.pageId !== undefined && row.id !== row.pageId) ||
    (row.locale !== undefined && row.localeCode !== undefined && row.locale !== row.localeCode)
  )
    throw operationFailure('Page operation omitted page identity')
  if (versionId !== null && row.versionId !== undefined && row.versionId !== versionId)
    throw operationFailure('Page version operation returned a different version')
  const sourceRevision = String(row.sourceRevision)
  const citation = pageCitation(row, id, locale, versionId)
  return {
    id,
    locale,
    path: row.path,
    title: row.title,
    description: row.description ?? '',
    contentType: row.contentType,
    sourceRevision,
    authority: pageAuthority(row.extra),
    okfResourceUri: okfResourceUri(id, versionId, sourceRevision),
    citation: citation.citation,
    ...(includeContent
      ? {
          content: row.content as string,
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
          citationSections: citation.citationSections
        }
      : {})
  }
}
type ParsedPage = PageIdentity & {
  readonly title: string
  readonly description: string
  readonly contentType: string
  readonly sourceRevision: string
  readonly authority: PageAuthority
  readonly okfResourceUri: string
  readonly citation: { readonly evidenceId: string; readonly label: string; readonly href: string }
  readonly content?: string
  readonly updatedAt?: string | Date
  readonly citationSections?: readonly { readonly evidenceId: string; readonly label: string; readonly href: string }[]
}

const pageNotFound = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if ('code' in error && error.code === 'PAGE_NOT_FOUND') return true
  return error.name.includes('PageNotFound')
}

const pageUnavailable = (error: unknown): boolean => {
  if (pageNotFound(error)) return true
  return error instanceof Error && (('code' in error && error.code === 'PAGE_LOCKED') || error.name === 'PAGE_LOCKED')
}
const unavailablePage = (): ActionKernelError => new ActionKernelError('PAGE_NOT_FOUND', 'Page is unavailable', 404)

const hostPageScope = (context: AgentKnowledgeContext | undefined): PageOperationScope | undefined => {
  if (!context) return undefined
  switch (context.scope.kind) {
    case 'all':
      return { kind: 'all' }
    case 'selected':
      return { kind: 'selected', pageIds: [...new Set(context.sources.map(source => source.id))].sort((left, right) => left - right) }
    case 'locale':
      return { kind: 'locale', locale: context.scope.locale }
    case 'section':
      return { kind: 'section', locale: context.scope.locale, path: context.scope.path }
  }
}

interface PageIdentity {
  readonly id: number
  readonly locale: string
  readonly path: string
}

const withinPageScope = (scope: PageOperationScope | undefined, page: PageIdentity): boolean => {
  if (!scope || scope.kind === 'all') return true
  if (scope.kind === 'selected') return scope.pageIds.includes(page.id)
  if (scope.kind === 'locale') return page.locale === scope.locale
  return page.locale === scope.locale && (page.path === scope.path || page.path.startsWith(`${scope.path}/`))
}

const assertSelectorWithinScope = (scope: PageOperationScope | undefined, selector: PageGetInput): void => {
  if (!scope || scope.kind === 'all') return
  if ('id' in selector) {
    if (scope.kind === 'selected' && !scope.pageIds.includes(selector.id)) throw unavailablePage()
    return
  }
  if (scope.kind === 'selected') return
  const identity = { id: 0, locale: selector.locale, path: selector.path }
  if (!withinPageScope(scope, identity)) throw unavailablePage()
}

const scopeFingerprint = (scope: PageOperationScope | undefined, secret: Uint8Array): string =>
  createHmac('sha256', secret)
    .update(scope === undefined ? 'unscoped' : JSON.stringify(scope))
    .digest('base64url')

const getPageBySelector = async (operations: PageOperations, requester: Express.User, input: PageGetInput): Promise<unknown> => {
  if ('id' in input) return operations.get({ id: input.id, requester })
  let privateFailure: unknown
  try {
    return await operations.getByPath({ path: input.path, locale: input.locale, visibility: 'private', requester })
  } catch (error: unknown) {
    privateFailure = error
  }
  if (!pageNotFound(privateFailure)) throw privateFailure
  return operations.getByPath({ path: input.path, locale: input.locale, visibility: 'public', requester })
}
const readPageWithinScope = async (
  operations: PageOperations,
  requester: Express.User,
  selector: PageGetInput,
  scope: PageOperationScope | undefined,
  includeContent: boolean,
  versionId: number | null = null
): Promise<{ readonly rawPage: unknown; readonly page: ParsedPage }> => {
  assertSelectorWithinScope(scope, selector)
  let rawPage: unknown
  try {
    rawPage = await getPageBySelector(operations, requester, selector)
  } catch (error: unknown) {
    if (scope && pageUnavailable(error)) throw unavailablePage()
    throw error
  }
  if (rawPage === null || rawPage === undefined) {
    if (scope) throw unavailablePage()
    throw new ActionKernelError('PAGE_NOT_FOUND', 'Page version is unavailable', 404)
  }
  const page = parsePage(rawPage, includeContent, versionId)
  const selectorMatches = 'id' in selector ? page.id === selector.id : page.locale === selector.locale && page.path === selector.path
  if (!selectorMatches) {
    if (scope) throw unavailablePage()
    throw operationFailure('Page operation returned a different page identity')
  }
  if (!withinPageScope(scope, page)) throw unavailablePage()
  return { rawPage, page }
}

const requesterFor = async (resolveRequester: PageReadActionDependencies['resolveRequester'], authority: ActionAuthority): Promise<Express.User> => {
  const requester = await resolveRequester(authority)
  if (!requester) throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'The action principal no longer exists', 401)
  return requester
}
export const snapshotRequesterScope = (authority: ActionAuthority): string =>
  authority.requester.kind === 'user'
    ? `request:${authority.requestId}:user:${authority.requester.userId}`
    : `request:${authority.requestId}:api-key:${authority.requester.apiKeyId}:group:${authority.requester.groupId}`

const RelatedCursorPayloadSchema = z.strictObject({
  version: z.literal(2),
  requesterScope: z.string().min(1).max(512),
  scopeFingerprint: z.string().min(1).max(128),
  pageId: z.number().int().positive(),
  maxDepth: z.number().int().min(1).max(32).nullable(),
  offset: z.number().int().nonnegative()
})
type RelatedCursorPayload = z.infer<typeof RelatedCursorPayloadSchema>
const relatedRequesterScope = (authority: ActionAuthority): string =>
  authority.requester.kind === 'user' ? `user:${authority.requester.userId}` : `api-key:${authority.requester.apiKeyId}:group:${authority.requester.groupId}`
const invalidRelatedCursor = (): never => {
  throw new ActionKernelError('INVALID_RELATED_CURSOR', 'Related-page cursor is invalid or does not match this traversal', 400)
}
const relatedCursorSignature = (payload: string, secret: Uint8Array): string => createHmac('sha256', secret).update(payload).digest('base64url')
const issueRelatedCursor = (payload: RelatedCursorPayload, secret: Uint8Array): string => {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${relatedCursorSignature(encoded, secret)}`
}
const readRelatedCursor = (token: string, secret: Uint8Array): RelatedCursorPayload => {
  const [encoded, suppliedSignature, extra] = token.split('.')
  if (!encoded || !suppliedSignature || extra !== undefined) return invalidRelatedCursor()
  const expected = Buffer.from(relatedCursorSignature(encoded, secret), 'base64url')
  const supplied = Buffer.from(suppliedSignature, 'base64url')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return invalidRelatedCursor()
  try {
    return RelatedCursorPayloadSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown)
  } catch {
    return invalidRelatedCursor()
  }
}

const normalizedPageTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const tags = value
    .flatMap(item => {
      if (typeof item === 'string') return [item]
      if (item && typeof item === 'object' && typeof Reflect.get(item, 'tag') === 'string') return [String(Reflect.get(item, 'tag'))]
      return []
    })
    .map(tag => tag.trim().toLocaleLowerCase())
    .filter(Boolean)
  return [...new Set(tags)].sort().slice(0, 50)
}
const safeWikiLinkTarget = (target: string, scope: PageOperationScope | undefined): boolean => {
  if (target.length < 4 || target.length > 1_024) return false
  for (let index = 0; index < target.length; index += 1) {
    const character = target.charCodeAt(index)
    if (character === 0x5c || character === 0x3f || character === 0x23 || character <= 0x1f || character === 0x7f) return false
  }
  const separator = target.indexOf('/')
  if (separator < 2 || separator === target.length - 1 || target.indexOf('/', separator + 1) === separator + 1) return false
  const locale = target.slice(0, separator)
  const path = target.slice(separator + 1)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,34}$/u.test(locale) || /%(?:2f|5c)/iu.test(path)) return false
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(path)
  } catch {
    return false
  }
  if (decodedPath.startsWith('/') || decodedPath.endsWith('/') || decodedPath.includes('\\')) return false
  if (decodedPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return false
  if (!scope || scope.kind === 'all' || scope.kind === 'selected') return true
  if (scope.kind === 'locale') return locale === scope.locale
  return locale === scope.locale && (path === scope.path || path.startsWith(`${scope.path}/`))
}

const matchesKnowledgeFilter = (view: KnowledgeProjectionView, filter?: KnowledgeDiscoveryFilter): boolean => {
  if (!filter) return true
  if (filter.state !== undefined && view.state !== filter.state) return false
  if (filter.lifecycleStatus !== undefined && view.lifecycle.status !== filter.lifecycleStatus) return false
  if (filter.trustTier !== undefined && view.lifecycle.trustTier !== filter.trustTier) return false
  if (filter.stale !== undefined && view.lifecycle.stale !== filter.stale) return false
  return filter.conceptType === undefined || view.conceptType?.toLocaleLowerCase() === filter.conceptType.toLocaleLowerCase()
}

export const registerPageReadActions = (kernel: ActionKernel, dependencies: PageReadActionDependencies): void => {
  const operations = dependencies.operations

  kernel.register('pages.search', async (rawInput, context) => {
    const requested = rawInput as SearchInput
    const scope = hostPageScope(context.knowledgeContext)
    const selectedScope = context.knowledgeContext?.scope
    const input = {
      ...requested,
      ...(selectedScope?.kind === 'section' ? { locale: selectedScope.locale, path: selectedScope.path } : {}),
      ...(selectedScope?.kind === 'locale' ? { locale: selectedScope.locale } : {})
    }
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const rawResponse = await operations.search({
      query: input.query,
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.knowledge ? { knowledge: input.knowledge } : {}),
      limit: SEARCH_CANDIDATE_WINDOW_LIMIT,
      ...(selectedScope?.kind === 'selected' ? { pageIds: context.knowledgeContext?.sources.map(source => source.id) ?? [] } : {}),
      ...(scope === undefined ? {} : { agentScope: scope }),
      requester
    })
    const response = SearchResponseSchema.safeParse(rawResponse)
    if (!response.success) throw operationFailure('Page search returned an invalid result')
    const hydrated = (
      await Promise.all(
        response.data.results.map(async result => {
          if (!withinPageScope(scope, result)) return null
          try {
            const rawPage = await operations.get({ id: result.id, requester })
            const page = parsePage(rawPage, false)
            const visibility =
              rawPage !== null && typeof rawPage === 'object' && 'visibility' in rawPage && rawPage.visibility === 'private' ? 'private' : 'public'
            if (
              page.id !== result.id ||
              page.sourceRevision !== String(result.sourceRevision) ||
              page.locale !== result.locale ||
              page.path !== result.path ||
              !withinPageScope(scope, page) ||
              visibility !== (result.visibility ?? 'public')
            )
              return null
            return {
              ...page,
              tags: normalizedPageTags(rawPage !== null && typeof rawPage === 'object' && 'tags' in rawPage ? rawPage.tags : undefined),
              score: result.score,
              matchedFields: result.matchedFields
            }
          } catch (error: unknown) {
            if (pageUnavailable(error)) return null
            throw error
          }
        })
      )
    ).filter(result => result !== null)
    const currentKnowledge = dependencies.knowledge
      ? await dependencies.knowledge.getCurrentMany(hydrated.map(result => result.id))
      : new Map<number, KnowledgeProjectionView>()
    const filtered = hydrated
      .map(result => {
        const knowledge = currentKnowledge.get(result.id)
        return {
          ...result,
          knowledge: knowledge?.sourceRevision === result.sourceRevision ? knowledge : null
        }
      })
      .filter(result => (result.knowledge !== null ? matchesKnowledgeFilter(result.knowledge, input.knowledge) : input.knowledge === undefined))
    const selected = filtered.slice(input.offset, input.offset + input.limit)
    const consumedThrough = input.offset + selected.length
    const allCandidatesVerified = hydrated.length === response.data.results.length && filtered.length === hydrated.length
    return {
      results: selected,
      suggestions: scope === undefined ? response.data.suggestions : [],
      totalInWindow: filtered.length,
      windowLimit: response.data.windowLimit,
      windowTruncated: scope === undefined ? response.data.windowTruncated : allCandidatesVerified && response.data.windowTruncated,
      nextOffset: consumedThrough < filtered.length ? consumedThrough : null
    }
  })

  kernel.register('pages.searchTags', async (rawInput, context) => {
    const input = rawInput as SearchTagsInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const tags = z
      .array(z.string())
      .max(20)
      .safeParse(
        await operations.searchTags({
          query: input.query,
          limit: input.limit,
          ...(scope === undefined ? {} : { agentScope: scope }),
          requester
        })
      )
    if (!tags.success) throw operationFailure('Tag search returned an invalid result')
    return { tags: tags.data.slice(0, input.limit) }
  })

  kernel.register('pages.listTags', async (rawInput, context) => {
    const input = rawInput as ListTagsInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const response = z.array(TagRowSchema).safeParse(await operations.listTags(scope === undefined ? requester : { requester, agentScope: scope }))
    if (!response.success) throw operationFailure('Tag listing returned an invalid result')
    const unique = [
      ...new Map(
        response.data
          .map(item => {
            const tag = item.tag.trim()
            return [tag.toLocaleLowerCase(), { tag, title: item.title?.trim().slice(0, 255) || null }] as const
          })
          .filter((entry): entry is readonly [string, { tag: string; title: string | null }] => Boolean(entry[0]))
      ).values()
    ].sort((left, right) => left.tag.localeCompare(right.tag))
    const selected = unique.slice(input.offset, input.offset + input.limit)
    return {
      tags: selected,
      nextOffset: input.offset + selected.length < unique.length ? input.offset + selected.length : null
    }
  })

  kernel.register('pages.discover', async (rawInput, context) => {
    const input = rawInput as DiscoverInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const { knowledge: knowledgeFilter, ...discoveryInput } = input
    const response = DiscoveryResponseSchema.safeParse(
      await operations.discover({
        ...discoveryInput,
        ...(knowledgeFilter ? { offset: 0, limit: 100 } : {}),
        ...(scope === undefined ? {} : { agentScope: scope }),
        requester
      })
    )
    if (!response.success) throw operationFailure('Page discovery returned an invalid result')
    const hydrated = (
      await Promise.all(
        response.data.pages.map(async item => {
          if (!withinPageScope(scope, item)) return null
          try {
            const rawPage = await operations.get({ id: item.id, requester })
            const page = parsePage(rawPage, false)
            if (page.id !== item.id || page.locale !== item.locale || page.path !== item.path || page.title !== item.title || !withinPageScope(scope, page))
              return null
            const raw = rawPage as Record<string, unknown>
            const updatedAt = raw.updatedAt instanceof Date ? raw.updatedAt.toISOString() : raw.updatedAt
            if (typeof updatedAt !== 'string') return null
            return {
              ...page,
              tags: normalizedPageTags(raw.tags),
              updatedAt
            }
          } catch (error: unknown) {
            if (pageUnavailable(error)) return null
            throw error
          }
        })
      )
    ).filter(result => result !== null)
    const currentKnowledge = dependencies.knowledge
      ? await dependencies.knowledge.getCurrentMany(hydrated.map(result => result.id))
      : new Map<number, KnowledgeProjectionView>()
    const filtered = hydrated
      .map(result => {
        const knowledge = currentKnowledge.get(result.id)
        return { ...result, knowledge: knowledge?.sourceRevision === result.sourceRevision ? knowledge : null }
      })
      .filter(result => (result.knowledge !== null ? matchesKnowledgeFilter(result.knowledge, knowledgeFilter) : knowledgeFilter === undefined))
    const pages = knowledgeFilter ? filtered.slice(input.offset, input.offset + input.limit) : filtered
    const allCandidatesVerified = hydrated.length === response.data.pages.length
    const totalInWindow = knowledgeFilter ? filtered.length : allCandidatesVerified ? response.data.totalInWindow : filtered.length
    return {
      pages,
      totalInWindow,
      windowLimit: response.data.windowLimit,
      nextOffset: knowledgeFilter
        ? input.offset + pages.length < totalInWindow
          ? input.offset + pages.length
          : null
        : allCandidatesVerified
          ? response.data.nextOffset
          : null
    }
  })

  kernel.register('pages.get', async (rawInput, context) => {
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const { page } = await readPageWithinScope(operations, requester, rawInput as PageGetInput, scope, true)
    const projection = await dependencies.knowledge?.getCurrent(page.id)
    return { ...page, knowledge: projection?.sourceRevision === page.sourceRevision ? projection : null }
  })
  kernel.register('pages.getOkf', async (rawInput, context) => {
    const input = rawInput as OkfInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const historical = 'pageId' in input
    let rawPage: unknown
    let parsed: ParsedPage
    if (historical) {
      if (scope) await readPageWithinScope(operations, requester, { id: input.pageId }, scope, false)
      try {
        rawPage = await operations.getVersion({ pageId: input.pageId, versionId: input.versionId, requester })
      } catch (error: unknown) {
        if (scope && pageUnavailable(error)) throw unavailablePage()
        throw error
      }
      if (!rawPage) {
        if (scope) throw unavailablePage()
        throw new ActionKernelError('PAGE_NOT_FOUND', 'Page version is unavailable', 404)
      }
      parsed = parsePage(rawPage, true, input.versionId)
      if (parsed.id !== input.pageId || !withinPageScope(scope, parsed)) throw unavailablePage()
    } else {
      const result = await readPageWithinScope(operations, requester, input, scope, true)
      rawPage = result.rawPage
      parsed = result.page
    }
    if (parsed.contentType !== 'markdown') throw new ActionKernelError('UNSUPPORTED_CONTENT_TYPE', 'Only Markdown pages can be serialized as OKF concepts', 409)
    if (typeof parsed.content !== 'string') throw operationFailure('Page operation omitted Markdown source')
    if (parsed.authority.state !== 'valid')
      throw new ActionKernelError('INVALID_OKF_AUTHORITY', `Cannot serialize page with ${parsed.authority.state} OKF authority`, 409)
    const projection = historical
      ? await dependencies.knowledge?.getRevision(parsed.id, parsed.sourceRevision)
      : await dependencies.knowledge?.getCurrent(parsed.id)
    const knowledge = projection?.sourceRevision === parsed.sourceRevision ? projection : null
    const raw = rawPage as Record<string, unknown>
    const visibility = raw.visibility === 'private' ? 'private' : 'public'
    const tags = normalizedPageTags(raw.tags)
    return serializeCanonicalOkfPage({
      pageId: parsed.id,
      versionId: historical ? input.versionId : null,
      sourceRevision: parsed.sourceRevision,
      locale: parsed.locale,
      path: parsed.path,
      title: parsed.title,
      description: parsed.description,
      tags,
      visibility,
      content: parsed.content,
      authority: parsed.authority,
      knowledge
    })
  })
  kernel.register('pages.readForPatch', async (rawInput, context) => {
    const input = rawInput as PatchReadInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const { page } = await readPageWithinScope(operations, requester, { id: input.pageId }, scope, true)
    if (page.contentType !== 'markdown') throw new ActionKernelError('UNSUPPORTED_CONTENT_TYPE', 'Only Markdown pages support hashline snapshots', 409)
    if (page.content === undefined) throw operationFailure('Page operation omitted Markdown source')
    return issueWikiLineSnapshot({
      page: { id: page.id, locale: page.locale, path: page.path, contentType: 'markdown' },
      sourceRevision: page.sourceRevision,
      source: page.content,
      requesterScope: snapshotRequesterScope(context.authority),
      signingSecret: dependencies.snapshotSigningSecret,
      ...(input.ranges ? { requestedRanges: input.ranges } : {}),
      ...(input.previousSnapshotToken ? { previousSnapshotToken: input.previousSnapshotToken } : {})
    })
  })

  kernel.register('pages.listRecent', async (rawInput, context) => {
    const input = rawInput as RecentInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const recent = RecentResponseSchema.safeParse(
      await operations.listRecent({
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        limit: input.limit,
        ...(scope === undefined ? {} : { agentScope: scope }),
        requester
      })
    )
    if (!recent.success || recent.data.requestedLimit !== input.limit || recent.data.pages.length > input.limit) {
      throw operationFailure('Recent page operation returned an invalid result')
    }
    const pages = (
      await Promise.all(
        recent.data.pages.map(async item => {
          if (
            !withinPageScope(scope, item) ||
            (input.locale !== undefined && item.locale !== input.locale) ||
            item.citation.evidenceId !== `page:${item.id}:revision:${item.sourceRevision}`
          )
            return null
          try {
            const rawPage = await operations.get({ id: item.id, requester })
            const page = parsePage(rawPage, true)
            const raw = rawPage as Record<string, unknown>
            const content = page.content as string
            const updatedAt = page.updatedAt
            const characterCountMatches = item.sourceContentCharacters === content.length
            if (
              page.id !== item.id ||
              page.locale !== item.locale ||
              page.path !== item.path ||
              page.title !== item.title ||
              page.contentType !== item.contentType ||
              page.sourceRevision !== item.sourceRevision ||
              !withinPageScope(scope, page) ||
              !characterCountMatches ||
              !content.startsWith(item.content) ||
              item.contentTruncated !== (item.content !== content) ||
              (!item.contentTruncated && item.content !== content) ||
              typeof updatedAt !== 'string'
            )
              return null
            const href = `${raw.visibility === 'private' ? '/_private' : ''}/${page.locale}/${page.path}`
            return {
              id: page.id,
              locale: page.locale,
              path: page.path,
              title: page.title,
              contentType: page.contentType,
              sourceRevision: page.sourceRevision,
              updatedAt,
              content: item.content,
              sourceContentCharacters: content.length,
              contentTruncated: item.content !== content,
              citation: {
                evidenceId: page.citation.evidenceId,
                label: page.citation.label,
                href
              }
            }
          } catch (error: unknown) {
            if (pageUnavailable(error)) return null
            throw error
          }
        })
      )
    ).filter(page => page !== null)
    const everyCandidateVerified = pages.length === recent.data.pages.length
    return {
      ...recent.data,
      exhausted: everyCandidateVerified ? recent.data.exhausted : true,
      pages
    }
  })

  kernel.register('pages.listHistory', async (rawInput, context) => {
    const input = rawInput as HistoryInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const { page } = await readPageWithinScope(operations, requester, { id: input.pageId }, scope, false)
    let value: unknown
    try {
      value = await operations.getHistory({ id: page.id, offsetPage: 0, offsetSize: input.limit, requester })
    } catch (error: unknown) {
      if (scope && pageUnavailable(error)) throw unavailablePage()
      throw error
    }
    const history = HistorySchema.safeParse(value)
    if (!history.success) throw operationFailure('Page history operation returned an invalid result')
    return {
      versions: history.data.trail.slice(0, input.limit).map(version => ({
        id: version.versionId,
        sourceRevision: String(version.sourceRevision),
        resourceUri: okfResourceUri(page.id, version.versionId, version.sourceRevision),
        action: version.actionType,
        versionDate: version.versionDate instanceof Date ? version.versionDate.toISOString() : version.versionDate,
        authorName: version.authorName
      }))
    }
  })

  kernel.register('pages.getVersion', async (rawInput, context) => {
    const input = rawInput as VersionInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    if (scope) await readPageWithinScope(operations, requester, { id: input.pageId }, scope, false)
    let value: unknown
    try {
      value = await operations.getVersion({ pageId: input.pageId, versionId: input.versionId, requester })
    } catch (error: unknown) {
      if (scope && pageUnavailable(error)) throw unavailablePage()
      throw error
    }
    if (!value) {
      if (scope) throw unavailablePage()
      throw new ActionKernelError('PAGE_NOT_FOUND', 'Page version is unavailable', 404)
    }
    const parsed = parsePage(value, true, input.versionId)
    if (parsed.id !== input.pageId || !withinPageScope(scope, parsed)) throw unavailablePage()
    const versionDate = z.looseObject({ versionDate: z.union([z.string(), z.date()]) }).safeParse(value)
    if (!versionDate.success) throw operationFailure('Page version operation omitted its date')
    const citationSections = parsed.citationSections ?? []
    const projection = await dependencies.knowledge?.getRevision(parsed.id, parsed.sourceRevision)
    return {
      ...parsed,
      versionId: input.versionId,
      versionDate: versionDate.data.versionDate instanceof Date ? versionDate.data.versionDate.toISOString() : versionDate.data.versionDate,
      knowledge: projection?.sourceRevision === parsed.sourceRevision ? projection : null,
      citationSections
    }
  })

  kernel.register('pages.listLinks', async (rawInput, context) => {
    const input = rawInput as LinksInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const { page } = await readPageWithinScope(operations, requester, { id: input.pageId }, scope, false)
    const parsedLinks = LinksSchema.safeParse(
      await operations.listLinks({ locale: page.locale, ...(scope === undefined ? {} : { agentScope: scope }), requester })
    )
    if (!parsedLinks.success) throw operationFailure('Page links operation returned an invalid result')
    const selected = parsedLinks.data.find(row => row.id === page.id)
    let inScope = (selected?.links ?? []).filter(target => safeWikiLinkTarget(target, scope))
    if (scope?.kind === 'selected' && inScope.length > 0) {
      const admittedTargets = await Promise.all(
        inScope.map(async target => {
          const separator = target.indexOf('/')
          const selector = { locale: target.slice(0, separator), path: target.slice(separator + 1) }
          try {
            const rawTarget = await getPageBySelector(operations, requester, selector)
            const targetPage = parsePage(rawTarget, false)
            return targetPage.locale === selector.locale && targetPage.path === selector.path && withinPageScope(scope, targetPage) ? target : null
          } catch (error: unknown) {
            if (pageUnavailable(error)) return null
            throw error
          }
        })
      )
      inScope = admittedTargets.filter((target): target is string => target !== null)
    }
    const links = inScope.slice(0, input.limit).map(target => ({
      label: target,
      target,
      kind: 'page' as const
    }))
    return { links, truncated: inScope.length > links.length }
  })

  kernel.register('pages.related', async (rawInput, context) => {
    const input = rawInput as RelatedInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const scope = hostPageScope(context.knowledgeContext)
    const { page: root } = await readPageWithinScope(operations, requester, { id: input.pageId }, scope, false)
    const requesterScope = relatedRequesterScope(context.authority)
    const expectedMaxDepth = input.maxDepth ?? null
    const fingerprint = scopeFingerprint(scope, dependencies.snapshotSigningSecret)
    const cursor = input.cursor === null ? null : readRelatedCursor(input.cursor, dependencies.snapshotSigningSecret)
    if (
      cursor &&
      (cursor.requesterScope !== requesterScope || cursor.scopeFingerprint !== fingerprint || cursor.pageId !== root.id || cursor.maxDepth !== expectedMaxDepth)
    )
      return invalidRelatedCursor()
    const response = RelatedResponseSchema.safeParse(
      await operations.listRelated({
        pageId: root.id,
        limit: input.limit,
        offset: cursor?.offset ?? 0,
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        ...(scope === undefined ? {} : { agentScope: scope }),
        requester
      })
    )
    if (!response.success) throw operationFailure('Related pages operation returned an invalid result')
    if (response.data.truncated !== (response.data.nextOffset !== null))
      throw operationFailure('Related pages operation returned inconsistent continuation state')

    const candidates = response.data.pages.map(listed => ({ listed, page: parsePage(listed, false) }))
    const verifyViaPages = scope?.kind === 'locale' || scope?.kind === 'section'
    const viaPageIds = [
      ...new Set(
        candidates
          .filter(candidate => withinPageScope(scope, candidate.page))
          .map(candidate => candidate.listed.viaPageId)
          .filter(id => id !== root.id && verifyViaPages)
      )
    ]
    const viaPages = new Map<number, ParsedPage>([[root.id, root]])
    if (viaPageIds.length > 0) {
      const loadedViaPages = await Promise.all(
        viaPageIds.map(async id => {
          try {
            const value = await operations.get({ id, requester })
            const page = parsePage(value, false)
            return page.id === id && withinPageScope(scope, page) ? ([id, page] as const) : null
          } catch (error: unknown) {
            if (pageUnavailable(error)) return null
            throw error
          }
        })
      )
      for (const page of loadedViaPages) if (page !== null) viaPages.set(page[0], page[1])
    }
    const pages = (
      await Promise.all(
        candidates.map(async ({ listed, page: candidate }) => {
          if (
            !withinPageScope(scope, candidate) ||
            (scope?.kind === 'selected' && !scope.pageIds.includes(listed.viaPageId)) ||
            (verifyViaPages && !viaPages.has(listed.viaPageId))
          )
            return null
          try {
            const rawPage = await operations.get({ id: candidate.id, requester })
            const page = parsePage(rawPage, false)
            const candidateVisibility = listed.visibility === 'private' ? 'private' : 'public'
            const visibility =
              rawPage !== null && typeof rawPage === 'object' && 'visibility' in rawPage && rawPage.visibility === 'private' ? 'private' : 'public'
            if (
              page.id !== candidate.id ||
              page.sourceRevision !== candidate.sourceRevision ||
              page.locale !== candidate.locale ||
              page.path !== candidate.path ||
              !withinPageScope(scope, page) ||
              visibility !== candidateVisibility
            )
              return null
            return {
              ...page,
              tags: normalizedPageTags(rawPage !== null && typeof rawPage === 'object' && 'tags' in rawPage ? rawPage.tags : undefined),
              distance: listed.distance,
              direction: listed.direction,
              viaPageId: listed.viaPageId
            }
          } catch (error: unknown) {
            if (pageUnavailable(error)) return null
            throw error
          }
        })
      )
    ).filter(page => page !== null)
    const everyCandidateVerified = pages.length === response.data.pages.length
    const knowledge = dependencies.knowledge
      ? await dependencies.knowledge.getCurrentMany(pages.map(page => page.id))
      : new Map<number, KnowledgeProjectionView>()
    return {
      pages: pages.map(page => {
        const projection = knowledge.get(page.id)
        return { ...page, knowledge: projection?.sourceRevision === page.sourceRevision ? projection : null }
      }),
      nextCursor:
        response.data.nextOffset === null || !everyCandidateVerified
          ? null
          : issueRelatedCursor(
              {
                version: 2,
                requesterScope,
                scopeFingerprint: fingerprint,
                pageId: root.id,
                maxDepth: expectedMaxDepth,
                offset: response.data.nextOffset
              },
              dependencies.snapshotSigningSecret
            )
    }
  })
}
const PAGE_EVIDENCE_ACTIONS: Readonly<Partial<Record<AgentActionName, true>>> = {
  'pages.search': true,
  'pages.discover': true,
  'pages.get': true,
  'pages.getOkf': true,
  'pages.readForPatch': true,
  'pages.listRecent': true,
  'pages.listHistory': true,
  'pages.getVersion': true,
  'pages.related': true,
  'pages.applyProposal': true
}

const validationRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const sameCanonicalValue = (left: unknown, right: unknown): boolean => {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

const hasCanonicalFields = (candidate: Record<string, unknown>, expected: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean =>
  fields.every(field => Object.hasOwn(candidate, field) && sameCanonicalValue(candidate[field], expected[field]))

const normalizedDate = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return typeof value === 'string' ? value : null
}

const expectedPageFields = (page: ParsedPage, knowledge: KnowledgeProjectionView | null): Record<string, unknown> => ({
  id: page.id,
  locale: page.locale,
  path: page.path,
  title: page.title,
  description: page.description,
  contentType: page.contentType,
  sourceRevision: page.sourceRevision,
  authority: page.authority,
  okfResourceUri: page.okfResourceUri,
  citation: page.citation,
  knowledge
})

const isExpectedEvidenceRejection = (error: unknown): boolean => {
  if (pageUnavailable(error)) return true
  if (error instanceof ActionKernelError && error.code === 'INVALID_PAGE_RESULT') return true
  if (error instanceof Error && /(Forbidden|NotFound|Locked)/u.test(error.name)) return true
  if (typeof error === 'object' && error !== null) {
    const status = Reflect.get(error, 'status')
    return Number.isInteger(status) && Number(status) >= 400 && Number(status) < 500
  }
  return false
}

const versionIdentityMatches = (value: unknown, versionId: number): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const parsed = z.coerce.number().int().positive().safeParse(Reflect.get(value, 'versionId'))
  return parsed.success && parsed.data === versionId
}

export const createPageEvidenceValidator = (
  dependencies: PageReadActionDependencies
): ((
  authority: ActionAuthority,
  knowledgeContext: AgentKnowledgeContext | undefined,
  actionName: AgentActionName,
  output: unknown,
  signal: AbortSignal
) => Promise<boolean>) => {
  return async (authority, knowledgeContext, actionName, output, signal) => {
    if (signal.aborted) return false
    if (!PAGE_EVIDENCE_ACTIONS[actionName]) return true
    const parsedOutput = actionDefinition(actionName).output.safeParse(output)
    if (!parsedOutput.success) return false
    const result = validationRecord(parsedOutput.data)
    if (!result) return false

    const scope = hostPageScope(knowledgeContext)
    try {
      if (signal.aborted) return false
      const requester = await requesterFor(dependencies.resolveRequester, authority)
      if (signal.aborted) return false
      const readCurrent = async (pageId: number, includeContent: boolean): Promise<{ readonly rawPage: unknown; readonly page: ParsedPage } | null> => {
        if (signal.aborted) return null
        const current = await readPageWithinScope(dependencies.operations, requester, { id: pageId }, scope, includeContent)
        return signal.aborted ? null : current
      }
      const knowledgeForCurrent = async (page: ParsedPage): Promise<KnowledgeProjectionView | null> => {
        const projection = await dependencies.knowledge?.getCurrent(page.id)
        return projection?.sourceRevision === page.sourceRevision ? projection : null
      }
      const knowledgeForVersion = async (page: ParsedPage): Promise<KnowledgeProjectionView | null> => {
        const projection = await dependencies.knowledge?.getRevision(page.id, page.sourceRevision)
        return projection?.sourceRevision === page.sourceRevision ? projection : null
      }
      const samePageSummary = (
        candidate: Record<string, unknown>,
        rawPage: unknown,
        page: ParsedPage,
        knowledge: KnowledgeProjectionView | null,
        includeUpdatedAt: boolean
      ): boolean => {
        const expected = expectedPageFields(page, knowledge)
        const fields = ['id', 'locale', 'path', 'title', 'description', 'contentType', 'sourceRevision', 'authority', 'okfResourceUri', 'citation', 'knowledge']
        if (!hasCanonicalFields(candidate, expected, fields)) return false
        const raw = validationRecord(rawPage)
        if (!raw) return false
        if (Object.hasOwn(candidate, 'tags') && !sameCanonicalValue(candidate.tags, normalizedPageTags(raw.tags))) return false
        if (includeUpdatedAt) {
          const updatedAt = normalizedDate(raw.updatedAt)
          if (updatedAt === null || !sameCanonicalValue(candidate.updatedAt, updatedAt)) return false
        }
        return true
      }

      if (actionName === 'pages.get') {
        const id = result.id
        if (typeof id !== 'number') return false
        const current = await readCurrent(id, true)
        if (!current || current.page.content === undefined || current.page.updatedAt === undefined) return false
        const knowledge = await knowledgeForCurrent(current.page)
        if (signal.aborted) return false
        const expected = {
          ...expectedPageFields(current.page, knowledge),
          content: current.page.content,
          updatedAt: normalizedDate(current.page.updatedAt),
          citationSections: current.page.citationSections ?? []
        }
        return hasCanonicalFields(result, expected, Object.keys(expected))
      }

      if (actionName === 'pages.getVersion') {
        const pageId = result.id
        const versionId = result.versionId
        if (typeof pageId !== 'number' || typeof versionId !== 'number') return false
        if (!(await readCurrent(pageId, false))) return false
        const rawVersion = await dependencies.operations.getVersion({ pageId, versionId, requester })
        if (signal.aborted || !rawVersion || !versionIdentityMatches(rawVersion, versionId)) return false
        const page = parsePage(rawVersion, true, versionId)
        if (page.id !== pageId || !withinPageScope(scope, page) || page.content === undefined || page.updatedAt === undefined) return false
        const versionDate = normalizedDate(validationRecord(rawVersion)?.versionDate)
        if (versionDate === null) return false
        const knowledge = await knowledgeForVersion(page)
        if (signal.aborted) return false
        const expected = {
          ...expectedPageFields(page, knowledge),
          content: page.content,
          updatedAt: normalizedDate(page.updatedAt),
          citationSections: page.citationSections ?? [],
          versionId,
          versionDate
        }
        return hasCanonicalFields(result, expected, Object.keys(expected))
      }

      if (actionName === 'pages.getOkf') {
        const pageId = result.pageId
        const versionId = result.versionId
        if (typeof pageId !== 'number' || (versionId !== null && typeof versionId !== 'number')) return false
        let rawPage: unknown
        let page: ParsedPage
        if (versionId === null) {
          const current = await readCurrent(pageId, true)
          if (!current) return false
          rawPage = current.rawPage
          page = current.page
        } else {
          if (!(await readCurrent(pageId, false))) return false
          rawPage = await dependencies.operations.getVersion({ pageId, versionId, requester })
          if (signal.aborted || !rawPage || !versionIdentityMatches(rawPage, versionId)) return false
          page = parsePage(rawPage, true, versionId)
          if (page.id !== pageId || !withinPageScope(scope, page)) return false
        }
        if (signal.aborted || page.contentType !== 'markdown' || page.content === undefined || page.authority.state !== 'valid') return false
        const raw = validationRecord(rawPage)
        if (!raw) return false
        const projection = versionId === null ? await knowledgeForCurrent(page) : await knowledgeForVersion(page)
        if (signal.aborted) return false
        let expected: CanonicalOkfPageDocument
        try {
          expected = serializeCanonicalOkfPage({
            pageId: page.id,
            versionId,
            sourceRevision: page.sourceRevision,
            locale: page.locale,
            path: page.path,
            title: page.title,
            description: page.description,
            tags: normalizedPageTags(raw.tags),
            visibility: raw.visibility === 'private' ? 'private' : 'public',
            content: page.content,
            authority: page.authority,
            knowledge: projection
          })
        } catch {
          return false
        }
        return sameCanonicalValue(result, expected)
      }

      if (actionName === 'pages.listRecent') {
        const pages = result.pages
        if (!Array.isArray(pages)) return false
        for (const candidateValue of pages) {
          if (signal.aborted) return false
          const candidate = validationRecord(candidateValue)
          if (!candidate || typeof candidate.id !== 'number') return false
          const current = await readCurrent(candidate.id, true)
          if (!current || current.page.content === undefined || current.page.updatedAt === undefined) return false
          const page = current.page
          const raw = validationRecord(current.rawPage)
          if (!raw) return false
          const content = page.content
          if (content === undefined) return false
          const excerpt = candidate.content
          const updatedAt = normalizedDate(page.updatedAt)
          if (
            updatedAt === null ||
            page.id !== candidate.id ||
            !sameCanonicalValue(candidate.locale, page.locale) ||
            !sameCanonicalValue(candidate.path, page.path) ||
            !sameCanonicalValue(candidate.title, page.title) ||
            !sameCanonicalValue(candidate.contentType, page.contentType) ||
            !sameCanonicalValue(candidate.sourceRevision, page.sourceRevision) ||
            !sameCanonicalValue(candidate.updatedAt, updatedAt) ||
            typeof excerpt !== 'string' ||
            candidate.sourceContentCharacters !== content.length ||
            !content.startsWith(excerpt) ||
            candidate.contentTruncated !== (excerpt !== content) ||
            !sameCanonicalValue(candidate.citation, page.citation) ||
            (raw.visibility === 'private') !== page.citation.href.startsWith('/_private/')
          )
            return false
        }
        return !signal.aborted
      }

      if (actionName === 'pages.readForPatch') {
        const snapshotPage = validationRecord(result.page)
        const revision = validationRecord(result.revision)
        if (!snapshotPage || !revision || typeof snapshotPage.id !== 'number') return false
        const current = await readCurrent(snapshotPage.id, true)
        if (!current || current.page.contentType !== 'markdown' || current.page.content === undefined) return false
        const source = validateWikiMarkdownSource(current.page.content)
        const token = inspectWikiLineSnapshotToken(String(result.snapshotToken), dependencies.snapshotSigningSecret, snapshotRequesterScope(authority))
        if (
          signal.aborted ||
          token.pageId !== current.page.id ||
          token.sourceRevision !== current.page.sourceRevision ||
          snapshotPage.id !== current.page.id ||
          snapshotPage.locale !== current.page.locale ||
          snapshotPage.path !== current.page.path ||
          snapshotPage.contentType !== 'markdown' ||
          revision.sourceRevision !== current.page.sourceRevision ||
          revision.rawSha256 !== source.rawSha256 ||
          revision.canonicalSha256 !== source.canonicalSha256 ||
          result.documentTag !== source.documentTag ||
          result.lineEnding !== source.lineEnding ||
          result.finalNewline !== source.finalNewline
        )
          return false
        if (typeof result.expiresAt !== 'string') return false
        const expiry = Date.parse(result.expiresAt)
        const now = Date.now()
        if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 15 * 60_000) return false
        if (!Array.isArray(result.disclosed) || !Array.isArray(result.warnings)) return false
        const disclosed: Array<Record<string, unknown>> = []
        let previousEnd = 0
        for (const rangeValue of result.disclosed) {
          const range = validationRecord(rangeValue)
          if (
            !range ||
            typeof range.startLine !== 'number' ||
            typeof range.endLine !== 'number' ||
            (previousEnd > 0 && range.startLine <= previousEnd + 1) ||
            range.endLine < range.startLine ||
            range.endLine > source.lines.length
          )
            return false
          const lines = []
          for (let number = range.startLine; number <= range.endLine; number += 1) {
            const text = source.lines[number - 1]
            if (text === undefined) return false
            const tag = createHash('sha256').update(`${source.documentTag}\0${number}\0${text}`).digest('hex').slice(0, 12)
            lines.push({ number, tag, text })
          }
          disclosed.push({ startLine: range.startLine, endLine: range.endLine, lines })
          previousEnd = range.endLine
        }
        const expectedWarnings = source.warnings.filter(warning =>
          disclosed.some(range => warning.line >= Number(range.startLine) && warning.line <= Number(range.endLine))
        )
        return sameCanonicalValue(result.disclosed, disclosed) && sameCanonicalValue(result.warnings, expectedWarnings) && !signal.aborted
      }

      if (actionName === 'pages.listHistory') {
        const versions = result.versions
        if (!Array.isArray(versions)) return false
        if (versions.length === 0) return !signal.aborted
        const first = validationRecord(versions[0])
        const uri =
          typeof first?.resourceUri === 'string'
            ? /^wiki:\/\/pages\/([1-9][0-9]*)\/versions\/([1-9][0-9]*)\/revisions\/([1-9][0-9]*)\/okf$/u.exec(first.resourceUri)
            : null
        if (!uri) return false
        const pageId = Number(uri[1])
        if (!Number.isSafeInteger(pageId) || !(await readCurrent(pageId, false))) return false
        const history = HistorySchema.safeParse(await dependencies.operations.getHistory({ id: pageId, offsetPage: 0, offsetSize: versions.length, requester }))
        if (signal.aborted || !history.success) return false
        const expected = history.data.trail.slice(0, versions.length).map(version => ({
          id: version.versionId,
          sourceRevision: String(version.sourceRevision),
          resourceUri: okfResourceUri(pageId, version.versionId, version.sourceRevision),
          action: version.actionType,
          versionDate: normalizedDate(version.versionDate),
          authorName: version.authorName
        }))
        return expected.length === versions.length && sameCanonicalValue(versions, expected)
      }

      if (actionName === 'pages.applyProposal') {
        const pageValue = result.page
        if (pageValue === null) return !signal.aborted
        const candidate = validationRecord(pageValue)
        if (!candidate || typeof candidate.id !== 'number') return false
        const current = await readCurrent(candidate.id, false)
        if (!current) return false
        const expected = {
          id: current.page.id,
          locale: current.page.locale,
          path: current.page.path,
          title: current.page.title,
          description: current.page.description,
          contentType: current.page.contentType,
          sourceRevision: current.page.sourceRevision,
          knowledge: null
        }
        return hasCanonicalFields(candidate, expected, Object.keys(expected)) && !signal.aborted
      }

      if (actionName === 'pages.search' || actionName === 'pages.discover' || actionName === 'pages.related') {
        const pageValues = actionName === 'pages.search' ? result.results : result.pages
        if (!Array.isArray(pageValues)) return false
        const candidates: Array<{ readonly value: Record<string, unknown>; readonly id: number }> = []
        const relatedCandidateIds = new Set<number>()
        const viaPageIds = new Set<number>()
        for (const pageValue of pageValues) {
          const candidate = validationRecord(pageValue)
          if (!candidate || typeof candidate.id !== 'number') return false
          candidates.push({ value: candidate, id: candidate.id })
          relatedCandidateIds.add(candidate.id)
          if (actionName === 'pages.related') {
            if (typeof candidate.viaPageId !== 'number') return false
            viaPageIds.add(candidate.viaPageId)
          }
        }
        const missingViaPageIds = [...viaPageIds].filter(pageId => !relatedCandidateIds.has(pageId))
        const currentPages = await Promise.all(
          candidates.map(async candidate => {
            if (signal.aborted) return null
            try {
              return await readCurrent(candidate.id, false)
            } catch (error: unknown) {
              if (isExpectedEvidenceRejection(error)) return null
              throw error
            }
          })
        )
        const viaPages = await Promise.all(missingViaPageIds.map(pageId => readCurrent(pageId, false)))
        if (signal.aborted || viaPages.some(page => page === null)) return false
        if (signal.aborted || currentPages.some(current => current === null)) return false
        const authorizedPages = currentPages.filter((current): current is { readonly rawPage: unknown; readonly page: ParsedPage } => current !== null)
        const currentKnowledge = dependencies.knowledge
          ? await dependencies.knowledge.getCurrentMany(authorizedPages.map(current => current.page.id))
          : new Map<number, KnowledgeProjectionView>()
        if (signal.aborted) return false
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]
          const current = authorizedPages[index]
          if (!candidate || !current) return false
          const projection = currentKnowledge.get(current.page.id)
          const knowledge = projection?.sourceRevision === current.page.sourceRevision ? projection : null
          if (!samePageSummary(candidate.value, current.rawPage, current.page, knowledge, actionName === 'pages.discover')) return false
        }
        if (actionName === 'pages.related' && result.nextCursor !== null) {
          if (typeof result.nextCursor !== 'string') return false
          const cursor = readRelatedCursor(result.nextCursor, dependencies.snapshotSigningSecret)
          if (
            cursor.requesterScope !== relatedRequesterScope(authority) ||
            cursor.scopeFingerprint !== scopeFingerprint(scope, dependencies.snapshotSigningSecret)
          )
            return false
          if (!(await readCurrent(cursor.pageId, false))) return false
        }
        return !signal.aborted
      }

      return false
    } catch (error: unknown) {
      if (signal.aborted || isExpectedEvidenceRejection(error)) return false
      throw error
    }
  }
}

export const registerWikiPageReadActions = async (
  kernel: ActionKernel,
  resolveRequester: PageReadActionDependencies['resolveRequester'],
  snapshotSigningSecret: Uint8Array
): Promise<void> => {
  const operations = (await import('../../operations/pages.ts')).default
  registerPageReadActions(kernel, { operations, resolveRequester, snapshotSigningSecret })
}

export const authorityAuthContext = (authority: ActionAuthority, principal: Express.User): RequestAuthContext<Express.User> => {
  if (authority.requester.kind === 'user') {
    return { kind: 'user', userId: authority.requester.userId, ownershipUserId: authority.requester.userId, principal }
  }
  return {
    kind: 'apiKey',
    apiKeyId: authority.requester.apiKeyId,
    groupId: authority.requester.groupId,
    ownershipUserId: null,
    principal
  }
}
