import { createProductMetadata, type ProductMetadata } from '../../shared/product.ts'

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>


export type UpdateStatus = 'unavailable' | 'current' | 'available'

export type SystemSummary = {
  product: ProductMetadata
  currentVersion: string
  latestVersion: string | null
  latestVersionReleaseDate: string | null
  updateStatus: UpdateStatus
  groupsTotal: number
  pagesTotal: number
  usersTotal: number
  tagsTotal: number
}
export type SystemInfo = SystemSummary & {
  configFile: string
  cpuCores: number
  dbHost: string
  dbType: string
  dbVersion: string
  hostname: string
  bunVersion: string
  operatingSystem: string
  platform: string
  ramTotal: string
  upgradeCapable: boolean
  workingDirectory: string
}

export type SystemSslInfo = {
  httpPort: number
  httpRedirection: boolean
  httpsPort: number
  sslDomain: string | null
  sslExpirationDate: string | null
  sslProvider: string | null
  sslStatus: string
  sslSubscriberEmail: string | null
}

export type SystemFlags = Record<string, boolean>

export type SystemExtension = {
  key: string
  title: string
  description: string
  isInstalled: boolean
  isCompatible: boolean
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function parseJsonResponse (response: Response, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers.get('content-type') || '' : ''

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

function normalizeFlagsPayload (payload: unknown, fallbackMessage: string): SystemFlags {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.reduce<SystemFlags>((result, row) => {
    if (!isRecord(row) || typeof row.key !== 'string' || typeof row.value !== 'boolean') {
      throw new Error(fallbackMessage)
    }
    result[row.key] = row.value
    return result
  }, {})
}

function normalizeProductMetadata (payload: Record<string, unknown>, fallbackMessage: string): ProductMetadata {
  const value = payload.product
  if (!isRecord(value) || typeof value.revision !== 'string' || typeof value.date !== 'string') {
    throw new Error(fallbackMessage)
  }
  let expected: ProductMetadata
  try {
    expected = createProductMetadata({ revision: value.revision, date: value.date })
  } catch {
    throw new Error(fallbackMessage)
  }
  if (Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) {
    throw new Error(fallbackMessage)
  }
  return expected
}

function normalizeSystemSummaryPayload (payload: unknown, fallbackMessage: string): SystemSummary {
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  const product = normalizeProductMetadata(payload, fallbackMessage)
  if (payload.currentVersion !== product.version) throw new Error(fallbackMessage)
  if (typeof payload.latestVersion !== 'string' && payload.latestVersion !== null) throw new Error(fallbackMessage)
  if (typeof payload.latestVersionReleaseDate !== 'string' && payload.latestVersionReleaseDate !== null) throw new Error(fallbackMessage)
  if (payload.updateStatus !== 'unavailable' && payload.updateStatus !== 'current' && payload.updateStatus !== 'available') throw new Error(fallbackMessage)
  if (
    typeof payload.groupsTotal !== 'number' ||
    typeof payload.pagesTotal !== 'number' ||
    typeof payload.usersTotal !== 'number' ||
    typeof payload.tagsTotal !== 'number' ||
    !Number.isFinite(payload.groupsTotal) ||
    !Number.isFinite(payload.pagesTotal) ||
    !Number.isFinite(payload.usersTotal) ||
    !Number.isFinite(payload.tagsTotal)
  ) throw new Error(fallbackMessage)
  return {
    product,
    currentVersion: product.version,
    latestVersion: payload.latestVersion,
    latestVersionReleaseDate: payload.latestVersionReleaseDate,
    updateStatus: payload.updateStatus,
    groupsTotal: payload.groupsTotal,
    pagesTotal: payload.pagesTotal,
    usersTotal: payload.usersTotal,
    tagsTotal: payload.tagsTotal
  }
}

function normalizeSystemInfoPayload (payload: unknown, fallbackMessage: string): SystemInfo {
  if (!isRecord(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredStringFields = [
    'configFile',
    'currentVersion',
    'dbHost',
    'dbType',
    'dbVersion',
    'hostname',
    'bunVersion',
    'operatingSystem',
    'platform',
    'ramTotal',
    'workingDirectory'
  ]
  const requiredNumberFields = ['cpuCores']

  if (requiredStringFields.some(field => typeof payload[field] !== 'string')) {
    throw new Error(fallbackMessage)
  }
  if (requiredNumberFields.some(field => !Number.isFinite(payload[field]))) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.upgradeCapable !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.latestVersionReleaseDate !== 'string' && payload.latestVersionReleaseDate !== null) {
    throw new Error(fallbackMessage)
  }
  normalizeSystemSummaryPayload(payload, fallbackMessage)

  return payload as SystemInfo
}

function normalizeSystemTelemetryPayload (payload: unknown, fallbackMessage: string) {
  if (!isRecord(payload)) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.telemetry !== 'boolean') {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.telemetryClientId !== 'string' && payload.telemetryClientId !== null) {
    throw new Error(fallbackMessage)
  }

  return {
    telemetry: payload.telemetry,
    telemetryClientId: payload.telemetryClientId
  }
}

function normalizeSystemExportStatusPayload (payload: unknown, fallbackMessage: string) {
  if (!isRecord(payload)) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.status !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.progress !== 'number' || !Number.isFinite(payload.progress)) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.message !== 'string' && payload.message !== null) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.startedAt !== 'string' && payload.startedAt !== null) {
    throw new Error(fallbackMessage)
  }

  return {
    status: payload.status,
    progress: payload.progress,
    message: payload.message,
    startedAt: payload.startedAt
  }
}

