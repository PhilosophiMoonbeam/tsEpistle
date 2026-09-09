import { ThemePolicySchema, type ThemePolicy, type ThemeWorkspace, type ThemeWriteResult } from '../../shared/theme-policy.ts'
import { sameOriginJsonFetch } from './json-transport.ts'
const request = async (method: string, suffix = '', body?: unknown) => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/theming/workspace' + suffix, {
    method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload: unknown = await response.json()
  if (!response.ok) throw Object.assign(new Error(payload && typeof payload === 'object' && typeof Reflect.get(payload, 'error') === 'string' ? Reflect.get(payload, 'error') : 'Theme administration is unavailable.'), { status: response.status })
  if (!payload || typeof payload !== 'object') throw new Error('The workspace response could not be read.')
  return payload
}
export const fetchThemeWorkspace = async (): Promise<ThemeWorkspace> => {
  const payload = await request('GET')
  if (typeof Reflect.get(payload, 'fingerprint') !== 'string' || !Reflect.get(payload, 'policy') || !Reflect.get(payload, 'runtime') || !Array.isArray(Reflect.get(payload, 'history'))) throw new Error('The Theme workspace could not be read.')
  const policy = ThemePolicySchema.safeParse(Reflect.get(payload, 'policy')), runtime = Reflect.get(payload, 'runtime'), capabilities = Reflect.get(payload, 'capabilities')
  if (!policy.success || !runtime || !['applied', 'needs-attention'].includes(runtime.state) || typeof runtime.observedAt !== 'string' || !capabilities || typeof Reflect.get(capabilities, 'editCustomCode') !== 'boolean') throw new Error('The Theme workspace contains invalid settings. Review server diagnostics.')
  return { ...payload, policy: policy.data, capabilities: { editCustomCode: Reflect.get(capabilities, 'editCustomCode') } } as ThemeWorkspace
}
const write = async (method: string, suffix: string, body: unknown): Promise<ThemeWriteResult> => {
  const payload = await request(method, suffix, body)
  if (!['applied', 'needs-attention'].includes(Reflect.get(payload, 'activation'))) throw new Error('The save outcome is unconfirmed. Reload before repeating this action.')
  return payload as ThemeWriteResult
}
export const saveThemeWorkspace = (policy: ThemePolicy, fingerprint: string, reason: string) => write('PUT', '', { policy, fingerprint, reason })
export const retryThemeRuntime = (fingerprint: string) => write('POST', '/activate', { fingerprint })
