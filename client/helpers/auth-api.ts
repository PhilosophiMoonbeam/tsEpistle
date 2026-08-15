import { isRecord } from './type-guards'

type JsonResponse = { ok: boolean, headers?: { get: (name: string) => string | null }, json: () => Promise<unknown> }
type FetchImpl = (url: string, init: RequestInit) => Promise<JsonResponse>

function isFiniteNumber (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function getErrorMessage (payload: unknown, fallbackMessage: string): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error.length > 0) {
    return payload.error
  }
  if (isRecord(payload) && typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message
  }
  return fallbackMessage
}

export type AuthResponse = {
  continuationToken?: string
  mustChangePwd?: boolean
  mustProvideTFA?: boolean
  mustSetupTFA?: boolean
  tfaQRImage?: string
  tfaSecret?: string
  jwt?: string
  redirect?: string
}

export type AuthStrategy = {
  key: string
  displayName: string
  order: number
  selfRegistration: boolean
  strategy: {
    useForm: boolean
    usernameType: string
    color: string
    icon: string
  }
}

function isValidAuthResponse (payload: unknown): payload is AuthResponse {
  if (!isRecord(payload)) {
    return false
  }

  if (payload.mustChangePwd === true || payload.mustProvideTFA === true) {
    return typeof payload.continuationToken === 'string' && payload.continuationToken.length > 0
  }

  if (payload.mustSetupTFA === true) {
    return typeof payload.continuationToken === 'string' && payload.continuationToken.length > 0 &&
      typeof payload.tfaQRImage === 'string' && payload.tfaQRImage.length > 0 &&
      typeof payload.tfaSecret === 'string' && payload.tfaSecret.length > 0
  }

  return typeof payload.jwt === 'string' && payload.jwt.length > 0
}

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const contentType = response.headers?.get('content-type') || ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, fallbackMessage))
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function parseConfigJson (value: string, fallbackMessage: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) {
      throw new Error(fallbackMessage)
    }
    return parsed
  } catch (err) {
    throw new Error(fallbackMessage, { cause: err })
  }
}

export type AdminAuthProperty = Record<string, unknown> & {
  key: string
  default?: unknown
  order?: number
}

export type AdminAuthStrategy = {
  key: string
  title: string
  description: string
  logo: string
  website: string
  isAvailable: boolean
  isDisabled: boolean
  props: AdminAuthProperty[]
}

export type AdminActiveAuthConfig = {
  key: string
  value: Record<string, unknown> & {
    value?: unknown
    order?: number
  }
}

export type AdminActiveAuthStrategy = {
  key: string
  strategy: AdminAuthStrategy
  config: AdminActiveAuthConfig[]
  order: number
  isEnabled: boolean
  displayName: string
  selfRegistration: boolean
  domainWhitelist: string[]
  autoEnrollGroups: number[]
}

function normalizeAdminAuthStrategy (value: unknown, fallbackMessage: string): AdminAuthStrategy {
  if (!isRecord(value) || typeof value.key !== 'string' || value.key.length < 1 || typeof value.isAvailable !== 'boolean' || !Array.isArray(value.props)) {
    throw new Error(fallbackMessage)
  }

  const props = value.props.map((configValue: unknown): AdminAuthProperty => {
    if (!isRecord(configValue) || typeof configValue.key !== 'string' || configValue.key.length < 1 || typeof configValue.value !== 'string') {
      throw new Error(fallbackMessage)
    }
    return {
      key: configValue.key,
      ...parseConfigJson(configValue.value, fallbackMessage)
    }
  }).sort((left, right) => {
    const leftOrder = isFiniteNumber(left.order) ? left.order : 0
    const rightOrder = isFiniteNumber(right.order) ? right.order : 0
    return leftOrder - rightOrder
  })

  return {
    ...value,
    isDisabled: !value.isAvailable || value.key === 'local',
    props
  } as AdminAuthStrategy
}

