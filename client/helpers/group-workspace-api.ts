import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'
import type {
  GroupDirectory,
  GroupWorkspace,
  GroupMembers,
  GroupPolicyDraft,
  GroupAccessInput,
  GroupAccessResult,
  GroupWriteResult
} from '../../shared/group-policy.ts'
export interface GroupCreationOptions {
  fingerprint: string
  allowedPermissions: string[]
}
const request = async <T>(path: string, validate: (value: unknown) => boolean, method = 'GET', body?: unknown): Promise<T> => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/groups/workspace' + path, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const payload: unknown = await response.json()
  if (!response.ok)
    throw Object.assign(new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : 'The group request could not be completed.'), {
      status: response.status
    })
  if (!validate(payload)) throw new Error('The group response could not be read. Reload before retrying a change.')
  return payload as T
}
const record = (v: unknown) =>
  isRecord(v) &&
  Number.isSafeInteger(v.id) &&
  typeof v.name === 'string' &&
  typeof v.description === 'string' &&
  typeof v.isSystem === 'boolean' &&
  typeof v.formMfaRequired === 'boolean' &&
  Array.isArray(v.permissions) &&
  typeof v.memberCount === 'number'
const workspace = (v: unknown) =>
  record(v) &&
  isRecord(v) &&
  typeof v.fingerprint === 'string' &&
  Array.isArray(v.pageRules) &&
  Array.isArray(v.allowedPermissions) &&
  Array.isArray(v.history) &&
  isRecord(v.capabilities) &&
  isRecord(v.dependencies)
const result = (v: unknown) => isRecord(v) && Number.isSafeInteger(v.id) && typeof v.sessionsEnded === 'number' && typeof v.currentSessionEnded === 'boolean'
export const fetchGroupDirectory = (query: URLSearchParams) =>
  request<GroupDirectory>('?' + query, v => isRecord(v) && Array.isArray(v.items) && v.items.every(record) && typeof v.total === 'number' && isRecord(v.counts))
export const fetchGroupWorkspace = (id: number) => request<GroupWorkspace>('/' + id, workspace)
export const fetchGroupCreationOptions = () =>
  request<GroupCreationOptions>('/creation-options', v => isRecord(v) && typeof v.fingerprint === 'string' && Array.isArray(v.allowedPermissions))
export const createReviewedGroup = (policy: GroupPolicyDraft, reason: string, fingerprint: string) =>
  request<GroupWriteResult>('', result, 'POST', { policy, reason, fingerprint })
export const saveGroupPolicy = (id: number, policy: GroupPolicyDraft, reason: string, fingerprint: string) =>
  request<GroupWriteResult>(`/${id}/policy`, result, 'PUT', { policy, reason, fingerprint })
export const fetchGroupMembers = (id: number, query: URLSearchParams) =>
  request<GroupMembers>(
    `/${id}/members?${query}`,
    v =>
      isRecord(v) &&
      Array.isArray(v.items) &&
      v.items.every(
        row =>
          isRecord(row) && Number.isSafeInteger(row.id) && typeof row.name === 'string' && typeof row.email === 'string' && typeof row.canRemove === 'boolean'
      ) &&
      typeof v.total === 'number'
  )
export const changeGroupMembers = (id: number, action: 'add' | 'remove', userIds: number[], reason: string, fingerprint: string) =>
  request<GroupWriteResult>(`/${id}/members`, result, 'POST', { action, userIds, reason, fingerprint })
export const removeReviewedGroup = (id: number, reason: string, fingerprint: string) =>
  request<GroupWriteResult>(`/${id}`, result, 'DELETE', { reason, fingerprint })
export const evaluateGroupPolicy = (id: number, input: GroupAccessInput) =>
  request<GroupAccessResult>(
    `/${id}/evaluate`,
    v =>
      isRecord(v) &&
      typeof v.allowed === 'boolean' &&
      typeof v.reason === 'string' &&
      Array.isArray(v.rules) &&
      typeof v.fingerprint === 'string' &&
      typeof v.ruleCount === 'number',
    'POST',
    input
  )
export const groupRequestStatus = (error: unknown): number =>
  error && typeof error === 'object' && typeof Reflect.get(error, 'status') === 'number' ? (Reflect.get(error, 'status') as number) : 0
export const groupPolicyCopy = (value: GroupPolicyDraft): GroupPolicyDraft =>
  JSON.parse(
    JSON.stringify({
      name: value.name,
      description: value.description,
      redirectOnLogin: value.redirectOnLogin,
      formMfaRequired: value.formMfaRequired,
      permissions: value.permissions,
      pageRules: value.pageRules
    })
  ) as GroupPolicyDraft
export const groupPolicySignature = (value: GroupPolicyDraft): string =>
  JSON.stringify({
    ...groupPolicyCopy(value),
    name: value.name.trim(),
    description: value.description.trim(),
    redirectOnLogin: value.redirectOnLogin.trim() || '/',
    permissions: [...value.permissions].sort(),
    pageRules: value.pageRules.map(rule => ({
      id: rule.id,
      path: rule.path.trim(),
      match: rule.match,
      deny: rule.deny,
      roles: [...rule.roles].sort(),
      locales: [...rule.locales].sort()
    }))
  })
export const emptyGroupPolicy = (): GroupPolicyDraft => ({ name: '', description: '', redirectOnLogin: '/', formMfaRequired: false, permissions: [], pageRules: [] })
