import { computed, reactive, readonly } from 'vue'
import { fetchPage } from './pages-api.ts'

export type WorkingSetPage = {
  id: number
  locale: string
  path: string
  title: string
  visibility: 'public' | 'private'
}
export type PageWorkingSetIdentity = {
  origin: string
  installation: string
  accountId: number
  authVersion: number
}

const STORAGE_KEY = 'tsepistle:page-working-set:v1'
const RECENT_LIMIT = 5
const PIN_LIMIT = 50
const state = reactive({
  recentIds: [] as number[],
  pinnedIds: [] as number[],
  status: 'unknown' as 'unknown' | 'ready' | 'unavailable',
  storage: 'unavailable' as 'session' | 'unavailable',
  generation: 0,
  metadataStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'unavailable'
})
let scopeKey: string | null = null
let storage: Storage | null = null
const metadata = reactive(new Map<number, WorkingSetPage>())
let requestGeneration = 0
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0
const normalizeIds = (ids: unknown, limit: number): number[] => (Array.isArray(ids) ? [...new Set(ids.filter(validId))].slice(0, limit) : [])
const view = readonly({
  pinLimit: PIN_LIMIT,
  get recentIds() {
    return state.recentIds
  },
  get pinnedIds() {
    return state.pinnedIds
  },
  get status() {
    return state.status
  },
  get storage() {
    return state.storage
  },
  get generation() {
    return state.generation
  },
  get metadataStatus() {
    return state.metadataStatus
  },
  get recentPages() {
    return recentPages.value
  },
  get pinnedPages() {
    return pinnedPages.value
  }
})
const recentPages = computed(() => state.recentIds.flatMap(id => (metadata.has(id) ? [metadata.get(id)!] : [])))
const pinnedPages = computed(() => state.pinnedIds.flatMap(id => (metadata.has(id) ? [metadata.get(id)!] : [])))

/** Selectors and pins last only for this tab's browser session, never across devices.
 * Only page IDs and the explicit installation/account/auth-generation scope persist.
 * Titles, paths and visibility are fetched anew under current server authority.
 */
export const usePageWorkingSet = () => view
export const capturePageWorkingSetScope = (): number | null => (state.status === 'ready' ? state.generation : null)
const isCurrent = (capturedScope: number | null): boolean =>
  capturedScope !== null && capturedScope === state.generation && state.status === 'ready' && scopeKey !== null

const clearMetadata = (): void => {
  requestGeneration += 1
  metadata.clear()
  state.metadataStatus = 'idle'
}
const persist = (): void => {
  if (!storage || !scopeKey) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ scope: scopeKey, recentIds: state.recentIds, pinnedIds: state.pinnedIds }))
  } catch {
    storage = null
    state.storage = 'unavailable'
  }
}

/** Suspend online display on unknown verification without turning it into logout. */
export const suspendPageWorkingSet = (): void => {
  state.generation += 1
  state.status = 'unavailable'
  clearMetadata()
}

/** Verified identity/authorization boundary: retire selectors and all pending metadata. */
export const invalidatePageWorkingSet = (): void => {
  suspendPageWorkingSet()
  state.recentIds = []
  state.pinnedIds = []
  scopeKey = null
  try {
    const currentStorage = storage ?? window.sessionStorage
    currentStorage.removeItem(STORAGE_KEY)
  } catch {
    state.storage = 'unavailable'
  }
  storage = null
}

/** Called only by the store after a verified whoami result. */
export const establishPageWorkingSet = (identity: PageWorkingSetIdentity): void => {
  const nextScope = JSON.stringify([identity.origin, identity.installation, identity.accountId, identity.authVersion])
  if (scopeKey !== null && scopeKey !== nextScope) invalidatePageWorkingSet()
  const changed = scopeKey !== nextScope
  scopeKey = nextScope
  state.generation += 1
  clearMetadata()
  if (changed) {
    state.recentIds = []
    state.pinnedIds = []
  }
  try {
    storage = window.sessionStorage
    const raw = storage.getItem(STORAGE_KEY)
    if (changed && raw) {
      const saved: unknown = JSON.parse(raw)
      if (saved && typeof saved === 'object' && Reflect.get(saved, 'scope') === nextScope) {
        state.recentIds = normalizeIds(Reflect.get(saved, 'recentIds'), RECENT_LIMIT)
        state.pinnedIds = normalizeIds(Reflect.get(saved, 'pinnedIds'), PIN_LIMIT)
      }
    }
    state.storage = 'session'
  } catch {
    storage = null
    state.storage = 'unavailable'
  }
  state.status = 'ready'
  persist()
}

export const recordPageVisit = (pageId: number, capturedScope: number | null): boolean => {
  if (!validId(pageId) || !isCurrent(capturedScope)) return false
  state.recentIds = [pageId, ...state.recentIds.filter(id => id !== pageId)].slice(0, RECENT_LIMIT)
  clearMetadata()
  persist()
  return true
}
/** The editor invokes this only after a successful server commit, not draft capture. */
export const recordPageEdit = recordPageVisit

export const pinPage = (pageId: number, capturedScope: number | null): boolean => {
  if (!validId(pageId) || !isCurrent(capturedScope)) return false
  if (state.pinnedIds.includes(pageId)) return true
  if (state.pinnedIds.length >= PIN_LIMIT) return false
  state.pinnedIds = [...state.pinnedIds, pageId]
  clearMetadata()
  persist()
  return true
}
export const unpinPage = (pageId: number, capturedScope: number | null): boolean => {
  if (!validId(pageId) || !isCurrent(capturedScope)) return false
  state.pinnedIds = state.pinnedIds.filter(id => id !== pageId)
  clearMetadata()
  persist()
  return true
}
export const removePage = (pageId: number, capturedScope: number | null): boolean => {
  if (!validId(pageId) || !isCurrent(capturedScope)) return false
  state.recentIds = state.recentIds.filter(id => id !== pageId)
  state.pinnedIds = state.pinnedIds.filter(id => id !== pageId)
  clearMetadata()
  persist()
  return true
}

/** Revalidate all display metadata. No saved title/path or prior capability is trusted. */
export const hydratePageWorkingSet = async (): Promise<void> => {
  const capturedScope = capturePageWorkingSetScope()
  if (capturedScope === null) return
  const request = ++requestGeneration
  metadata.clear()
  state.metadataStatus = 'loading'
  const ids = [...new Set([...state.recentIds, ...state.pinnedIds])]
  const results = await Promise.all(
    ids.map(async id => {
      try {
        const page = await fetchPage(window.fetch.bind(window), id)
        if (page.id !== id) return { id, denied: false, page: null }
        return { id, denied: false, page: { id, locale: page.locale, path: page.path, title: page.title ?? page.path, visibility: page.visibility } }
      } catch (error) {
        const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined
        return { id, denied: status === 401 || status === 403 || status === 404, page: null }
      }
    })
  )
  if (!isCurrent(capturedScope) || request !== requestGeneration) return
  let unavailable = false
  const denied = new Set<number>()
  for (const result of results) {
    if (result.page) metadata.set(result.id, result.page)
    else if (result.denied) denied.add(result.id)
    else unavailable = true
  }
  if (denied.size) {
    state.recentIds = state.recentIds.filter(id => !denied.has(id))
    state.pinnedIds = state.pinnedIds.filter(id => !denied.has(id))
    persist()
  }
  state.metadataStatus = unavailable ? 'unavailable' : 'ready'
}
