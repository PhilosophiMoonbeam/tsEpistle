import type { ContentExtensionDefinition, ContentExtensionKey } from '../../shared/content-extensions.ts'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options: RequestInit) => Promise<JsonResponse>

export type ContentExtensionStatus = ContentExtensionDefinition & {
  isEnabled: boolean
  compatible: boolean
  diagnostic: string | null
}

export type ContentExtensionsStatus = {
  hostVersion: number
  extensions: ContentExtensionStatus[]
}


function normalizeExtension (input: unknown, fallbackMessage: string): ContentExtensionStatus {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(fallbackMessage)
  const key = Reflect.get(input, 'key')
  const version = Reflect.get(input, 'version')
  const title = Reflect.get(input, 'title')
  const description = Reflect.get(input, 'description')
  const icon = Reflect.get(input, 'icon')
  const isEnabled = Reflect.get(input, 'isEnabled')
  const compatible = Reflect.get(input, 'compatible')
  const diagnostic = Reflect.get(input, 'diagnostic')
  if (
    (key !== 'qr' && key !== 'gallery' && key !== 'index') ||
    !Number.isInteger(version) ||
    typeof title !== 'string' ||
    typeof description !== 'string' ||
    typeof icon !== 'string' ||
    typeof isEnabled !== 'boolean' ||
    typeof compatible !== 'boolean' ||
    !(diagnostic === null || typeof diagnostic === 'string')
  ) {
    throw new Error(fallbackMessage)
  }

  return {
    key: key as ContentExtensionKey,
    version: version as number,
    title,
    description,
    icon,
    isEnabled,
    compatible,
    diagnostic
  }
}

export async function fetchContentExtensions (
  fetchImpl: FetchImpl,
  fallbackMessage = 'Content extensions could not be loaded.'
): Promise<ContentExtensionsStatus> {
  const response = await fetchImpl('/_api/content-extensions', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const contentType = response.headers?.get('content-type') || ''
  const payload = contentType.includes('application/json') ? await response.json() : null

  if (!response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const error = Reflect.get(payload, 'error')
      const messageValue = error ?? Reflect.get(payload, 'message')
      if (typeof messageValue === 'string' && messageValue.length > 0) throw new Error(messageValue)
    }
    throw new Error(fallbackMessage)
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(fallbackMessage)
  const hostVersion = Reflect.get(payload, 'hostVersion')
  const extensions = Reflect.get(payload, 'extensions')
  if (!Number.isInteger(hostVersion) || !Array.isArray(extensions)) throw new Error(fallbackMessage)

  return {
    hostVersion: hostVersion as number,
    extensions: extensions.map(extension => normalizeExtension(extension, fallbackMessage))
  }
}
