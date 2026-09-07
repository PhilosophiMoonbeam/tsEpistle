import type { TlsWorkspace, TlsOperation } from '../../shared/tls-workspace.ts'
import { sameOriginJsonFetch } from './json-transport.ts'
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const request = async (method: string, path: string, body?: unknown) => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/tls' + path, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const value = record(await response.json().catch(() => null))
  if (!response.ok)
    throw Object.assign(new Error(typeof value.error === 'string' ? value.error : 'HTTPS administration is unavailable.'), {
      status: response.status
    })
  return value
}
export const fetchTlsWorkspace = async (): Promise<TlsWorkspace> => {
  const value = await request('GET', '/workspace')
  if (
    typeof value.fingerprint !== 'string' ||
    typeof value.publicUrl !== 'string' ||
    typeof record(value.redirection).enabled !== 'boolean' ||
    typeof record(value.runtimeRedirection).settingsCurrent !== 'boolean' ||
    !value.listeners ||
    !value.deployment ||
    !Array.isArray(value.operations) ||
    !Array.isArray(value.history)
  )
    throw new Error('The HTTPS workspace response could not be confirmed. Reload before making changes.')
  return value as unknown as TlsWorkspace
}
const receipt = (value: Record<string, unknown>, id: string): TlsOperation => {
  if (value.id !== id || !['running', 'succeeded', 'failed', 'uncertain'].includes(String(value.state)) || typeof value.summary !== 'string')
    throw new Error('The operation receipt could not be confirmed. Read its status before requesting another action.')
  return value as unknown as TlsOperation
}
export const startTlsOperation = async (input: { id: string; [key: string]: unknown }) =>
  receipt(await request('POST', '/operations', input), input.id)
export const fetchTlsOperation = async (id: string) => receipt(await request('GET', '/operations/' + encodeURIComponent(id)), id)
const publication = async (path: string, method: string, input: unknown) => {
  const value = await request(method, path, input)
  if (typeof value.applied !== 'boolean' || typeof value.enabled !== 'boolean' || typeof value.revision !== 'string')
    throw new Error('The policy outcome is unconfirmed. Reload saved settings before repeating it.')
  return value as { applied: boolean; enabled: boolean; revision: string }
}
export const saveTlsPolicy = (input: unknown) => publication('/workspace', 'PUT', input)
export const applyTlsPolicy = (fingerprint: string) => publication('/workspace/apply', 'POST', { fingerprint })
