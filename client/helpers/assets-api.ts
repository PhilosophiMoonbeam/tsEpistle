import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

async function parseResponse(response: Response, fallbackMessage: string): Promise<unknown> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : fallbackMessage)
  }
  return payload
}

async function sendJson(fetchImpl: FetchImpl, url: string, method: string, body: unknown, fallbackMessage: string): Promise<void> {
  const response = await sameOriginJsonFetch(fetchImpl, url, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  await parseResponse(response, fallbackMessage)
}

export type Asset = {
  id: number
  filename: string
  description: string
  ext: string
  fileSize: number
  createdAt: string
  kind: string
}

export type AssetFolder = {
  id: number
  name: string
  slug: string
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

export async function fetchAssetFolders(fetchImpl: FetchImpl, parentFolderId: number, fallbackMessage = 'Asset folder list failed'): Promise<AssetFolder[]> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/assets/folders?parentFolderId=${encodeURIComponent(parentFolderId)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload.map(row => normalizeAssetFolder(row, fallbackMessage))
}

export function createAssetFolder(fetchImpl: FetchImpl, parentFolderId: number, slug: string, fallbackMessage = 'Asset folder creation failed'): Promise<void> {
  return sendJson(fetchImpl, '/_api/assets/folders', 'POST', { parentFolderId, slug }, fallbackMessage)
}

export function renameAsset(fetchImpl: FetchImpl, id: number, filename: string, fallbackMessage = 'Asset rename failed'): Promise<void> {
  return sendJson(fetchImpl, `/_api/assets/${encodeURIComponent(id)}`, 'PATCH', { filename }, fallbackMessage)
}

export async function deleteAsset(fetchImpl: FetchImpl, id: number, fallbackMessage = 'Asset delete failed'): Promise<void> {
  const response = await sameOriginJsonFetch(fetchImpl, `/_api/assets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  await parseResponse(response, fallbackMessage)
}
