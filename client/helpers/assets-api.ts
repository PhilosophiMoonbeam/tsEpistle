import { isRecord } from './type-guards'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

async function parseResponse (response: Response, fallbackMessage: string): Promise<unknown> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(isRecord(payload) && typeof payload.error === 'string' ? payload.error : fallbackMessage)
  }
  return payload
}

async function sendJson (fetchImpl: FetchImpl, url: string, method: string, body: unknown, fallbackMessage: string): Promise<void> {
  const response = await fetchImpl(url, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  await parseResponse(response, fallbackMessage)
}

export async function fetchAssets (fetchImpl: FetchImpl, folderId: number, kind = 'ALL', fallbackMessage = 'Asset list failed'): Promise<any[]> {
  const response = await fetchImpl(`/_api/assets?folderId=${encodeURIComponent(folderId)}&kind=${encodeURIComponent(kind)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload
}

export async function fetchAssetFolders (fetchImpl: FetchImpl, parentFolderId: number, fallbackMessage = 'Asset folder list failed'): Promise<any[]> {
  const response = await fetchImpl(`/_api/assets/folders?parentFolderId=${encodeURIComponent(parentFolderId)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const payload = await parseResponse(response, fallbackMessage)
  if (!Array.isArray(payload)) throw new Error(fallbackMessage)
  return payload
}

export function createAssetFolder (fetchImpl: FetchImpl, parentFolderId: number, slug: string, fallbackMessage = 'Asset folder creation failed'): Promise<void> {
  return sendJson(fetchImpl, '/_api/assets/folders', 'POST', { parentFolderId, slug }, fallbackMessage)
}

export function renameAsset (fetchImpl: FetchImpl, id: number, filename: string, fallbackMessage = 'Asset rename failed'): Promise<void> {
  return sendJson(fetchImpl, `/_api/assets/${encodeURIComponent(id)}`, 'PATCH', { filename }, fallbackMessage)
}

export async function deleteAsset (fetchImpl: FetchImpl, id: number, fallbackMessage = 'Asset delete failed'): Promise<void> {
  const response = await fetchImpl(`/_api/assets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  await parseResponse(response, fallbackMessage)
}
