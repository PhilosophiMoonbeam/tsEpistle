import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'
import type { DiscussionWorkspace, DiscussionPolicySnapshot, DiscussionProviderSettings, ModerationInspection, ModerationInventory, PageDiscussionPolicy, DiscussionPage } from '../../shared/discussion-policy.ts'
import { PageRatingModeSchema, type PageRatingMode } from '../../shared/page-ratings.ts'
export interface ClosedDiscussionInventory { items: Array<{ page: DiscussionPage; updatedAt: string }>; total: number; limit: number; offset: number }
const request = async <T,>(path: string, validate: (value: unknown) => boolean, method = 'GET', body?: unknown): Promise<T> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/comments/' + path, { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const payload: unknown = await response.json()
  if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'Discussion request failed. Try again.')
  if (!validate(payload)) throw new Error('Discussion response is invalid. Reload before retrying.')
  return payload as T
}
const snapshot = (value: unknown) => isRecord(value) && typeof value.fingerprint === 'string' && typeof value.enabled === 'boolean' && typeof value.pageRatingsEnabled === 'boolean' && PageRatingModeSchema.safeParse(value.pageRatingsMode).success && Array.isArray(value.providers) && value.providers.every(row => isRecord(row) && typeof row.key === 'string' && typeof row.isEnabled === 'boolean' && isRecord(row.config) && isRecord(row.props))
const inventory = (value: unknown) => isRecord(value) && Array.isArray(value.items) && typeof value.total === 'number' && typeof value.limit === 'number' && typeof value.offset === 'number'
const inspection = (value: unknown) => isRecord(value) && typeof value.id === 'number' && typeof value.content === 'string' && typeof value.fingerprint === 'string' && typeof value.isHidden === 'boolean' && isRecord(value.page) && Array.isArray(value.history)
const policy = (value: unknown) => isRecord(value) && typeof value.closed === 'boolean' && typeof value.fingerprint === 'string' && isRecord(value.page) && Array.isArray(value.history)
export const fetchDiscussionWorkspace = () => request<DiscussionWorkspace>('workspace', value => snapshot(value) && isRecord(value) && isRecord(value.counts) && isRecord(value.runtime))
export const saveDiscussionWorkspace = (enabled: boolean, providers: DiscussionProviderSettings[], fingerprint: string, pageRatingsMode: PageRatingMode) => request<DiscussionPolicySnapshot & { warnings: string[] }>('workspace', snapshot, 'PUT', { enabled, providers, fingerprint, pageRatingsMode })
export const fetchDiscussionInventory = (params: URLSearchParams) => request<ModerationInventory>('moderation?' + params, inventory)
export const inspectDiscussion = (id: number) => request<ModerationInspection>('moderation/' + id, inspection)
export const moderateDiscussion = (id: number, hidden: boolean, reason: string, fingerprint: string) => request<ModerationInspection>('moderation/' + id, inspection, 'PATCH', { hidden, reason, fingerprint })
export const fetchClosedDiscussions = (params: URLSearchParams) => request<ClosedDiscussionInventory>('closed-pages?' + params, inventory)
export const fetchPageDiscussionPolicy = (id: number) => request<PageDiscussionPolicy>('page-policy/' + id, policy)
export const savePageDiscussionPolicy = (id: number, closed: boolean, reason: string, fingerprint: string) => request<PageDiscussionPolicy>('page-policy/' + id, policy, 'PATCH', { closed, reason, fingerprint })
