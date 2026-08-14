import { getWikiAuth, type WikiAuth } from '../controllers/_types.ts'

export type PagePrincipal = Parameters<WikiAuth['checkAccess']>[0]

export type PageVisibility = 'public' | 'private'

export interface PageVisibilityRecord {
  visibility: PageVisibility
  ownerId: number | null
  path: string
  localeCode?: string
  locale?: string
  tags?: unknown
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

const column = (table: string | undefined, name: string): string => table ? `${table}.${name}` : name

export const principalId = (user: PagePrincipal): number | null => {
  const id = user && typeof user.id === 'number' && Number.isSafeInteger(user.id) ? user.id : null
  return id !== null && id > 0 && id !== 2 ? id : null
}

export const managesSystem = (user: PagePrincipal): boolean =>
  getWikiAuth().checkAccess(user, ['manage:system'])

export const ownsPrivatePage = (user: PagePrincipal, page: Pick<PageVisibilityRecord, 'visibility' | 'ownerId'>): boolean =>
  page.visibility === 'private' && principalId(user) === page.ownerId

export const canReadPage = (user: PagePrincipal, page: PageVisibilityRecord): boolean => {
  if (page.visibility === 'private') return ownsPrivatePage(user, page) || managesSystem(user)
  return getWikiAuth().checkAccess(user, ['read:pages'], {
    path: page.path,
    locale: page.localeCode ?? page.locale,
    tags: page.tags
  })
}

export const canWritePage = (user: PagePrincipal, page: PageVisibilityRecord): boolean => {
  if (page.visibility === 'private') return ownsPrivatePage(user, page) || managesSystem(user)
  return getWikiAuth().checkAccess(user, ['write:pages', 'manage:pages', 'manage:system'], {
    path: page.path,
    locale: page.localeCode ?? page.locale,
    tags: page.tags
  })
}

export const canDeletePage = (user: PagePrincipal, page: PageVisibilityRecord): boolean => {
  if (page.visibility === 'private') return ownsPrivatePage(user, page) || managesSystem(user)
  return getWikiAuth().checkAccess(user, ['delete:pages', 'manage:system'], {
    path: page.path,
    locale: page.localeCode ?? page.locale,
    tags: page.tags
  })
}

export const scopePageQueryForOwner = <T extends VisibilityQuery>(
  query: T,
  ownerId: number | null,
  options: Pick<ScopeOptions, 'table'> = {}
): T => {
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
  page.visibility === 'private'
    ? `/_private/${page.localeCode ?? 'en'}/${page.path}`
    : `/${page.localeCode ?? 'en'}/${page.path}`
