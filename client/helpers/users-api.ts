import { isRecord } from './type-guards'

type JsonResponse = { ok: boolean, headers?: { get: (name: string) => string | null }, json: () => Promise<unknown> }
type FetchImpl = (url: string, init: RequestInit) => Promise<JsonResponse>

export type UserSearchRow = {
  id: number
  name: string
  email: string
  providerKey: string
}

export type LastLoginRow = {
  id: number
  name: string
  lastLoginAt: string
}

export type UserGroup = {
  id: number
  name: string
}

export type AdminUserListRow = {
  id: number
  name: string
  email: string
  providerKey: string
  isSystem: boolean
  isActive: boolean
  createdAt: string
  lastLoginAt: string | null
}

export type AdminUsersListOptions = {
  page?: number
  pageSize?: number
  filter?: string
  providerKey?: string
  orderBy?: string
  orderByDirection?: 'asc' | 'desc'
}

export type AdminUsersListResponse = {
  total: number
  users: AdminUserListRow[]
}

export type CreateAdminUserInput = {
  providerKey: string
  email: string
  passwordRaw: string
  name: string
  groups: number[]
  mustChangePassword: boolean
  sendWelcomeEmail: boolean
}

export type UpdateAdminUserInput = {
  email: string
  name: string
  newPassword: string
  groups: number[]
  location: string
  jobTitle: string
  timezone: string
}

export type AdminUserDetail = {
  id: number
  name: string
  email: string
  providerKey: string
  providerName: string
  providerId: string | null
  providerIs2FACapable: boolean
  location: string
  jobTitle: string
  timezone: string
  isSystem: boolean
  isActive: boolean
  isVerified: boolean
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
  tfaIsActive: boolean
  groups: UserGroup[]
}

