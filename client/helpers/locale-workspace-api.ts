import { LocalePolicySchema, type LocalePolicy, type LocaleWorkspace, type LocaleWriteResult } from '../../shared/locale-policy.ts'
import { sameOriginJsonFetch } from './json-transport.ts'
export interface LocaleFileReview {
  id: string
  code: string
  name: string
  nativeName: string
  digest: string
  reason: string
  expiresAt: string
  changes: { added: string[]; changed: string[]; removed: string[] }
}

const isLocaleFileReview = (value: unknown): value is LocaleFileReview => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const changes = Reflect.get(value, 'changes')
  return (
    ['id', 'code', 'name', 'nativeName', 'digest', 'reason', 'expiresAt'].every(key => typeof Reflect.get(value, key) === 'string') &&
    changes !== null &&
    typeof changes === 'object' &&
    !Array.isArray(changes) &&
    ['added', 'changed', 'removed'].every(key => Array.isArray(Reflect.get(changes, key)) && Reflect.get(changes, key).every((item: unknown) => typeof item === 'string'))
  )
}

const request = async (method: string, suffix = '', body?: unknown) => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/locales/workspace' + suffix, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw Object.assign(
      new Error(
        payload && typeof payload === 'object' && typeof Reflect.get(payload, 'error') === 'string'
          ? Reflect.get(payload, 'error')
          : 'Locale administration is unavailable.'
      ),
      { status: response.status }
    )
  if (!payload || typeof payload !== 'object') throw new Error('The Locale response could not be read.')
  return payload
}
export const fetchLocaleWorkspace = async (): Promise<LocaleWorkspace> => {
  const payload = await request('GET'),
    policy = LocalePolicySchema.safeParse(Reflect.get(payload, 'policy')),
    runtime = Reflect.get(payload, 'runtime')
  if (
    !policy.success ||
    typeof Reflect.get(payload, 'fingerprint') !== 'string' ||
    !runtime ||
    !['applied', 'needs-attention'].includes(runtime.state) ||
    !Array.isArray(Reflect.get(payload, 'locales')) ||
    !Array.isArray(Reflect.get(payload, 'history')) ||
    !Array.isArray(Reflect.get(payload, 'operations')) ||
    !Reflect.get(payload, 'catalog')
  )
    throw new Error('The Locale workspace contains an invalid response. Reload to confirm saved settings.')
  return { ...payload, policy: policy.data } as LocaleWorkspace
}
const write = async (method: string, suffix: string, body: unknown): Promise<LocaleWriteResult> => {
  const payload = await request(method, suffix, body)
  if (!['applied', 'needs-attention'].includes(Reflect.get(payload, 'activation')))
    throw new Error('The save outcome is unconfirmed. Reload before repeating this action.')
  return payload as LocaleWriteResult
}
export const saveLocaleWorkspace = (policy: LocalePolicy, fingerprint: string, reason: string) => write('PUT', '', { policy, fingerprint, reason })
export const reviewLocaleFile = async (file: File, code: string, fingerprint: string, reason: string): Promise<LocaleFileReview> => {
  const body = new FormData()
  body.append('code', code)
  body.append('fingerprint', fingerprint)
  body.append('reason', reason)
  body.append('file', file)
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/locales/workspace/local-files/review', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    body
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw Object.assign(
      new Error(
        payload && typeof payload === 'object' && typeof Reflect.get(payload, 'error') === 'string'
          ? Reflect.get(payload, 'error')
          : 'Locale file review could not be completed.'
      ),
      { status: response.status }
    )
  if (!isLocaleFileReview(payload)) throw new Error('The locale file review response could not be read.')
  return payload
}

export const commitLocaleFile = async (reviewId: string): Promise<{ jobId: string }> => {
  const payload = await request('POST', `/local-files/${encodeURIComponent(reviewId)}/commit`, {})
  if (typeof Reflect.get(payload, 'jobId') !== 'string' || !Reflect.get(payload, 'jobId')) throw new Error('The locale installation outcome is unconfirmed. Reload before retrying this action.')
  return payload as { jobId: string }
}
export const retryLocaleRuntime = (fingerprint: string) => write('POST', '/activate', { fingerprint })
export const queueLocaleOperation = async (
  kind: 'install' | 'catalog',
  code: string | undefined,
  fingerprint: string,
  reason: string
): Promise<{ jobId: string }> => {
  const payload = await request('POST', '/operations', { kind, code, fingerprint, reason })
  if (typeof Reflect.get(payload, 'jobId') !== 'string') throw new Error('The operation outcome is unconfirmed. Reload before starting another operation.')
  return payload as { jobId: string }
}
