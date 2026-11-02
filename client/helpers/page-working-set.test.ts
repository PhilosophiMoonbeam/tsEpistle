import { afterEach, beforeEach, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow } from '../test/browser-dom.mts'
import type { PageWorkingSetIdentity } from './page-working-set.ts'

import {
  capturePageWorkingSetScope,
  establishPageWorkingSet,
  hydratePageWorkingSet,
  invalidatePageWorkingSet,
  pinPage,
  recordPageEdit,
  recordPageVisit,
  removePage,
  suspendPageWorkingSet,
  unpinPage,
  usePageWorkingSet
} from './page-working-set.ts'
const workingSet = usePageWorkingSet()
const storageKey = 'tsepistle:page-working-set:v1'
const storageDescriptor = Object.getOwnPropertyDescriptor(browserWindow, 'sessionStorage')!
const identity: PageWorkingSetIdentity = { origin: 'http://localhost', installation: 'wiki-one', accountId: 7, authVersion: 3 }
const timestamp = '2026-10-22T00:00:00.000Z'
const page = (id: number) => ({
  id,
  locale: 'en',
  path: `private/team-${id}`,
  hash: `hash-${id}`,
  title: `Confidential plan ${id}`,
  description: 'Private description',
  content: 'Private body must never be persisted',
  visibility: 'private',
  ownerId: 7,
  contentType: 'markdown',
  createdAt: timestamp,
  updatedAt: timestamp,
  sourceRevision: '1',
  capabilities: { viewStewardContacts: false },
  accuracy: {
    sourceRevision: '1',
    updatedAt: timestamp,
    author: null,
    latestAttestation: null,
    canVerify: false,
    asOf: timestamp,
    status: 'needs-verification'
  },
  changeReason: null
})
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const saved = () => JSON.parse(browserWindow.sessionStorage.getItem(storageKey)!)
const establish = () => {
  establishPageWorkingSet(identity)
  return capturePageWorkingSetScope()
}

beforeEach(() => {
  Object.defineProperty(browserWindow, 'sessionStorage', storageDescriptor)
  invalidatePageWorkingSet()
  browserWindow.sessionStorage.removeItem(storageKey)
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(browserWindow, 'sessionStorage', storageDescriptor)
  invalidatePageWorkingSet()
})

it('orders the last five distinct visits and committed edits by activity, not page modification time or ID', () => {
  const scope = establish()
  for (const id of [40, 2, 90, 11, 7]) recordPageVisit(id, scope)
  expect(workingSet.recentIds).toEqual([7, 11, 90, 2, 40])
  recordPageVisit(2, scope)
  expect(workingSet.recentIds).toEqual([2, 7, 11, 90, 40])
  recordPageEdit(90, scope)
  expect(workingSet.recentIds).toEqual([90, 2, 7, 11, 40])
  recordPageEdit(65, scope)
  expect(workingSet.recentIds).toEqual([65, 90, 2, 7, 11])
  expect(saved().recentIds).toEqual([65, 90, 2, 7, 11])
})

it('keeps pins separate from recency, deduplicates at the fifty-pin boundary, and frees capacity on unpin', () => {
  const scope = establish()
  recordPageVisit(90, scope)
  recordPageEdit(2, scope)
  for (let id = 1; id <= 50; id++) expect(pinPage(id, scope)).toBe(true)
  expect(pinPage(2, scope)).toBe(true)
  expect(pinPage(51, scope)).toBe(false)
  expect(workingSet.pinnedIds).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
    42, 43, 44, 45, 46, 47, 48, 49, 50
  ])
  expect(workingSet.recentIds).toEqual([2, 90])
  expect(unpinPage(2, scope)).toBe(true)
  expect(pinPage(51, scope)).toBe(true)
  expect(workingSet.pinnedIds).toHaveLength(50)
  expect(workingSet.pinnedIds).not.toContain(2)
  expect(workingSet.pinnedIds[49]).toBe(51)
  expect(workingSet.recentIds).toEqual([2, 90])
})