export type AdminUserMutationResult = {
  succeeded: boolean
  message: string
  welcomeEmailError?: string
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

function normalizeUserSearchRow (row: unknown, fallbackMessage: string): UserSearchRow {
  if (!isRecord(row)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.id !== 'number' || !Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.email !== 'string' || row.email.length < 1 || typeof row.providerKey !== 'string' || row.providerKey.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    providerKey: row.providerKey
  }
}

function normalizeLastLoginRow (row: unknown, fallbackMessage: string): LastLoginRow {
  if (!isRecord(row)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.id !== 'number' || !Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.lastLoginAt !== 'string' || row.lastLoginAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    lastLoginAt: row.lastLoginAt
  }
}

function normalizeUserGroupRow (row: unknown, fallbackMessage: string): UserGroup {
  if (!isRecord(row)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.id !== 'number' || !Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name
  }
}

function normalizeAdminUserListRow (row: unknown, fallbackMessage: string): AdminUserListRow {
  if (!isRecord(row)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.id !== 'number' || !Number.isInteger(row.id) || typeof row.name !== 'string' || row.name.length < 1 || typeof row.email !== 'string' || row.email.length < 1 || typeof row.providerKey !== 'string' || row.providerKey.length < 1) {
    throw new Error(fallbackMessage)
  }
  if (typeof row.isSystem !== 'boolean' || typeof row.isActive !== 'boolean' || typeof row.createdAt !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (row.lastLoginAt !== null && typeof row.lastLoginAt !== 'string') {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    providerKey: row.providerKey,
    isSystem: row.isSystem,
    isActive: row.isActive,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt
  }
}

function normalizeUserDetail (payload: unknown, fallbackMessage: string): AdminUserDetail {
  if (!isRecord(payload)) {
    throw new Error(fallbackMessage)
  }

  if (
    typeof payload.id !== 'number' ||
    !Number.isInteger(payload.id) ||
    typeof payload.name !== 'string' ||
    typeof payload.email !== 'string' ||
    typeof payload.providerKey !== 'string' ||
    typeof payload.providerName !== 'string' ||
    typeof payload.location !== 'string' ||
    typeof payload.jobTitle !== 'string' ||
    typeof payload.timezone !== 'string' ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.updatedAt !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }
  if (payload.providerId !== null && typeof payload.providerId !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.providerIs2FACapable !== 'boolean' || typeof payload.isSystem !== 'boolean' || typeof payload.isActive !== 'boolean' || typeof payload.isVerified !== 'boolean' || typeof payload.tfaIsActive !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (payload.lastLoginAt !== null && typeof payload.lastLoginAt !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(payload.groups)) {
    throw new Error(fallbackMessage)
  }

  return {
    id: payload.id,
    name: payload.name,
    email: payload.email,
    providerKey: payload.providerKey,
    providerName: payload.providerName,
    providerId: payload.providerId,
    providerIs2FACapable: payload.providerIs2FACapable,
    location: payload.location,
    jobTitle: payload.jobTitle,
    timezone: payload.timezone,
    isSystem: payload.isSystem,
    isActive: payload.isActive,
    isVerified: payload.isVerified,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    lastLoginAt: payload.lastLoginAt,
    tfaIsActive: payload.tfaIsActive,
    groups: payload.groups.map(row => normalizeUserGroupRow(row, fallbackMessage))
  }
}

function normalizePositiveIntegerId (id: number | string, fallbackMessage: string): number {
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
    return id
  }

  if (typeof id === 'string' && /^[1-9]\d*$/.test(id)) {
    return Number.parseInt(id, 10)
  }

  throw new Error(fallbackMessage)
}

function normalizeSuccessResult (payload: unknown, fallbackMessage: string): AdminUserMutationResult {
  if (!isRecord(payload) || payload.succeeded !== true || typeof payload.message !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (payload.welcomeEmailError !== undefined && typeof payload.welcomeEmailError !== 'string') {
    throw new Error(fallbackMessage)
  }

  return {
    succeeded: true,
    message: payload.message,
    ...(typeof payload.welcomeEmailError === 'string' ? { welcomeEmailError: payload.welcomeEmailError } : {})
  }
}

export async function searchUsers (fetchImpl: FetchImpl, query: unknown, fallbackMessage = 'User search response is invalid'): Promise<UserSearchRow[]> {
  const normalizedQuery = typeof query === 'string' ? query.trim() : ''
  if (normalizedQuery.length < 2) {
    return []
  }

  const response = await fetchImpl(`/_api/users/search?query=${encodeURIComponent(normalizedQuery)}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeUserSearchRow(row, fallbackMessage))
}

export async function fetchLastLogins (fetchImpl: FetchImpl, fallbackMessage = 'Last logins response is invalid'): Promise<LastLoginRow[]> {
  const response = await fetchImpl('/_api/users/last-logins', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeLastLoginRow(row, fallbackMessage))
}

export async function fetchAdminUsersList (fetchImpl: FetchImpl, options: AdminUsersListOptions = {}, fallbackMessage = 'Users list response is invalid'): Promise<AdminUsersListResponse> {
  const params = new URLSearchParams()
  params.set('page', String(options.page || 1))
  params.set('pageSize', String(options.pageSize || 15))
  params.set('filter', typeof options.filter === 'string' ? options.filter : '')
  params.set('providerKey', options.providerKey || 'all')
  params.set('orderBy', options.orderBy || 'name')
  params.set('orderByDirection', options.orderByDirection === 'desc' ? 'desc' : 'asc')

  const response = await fetchImpl(`/_api/users?${params.toString()}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.total !== 'number' || !Number.isInteger(payload.total) || payload.total < 0 || !Array.isArray(payload.users)) {
    throw new Error(fallbackMessage)
  }

  return {
    total: payload.total,
    users: payload.users.map(row => normalizeAdminUserListRow(row, fallbackMessage))
  }
}

export async function createAdminUser (fetchImpl: FetchImpl, payload: CreateAdminUserInput, fallbackMessage = 'User create response is invalid'): Promise<AdminUserMutationResult> {
  const response = await fetchImpl('/_api/users', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  return normalizeSuccessResult(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function sendAdminUserWelcomeEmail (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'Welcome email response is invalid'): Promise<AdminUserMutationResult> {
  const normalizedId = normalizePositiveIntegerId(id, fallbackMessage)
  const response = await fetchImpl(`/_api/users/${normalizedId}/welcome-email`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  })

  return normalizeSuccessResult(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function updateAdminUser (fetchImpl: FetchImpl, id: number | string, payload: UpdateAdminUserInput, fallbackMessage = 'User update response is invalid'): Promise<AdminUserMutationResult> {
  const normalizedId = normalizePositiveIntegerId(id, fallbackMessage)
  const response = await fetchImpl(`/_api/users/${normalizedId}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  return normalizeSuccessResult(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function deleteAdminUser (fetchImpl: FetchImpl, id: number | string, replaceId: number | string, fallbackMessage = 'User delete response is invalid'): Promise<AdminUserMutationResult> {
  const normalizedId = normalizePositiveIntegerId(id, fallbackMessage)
  const normalizedReplaceId = normalizePositiveIntegerId(replaceId, fallbackMessage)
  const response = await fetchImpl(`/_api/users/${normalizedId}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ replaceId: normalizedReplaceId })
  })

  return normalizeSuccessResult(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function patchAdminUserAction (fetchImpl: FetchImpl, id: number | string, path: string, payload: unknown, fallbackMessage: string): Promise<AdminUserMutationResult> {
  const normalizedId = normalizePositiveIntegerId(id, fallbackMessage)
  const response = await fetchImpl(`/_api/users/${normalizedId}/${path}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  return normalizeSuccessResult(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function setAdminUserActive (fetchImpl: FetchImpl, id: number | string, isActive: boolean, fallbackMessage = 'User status response is invalid'): Promise<AdminUserMutationResult> {
  return patchAdminUserAction(fetchImpl, id, 'status', { isActive }, fallbackMessage)
}

export async function verifyAdminUser (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'User verification response is invalid'): Promise<AdminUserMutationResult> {
  return patchAdminUserAction(fetchImpl, id, 'verification', { isVerified: true }, fallbackMessage)
}

export async function setAdminUserTfa (fetchImpl: FetchImpl, id: number | string, enabled: boolean, fallbackMessage = 'User 2FA response is invalid'): Promise<AdminUserMutationResult> {
  return patchAdminUserAction(fetchImpl, id, 'tfa', { enabled }, fallbackMessage)
}

export async function fetchUserDetails (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'User detail response is invalid'): Promise<AdminUserDetail> {
  const normalizedId = normalizePositiveIntegerId(id, fallbackMessage)
  const response = await fetchImpl(`/_api/users/${normalizedId}`, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeUserDetail(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export type Profile = {
  id: number
  email: string
  name: string
  providerKey: string
  providerName: string
  isSystem: boolean
  isVerified: boolean
  location: string
  jobTitle: string
  timezone: string
  dateFormat: string
  appearance: string
  createdAt: string
  updatedAt: string
  lastLoginAt: string
  groups: string[]
  pagesTotal: number
}

type ProfileUpdateInput = {
  name: string
  location: string
  jobTitle: string
  timezone: string
  dateFormat: string
  appearance: string
}

function isStringArray (value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function normalizeProfile (payload: unknown, fallbackMessage: string): Profile {
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'number' ||
    typeof payload.email !== 'string' ||
    typeof payload.name !== 'string' ||
    typeof payload.providerKey !== 'string' ||
    typeof payload.providerName !== 'string' ||
    typeof payload.isSystem !== 'boolean' ||
    typeof payload.isVerified !== 'boolean' ||
    typeof payload.location !== 'string' ||
    typeof payload.jobTitle !== 'string' ||
    typeof payload.timezone !== 'string' ||
    typeof payload.dateFormat !== 'string' ||
    typeof payload.appearance !== 'string' ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.updatedAt !== 'string' ||
    typeof payload.lastLoginAt !== 'string' ||
    !isStringArray(payload.groups) ||
    typeof payload.pagesTotal !== 'number'
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    id: payload.id,
    email: payload.email,
    name: payload.name,
    providerKey: payload.providerKey,
    providerName: payload.providerName,
    isSystem: payload.isSystem,
    isVerified: payload.isVerified,
    location: payload.location,
    jobTitle: payload.jobTitle,
    timezone: payload.timezone,
    dateFormat: payload.dateFormat,
    appearance: payload.appearance,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    lastLoginAt: payload.lastLoginAt,
    groups: payload.groups,
    pagesTotal: payload.pagesTotal
  }
}

export async function fetchProfile (fetchImpl: FetchImpl, fallbackMessage = 'Profile response is invalid'): Promise<Profile> {
  const response = await fetchImpl('/_api/users/profile', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  return normalizeProfile(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function sendProfileRequest (fetchImpl: FetchImpl, path: string, method: string, body: unknown, fallbackMessage: string): Promise<string> {
  const response = await fetchImpl(`/_api/users/profile${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.token !== 'string' || payload.token.length < 1) {
    throw new Error(fallbackMessage)
  }
  return payload.token
}

export function updateProfile (fetchImpl: FetchImpl, input: ProfileUpdateInput, fallbackMessage = 'Profile update failed'): Promise<string> {
  return sendProfileRequest(fetchImpl, '', 'PATCH', input, fallbackMessage)
}

export function changeProfilePassword (fetchImpl: FetchImpl, current: string, newPassword: string, fallbackMessage = 'Password change failed'): Promise<string> {
  return sendProfileRequest(fetchImpl, '/password', 'POST', { current, newPassword }, fallbackMessage)
}