function normalizeAdminActiveAuthStrategy (value: unknown, fallbackMessage: string): AdminActiveAuthStrategy {
  if (!isRecord(value) || typeof value.key !== 'string' || value.key.length < 1 || !isRecord(value.strategy) || typeof value.strategy.key !== 'string' || !Array.isArray(value.config) || !isFiniteNumber(value.order) || typeof value.isEnabled !== 'boolean' || typeof value.displayName !== 'string' || typeof value.selfRegistration !== 'boolean' || !Array.isArray(value.domainWhitelist) || !Array.isArray(value.autoEnrollGroups)) {
    throw new Error(fallbackMessage)
  }

  const config = value.config.map((configValue: unknown): AdminActiveAuthConfig => {
    if (!isRecord(configValue) || typeof configValue.key !== 'string' || configValue.key.length < 1 || typeof configValue.value !== 'string') {
      throw new Error(fallbackMessage)
    }
    return {
      ...configValue,
      value: parseConfigJson(configValue.value, fallbackMessage)
    } as AdminActiveAuthConfig
  }).sort((left, right) => {
    const leftOrder = isFiniteNumber(left.value.order) ? left.value.order : 0
    const rightOrder = isFiniteNumber(right.value.order) ? right.value.order : 0
    return leftOrder - rightOrder
  })

  return {
    ...value,
    config
  } as AdminActiveAuthStrategy
}

