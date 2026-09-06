import type { MailWorkspace, MailCheck, MailCheckRequest } from '../../shared/mail-workspace.ts'
import { MailPolicySchema, mailRecord } from '../../shared/mail-workspace.ts'
import { sameOriginJsonFetch } from './json-transport.ts'
const request = async (method: string, suffix: string, body?: unknown): Promise<Record<string, unknown>> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/mail' + suffix, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw Object.assign(new Error(typeof mailRecord(payload).error === 'string' ? String(mailRecord(payload).error) : 'Mail administration is unavailable.'), {
      status: response.status
    })
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('The Mail response could not be read. Refresh before repeating an action.')
  return payload as Record<string, unknown>
}
export const fetchMailWorkspace = async (): Promise<MailWorkspace> => {
  const value = await request('GET', '/workspace'),
    secrets = mailRecord(value.secrets),
    runtime = mailRecord(value.runtime)
  if (
    !MailPolicySchema.safeParse(value.policy).success ||
    typeof value.fingerprint !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof secrets.pass !== 'boolean' ||
    typeof secrets.dkimPrivateKey !== 'boolean' ||
    typeof runtime.settingsCurrent !== 'boolean' ||
    !Array.isArray(value.history) ||
    !Array.isArray(value.checks) ||
    !Array.isArray(value.issues)
  )
    throw new Error('The Mail workspace response is invalid. Reload to confirm saved settings.')
  return value as unknown as MailWorkspace
}
const publication = async (method: string, suffix: string, input: unknown) => {
  const value = await request(method, suffix, input)
  if (typeof value.revision !== 'string' || typeof value.applied !== 'boolean')
    throw new Error('The save or application outcome is unconfirmed. Reload before repeating it.')
  return value as { revision: string; applied: boolean }
}
export const saveMailWorkspace = (input: unknown) => publication('PUT', '/workspace', input)
export const applyMailWorkspace = (fingerprint: string) => publication('POST', '/workspace/apply', { fingerprint })
const check = (value: Record<string, unknown>, id: string): MailCheck => {
  if (value.id !== id || !['running', 'succeeded', 'failed', 'uncertain'].includes(String(value.state)) || typeof value.summary !== 'string')
    throw new Error('The check receipt could not be confirmed. Refresh its status before requesting another check.')
  return value as unknown as MailCheck
}
export const startMailCheck = async (input: MailCheckRequest) => check(await request('POST', '/checks', input), input.id)
export const fetchMailCheck = async (id: string) => check(await request('GET', '/checks/' + encodeURIComponent(id)), id)
export const fetchMailPreview = async (key: string) => {
  const value = await request('GET', '/templates/' + encodeURIComponent(key))
  if (value.key !== key || typeof value.html !== 'string' || typeof value.subject !== 'string') throw new Error('The email preview could not be loaded.')
  return value as { key: string; html: string; subject: string }
}
