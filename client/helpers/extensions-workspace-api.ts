import type {
  ExtensionWorkspaceCapability,
  ExtensionWorkspaceDependency,
  ExtensionWorkspaceExtension,
  ExtensionWorkspaceLink,
  ExtensionsWorkspace,
  OptionalExtensionKey,
  OptionalExtensionRuntimeObservation
} from '../../shared/extensions-workspace.ts'
import { OPTIONAL_EXTENSION_KEYS } from '../../shared/extensions-workspace.ts'
import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards.ts'

type JsonHeaders = { get(name: string): string | null }
type JsonResponse = { ok: boolean; headers?: JsonHeaders; json(): Promise<unknown> }
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<JsonResponse>

const configurationDestinations = [
  { label: 'Configure Git storage', path: '/storage', query: { section: 'targets', target: 'git' }, hash: undefined },
  { label: 'Manage workspace logo', path: '/general', query: undefined, hash: 'identity' },
  { label: 'Open Agent Browser', path: '/agents', query: undefined, hash: 'browser' }
] as const

const link = (value: unknown, fallback: string): ExtensionWorkspaceLink => {
  if (
    !isRecord(value) ||
    typeof value.label !== 'string' ||
    !value.label ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/') ||
    value.path.startsWith('//')
  )
    throw new Error(fallback)
  const query = value.query
  if (query !== undefined && (!isRecord(query) || Object.values(query).some(item => typeof item !== 'string'))) throw new Error(fallback)
  if (value.hash !== undefined && typeof value.hash !== 'string') throw new Error(fallback)
  const parsedQuery = query === undefined ? undefined : Object.fromEntries(Object.entries(query).map(([key, item]) => [key, item as string]))
  const allowed = configurationDestinations.some(destination => {
    const destinationQuery = Object.entries(destination.query || {})
    const responseQuery = Object.entries(parsedQuery || {})
    return (
      destination.label === value.label &&
      destination.path === value.path &&
      destination.hash === value.hash &&
      destinationQuery.length === responseQuery.length &&
      destinationQuery.every(([key, item]) => parsedQuery?.[key] === item)
    )
  })
  if (!allowed) throw new Error(fallback)
  return {
    label: value.label,
    path: value.path,
    ...(parsedQuery === undefined ? {} : { query: parsedQuery }),
    ...(value.hash === undefined ? {} : { hash: value.hash })
  }
}

const capabilities = (value: unknown, fallback: string): ExtensionWorkspaceCapability[] => {
  if (!Array.isArray(value)) throw new Error(fallback)
  return value.map(item => {
    if (!isRecord(item) || typeof item.title !== 'string' || !item.title || typeof item.detail !== 'string' || !item.detail) throw new Error(fallback)
    return { title: item.title, detail: item.detail, ...(item.configuration === undefined ? {} : { configuration: link(item.configuration, fallback) }) }
  })
}

const dependencies = (value: unknown, fallback: string): ExtensionWorkspaceDependency[] => {
  if (!Array.isArray(value)) throw new Error(fallback)
  return value.map(item => {
    if (!isRecord(item) || typeof item.title !== 'string' || !item.title || typeof item.detail !== 'string' || !item.detail) throw new Error(fallback)
    return { title: item.title, detail: item.detail }
  })
}

const observation = (value: unknown, fallback: string): OptionalExtensionRuntimeObservation & { checkedAt: string } => {
  if (
    !isRecord(value) ||
    !['usable', 'missing', 'not-provided', 'unknown'].includes(String(value.state)) ||
    !['verified', 'not-applicable', 'unknown'].includes(String(value.compatibility)) ||
    typeof value.evidence !== 'string' ||
    !value.evidence ||
    typeof value.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.checkedAt))
  )
    throw new Error(fallback)
  return {
    state: value.state as OptionalExtensionRuntimeObservation['state'],
    compatibility: value.compatibility as OptionalExtensionRuntimeObservation['compatibility'],
    evidence: value.evidence,
    checkedAt: value.checkedAt
  }
}

const extension = (value: unknown, fallback: string): ExtensionWorkspaceExtension => {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    !OPTIONAL_EXTENSION_KEYS.includes(value.key as OptionalExtensionKey) ||
    typeof value.title !== 'string' ||
    !value.title ||
    typeof value.description !== 'string' ||
    !value.description ||
    !isRecord(value.installation)
  )
    throw new Error(fallback)
  const installation = value.installation,
    boundary = installation.boundary
  if (
    !['application-image', 'application-package', 'separate-image'].includes(String(boundary)) ||
    typeof installation.detail !== 'string' ||
    !installation.detail ||
    typeof installation.recovery !== 'string' ||
    !installation.recovery
  )
    throw new Error(fallback)
  return {
    key: value.key as OptionalExtensionKey,
    title: value.title,
    description: value.description,
    installation: {
      boundary: boundary as ExtensionWorkspaceExtension['installation']['boundary'],
      detail: installation.detail,
      recovery: installation.recovery
    },
    capabilities: capabilities(value.capabilities, fallback),
    dependencies: dependencies(value.dependencies, fallback),
    observation: observation(value.observation, fallback)
  }
}

export const fetchExtensionsWorkspace = async (
  fetchImpl: FetchImpl,
  fallback = 'Extension observations could not be loaded.'
): Promise<ExtensionsWorkspace> => {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/extensions/workspace', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
  const contentType = response.headers?.get('content-type') || ''
  const value = contentType.includes('application/json') ? await response.json() : null
  if (!response.ok) {
    if (isRecord(value) && typeof value.error === 'string' && value.error) throw new Error(value.error)
    throw new Error(fallback)
  }
  if (!isRecord(value) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.extensions))
    throw new Error(fallback)
  return { observedAt: value.observedAt, extensions: value.extensions.map(item => extension(item, fallback)) }
}
