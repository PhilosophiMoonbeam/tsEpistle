import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'
import type { AccountAction, AccountCreationOptions, AccountDirectory, AccountProfileDraft, AccountWorkspace } from '../../shared/account-policy.ts'
const request = async <T>(path: string, valid: (value: unknown) => boolean, method = 'GET', body?: unknown): Promise<T> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/users/workspace' + path, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload: unknown = await response.json()
  if (!response.ok)
    throw Object.assign(new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'The account request could not be completed.'), {
      status: response.status
    })
  if (!valid(payload)) throw new Error('The account response could not be read. Reload before retrying a change.')
  return payload as T
}
const record = (v: unknown) =>
  isRecord(v) &&
  typeof v.id === 'number' &&
  typeof v.name === 'string' &&
  typeof v.email === 'string' &&
  typeof v.isActive === 'boolean' &&
  Array.isArray(v.groups)
const profile = (v: unknown): v is AccountProfileDraft =>
  isRecord(v) &&
  ['name', 'email', 'location', 'jobTitle', 'timezone'].every(field => typeof v[field] === 'string') &&
  typeof v.pronouns === 'string' &&
  v.pronouns.length <= 255 &&
  Array.isArray(v.groups) &&
  v.groups.every(id => Number.isSafeInteger(id) && id > 0)
const workspace = (v: unknown) =>
  record(v) &&
  isRecord(v) &&
  typeof v.fingerprint === 'string' &&
  profile(v.profile) &&
  Array.isArray(v.availableGroups) &&
  isRecord(v.capabilities) &&
  Array.isArray(v.capabilities.actions) &&
  Array.isArray(v.history) &&
  isRecord(v.contributionCounts)
const options = (v: unknown) => isRecord(v) && typeof v.fingerprint === 'string' && Array.isArray(v.providers) && Array.isArray(v.groups)
export const fetchAccountDirectory = (params: URLSearchParams) =>
  request<AccountDirectory>(
    '?' + params,
    v =>
      isRecord(v) &&
      Array.isArray(v.items) &&
      v.items.every(record) &&
      typeof v.total === 'number' &&
      isRecord(v.counts) &&
      Array.isArray(v.providers) &&
      Array.isArray(v.groups)
  )
export const fetchAccount = (id: number) => request<AccountWorkspace>('/' + id, workspace)
export const fetchAccountCreationOptions = () => request<AccountCreationOptions>('/creation-options', options)
export const createAccount = (input: {
  fingerprint: string
  profile: AccountProfileDraft
  providerKey: string
  password?: string
  isVerified: boolean
  mustChangePassword: boolean
  reason: string
}) => request<{ id: number }>('', v => isRecord(v) && Number.isSafeInteger(v.id), 'POST', input)
export const saveAccountProfile = (id: number, profile: AccountProfileDraft, reason: string, fingerprint: string) =>
  request<AccountWorkspace>(`/${id}/profile`, workspace, 'PUT', { profile, reason, fingerprint })
export const actOnAccount = (id: number, action: AccountAction, reason: string, fingerprint: string) =>
  request<AccountWorkspace>(`/${id}/actions`, workspace, 'POST', { action, reason, fingerprint })
export const replaceAccountPassword = (id: number, password: string, mustChangePassword: boolean, reason: string, fingerprint: string) =>
  request<AccountWorkspace>(`/${id}/password`, workspace, 'PUT', { password, mustChangePassword, reason, fingerprint })
export const deleteAccount = (id: number, replaceId: number, reason: string, fingerprint: string) =>
  request<{ id: number; deleted: true }>(`/${id}`, v => isRecord(v) && v.id === id && v.deleted === true, 'DELETE', { replaceId, reason, fingerprint })
export const sendAccountWelcomeEmail = (id: number, reason: string, fingerprint: string) =>
  request<{ accepted: true }>(`/${id}/welcome-email`, v => isRecord(v) && v.accepted === true, 'POST', { reason, fingerprint })
export const accountRequestStatus = (error: unknown): number =>
  error && typeof error === 'object' && typeof Reflect.get(error, 'status') === 'number' ? (Reflect.get(error, 'status') as number) : 0
