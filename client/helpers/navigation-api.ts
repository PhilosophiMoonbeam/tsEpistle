type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json: () => Promise<unknown>
}

type FetchImpl = (url: string, options: Record<string, unknown>) => Promise<JsonResponse>

type NavigationSaveResponse = {
  message: string
}

export type NavigationConfig = {
  mode: string
  expandParent: boolean
}

export type NavigationItem = {
  id: string
  kind: string
  label?: string | null
  icon?: string | null
  targetType?: string | null
  target?: string | null
  visibilityMode?: string | null
  visibilityGroups?: number[] | null
}

export type NavigationTreeRow = {
  locale: string
  items: NavigationItem[]
}

export type NavigationPayload = {
  config: NavigationConfig
  tree: NavigationTreeRow[]
}

const VALID_NAVIGATION_MODES = ['NONE', 'TREE', 'MIXED', 'STATIC']

async function parseJsonResponse (response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''

  let payload: unknown = null
  if (contentType.includes('application/json')) {
    payload = await response.json()
  }

  if (!response.ok) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { error?: unknown }).error === 'string' && (payload as { error: string }).error.length > 0) {
      throw new Error((payload as { error: string }).error)
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as { message?: unknown }).message === 'string' && (payload as { message: string }).message.length > 0) {
      throw new Error((payload as { message: string }).message)
    }
    throw new Error(fallbackMessage)
  }

  if (payload === null) {
    throw new Error(fallbackMessage)
  }

  return payload
}

function normalizeNavigationItem (item: unknown, fallbackMessage: string): NavigationItem {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(fallbackMessage)
  }

  const navItem = item as Partial<NavigationItem>
  if (typeof navItem.id !== 'string' || navItem.id.length < 1 || typeof navItem.kind !== 'string' || navItem.kind.length < 1) {
    throw new Error(fallbackMessage)
  }

  for (const field of ['label', 'icon', 'targetType', 'target', 'visibilityMode'] as const) {
    if (navItem[field] !== null && navItem[field] !== undefined && typeof navItem[field] !== 'string') {
      throw new Error(fallbackMessage)
    }
  }

  if (navItem.visibilityGroups !== null && navItem.visibilityGroups !== undefined && (!Array.isArray(navItem.visibilityGroups) || navItem.visibilityGroups.some(groupId => !Number.isInteger(groupId)))) {
    throw new Error(fallbackMessage)
  }

  return {
    id: navItem.id,
    kind: navItem.kind,
    label: navItem.label,
    icon: navItem.icon,
    targetType: navItem.targetType,
    target: navItem.target,
    visibilityMode: navItem.visibilityMode,
    visibilityGroups: navItem.visibilityGroups
  }
}

function normalizeNavigationPayload (payload: unknown, fallbackMessage: string): NavigationPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }
  const navPayload = payload as Partial<NavigationPayload>
  const rawConfig = navPayload.config as Partial<NavigationConfig> | undefined
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig) || !VALID_NAVIGATION_MODES.includes(rawConfig.mode ?? '') || (rawConfig.expandParent !== undefined && typeof rawConfig.expandParent !== 'boolean')) {
    throw new Error(fallbackMessage)
  }
  if (!Array.isArray(navPayload.tree)) {
    throw new Error(fallbackMessage)
  }

  return {
    config: {
      mode: rawConfig.mode!,
      expandParent: rawConfig.expandParent !== false
    },
    tree: navPayload.tree.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(fallbackMessage)
      }
      const treeRow = row as Partial<NavigationTreeRow>
      if (typeof treeRow.locale !== 'string' || treeRow.locale.length < 1 || !Array.isArray(treeRow.items)) {
        throw new Error(fallbackMessage)
      }
      return {
        locale: treeRow.locale,
        items: treeRow.items.map(item => normalizeNavigationItem(item, fallbackMessage))
      }
    })
  }
}

function normalizeNavigationSavePayload (payload: unknown, fallbackMessage: string): NavigationSaveResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string' || (payload as { message: string }).message.length < 1) {
    throw new Error(fallbackMessage)
  }

  return {
    message: (payload as { message: string }).message
  }
}

export async function fetchNavigation (fetchImpl: FetchImpl, fallbackMessage = 'Navigation response is invalid'): Promise<NavigationPayload> {
  const response = await fetchImpl('/_api/navigation', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })

  return normalizeNavigationPayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}

export async function saveNavigation (fetchImpl: FetchImpl, tree: unknown[], mode: string, expandParent: boolean, fallbackMessage = 'Navigation save failed'): Promise<NavigationSaveResponse> {
  const response = await fetchImpl('/_api/navigation', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tree, mode, expandParent })
  })

  return normalizeNavigationSavePayload(await parseJsonResponse(response, fallbackMessage), fallbackMessage)
}
