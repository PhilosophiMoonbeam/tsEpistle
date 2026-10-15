import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'
import type { DiscussionAnnotation, DiscussionAnnotationAnchor, DiscussionPageAnnotations } from '../../shared/discussion-annotations.ts'

const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export function isDiscussionAnchor(value: unknown): value is DiscussionAnnotationAnchor {
  return (
    isRecord(value) &&
    typeof value.exact === 'string' &&
    value.exact.trim().length > 0 &&
    value.exact.length <= 1000 &&
    typeof value.prefix === 'string' &&
    value.prefix.length <= 64 &&
    typeof value.suffix === 'string' &&
    value.suffix.length <= 64 &&
    (value.heading === null || (typeof value.heading === 'string' && value.heading.length <= 255)) &&
    typeof value.offset === 'number' &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0
  )
}
export function isDiscussionAnnotation(value: unknown): value is DiscussionAnnotation {
  return (
    isRecord(value) &&
    id(value.id) &&
    id(value.commentId) &&
    id(value.revision) &&
    typeof value.position === 'number' &&
    Number.isInteger(value.position) &&
    value.position >= 0 &&
    value.position < 8 &&
    typeof value.note === 'string' &&
    value.note.length <= 5000 &&
    isDiscussionAnchor(value.anchor) &&
    (value.resolvedAt === null || typeof value.resolvedAt === 'string') &&
    (value.resolvedById === null || id(value.resolvedById)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}
async function request(path: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/comments/' + path, {
    method: body ? 'PATCH' : 'GET',
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload: unknown = await response.json()
  if (!response.ok)
    throw Object.assign(new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'Discussion request failed.'), {
      status: response.status
    })
  return payload
}
export async function fetchDiscussionPageAnnotations(pageId: number, after: number | null, signal?: AbortSignal): Promise<DiscussionPageAnnotations> {
  const value = await request(`annotations?pageId=${pageId}&limit=50${after === null ? '' : `&after=${after}`}`, signal)
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !value.items.every(isDiscussionAnnotation) ||
    !(value.nextAfter === null || (id(value.nextAfter) && value.nextAfter > (after ?? 0)))
  )
    throw new Error('Annotation response is invalid.')
  return { items: value.items, nextAfter: value.nextAfter }
}
export async function changeDiscussionAnnotation(
  commentId: number,
  annotationId: number,
  expectedRevision: number,
  resolved: boolean
): Promise<DiscussionAnnotation> {
  const value = await request(`${commentId}/annotations/${annotationId}`, undefined, { expectedRevision, resolved })
  if (!isDiscussionAnnotation(value)) throw new Error('Annotation response is invalid. Reload before retrying.')
  return value
}
