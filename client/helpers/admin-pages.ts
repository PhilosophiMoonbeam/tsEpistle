import { fetchPage, type PageDetails, type PageListRow } from './pages-api'
import { sameOriginJsonFetch } from './json-transport'

export type PublicationState = 'Unavailable' | 'Draft' | 'Scheduled' | 'Window ended' | 'Published' | 'Enabled' | 'Invalid schedule'
export function publicationState(page: Pick<PageListRow, 'isPublished' | 'publishStartDate' | 'publishEndDate'>, now = Date.now()): PublicationState {
  if (page.isPublished === undefined) return 'Unavailable'
  if (page.isPublished === false) return 'Draft'
  if (page.publishStartDate === undefined || page.publishEndDate === undefined) return 'Enabled'
  const start = page.publishStartDate ? Date.parse(page.publishStartDate) : null
  const end = page.publishEndDate ? Date.parse(page.publishEndDate) : null
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end)) || (start !== null && end !== null && end <= start))
    return 'Invalid schedule'
  if (end !== null && end < now) return 'Window ended'
  if (start !== null && start > now) return 'Scheduled'
  return 'Published'
}
export const pageHref = (page: Pick<PageListRow, 'visibility' | 'locale' | 'path'>, prefix = ''): string =>
  `${prefix}${page.visibility === 'private' ? '/_private' : ''}/${encodeURIComponent(page.locale)}/${page.path.split('/').map(encodeURIComponent).join('/')}`
export type PublicationInput = { isPublished: boolean; publishStartDate?: string | null; publishEndDate?: string | null }
export async function savePublication(id: number, revision: string, input: PublicationInput): Promise<void> {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), `/_api/pages/${id}/publication`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, expectedSourceRevision: revision })
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload?.error || 'Publication update failed. Reload the page before trying again.')
}
export type PublicationReview = {
  id: number
  title: string
  page: PageDetails | null
  status: 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'unchanged'
  error: string
}
export async function inspectPublication(row: PublicationReview): Promise<void> {
  row.status = 'loading'
  row.error = ''
  row.page = null
  try {
    row.page = await fetchPage(window.fetch.bind(window), row.id)
    row.title = row.page.title || row.page.path
    row.status = 'ready'
  } catch (error) {
    row.status = 'error'
    row.error = error instanceof Error ? error.message : 'Unable to review this page.'
  }
}
export async function applyPublication(row: PublicationReview, enabled: boolean): Promise<void> {
  if (row.status !== 'ready' || !row.page) return
  if (!row.page.capabilities?.viewStewardContacts || row.page.isPublished === undefined || row.page.publishStartDate === undefined || row.page.publishEndDate === undefined) {
    row.status = 'error'
    row.error = 'Publication controls are unavailable for this page.'
    return
  }
  if (row.page.isPublished === enabled) {
    row.status = 'unchanged'
    return
  }
  row.status = 'saving'
  row.error = ''
  try {
    await savePublication(row.id, row.page.sourceRevision, { isPublished: enabled })
    row.status = 'saved'
  } catch (error) {
    row.status = 'error'
    row.error = error instanceof Error ? error.message : 'Publication update failed.'
  }
}

export async function transferPageOwner(id: number, revision: string, ownerId: number): Promise<void> {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), `/_api/pages/${id}/owner`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, expectedSourceRevision: revision })
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload?.error || 'Ownership transfer failed. Review the current page and try again.')
}
