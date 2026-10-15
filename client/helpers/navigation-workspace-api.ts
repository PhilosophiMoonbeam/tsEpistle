import { NavigationPolicySchema, type NavigationPolicy, type NavigationWorkspace, type NavigationWriteResult } from '../../shared/navigation-policy.ts'
import { NavigationMoveReviewSchema, type NavigationMoveReview } from '../../shared/navigation-move-repair.ts'
import { sameOriginJsonFetch } from './json-transport.ts'
const request = async (method: string, suffix = '', body?: unknown, signal?: AbortSignal) => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/navigation/workspace' + suffix, {
    method,
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload: unknown = await response.json()
  if (!response.ok)
    throw Object.assign(
      new Error(
        payload && typeof payload === 'object' && typeof Reflect.get(payload, 'error') === 'string'
          ? Reflect.get(payload, 'error')
          : 'Navigation administration is unavailable.'
      ),
      { status: response.status }
    )
  if (!payload || typeof payload !== 'object') throw new Error('The workspace response could not be read.')
  return payload
}
export const fetchNavigationWorkspace = async (): Promise<NavigationWorkspace> => {
  const payload = await request('GET')
  if (
    typeof Reflect.get(payload, 'fingerprint') !== 'string' ||
    !Reflect.get(payload, 'policy') ||
    !Reflect.get(payload, 'runtime') ||
    !Array.isArray(Reflect.get(payload, 'history'))
  )
    throw new Error('The Navigation workspace could not be read.')
  const policy = NavigationPolicySchema.safeParse(Reflect.get(payload, 'policy')),
    runtime = Reflect.get(payload, 'runtime')
  if (!policy.success || !runtime || !['applied', 'needs-attention'].includes(runtime.state) || typeof runtime.observedAt !== 'string')
    throw new Error('The Navigation workspace contains invalid settings. Review server diagnostics.')
  if (
    !Array.isArray(Reflect.get(payload, 'groups')) ||
    !Array.isArray(Reflect.get(payload, 'locales')) ||
    !Array.isArray(Reflect.get(payload, 'guestGroups')) ||
    typeof Reflect.get(payload, 'defaultLocale') !== 'string'
  )
    throw new Error('Navigation audience and locale options could not be read.')
  return { ...payload, policy: policy.data } as NavigationWorkspace
}
const write = async (method: string, suffix: string, body: unknown, signal?: AbortSignal): Promise<NavigationWriteResult> => {
  const payload = await request(method, suffix, body, signal)
  if (!['applied', 'needs-attention'].includes(Reflect.get(payload, 'activation')))
    throw new Error('The save outcome is unconfirmed. Reload before repeating this action.')
  return payload as NavigationWriteResult
}
export const saveNavigationWorkspace = (policy: NavigationPolicy, fingerprint: string, reason: string) => write('PUT', '', { policy, fingerprint, reason })
export const retryNavigationRuntime = (fingerprint: string) => write('POST', '/activate', { fingerprint })
export const reviewMovedNavigationPage = async (pageId: number, menuLocale: string, signal?: AbortSignal): Promise<NavigationMoveReview> => {
  const payload = await request('POST', '/move-review', { pageId, menuLocale }, signal)
  const parsed = NavigationMoveReviewSchema.safeParse(payload)
  if (!parsed.success) throw new Error('The moved-page review could not be read. Reload before continuing.')
  return parsed.data
}
export const repairMovedNavigationPage = (review: NavigationMoveReview, selected: { locale: string; itemId: string }[], reason: string, signal?: AbortSignal) =>
  write('POST', '/move-repair', { review, selected, reason }, signal)
