import { fetchMentionCandidates } from './comments-api'
import { searchUsers } from './users-api'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export type ApprovalReviewerOption = {
  id: number
  label: string
  source: 'directory' | 'discussion' | 'manual'
}

// Global permissions that unlock the account directory search endpoint.
export const REVIEWER_DIRECTORY_PERMISSIONS = ['write:groups', 'manage:groups', 'write:users', 'manage:users', 'manage:system'] as const

export const canSearchReviewerDirectory = (permissions: readonly string[]): boolean =>
  permissions.some(permission => (REVIEWER_DIRECTORY_PERMISSIONS as readonly string[]).includes(permission))

const MANUAL_ID = /^#?(\d{1,12})$/

/** A typed user ID stays available as an explicit choice; the server validates eligibility. */
export const manualReviewerId = (query: string): number | null => {
  const match = MANUAL_ID.exec(query.trim())
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export type ReviewerSearchInput = {
  fetchImpl: FetchImpl
  pageId: number
  query: string
  directory: boolean
}

/**
 * Finds reviewer candidates without new server authority: account-directory
 * search for user administrators, otherwise people who joined this page's
 * discussion (handle prefix). Never throws for an empty or numeric query.
 */
export async function searchApprovalReviewers ({ fetchImpl, pageId, query, directory }: ReviewerSearchInput): Promise<ApprovalReviewerOption[]> {
  const trimmed = query.trim().replace(/^@/, '')
  if (trimmed.length < 2 || manualReviewerId(trimmed) !== null) return []
  if (directory) {
    const rows = await searchUsers(fetchImpl, trimmed)
    return rows.map(row => ({ id: row.id, label: row.name, source: 'directory' as const }))
  }
  if (!/^[a-z0-9_-]{2,32}$/i.test(trimmed)) return []
  const rows = await fetchMentionCandidates(fetchImpl, pageId, trimmed.toLowerCase())
  return rows.map(row => ({ id: row.id, label: `${row.name} (@${row.handle})`, source: 'discussion' as const }))
}
