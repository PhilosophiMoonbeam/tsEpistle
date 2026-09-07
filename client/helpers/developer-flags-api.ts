import {
  DeveloperFlagsApplyResultSchema,
  DeveloperFlagsSaveResultSchema,
  DeveloperFlagsWorkspaceSchema,
  type DeveloperFlags,
  type DeveloperFlagsApplyResult,
  type DeveloperFlagsSaveResult,
  type DeveloperFlagsWorkspace
} from '../../shared/developer-flags.ts'
import { sameOriginJsonFetch } from './json-transport.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const request = async (method: string, path: string, body?: unknown) => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/developer-flags' + path, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const value = record(await response.json().catch(() => null))
  if (!response.ok) {
    throw Object.assign(new Error(typeof value.error === 'string' ? value.error : 'Developer flag administration is unavailable.'), { status: response.status })
  }
  return value
}

const parse = <Result>(schema: { safeParse(value: unknown): { success: boolean; data?: Result } }, value: unknown, message: string): Result => {
  const result = schema.safeParse(value)
  if (!result.success || result.data === undefined) throw new Error(message)
  return result.data
}

export const fetchDeveloperFlagsWorkspace = async (): Promise<DeveloperFlagsWorkspace> =>
  parse(DeveloperFlagsWorkspaceSchema, await request('GET', '/workspace'), 'Developer flag observations could not be confirmed. Reload before making changes.')

export const saveDeveloperFlags = async (policy: DeveloperFlags, fingerprint: string, reason: string): Promise<DeveloperFlagsSaveResult> =>
  parse(
    DeveloperFlagsSaveResultSchema,
    await request('PUT', '/workspace', { policy, fingerprint, reason }),
    'The saved flag policy could not be confirmed. Reload before repeating this change.'
  )

export const applyDeveloperFlags = async (fingerprint: string): Promise<DeveloperFlagsApplyResult> =>
  parse(
    DeveloperFlagsApplyResultSchema,
    await request('POST', '/workspace/apply', { fingerprint }),
    'The runtime application could not be confirmed. Reload the workspace instead of retrying blindly.'
  )
