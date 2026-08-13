import { isRecord } from './type-guards'

type JsonResponse = {
  ok: boolean
  headers?: { get: (name: string) => string | null }
  json: () => Promise<unknown>
}
type FetchImpl = (url: string, init: RequestInit) => Promise<JsonResponse>

export type GroupPageRuleMatch = 'START' | 'EXACT' | 'END' | 'REGEX' | 'TAG'

const GROUP_PAGE_RULE_MATCHES: Record<GroupPageRuleMatch, true> = {
  START: true,
  EXACT: true,
  END: true,
  REGEX: true,
  TAG: true
}

function isInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isStringArray (value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isGroupPageRuleMatch (value: unknown): value is GroupPageRuleMatch {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GROUP_PAGE_RULE_MATCHES, value)
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const contentType = response.headers?.get('content-type') || ''
  let payload: unknown = null

  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string' && payload.error.length > 0) {
      throw new Error(payload.error)
    }
    if (isRecord(payload) && typeof payload.message === 'string' && payload.message.length > 0) {
      throw new Error(payload.message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

export type GroupOption = {
  id: number
  name: string
  isSystem: boolean
}

export type GroupListRow = GroupOption & {
  userCount: number
  createdAt: string
  updatedAt: string
}


export type GroupPageRule = {
  id: string
  path: string
  roles: string[]
  match: GroupPageRuleMatch
  deny: boolean
  locales: string[]
}

export type GroupUserRow = {
  id: number
  name: string
  email: string
}

export type GroupDetails = GroupOption & {
  redirectOnLogin: string
  permissions: string[]
  pageRules: GroupPageRule[]
  users: GroupUserRow[]
  createdAt: string
  updatedAt: string
}

export type GroupEditorState = Omit<GroupDetails, 'createdAt' | 'updatedAt'>

export type GroupUpdateInput = Pick<GroupEditorState, 'name' | 'redirectOnLogin' | 'permissions' | 'pageRules'>

export type GroupMutationResponse = {
  succeeded: true
  message: string
}

export type GroupCreateResponse = GroupMutationResponse & {
  group: GroupOption
}

export function createEmptyGroupEditorState (): GroupEditorState {
  return {
    id: 0,
    name: '',
    isSystem: false,
    permissions: [],
    pageRules: [],
    users: [],
    redirectOnLogin: '/'
  }
}

function normalizeGroupOption (row: unknown, fallbackMessage: string): GroupOption {
  if (!isRecord(row) || !isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.isSystem !== 'boolean') {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    isSystem: row.isSystem
  }
}

function normalizeGroupListRow (row: unknown, fallbackMessage: string): GroupListRow {
  const group = normalizeGroupOption(row, fallbackMessage)
  if (!isRecord(row) || !isInteger(row.userCount) || typeof row.createdAt !== 'string' || row.createdAt.length < 1 || typeof row.updatedAt !== 'string' || row.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    ...group,
    userCount: row.userCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function normalizeGroupDetailPageRule (row: unknown, fallbackMessage: string): GroupPageRule {
  if (
    !isRecord(row) ||
    typeof row.id !== 'string' ||
    row.id.length < 1 ||
    typeof row.path !== 'string' ||
    !isGroupPageRuleMatch(row.match) ||
    typeof row.deny !== 'boolean' ||
    !isStringArray(row.roles) ||
    !isStringArray(row.locales)
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    path: row.path,
    roles: row.roles,
    match: row.match,
    deny: row.deny,
    locales: row.locales
  }
}

function normalizeGroupDetailUser (row: unknown, fallbackMessage: string): GroupUserRow {
  if (!isRecord(row) || !isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.email !== 'string' || row.email.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email
  }
}

function normalizeGroupDetail (payload: unknown, fallbackMessage: string): GroupDetails {
  if (
    !isRecord(payload) ||
    !isInteger(payload.id) ||
    typeof payload.name !== 'string' ||
    payload.name.length < 1 ||
    typeof payload.redirectOnLogin !== 'string' ||
    typeof payload.isSystem !== 'boolean' ||
    !isStringArray(payload.permissions) ||
    !Array.isArray(payload.pageRules) ||
    !Array.isArray(payload.users) ||
    typeof payload.createdAt !== 'string' ||
    payload.createdAt.length < 1 ||
    typeof payload.updatedAt !== 'string' ||
    payload.updatedAt.length < 1
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: payload.id,
    name: payload.name,
    redirectOnLogin: payload.redirectOnLogin,
    isSystem: payload.isSystem,
    permissions: payload.permissions,
    pageRules: payload.pageRules.map(row => normalizeGroupDetailPageRule(row, fallbackMessage)),
    users: payload.users.map(row => normalizeGroupDetailUser(row, fallbackMessage)),
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt
  }
}

export async function fetchGroupOptions (fetchImpl: FetchImpl, fallbackMessage = 'Groups response is invalid'): Promise<GroupOption[]> {
  const response = await fetchImpl('/_api/groups', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeGroupOption(row, fallbackMessage))
}

export async function fetchGroupsList (fetchImpl: FetchImpl, fallbackMessage = 'Groups list response is invalid'): Promise<GroupListRow[]> {
  const response = await fetchImpl('/_api/groups/list', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeGroupListRow(row, fallbackMessage))
}

export async function fetchGroupDetails (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'Group detail response is invalid'): Promise<GroupDetails> {
  const response = await fetchImpl(`/_api/groups/${id}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupDetail(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeGroupMutationResponse (payload: unknown, fallbackMessage: string): GroupMutationResponse {
  if (!isRecord(payload) || payload.succeeded !== true || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    succeeded: true,
    message: payload.message
  }
}

export async function createGroup (fetchImpl: FetchImpl, name: string, fallbackMessage = 'Group create response is invalid'): Promise<GroupCreateResponse> {
  const response = await fetchImpl('/_api/groups', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  const result = normalizeGroupMutationResponse(payload, fallbackMessage)
  if (!isRecord(payload)) {
    throw new Error(fallbackMessage)
  }
  return {
    ...result,
    group: normalizeGroupOption(payload.group, fallbackMessage)
  }
}

export async function assignGroupUser (fetchImpl: FetchImpl, groupId: number | string, userId: number | string, fallbackMessage = 'Group user assign response is invalid'): Promise<GroupMutationResponse> {
  const response = await fetchImpl(`/_api/groups/${groupId}/users/${userId}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function unassignGroupUser (fetchImpl: FetchImpl, groupId: number | string, userId: number | string, fallbackMessage = 'Group user unassign response is invalid'): Promise<GroupMutationResponse> {
  const response = await fetchImpl(`/_api/groups/${groupId}/users/${userId}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function deleteGroup (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'Group delete response is invalid'): Promise<GroupMutationResponse> {
  const response = await fetchImpl(`/_api/groups/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function updateGroup (fetchImpl: FetchImpl, id: number | string, payload: GroupUpdateInput, fallbackMessage = 'Group update response is invalid'): Promise<GroupMutationResponse> {
  const response = await fetchImpl(`/_api/groups/${id}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: payload.name,
      redirectOnLogin: payload.redirectOnLogin,
      permissions: payload.permissions,
      pageRules: payload.pageRules
    })
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
