import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'
import { ProductMetadataSchema, type ProductMetadata } from '../../shared/product.ts'

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
  workingDirectory: string
  upgradeCapable: boolean
}

const parseJsonResponse = async (response: Response, fallbackMessage: string): Promise<unknown> => {
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string' && payload.error) throw new Error(payload.error)
    throw new Error(fallbackMessage)
  }
  if (payload === null) throw new Error(fallbackMessage)
  return payload
}

const request = async (fetchImpl: FetchImpl, method: string, path: string, body: unknown, fallbackMessage: string) =>
  parseJsonResponse(
    await sameOriginJsonFetch(fetchImpl, path, {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    fallbackMessage
  )

const normalizeSummary = (payload: unknown, fallbackMessage: string): SystemSummary => {
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  const product = ProductMetadataSchema.safeParse(payload.product)
  if (!product.success || payload.currentVersion !== product.data.version) throw new Error(fallbackMessage)
  if (
    (typeof payload.latestVersion !== 'string' && payload.latestVersion !== null) ||
    (typeof payload.latestVersionReleaseDate !== 'string' && payload.latestVersionReleaseDate !== null)
  )
    throw new Error(fallbackMessage)
  if (!['unavailable', 'current', 'available'].includes(String(payload.updateStatus))) throw new Error(fallbackMessage)
  for (const key of ['groupsTotal', 'pagesTotal', 'usersTotal', 'tagsTotal'])
    if (typeof payload[key] !== 'number' || !Number.isFinite(payload[key])) throw new Error(fallbackMessage)
  return payload as SystemSummary
}

export const fetchSystemSummary = async (fetchImpl: FetchImpl, fallbackMessage = 'System summary response is invalid') =>
  normalizeSummary(await request(fetchImpl, 'GET', '/_api/system/summary', undefined, fallbackMessage), fallbackMessage)

export const fetchSystemInfo = async (fetchImpl: FetchImpl, fallbackMessage = 'System info response is invalid'): Promise<SystemInfo> => {
  const payload = await request(fetchImpl, 'GET', '/_api/system/info', undefined, fallbackMessage)
  const summary = normalizeSummary(payload, fallbackMessage)
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  for (const key of ['configFile', 'dbHost', 'dbType', 'dbVersion', 'hostname', 'bunVersion', 'operatingSystem', 'platform', 'ramTotal', 'workingDirectory'])
    if (typeof payload[key] !== 'string') throw new Error(fallbackMessage)
  if (typeof payload.cpuCores !== 'number' || !Number.isFinite(payload.cpuCores) || typeof payload.upgradeCapable !== 'boolean')
    throw new Error(fallbackMessage)
  return { ...summary, ...payload } as SystemInfo
}

export const fetchSystemHost = async (fetchImpl: FetchImpl, fallbackMessage = 'Site host response is invalid') => {
  const payload = await request(fetchImpl, 'GET', '/_api/system/host', undefined, fallbackMessage)
  if (!isRecord(payload) || typeof payload.host !== 'string') throw new Error(fallbackMessage)
  return { host: payload.host }
}

export const renderPage = async (fetchImpl: FetchImpl, id: number, fallbackMessage = 'Page render failed') => {
  const payload = await request(fetchImpl, 'POST', '/_api/system/content/render-page', { id }, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string') throw new Error(fallbackMessage)
  return payload
}

export const performSystemUpgrade = async (fetchImpl: FetchImpl, fallbackMessage = 'Upgrade failed') => {
  const payload = await request(fetchImpl, 'POST', '/_api/system/upgrade', undefined, fallbackMessage)
  if (!isRecord(payload) || typeof payload.message !== 'string') throw new Error(fallbackMessage)
  return payload
}
