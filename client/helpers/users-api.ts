import { isUserContentTextSize, isUserTimeFormat, UserCommunicationLocaleSchema } from '../../shared/user-presentation.ts'
import type { ProfilePreferencesInput, UserCommunicationLocale, UserContentTextSize, UserTimeFormat } from '../../shared/user-presentation.ts'
import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'

type JsonResponse = { ok: boolean; headers?: { get: (name: string) => string | null }; json: () => Promise<unknown> }
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

async function parseJsonResponse(response: JsonResponse, fallbackMessage: string): Promise<unknown> {
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

function normalizeUserSearchRow(row: unknown, fallbackMessage: string): UserSearchRow {
  if (!isRecord(row)) {
    throw new Error(fallbackMessage)
  }

  if (
    typeof row.id !== 'number' ||
    !Number.isInteger(row.id) ||
    typeof row.name !== 'string' ||
    row.name.length < 1 ||
    typeof row.email !== 'string' ||
    row.email.length < 1 ||
    typeof row.providerKey !== 'string' ||
    row.providerKey.length < 1
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    providerKey: row.providerKey
  }
}

function normalizeLastLoginRow(row: unknown, fallbackMessage: string): LastLoginRow {
  if (!isRecord(row)) {
    throw new Error(fallbackMessage)
  }

  if (
    typeof row.id !== 'number' ||
    !Number.isInteger(row.id) ||
    typeof row.name !== 'string' ||
    row.name.length < 1 ||
    typeof row.lastLoginAt !== 'string' ||
    row.lastLoginAt.length < 1
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    id: row.id,
    name: row.name,
    lastLoginAt: row.lastLoginAt
  }
}

export async function searchUsers(fetchImpl: FetchImpl, query: unknown, fallbackMessage = 'User search response is invalid'): Promise<UserSearchRow[]> {
  const normalizedQuery = typeof query === 'string' ? query.trim() : ''
  if (normalizedQuery.length < 2) {
    return []
  }

  const response = await sameOriginJsonFetch(fetchImpl, `/_api/users/search?query=${encodeURIComponent(normalizedQuery)}`, {
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

export async function fetchLastLogins(fetchImpl: FetchImpl, fallbackMessage = 'Last logins response is invalid'): Promise<LastLoginRow[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/users/last-logins', {
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

export type Profile = {
  id: number
  email: string
  name: string
  handle: string
  providerKey: string
  providerName: string
  pictureUrl: string | null
  isSystem: boolean
  isVerified: boolean
  location: string
  jobTitle: string
  timezone: string
  dateFormat: string
  timeFormat: UserTimeFormat
  appearance: string
  reduceMotion: boolean
  underlineLinks: boolean
  contentTextSize: UserContentTextSize
  communicationLocale: UserCommunicationLocale
  createdAt: string
  updatedAt: string
  lastLoginAt: string
  groups: string[]
  pagesTotal: number
}

type ProfileUpdateInput = {
  name: string
  handle: string
  location: string
  jobTitle: string
  timezone: string
  dateFormat: string
  timeFormat: UserTimeFormat
  appearance: string
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function normalizeProfile(payload: unknown, fallbackMessage: string): Profile {
  const communicationLocale = UserCommunicationLocaleSchema.safeParse(isRecord(payload) ? payload.communicationLocale : undefined)
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'number' ||
    typeof payload.email !== 'string' ||
    typeof payload.name !== 'string' ||
    typeof payload.handle !== 'string' ||
    typeof payload.providerKey !== 'string' ||
    typeof payload.providerName !== 'string' ||
    (payload.pictureUrl !== null && typeof payload.pictureUrl !== 'string') ||
    typeof payload.isSystem !== 'boolean' ||
    typeof payload.isVerified !== 'boolean' ||
    typeof payload.location !== 'string' ||
    typeof payload.jobTitle !== 'string' ||
    typeof payload.timezone !== 'string' ||
    typeof payload.dateFormat !== 'string' ||
    typeof payload.appearance !== 'string' ||
    typeof payload.reduceMotion !== 'boolean' ||
    typeof payload.underlineLinks !== 'boolean' ||
    !isUserContentTextSize(payload.contentTextSize) ||
    !communicationLocale.success ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.updatedAt !== 'string' ||
    typeof payload.lastLoginAt !== 'string' ||
    !isStringArray(payload.groups) ||
    typeof payload.pagesTotal !== 'number'
  ) {
    throw new Error(fallbackMessage)
  }
  const timeFormat = payload.timeFormat === undefined ? 'locale' : payload.timeFormat
  if (typeof timeFormat !== 'string' || !isUserTimeFormat(timeFormat)) throw new Error(fallbackMessage)
  return {
    id: payload.id,
    email: payload.email,
    name: payload.name,
    handle: payload.handle,
    providerKey: payload.providerKey,
    pictureUrl: payload.pictureUrl as string | null,
    providerName: payload.providerName,
    isSystem: payload.isSystem,
    isVerified: payload.isVerified,
    location: payload.location,
    jobTitle: payload.jobTitle,
    timezone: payload.timezone,
    dateFormat: payload.dateFormat,
    timeFormat,
    appearance: payload.appearance,
    reduceMotion: payload.reduceMotion,
    underlineLinks: payload.underlineLinks,
    contentTextSize: payload.contentTextSize,
    communicationLocale: communicationLocale.data,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    lastLoginAt: payload.lastLoginAt,
    groups: payload.groups,
    pagesTotal: payload.pagesTotal
  }
}

export async function fetchProfile(fetchImpl: FetchImpl, fallbackMessage = 'Profile response is invalid'): Promise<Profile> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/users/profile', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  return normalizeProfile(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export type ProfileAvatarMutationResult = {
  message: string
  pictureUrl: string | null
}

function normalizeProfileAvatarMutation(payload: unknown, fallbackMessage: string): ProfileAvatarMutationResult {
  if (
    !isRecord(payload) ||
    typeof payload.message !== 'string' ||
    payload.message.length < 1 ||
    (payload.pictureUrl !== null && typeof payload.pictureUrl !== 'string') ||
    'token' in payload ||
    'jwt' in payload
  )
    throw new Error(fallbackMessage)
  return {
    message: payload.message,
    pictureUrl: payload.pictureUrl as string | null
  }
}

export async function uploadProfileAvatar(
  fetchImpl: FetchImpl,
  expectedAccountId: number,
  file: File,
  fallbackMessage = 'Profile avatar upload failed'
): Promise<ProfileAvatarMutationResult> {
  const form = new FormData()
  form.append('image', file, file.name)
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/users/profile/avatar', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-TsEpistle-Profile-Account': String(expectedAccountId) },
    body: form
  })
  return normalizeProfileAvatarMutation(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function removeProfileAvatar(fetchImpl: FetchImpl, expectedAccountId: number, fallbackMessage = 'Profile avatar removal failed'): Promise<ProfileAvatarMutationResult> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/users/profile/avatar', {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-TsEpistle-Profile-Account': String(expectedAccountId) }
  })
  return normalizeProfileAvatarMutation(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function sendProfileRequest(fetchImpl: FetchImpl, expectedAccountId: number, path: string, method: string, body: unknown, fallbackMessage: string): Promise<string> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/users/profile${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-TsEpistle-Profile-Account': String(expectedAccountId)
    },
    body: JSON.stringify(body)
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1 || 'token' in payload || 'jwt' in payload) {
    throw new Error(fallbackMessage)
  }
  return payload.message
}

export function updateProfile(fetchImpl: FetchImpl, expectedAccountId: number, input: ProfileUpdateInput, fallbackMessage = 'Profile update failed'): Promise<string> {
  return sendProfileRequest(fetchImpl, expectedAccountId, '', 'PATCH', input, fallbackMessage)
}
export function updateProfilePreferences(
  fetchImpl: FetchImpl,
  expectedAccountId: number,
  input: ProfilePreferencesInput,
  fallbackMessage = 'Profile preferences update failed'
): Promise<string> {
  return sendProfileRequest(fetchImpl, expectedAccountId, '/preferences', 'PATCH', input, fallbackMessage)
}

export function changeProfilePassword(fetchImpl: FetchImpl, expectedAccountId: number, current: string, newPassword: string, fallbackMessage = 'Password change failed'): Promise<string> {
  return sendProfileRequest(fetchImpl, expectedAccountId, '/password', 'POST', { current, newPassword }, fallbackMessage)
}
