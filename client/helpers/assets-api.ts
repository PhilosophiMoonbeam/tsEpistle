import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'
import { PageBrandingViewSchema, type PageBrandingView } from '../../shared/page-branding.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

async function parseResponse(response: Response, fallbackMessage: string): Promise<unknown> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : fallbackMessage)
  }
  return payload
}

async function sendJson<T = unknown>(fetchImpl: FetchImpl, url: string, method: string, body: unknown, fallbackMessage: string): Promise<T> {
  const response = await sameOriginJsonFetch(fetchImpl, url, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return (await parseResponse(response, fallbackMessage)) as T
}

export type Asset = {
  id: number
  filename: string
  description: string
  ext: string
  fileSize: number
  createdAt: string
  kind: string
  folderId?: number | null
}

export type AssetFolder = {
  id: number
  name: string
  slug: string
}

export type AssetRelocationInput = {
  filename?: string
  folderId?: number | null
}

export type AssetRelocationEffect = {
  id: string
  targetKey: string
  status: string
  lastError: string | null
}

export type AssetRelocationReceipt = {
  id: string
  assetId: number
  sourcePath: string
  destinationPath: string
  status: 'pending' | 'leased' | 'succeeded' | 'failed' | 'superseded'
  statusUrl: string
  effects: AssetRelocationEffect[]
}

function normalizeAsset(row: unknown, fallbackMessage: string): Asset {
  if (
    !isRecord(row) ||
    !Number.isInteger(row.id) ||
    typeof row.filename !== 'string' ||
    typeof row.ext !== 'string' ||
    typeof row.fileSize !== 'number' ||
    typeof row.createdAt !== 'string' ||
    typeof row.kind !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }
  if (row.description !== undefined && row.description !== null && typeof row.description !== 'string') {
    throw new Error(fallbackMessage)
  }
  if (row.folderId !== undefined && row.folderId !== null && !Number.isInteger(row.folderId)) throw new Error(fallbackMessage)
  return { ...row, description: typeof row.description === 'string' ? row.description : '' } as Asset
}

function normalizeAssetFolder(row: unknown, fallbackMessage: string): AssetFolder {
  if (!isRecord(row) || !Number.isInteger(row.id) || typeof row.name !== 'string' || typeof row.slug !== 'string') {
    throw new Error(fallbackMessage)
  }
  return row as unknown as AssetFolder
}

export async function fetchAssets(fetchImpl: FetchImpl, folderId: number, kind = 'ALL', fallbackMessage = 'Asset list failed'): Promise<Asset[]> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/assets?folderId=${encodeURIComponent(folderId)}&kind=${encodeURIComponent(kind)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizeAsset(row, fallbackMessage))
}

