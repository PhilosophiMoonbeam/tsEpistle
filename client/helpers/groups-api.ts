type JsonResponse = { ok: boolean, headers?: { get: (name: string) => string | null }, json: () => Promise<any> }
type FetchImpl = (url: string, init: any) => Promise<JsonResponse>

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<any> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers.get('content-type') || '' : ''

  let payload = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload.error === 'string' && payload.error.length > 0) {
      throw new Error(payload.error)
    }
    if (payload && typeof payload.message === 'string' && payload.message.length > 0) {
      throw new Error(payload.message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeGroupOption (row: any, fallbackMessage: string): any {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.isSystem !== 'boolean') {
    throw new Error(fallbackMessage)
  }

  return row
}

function normalizeGroupListRow (row: any, fallbackMessage: string): any {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.isSystem !== 'boolean' || !Number.isInteger(row.userCount)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.createdAt !== 'string' || row.createdAt.length < 1 || typeof row.updatedAt !== 'string' || row.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return row
}

function normalizeGroupDetailPageRule (row: any, fallbackMessage: string): any {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.id !== 'string' || row.id.length < 1 || typeof row.path !== 'string' || typeof row.match !== 'string' || typeof row.deny !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (!['START', 'EXACT', 'END', 'REGEX', 'TAG'].includes(row.match)) {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(row.roles) || row.roles.some(role => typeof role !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(row.locales) || row.locales.some(locale => typeof locale !== 'string')) {
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

function normalizeGroupDetailUser (row: any, fallbackMessage: string): any {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.email !== 'string' || row.email.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email
  }
}

function normalizeGroupDetail (payload: any, fallbackMessage: string): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  if (!Number.isInteger(payload.id) || typeof payload.name !== 'string' || payload.name.length < 1 || typeof payload.redirectOnLogin !== 'string' || typeof payload.isSystem !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(payload.permissions) || payload.permissions.some(permission => typeof permission !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(payload.pageRules) || !Array.isArray(payload.users)) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.createdAt !== 'string' || payload.createdAt.length < 1 || typeof payload.updatedAt !== 'string' || payload.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    ...payload,
    pageRules: payload.pageRules.map(row => normalizeGroupDetailPageRule(row, fallbackMessage)),
    users: payload.users.map(row => normalizeGroupDetailUser(row, fallbackMessage))
  }
}

export async function fetchGroupOptions (fetchImpl: FetchImpl, fallbackMessage = 'Groups response is invalid'): Promise<any[]> {
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

export async function fetchGroupsList (fetchImpl: FetchImpl, fallbackMessage = 'Groups list response is invalid'): Promise<any[]> {
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

export async function fetchGroupDetails (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'Group detail response is invalid'): Promise<any> {
  const response = await fetchImpl(`/_api/groups/${id}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupDetail(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

function normalizeGroupMutationResponse (payload: any, fallbackMessage: string): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  if (payload.succeeded !== true || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

export async function createGroup (fetchImpl: FetchImpl, name: string, fallbackMessage = 'Group create response is invalid'): Promise<any> {
  const response = await fetchImpl('/_api/groups', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name })
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function assignGroupUser (fetchImpl: FetchImpl, groupId: number | string, userId: number | string, fallbackMessage = 'Group user assign response is invalid'): Promise<any> {
  const response = await fetchImpl(`/_api/groups/${groupId}/users/${userId}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function unassignGroupUser (fetchImpl: FetchImpl, groupId: number | string, userId: number | string, fallbackMessage = 'Group user unassign response is invalid'): Promise<any> {
  const response = await fetchImpl(`/_api/groups/${groupId}/users/${userId}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function deleteGroup (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'Group delete response is invalid'): Promise<any> {
  const response = await fetchImpl(`/_api/groups/${id}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeGroupMutationResponse(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function updateGroup (fetchImpl: FetchImpl, id: number | string, payload: any, fallbackMessage = 'Group update response is invalid'): Promise<any> {
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
