import type { WikiAuth } from '../controllers/_types.ts'
import { pageRuleAuthorityMatchesRequester, type PageRuleAuthority } from './group-access.ts'

const getWikiAuth = (): WikiAuth => WIKI.auth as WikiAuth

export type PagePrincipal = Parameters<WikiAuth['checkAccess']>[0]

export type PageVisibility = 'public' | 'private'

export interface PageAuthorizationTag {
  tag: string
}

/**
 * The only page shape that may be used for page-rule authorization.
 *
 * `tags` is deliberately required here. A caller that has not loaded the
 * complete relation must not accidentally turn an unknown tag set into an
 * untagged page; callers should treat a `null` projection as unavailable
 * authority and fail closed.
 */
export interface PageAuthorizationContext {
  path: string
  locale: string
  localeCode: string
  visibility: PageVisibility
  ownerId: number | null
  tags: PageAuthorizationTag[]
}

export interface PageVisibilityRecord {
  visibility: PageVisibility
  ownerId: number | null
  path: string
  localeCode?: string
  locale?: string
  tags?: unknown
}

const normalizedTagName = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value : value !== null && typeof value === 'object' ? Reflect.get(value, 'tag') : undefined
  if (typeof raw !== 'string') return null
  const tag = raw.trim().toLowerCase()
  return tag.length > 0 ? tag : null
}

/**
 * Convert a page row/list/detail projection to one complete authorization
 * context. `null` means that the caller did not provide enough information
 * to make a safe page-rule decision.
 */
export const pageAuthorizationContext = (page: PageVisibilityRecord): PageAuthorizationContext | null => {
  const locale = typeof page.localeCode === 'string' ? page.localeCode : typeof page.locale === 'string' ? page.locale : null
  if (
    typeof page.path !== 'string' ||
    page.path.length === 0 ||
    locale === null ||
    (page.visibility !== 'public' && page.visibility !== 'private') ||
    (page.ownerId !== null && (!Number.isSafeInteger(page.ownerId) || page.ownerId < 1)) ||
    !Array.isArray(page.tags)
  ) {
    return null
  }
  const tags: PageAuthorizationTag[] = []
  const seen = new Set<string>()
  for (const value of page.tags) {
    const tag = normalizedTagName(value)
    if (tag === null) return null
    if (!seen.has(tag)) {
      seen.add(tag)
      tags.push({ tag })
    }
  }
  return {
    path: page.path,
    locale,
    localeCode: locale,
    visibility: page.visibility,
    ownerId: page.ownerId,
    tags
  }
}

interface VisibilityQuery {
  where(column: string, value: unknown): VisibilityQuery
  where(callback: (builder: VisibilityQuery) => void): VisibilityQuery
  orWhere(criteria: Record<string, unknown>): VisibilityQuery
}

interface ScopeOptions {
  table?: string
  includeAllForSystemManager?: boolean
}

const column = (table: string | undefined, name: string): string => (table ? `${table}.${name}` : name)
const compilePageRuleRegex = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

export const isValidPageRuleRegex = (pattern: string): boolean => compilePageRuleRegex(pattern) !== null

export const pageRuleRegexMatches = (pattern: string, path: string): boolean => compilePageRuleRegex(pattern)?.test(path) ?? false

export const principalId = (user: PagePrincipal): number | null => {
  if (user && Object.hasOwn(user, 'ownershipUserId')) {
    const ownershipUserId = user.ownershipUserId
    return typeof ownershipUserId === 'number' && Number.isSafeInteger(ownershipUserId) && ownershipUserId > 0 ? ownershipUserId : null
  }
  const id = user && typeof user.id === 'number' && Number.isSafeInteger(user.id) ? user.id : null
  return id !== null && id > 0 && id !== 2 ? id : null
}

export const managesSystem = (user: PagePrincipal): boolean => getWikiAuth().checkAccess(user, ['manage:system'])

export const ownsPrivatePage = (user: PagePrincipal, page: Pick<PageVisibilityRecord, 'visibility' | 'ownerId'>): boolean =>
  page.visibility === 'private' && principalId(user) === page.ownerId

export const canReadPage = (user: PagePrincipal, page: PageVisibilityRecord, authority: PageRuleAuthority): boolean => {
  if (!pageRuleAuthorityMatchesRequester(user, authority)) return false
  if (page.visibility === 'private') return ownsPrivatePage(user, page) || managesSystem(user)
  const context = pageAuthorizationContext(page)
  return context !== null && getWikiAuth().checkPageAccess(user, ['read:pages'], context, authority)
}

export const canWritePage = (user: PagePrincipal, page: PageVisibilityRecord, authority: PageRuleAuthority): boolean => {
  if (!pageRuleAuthorityMatchesRequester(user, authority)) return false
  if (page.visibility === 'private') return ownsPrivatePage(user, page) || managesSystem(user)
  const context = pageAuthorizationContext(page)
  return context !== null && getWikiAuth().checkPageAccess(user, ['write:pages', 'manage:pages', 'manage:system'], context, authority)
}

/**
 * Steward contacts are part of the restricted author/editor projection. They
 * are visible only to the same effective page writers (including the system
 * bypass), never merely to a global permission holder whose page rule denies
 * this canonical page.
 */
export const canViewStewardContacts = (user: PagePrincipal, page: PageVisibilityRecord, authority: PageRuleAuthority): boolean =>
  canWritePage(user, page, authority)

export const canDeletePage = (user: PagePrincipal, page: PageVisibilityRecord, authority: PageRuleAuthority): boolean => {
  if (!pageRuleAuthorityMatchesRequester(user, authority)) return false
  if (page.visibility === 'private') return ownsPrivatePage(user, page) || managesSystem(user)
  const context = pageAuthorizationContext(page)
  return context !== null && getWikiAuth().checkPageAccess(user, ['delete:pages', 'manage:system'], context, authority)
}

export const scopePageQueryForOwner = <T extends VisibilityQuery>(query: T, ownerId: number | null, options: Pick<ScopeOptions, 'table'> = {}): T => {
  query.where(builder => {
    builder.where(column(options.table, 'visibility'), 'public')
    if (ownerId !== null) {
      builder.orWhere({
        [column(options.table, 'visibility')]: 'private',
        [column(options.table, 'ownerId')]: ownerId
      })
    }
  })
  return query
}

export const scopePageQuery = <T extends VisibilityQuery>(query: T, user: PagePrincipal, options: ScopeOptions = {}): T => {
  if (options.includeAllForSystemManager && managesSystem(user)) return query
  return scopePageQueryForOwner(query, principalId(user), options)
}

export const pageRoute = (page: Pick<PageVisibilityRecord, 'visibility' | 'path' | 'localeCode'>): string =>
  `${page.visibility === 'private' ? '/_private' : ''}/${encodeURIComponent(page.localeCode ?? 'en')}/${page.path.split('/').map(encodeURIComponent).join('/')}`
