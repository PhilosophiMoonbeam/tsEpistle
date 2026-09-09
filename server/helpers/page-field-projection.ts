import { canViewStewardContacts, pageAuthorizationContext, type PagePrincipal, type PageVisibilityRecord } from './page-access.ts'
import type { PageRuleAuthority } from './group-access.ts'

/**
 * Page response properties that disclose publication or human attribution
 * metadata. They are returned only to an effective writer for the complete
 * current page authorization context.
 */
export const RESTRICTED_PAGE_FIELDS = [
  'isPublished',
  'publishStartDate',
  'publishEndDate',
  'editor',
  'editorKey',
  'authorId',
  'authorName',
  'authorEmail',
  'creatorId',
  'creatorName',
  'creatorEmail'
] as const

export type RestrictedPageField = (typeof RESTRICTED_PAGE_FIELDS)[number]

export interface RestrictedPageFieldAuthorizationInput {
  requester: PagePrincipal | undefined
  page: unknown
  authority: PageRuleAuthority
}

export interface PageFieldProjectionInput<T> extends RestrictedPageFieldAuthorizationInput {
  value: T
}


/**
 * Return whether the requester may receive publication/editor/attribution
 * fields for this page. Missing or malformed page context is never treated as
 * an untagged page and therefore always denies the projection.
 */
export const canViewRestrictedPageFields = ({ requester, page, authority }: RestrictedPageFieldAuthorizationInput): boolean => {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) return false
  const authorization = pageAuthorizationContext(page as unknown as PageVisibilityRecord)
  return authorization !== null && canViewStewardContacts(requester, authorization, authority)
}

/**
 * Project a response object without mutating the source. GraphQL uses the
 * predicate directly because selected fields must retain its null/error
 * semantics; REST transports use this projection to omit withheld keys.
 */
export const projectPageFields = <T>({ requester, page, authority, value }: PageFieldProjectionInput<T>): T => {
  if (
    canViewRestrictedPageFields({ requester, page, authority }) ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  )
    return value
  const projected = { ...(value as Record<string, unknown>) }
  for (const field of RESTRICTED_PAGE_FIELDS) delete projected[field]
  return projected as T
}

export const isRestrictedPageField = (field: string): field is RestrictedPageField =>
  (RESTRICTED_PAGE_FIELDS as readonly string[]).includes(field)