export async function fetchAssetBranding(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Asset branding descriptor failed'): Promise<PageBrandingView> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(fallbackMessage)
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/assets/${encodeURIComponent(id)}/branding`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseResponse(response, fallbackMessage)
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  const result = PageBrandingViewSchema.safeParse(payload.branding)
  if (!result.success) throw new Error(fallbackMessage)
  return result.data
}

export async function fetchAssetFolders(fetchImpl: FetchImpl, parentFolderId: number, fallbackMessage = 'Asset folder list failed'): Promise<AssetFolder[]> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/assets/folders?parentFolderId=${encodeURIComponent(parentFolderId)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizeAssetFolder(row, fallbackMessage))
}

export async function createAssetFolder(
  fetchImpl: FetchImpl,
  parentFolderId: number,
  slug: string,
  fallbackMessage = 'Asset folder creation failed'
): Promise<void> {
  await sendJson(fetchImpl, '/_api/assets/folders', 'POST', { parentFolderId, slug }, fallbackMessage)
}

const relocationStatuses: Record<string, true> = {
  pending: true,
  leased: true,
  succeeded: true,
  failed: true,
  superseded: true
}
const isPositiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const isRelocationStatus = (value: unknown): value is AssetRelocationReceipt['status'] => typeof value === 'string' && Object.hasOwn(relocationStatuses, value)

function normalizeRelocationInput(input: AssetRelocationInput, fallbackMessage: string): AssetRelocationInput {
  if (!isRecord(input)) throw new Error(fallbackMessage)
  const hasFilename = Object.hasOwn(input, 'filename')
  const hasFolderId = Object.hasOwn(input, 'folderId')
  if (!hasFilename && !hasFolderId) throw new Error(fallbackMessage)
  const filename = input.filename
  const folderId = input.folderId
  if (hasFilename && (typeof filename !== 'string' || filename.trim().length === 0)) throw new Error(fallbackMessage)
  if (hasFolderId && (folderId === undefined || (folderId !== null && (!Number.isSafeInteger(folderId) || folderId < 0)))) {
    throw new Error(fallbackMessage)
  }
  const normalized: AssetRelocationInput = {}
  if (hasFilename && typeof filename === 'string') normalized.filename = filename
  if (hasFolderId && folderId !== undefined) normalized.folderId = folderId
  return normalized
}

function normalizeAssetRelocation(payload: unknown, fallbackMessage: string): AssetRelocationReceipt {
  if (!isRecord(payload)) throw new Error(fallbackMessage)
  if (typeof payload.id !== 'string' || typeof payload.sourcePath !== 'string' || typeof payload.destinationPath !== 'string') {
    throw new Error(fallbackMessage)
  }
  const assetId = payload.assetId
  if (!isPositiveSafeInteger(assetId)) throw new Error(fallbackMessage)
  const status = payload.status
  if (!isRelocationStatus(status)) throw new Error(fallbackMessage)
  const statusUrl = payload.statusUrl
  if (typeof statusUrl !== 'string' || !statusUrl.startsWith('/_api/assets/relocations/')) throw new Error(fallbackMessage)
  const rawEffects = payload.effects
  if (!Array.isArray(rawEffects)) throw new Error(fallbackMessage)
  const effects = rawEffects.map(effect => {
    if (!isRecord(effect) || typeof effect.id !== 'string' || typeof effect.targetKey !== 'string' || typeof effect.status !== 'string') {
      throw new Error(fallbackMessage)
    }
    if (effect.lastError !== undefined && effect.lastError !== null && typeof effect.lastError !== 'string') throw new Error(fallbackMessage)
    return {
      id: effect.id,
      targetKey: effect.targetKey,
      status: effect.status,
      lastError: typeof effect.lastError === 'string' ? effect.lastError : null
    }
  })
  return {
    id: payload.id,
    assetId,
    sourcePath: payload.sourcePath,
    destinationPath: payload.destinationPath,
    status,
    statusUrl,
    effects
  }
}

export async function relocateAsset(
  fetchImpl: FetchImpl,
  id: number,
  input: AssetRelocationInput,
  fallbackMessage = 'Asset relocation failed'
): Promise<AssetRelocationReceipt> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(fallbackMessage)
  const normalizedInput = normalizeRelocationInput(input, fallbackMessage)
  const payload = await sendJson(fetchImpl, `/_api/assets/${encodeURIComponent(id)}`, 'PATCH', normalizedInput, fallbackMessage)
  return normalizeAssetRelocation(payload, fallbackMessage)
}

export async function renameAsset(fetchImpl: FetchImpl, id: number, filename: string, fallbackMessage = 'Asset rename failed'): Promise<void> {
  await relocateAsset(fetchImpl, id, { filename }, fallbackMessage)
}

export async function fetchAssetRelocationStatus(
  fetchImpl: FetchImpl,
  statusUrl: string,
  fallbackMessage = 'Asset relocation status is unavailable'
): Promise<AssetRelocationReceipt> {
  if (typeof statusUrl !== 'string' || !statusUrl.startsWith('/_api/assets/relocations/')) throw new Error(fallbackMessage)
  const response = await sameOriginJsonFetch(fetchImpl, statusUrl, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseResponse(response, fallbackMessage)
  return normalizeAssetRelocation(payload, fallbackMessage)
}

export async function deleteAsset(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Asset delete failed'): Promise<void> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/assets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  await parseResponse(response, fallbackMessage)
}