for (const boundary of ['accountId', 'authVersion', 'installation', 'origin'] as const) {
  it(`fences selectors, captured actions and a pending metadata response across verified ${boundary} changes`, async () => {
    const scope = establish()
    recordPageVisit(11, scope)
    pinPage(11, scope)
    const pending = Promise.withResolvers<Response>()
    vi.spyOn(browserWindow, 'fetch').mockImplementation(() => pending.promise)
    const hydration = hydratePageWorkingSet()
    const next = { ...identity }
    if (boundary === 'accountId') next.accountId = 8
    else if (boundary === 'authVersion') next.authVersion = 4
    else if (boundary === 'installation') next.installation = 'wiki-two'
    else next.origin = 'https://another-wiki.example'
    establishPageWorkingSet(next)
    expect(recordPageEdit(12, scope)).toBe(false)
    expect(pinPage(12, scope)).toBe(false)
    expect(removePage(11, scope)).toBe(false)
    expect(unpinPage(11, scope)).toBe(false)
    pending.resolve(json(page(11)))
    await hydration
    expect(workingSet.recentIds).toEqual([])
    expect(workingSet.pinnedIds).toEqual([])
    expect(workingSet.recentPages).toEqual([])
    expect(workingSet.pinnedPages).toEqual([])
    expect(workingSet.metadataStatus).toBe('idle')
    expect(saved().recentIds).toEqual([])
    expect(saved().pinnedIds).toEqual([])
  })
}

it('suspends unknown verification without purging this tab, then requires fresh authority and a fresh action scope', async () => {
  const scope = establish()
  recordPageVisit(11, scope)
  pinPage(11, scope)
  const fetch = vi.spyOn(browserWindow, 'fetch').mockResolvedValue(json(page(11)))
  await hydratePageWorkingSet()
  expect(workingSet.recentPages[0]?.title).toBe('Confidential plan 11')
  const persisted = browserWindow.sessionStorage.getItem(storageKey)
  suspendPageWorkingSet()
  expect(capturePageWorkingSetScope()).toBeNull()
  expect(workingSet.status).toBe('unavailable')
  expect(workingSet.recentPages).toEqual([])
  expect(workingSet.pinnedPages).toEqual([])
  expect(browserWindow.sessionStorage.getItem(storageKey)).toBe(persisted)
  expect(recordPageVisit(12, scope)).toBe(false)
  await hydratePageWorkingSet()
  expect(fetch).toHaveBeenCalledTimes(1)
  establishPageWorkingSet(identity)
  expect(workingSet.recentIds).toEqual([11])
  expect(workingSet.pinnedIds).toEqual([11])
  expect(workingSet.recentPages).toEqual([])
  expect(recordPageEdit(12, scope)).toBe(false)
  fetch.mockResolvedValue(json({ ...page(11), title: 'Reauthorized title' }))
  await hydratePageWorkingSet()
  expect(workingSet.recentPages[0]?.title).toBe('Reauthorized title')
  expect(recordPageEdit(12, capturePageWorkingSetScope())).toBe(true)
  expect(workingSet.recentIds).toEqual([12, 11])
})

it('restores only matching tab selectors and never persists private metadata or body after hydration', async () => {
  browserWindow.sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      scope: JSON.stringify(['http://localhost', 'wiki-one', 7, 3]),
      recentIds: [11, 12],
      pinnedIds: [12]
    })
  )
  const scope = establish()
  expect(workingSet.recentIds).toEqual([11, 12])
  expect(workingSet.pinnedIds).toEqual([12])
  expect(workingSet.recentPages).toEqual([])
  vi.spyOn(browserWindow, 'fetch').mockImplementation(async input => {
    if (String(input) === '/_api/pages/11') return json(page(11))
    if (String(input) === '/_api/pages/12') return json(page(12))
    throw new Error(`Unexpected request ${String(input)}`)
  })
  await hydratePageWorkingSet()
  expect(workingSet.recentPages.map(value => value.title)).toEqual(['Confidential plan 11', 'Confidential plan 12'])
  expect(workingSet.pinnedPages.map(value => value.path)).toEqual(['private/team-12'])
  recordPageEdit(12, scope)
  pinPage(13, scope)
  expect(saved()).toEqual({ scope: JSON.stringify(['http://localhost', 'wiki-one', 7, 3]), recentIds: [12, 11], pinnedIds: [12, 13] })
})

it('does not import another installation’s saved selectors on first verified establishment', () => {
  browserWindow.sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      scope: JSON.stringify(['http://localhost', 'wiki-two', 7, 3]),
      recentIds: [99],
      pinnedIds: [98]
    })
  )
  establish()
  expect(workingSet.recentIds).toEqual([])
  expect(workingSet.pinnedIds).toEqual([])
})