export async function fetchAdminAuthStrategies (fetchImpl: FetchImpl, fallbackMessage = 'Authentication strategies response is invalid'): Promise<AdminAuthStrategy[]> {
  const response = await fetchImpl('/_api/auth/admin/strategies', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(strategy => normalizeAdminAuthStrategy(strategy, fallbackMessage))
}

export async function fetchAdminAuthActiveStrategies (fetchImpl: FetchImpl, fallbackMessage = 'Active authentication strategies response is invalid'): Promise<AdminActiveAuthStrategy[]> {
  const response = await fetchImpl('/_api/auth/admin/active-strategies', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(strategy => normalizeAdminActiveAuthStrategy(strategy, fallbackMessage)).sort((left, right) => {
    const leftOrder = Number.isFinite(left.order) ? left.order : 0
    const rightOrder = Number.isFinite(right.order) ? right.order : 0
    return leftOrder - rightOrder
  })
}

export async function fetchAuthStrategies (fetchImpl: FetchImpl, fallbackMessage = 'Authentication strategies response is invalid'): Promise<AuthStrategy[]> {
  const response = await fetchImpl('/_api/auth/strategies', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map((value: unknown) => {
    if (!isRecord(value) || typeof value.key !== 'string' || typeof value.displayName !== 'string' || !isFiniteNumber(value.order) || typeof value.selfRegistration !== 'boolean' || !isRecord(value.strategy) || typeof value.strategy.useForm !== 'boolean' || typeof value.strategy.usernameType !== 'string' || typeof value.strategy.color !== 'string' || typeof value.strategy.icon !== 'string') {
      throw new Error(fallbackMessage)
    }
    return value as AuthStrategy
  }).sort((left, right) => left.order - right.order)
}

export type AdminAuthProviderSummary = {
  key: string
  displayName: string
  order: number
  isEnabled: boolean
}

export async function fetchAdminAuthProviders (fetchImpl: FetchImpl, fallbackMessage = 'Admin authentication providers response is invalid'): Promise<AdminAuthProviderSummary[]> {
  const response = await fetchImpl('/_api/auth/providers', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map((value: unknown) => {
    if (!isRecord(value) || typeof value.key !== 'string' || value.key.length < 1 || typeof value.displayName !== 'string' || value.displayName.length < 1 || !isFiniteNumber(value.order) || typeof value.isEnabled !== 'boolean') {
      throw new Error(fallbackMessage)
    }

    return value as AdminAuthProviderSummary
  }).sort((left, right) => left.order - right.order)
}

export type AdminApiKey = {
  id: number
  name: string
  keyShort: string
  isRevoked: boolean
  expiration: string
  createdAt: string
  updatedAt: string
}

export type AdminApiBootstrap = {
  enabled: boolean
  keys: AdminApiKey[]
}

function isValidAdminApiKeyShort (keyShort: string): boolean {
  return /^\.\.\..{20}$/.test(keyShort) || keyShort === '...[redacted]'
}

function normalizeAdminApiKey (value: unknown, fallbackMessage: string): AdminApiKey {
  if (!isRecord(value) || !isFiniteNumber(value.id) || typeof value.name !== 'string' || value.name.length < 1 || typeof value.keyShort !== 'string' || !isValidAdminApiKeyShort(value.keyShort) || typeof value.isRevoked !== 'boolean' || typeof value.expiration !== 'string' || value.expiration.length < 1 || typeof value.createdAt !== 'string' || value.createdAt.length < 1 || typeof value.updatedAt !== 'string' || value.updatedAt.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    id: value.id,
    name: value.name,
    keyShort: value.keyShort,
    isRevoked: value.isRevoked,
    expiration: value.expiration,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

export async function fetchAdminApiBootstrap (fetchImpl: FetchImpl, fallbackMessage = 'Admin API bootstrap response is invalid'): Promise<AdminApiBootstrap> {
  const response = await fetchImpl('/_api/auth/api', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.enabled !== 'boolean' || !Array.isArray(payload.keys)) {
    throw new Error(fallbackMessage)
  }

  return {
    enabled: payload.enabled,
    keys: payload.keys.map((key: unknown) => normalizeAdminApiKey(key, fallbackMessage))
  }
}

export type StatusResponse = Record<string, unknown> & {
  message: string
}

export type AdminApiKeyInput = {
  name: string
  expiration: string
  fullAccess: boolean
  group: number | null
}

export type AdminApiKeyCreationResponse = {
  key: string
  message: string
}

async function postJson (fetchImpl: FetchImpl, path: string, body: unknown, fallbackMessage: string): Promise<unknown> {
  const response = await fetchImpl(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  return parseJsonResponse(response, fallbackMessage)
}

export async function submitAuthRequest (fetchImpl: FetchImpl, path: string, body: unknown, fallbackMessage = 'Authentication request failed'): Promise<AuthResponse> {
  const payload = await postJson(fetchImpl, path, body, fallbackMessage)
  if (!isValidAuthResponse(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload
}

export async function submitStatusRequest (fetchImpl: FetchImpl, path: string, body: unknown, fallbackMessage = 'Authentication request failed'): Promise<StatusResponse> {
  const payload = await postJson(fetchImpl, path, body, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload as StatusResponse
}

export async function updateAdminAuthStrategies (fetchImpl: FetchImpl, strategies: readonly unknown[], fallbackMessage = 'Authentication strategies update failed'): Promise<StatusResponse> {
  return submitStatusRequest(fetchImpl, '/_api/auth/strategies', { strategies }, fallbackMessage)
}

export async function setAdminApiState (fetchImpl: FetchImpl, enabled: boolean, fallbackMessage = 'API state update failed'): Promise<StatusResponse> {
  return submitStatusRequest(fetchImpl, '/_api/auth/api/state', { enabled }, fallbackMessage)
}

export async function revokeAdminApiKey (fetchImpl: FetchImpl, id: number | string, fallbackMessage = 'API key revoke failed'): Promise<StatusResponse> {
  return submitStatusRequest(fetchImpl, `/_api/auth/api/keys/${encodeURIComponent(id)}/revoke`, {}, fallbackMessage)
}

export async function createAdminApiKey (fetchImpl: FetchImpl, payload: AdminApiKeyInput, fallbackMessage = 'API key creation failed'): Promise<AdminApiKeyCreationResponse> {
  const responsePayload = await submitStatusRequest(fetchImpl, '/_api/auth/api/keys', {
    name: payload.name,
    expiration: payload.expiration,
    fullAccess: payload.fullAccess,
    group: payload.group
  }, fallbackMessage)

  if (typeof responsePayload.key !== 'string' || responsePayload.key.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    key: responsePayload.key,
    message: responsePayload.message
  }
}

export async function regenerateAuthCertificates (fetchImpl: FetchImpl, fallbackMessage = 'Certificate regeneration failed'): Promise<StatusResponse> {
  return submitStatusRequest(fetchImpl, '/_api/auth/certificates/regenerate', {}, fallbackMessage)
}

export async function resetGuestUser (fetchImpl: FetchImpl, fallbackMessage = 'Guest user reset failed'): Promise<StatusResponse> {
  return submitStatusRequest(fetchImpl, '/_api/auth/guest/reset', {}, fallbackMessage)
}

export async function registerAccount (fetchImpl: FetchImpl, input: { email: string, password: string, name: string }, fallbackMessage = 'Registration failed'): Promise<StatusResponse> {
  return submitStatusRequest(fetchImpl, '/_api/auth/register', input, fallbackMessage)
}