function normalizeSystemHostPayload (payload: unknown, fallbackMessage: string) {
  if (!isRecord(payload)) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.host !== 'string') {
    throw new Error(fallbackMessage)
  }

  return {
    host: payload.host
  }
}

function normalizeSystemSslPayload (payload: unknown, fallbackMessage: string): SystemSslInfo {
  if (!isRecord(payload)) {
    throw new Error(fallbackMessage)
  }

  const requiredNumberFields = ['httpPort', 'httpsPort']
  const nullableStringFields = ['sslDomain', 'sslExpirationDate', 'sslProvider', 'sslSubscriberEmail']

  if (requiredNumberFields.some(field => !Number.isFinite(payload[field]))) {
    throw new Error(fallbackMessage)
  }
  if (typeof payload.httpRedirection !== 'boolean' || typeof payload.sslStatus !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (nullableStringFields.some(field => typeof payload[field] !== 'string' && payload[field] !== null)) {
    throw new Error(fallbackMessage)
  }

  return {
    httpPort: payload.httpPort,
    httpRedirection: payload.httpRedirection,
    httpsPort: payload.httpsPort,
    sslDomain: payload.sslDomain,
    sslExpirationDate: payload.sslExpirationDate,
    sslProvider: payload.sslProvider,
    sslStatus: payload.sslStatus,
    sslSubscriberEmail: payload.sslSubscriberEmail
  } as SystemSslInfo
}

function normalizeSystemExtension (row: unknown, fallbackMessage: string): SystemExtension {
  if (!isRecord(row)) {
    throw new Error(fallbackMessage)
  }

  if (typeof row.key !== 'string' || typeof row.title !== 'string' || typeof row.description !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (typeof row.isInstalled !== 'boolean' || typeof row.isCompatible !== 'boolean') {
    throw new Error(fallbackMessage)
  }

  return {
    key: row.key,
    title: row.title,
    description: row.description,
    isInstalled: row.isInstalled,
    isCompatible: row.isCompatible
  }
}

function normalizeSystemExtensionsPayload (payload: unknown, fallbackMessage: string): SystemExtension[] {
  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(row => normalizeSystemExtension(row, fallbackMessage))
}

async function fetchSystemSummary (fetchImpl: FetchImpl, fallbackMessage = 'System summary response is invalid') {
  const response = await fetchImpl('/_api/system/summary', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemSummaryPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemInfo (fetchImpl: FetchImpl, fallbackMessage = 'System info response is invalid') {
  const response = await fetchImpl('/_api/system/info', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemInfoPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemTelemetry (fetchImpl: FetchImpl, fallbackMessage = 'System telemetry response is invalid') {
  const response = await fetchImpl('/_api/system/telemetry', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemTelemetryPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemExportStatus (fetchImpl: FetchImpl, fallbackMessage = 'Export status response is invalid') {
  const response = await fetchImpl('/_api/system/export-status', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemExportStatusPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function startSystemExport (fetchImpl: FetchImpl, entities: string[], path: string, fallbackMessage = 'Export failed') {
  const response = await fetchImpl('/_api/system/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ entities, path })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function fetchSystemHost (fetchImpl: FetchImpl, fallbackMessage = 'Site host response is invalid') {
  const response = await fetchImpl('/_api/system/host', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemHostPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemSsl (fetchImpl: FetchImpl, fallbackMessage = 'SSL status response is invalid') {
  const response = await fetchImpl('/_api/system/ssl', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemSslPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function updateSystemSslRedirection (fetchImpl: FetchImpl, enabled: boolean, fallbackMessage = 'HTTP Redirection update failed') {
  const response = await fetchImpl('/_api/system/ssl/redirection', {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ enabled })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function renewSystemSslCertificate (fetchImpl: FetchImpl, fallbackMessage = 'SSL Certificate renewal failed') {
  const response = await fetchImpl('/_api/system/ssl/renew', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function fetchSystemFlags (fetchImpl: FetchImpl, fallbackMessage = 'System flags response is invalid'): Promise<SystemFlags> {
  const response = await fetchImpl('/_api/system/flags', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeFlagsPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function fetchSystemExtensions (fetchImpl: FetchImpl, fallbackMessage = 'System extensions response is invalid'): Promise<SystemExtension[]> {
  const response = await fetchImpl('/_api/system/extensions', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeSystemExtensionsPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

async function updateSystemFlags (fetchImpl: FetchImpl, flags: Record<string, boolean>, fallbackMessage = 'System flags update failed') {
  const response = await fetchImpl('/_api/system/flags', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      flags: Object.keys(flags).map(key => ({ key, value: flags[key] }))
    })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function updateSystemTelemetry (fetchImpl: FetchImpl, enabled: boolean, fallbackMessage = 'Telemetry update failed') {
  const response = await fetchImpl('/_api/system/telemetry', {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ enabled })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function resetSystemTelemetryClientId (fetchImpl: FetchImpl, fallbackMessage = 'Telemetry Client ID reset failed') {
  const response = await fetchImpl('/_api/system/telemetry/reset-client-id', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function flushSystemCache (fetchImpl: FetchImpl, fallbackMessage = 'Cache flush failed') {
  const response = await fetchImpl('/_api/system/cache/flush', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function flushSystemTemporaryUploads (fetchImpl: FetchImpl, fallbackMessage = 'Temporary Uploads flush failed') {
  const response = await fetchImpl('/_api/system/cache/temp-uploads/flush', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function rebuildPageTree (fetchImpl: FetchImpl, fallbackMessage = 'Page tree rebuild failed') {
  const response = await fetchImpl('/_api/system/content/rebuild-tree', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function migratePagesToLocale (fetchImpl: FetchImpl, sourceLocale: string, targetLocale: string, fallbackMessage = 'Locale migration failed') {
  const response = await fetchImpl('/_api/system/content/migrate-locale', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sourceLocale,
      targetLocale
    })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1 || typeof payload.count !== 'number' || !Number.isFinite(payload.count)) {
    throw new Error(fallbackMessage)
  }

  return {
    message: payload.message,
    count: payload.count
  }
}

async function renderPage (fetchImpl: FetchImpl, id: number, fallbackMessage = 'Page render failed') {
  const response = await fetchImpl('/_api/system/content/render-page', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ id })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function purgePageHistory (fetchImpl: FetchImpl, olderThan: string, fallbackMessage = 'Page history purge failed') {
  const response = await fetchImpl('/_api/system/content/purge-history', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ olderThan })
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function performSystemUpgrade (fetchImpl: FetchImpl, fallbackMessage = 'Upgrade failed') {
  const response = await fetchImpl('/_api/system/upgrade', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string' || payload.message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return payload
}

async function importV1Users (fetchImpl: FetchImpl, mongoDbConnString: string, groupMode: string, fallbackMessage = 'Wiki.js 1.x user import failed') {
  const response = await fetchImpl('/_api/system/import-v1/users', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mongoDbConnString, groupMode })
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  if (!isRecord(payload) || typeof payload.usersCount !== 'number' || !Number.isSafeInteger(payload.usersCount) || typeof payload.groupsCount !== 'number' || !Number.isSafeInteger(payload.groupsCount) || !Array.isArray(payload.failed)) {
    throw new Error(fallbackMessage)
  }
  return {
    usersCount: payload.usersCount,
    groupsCount: payload.groupsCount,
    failed: payload.failed
  }
}

export {
  fetchSystemSummary,
  fetchSystemInfo,
  fetchSystemTelemetry,
  fetchSystemExportStatus,
  startSystemExport,
  fetchSystemHost,
  fetchSystemSsl,
  updateSystemSslRedirection,
  renewSystemSslCertificate,
  fetchSystemFlags,
  fetchSystemExtensions,
  updateSystemFlags,
  updateSystemTelemetry,
  resetSystemTelemetryClientId,
  flushSystemCache,
  flushSystemTemporaryUploads,
  rebuildPageTree,
  migratePagesToLocale,
  renderPage,
  purgePageHistory,
  performSystemUpgrade,
  importV1Users
}