for (const denial of ['access', 'read', 'write'] as const) {
  it(`keeps truthful in-memory activity and pins when session storage ${denial} is denied`, () => {
    const denied = () => {
      throw new browserWindow.DOMException('Storage denied', 'SecurityError')
    }
    if (denial === 'access') Object.defineProperty(browserWindow, 'sessionStorage', { configurable: true, get: denied })
    else if (denial === 'read') vi.spyOn(browserWindow.Storage.prototype, 'getItem').mockImplementation(denied)
    else vi.spyOn(browserWindow.Storage.prototype, 'setItem').mockImplementation(denied)
    const scope = establish()
    recordPageVisit(11, scope)
    recordPageEdit(12, scope)
    pinPage(11, scope)
    expect(workingSet.status).toBe('ready')
    expect(workingSet.storage).toBe('unavailable')
    expect(workingSet.recentIds).toEqual([12, 11])
    expect(workingSet.pinnedIds).toEqual([11])
    suspendPageWorkingSet()
    establishPageWorkingSet(identity)
    expect(workingSet.recentIds).toEqual([12, 11])
    expect(workingSet.pinnedIds).toEqual([11])
  })
}

it('removes unauthorized and deleted selectors from recents, pins and persistence without discarding transiently unavailable pages', async () => {
  const scope = establish()
  for (const id of [11, 12, 13, 14, 15]) {
    recordPageVisit(id, scope)
    pinPage(id, scope)
  }
  const fetch = vi.spyOn(browserWindow, 'fetch').mockImplementation(async input => {
    switch (String(input)) {
      case '/_api/pages/11':
        return json({ message: 'Sign in required' }, 401)
      case '/_api/pages/12':
        return json({ message: 'No access' }, 403)
      case '/_api/pages/13':
        return json({ message: 'Deleted' }, 404)
      case '/_api/pages/14':
        return json(page(14))
      case '/_api/pages/15':
        return json({ message: 'Temporarily unavailable' }, 503)
      default:
        throw new Error(`Unexpected request ${String(input)}`)
    }
  })
  await hydratePageWorkingSet()
  expect(workingSet.recentIds).toEqual([15, 14])
  expect(workingSet.pinnedIds).toEqual([14, 15])
  expect(workingSet.recentPages.map(value => value.id)).toEqual([14])
  expect(workingSet.pinnedPages.map(value => value.id)).toEqual([14])
  expect(workingSet.metadataStatus).toBe('unavailable')
  expect(saved().recentIds).toEqual([15, 14])
  expect(saved().pinnedIds).toEqual([14, 15])
  fetch.mockClear()
  fetch.mockImplementation(async input => {
    if (String(input) === '/_api/pages/14') return json(page(14))
    if (String(input) === '/_api/pages/15') return json(page(15))
    throw new Error(`Removed page requested again: ${String(input)}`)
  })
  await hydratePageWorkingSet()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(workingSet.recentPages.map(value => value.id)).toEqual([15, 14])
  expect(workingSet.metadataStatus).toBe('ready')
})

it('does not let an older successful metadata request resurrect a page denied by a later request', async () => {
  const scope = establish()
  recordPageVisit(11, scope)
  pinPage(11, scope)
  const pending = Promise.withResolvers<Response>()
  vi.spyOn(browserWindow, 'fetch')
    .mockResolvedValue(json({ message: 'No longer readable' }, 403))
    .mockImplementationOnce(() => pending.promise)
  const earlier = hydratePageWorkingSet()
  await hydratePageWorkingSet()
  expect(workingSet.recentIds).toEqual([])
  expect(workingSet.pinnedIds).toEqual([])
  pending.resolve(json(page(11)))
  await earlier
  expect(workingSet.recentPages).toEqual([])
  expect(workingSet.pinnedPages).toEqual([])
  expect(saved().recentIds).toEqual([])
  expect(saved().pinnedIds).toEqual([])
})

it('ignores pending metadata after explicit removal and retires captured actions on verified invalidation', async () => {
  const scope = establish()
  recordPageVisit(11, scope)
  pinPage(11, scope)
  const pending = Promise.withResolvers<Response>()
  vi.spyOn(browserWindow, 'fetch').mockImplementation(() => pending.promise)
  const hydration = hydratePageWorkingSet()
  expect(removePage(11, scope)).toBe(true)
  pending.resolve(json(page(11)))
  await hydration
  expect(workingSet.recentIds).toEqual([])
  expect(workingSet.pinnedIds).toEqual([])
  expect(workingSet.recentPages).toEqual([])
  expect(workingSet.pinnedPages).toEqual([])
  recordPageVisit(12, scope)
  invalidatePageWorkingSet()
  expect(browserWindow.sessionStorage.getItem(storageKey)).toBeNull()
  expect(recordPageEdit(13, scope)).toBe(false)
  establishPageWorkingSet(identity)
  expect(workingSet.recentIds).toEqual([])
  expect(workingSet.pinnedIds).toEqual([])
})
