import { createHash } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import {
  authenticateAsAdmin,
  expectLocatorWithinViewport,
  expectResponsiveLayout,
  responsiveTest as test
} from './helpers.ts'
import { OFFLINE_DB_NAME, type OfflinePageSnapshotV1 } from '../../shared/offline.ts'

type PageRow = {
  id?: unknown
  path?: unknown
}

type OfflineWindow = Window & {
  __rejectOfflineClipboard?: (() => void) | undefined
  __restoreOfflineSnapshotFetch?: (() => void) | undefined
}

type OfflineSnapshotRow = {
  siteId: string
  pageId: number
  locale: string
  snapshot: OfflinePageSnapshotV1
  lastOpenedAt: string
  byteSize: number
}

type OfflineSearchRow = {
  siteId: string
  pageId: number
  locale: string
  path: string
  title: string
  byteSize: number
}

type OfflineDatabaseInspection = {
  databaseVersion: number
  storeNames: string[]
  meta: Record<string, unknown> | null
  snapshots: OfflineSnapshotRow[]
  searchDocuments: OfflineSearchRow[]
  draftCount: number
}

type OwnedCacheInspection = {
  names: string[]
  ownedNames: string[]
  entries: Record<string, string[]>
}

type SavePageOptions = {
  expiresAt?: string
}

const OFFLINE_PATH = '/_offline'
const SEEDED_PAGE_PATHS = ['visual-markdown-browser', 'visual-html-browser'] as const
const OWNED_CACHE_NAME_PATTERN = /^tsepistle-pwa-precache-v1-[0-9a-f]{16}(?:-candidate-[0-9a-z-]+)?$/u

async function waitForOfflineShell(page: Page): Promise<void> {
  await expect(page.locator('main.offline-shell')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Saved pages', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search saved pages', exact: true })).toBeVisible()
}

async function inspectOfflineDatabase(page: Page): Promise<OfflineDatabaseInspection> {
  return page.evaluate(async databaseName => {
    const openDatabase = (): Promise<IDBDatabase> => {
      const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>()
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Offline database could not be opened.'))
      return promise
    }

    const database = await openDatabase()
    const requestedStores = ['meta', 'snapshots', 'drafts', 'searchDocuments']
    const storeNames = requestedStores.filter(name => database.objectStoreNames.contains(name))
    if (storeNames.length === 0) {
      const databaseVersion = database.version
      database.close()
      return {
        databaseVersion,
        storeNames,
        meta: null,
        snapshots: [],
        searchDocuments: [],
        draftCount: 0
      } satisfies OfflineDatabaseInspection
    }

    const transaction = database.transaction(storeNames, 'readonly')
    const completion = Promise.withResolvers<void>()
    transaction.oncomplete = () => completion.resolve()
    transaction.onerror = () => completion.reject(transaction.error ?? new Error('Offline inspection transaction failed.'))
    transaction.onabort = () => completion.reject(transaction.error ?? new Error('Offline inspection transaction was aborted.'))
    const reads = storeNames.map(name => {
      const read = Promise.withResolvers<unknown[]>()
      const request = transaction.objectStore(name).getAll()
      request.onsuccess = () => read.resolve(request.result as unknown[])
      request.onerror = () => read.reject(request.error ?? new Error(`Offline ${name} inspection failed.`))
      return read.promise
    })
    const values = await Promise.all(reads)
    await completion.promise
    const databaseVersion = database.version
    database.close()
    const byStore = new Map(storeNames.map((name, index) => [name, values[index] ?? []]))
    return {
      databaseVersion,
      storeNames,
      meta: (byStore.get('meta')?.[0] as Record<string, unknown> | undefined) ?? null,
      snapshots: (byStore.get('snapshots') ?? []) as OfflineSnapshotRow[],
      searchDocuments: (byStore.get('searchDocuments') ?? []) as OfflineSearchRow[],
      draftCount: byStore.get('drafts')?.length ?? 0
    } satisfies OfflineDatabaseInspection
  }, OFFLINE_DB_NAME)
}

async function inspectOwnedCaches(page: Page): Promise<OwnedCacheInspection> {
  return page.evaluate(async cacheNamePattern => {
    const names = await caches.keys()
    const ownedNames = names.filter(name => new RegExp(cacheNamePattern, 'u').test(name))
    const entries: Record<string, string[]> = {}
    for (const name of ownedNames) {
      const cache = await caches.open(name)
      entries[name] = (await cache.keys()).map(request => request.url)
    }
    return { names, ownedNames, entries }
  }, OWNED_CACHE_NAME_PATTERN.source)
}

async function waitForFeatureWorker(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!navigator.serviceWorker) return false
          try {
            const registration = await navigator.serviceWorker.ready
            const active = registration.active
            return Boolean(active && navigator.serviceWorker.controller && new URL(active.scriptURL).pathname === '/sw.js')
          } catch {
            return false
          }
        }),
      { timeout: 30_000 }
    )
    .toBe(true)
  await expect
    .poll(
      async () => {
        const cache = await inspectOwnedCaches(page)
        return cache.ownedNames.length > 0 && Object.values(cache.entries).some(urls => urls.some(url => new URL(url).pathname === OFFLINE_PATH))
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function warmFeatureWorker(page: Page): Promise<void> {
  await page.goto(OFFLINE_PATH, { waitUntil: 'networkidle' })
  await waitForOfflineShell(page)
  await waitForFeatureWorker(page)
}

function snapshotIntegrity(snapshot: OfflinePageSnapshotV1): string {
  const payload = JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    pageId: snapshot.pageId,
    locale: snapshot.locale,
    path: snapshot.path,
    canonicalPath: snapshot.canonicalPath,
    title: snapshot.title,
    description: snapshot.description,
    sourceRevision: snapshot.sourceRevision,
    capturedAt: snapshot.capturedAt,
    expiresAt: snapshot.expiresAt,
    content: {
      representation: snapshot.content.representation,
      sanitizerVersion: snapshot.content.sanitizerVersion,
      html: snapshot.content.html
    },
    searchText: snapshot.searchText,
    contentType: snapshot.contentType
  })
  return createHash('sha256').update(`tsepistle/offline-snapshot-v1\u0000${payload}`).digest('hex')
}

async function pageIdForPath(page: Page, path: string): Promise<number> {
  const pagesResponse = await page.request.get('/_api/pages')
  expect(pagesResponse.ok(), `Page index request failed: HTTP ${pagesResponse.status()}`).toBe(true)
  const pages = (await pagesResponse.json()) as PageRow[]
  const row = pages.find(candidate => candidate.path === path)
  if (!row || typeof row.id !== 'number') throw new Error(`The setup fixture page ${path} was not found.`)
  return row.id
}

async function savePageFromReader(page: Page, path: string, options: SavePageOptions = {}): Promise<OfflineSnapshotRow> {
  const pageId = await pageIdForPath(page, path)
  await page.goto(`/en/${path}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.page-header-section')).toBeVisible({ timeout: 30_000 })
  const control = page.locator('.page-offline-control')
  await expect(control).toBeVisible({ timeout: 30_000 })
  await expect(control).toBeEnabled({ timeout: 30_000 })
  await expect
    .poll(() => control.getAttribute('aria-label'), { timeout: 30_000 })
    .toMatch(/^(?:Save for offline|Update offline copy|Remove offline copy)$/u)

  if ((await control.getAttribute('aria-label')) === 'Remove offline copy' && !options.expiresAt) {
    const current = (await inspectOfflineDatabase(page)).snapshots.find(record => record.pageId === pageId)
    if (!current) throw new Error(`The saved snapshot for ${path} was not found.`)
    return current
  }

  if ((await control.getAttribute('aria-label')) === 'Remove offline copy') {
    await control.click()
    await expect(control).toHaveAttribute('aria-label', 'Save for offline', { timeout: 30_000 })
  }

  let restoreSnapshotFetch = false
  if (options.expiresAt) {
    const response = await page.request.get(`/_api/pages/${pageId}/offline-snapshot`)
    expect(response.ok(), `Offline snapshot fixture request failed: HTTP ${response.status()}`).toBe(true)
    const snapshot = (await response.json()) as OfflinePageSnapshotV1
    const withExpiry: OfflinePageSnapshotV1 = {
      ...snapshot,
      expiresAt: options.expiresAt,
      integrity: ''
    }
    withExpiry.integrity = snapshotIntegrity(withExpiry)
    await page.evaluate(
      ({ pathname, body }) => {
        const target = window as OfflineWindow
        const originalFetch = window.fetch
        target.__restoreOfflineSnapshotFetch = () => {
          window.fetch = originalFetch
          delete target.__restoreOfflineSnapshotFetch
        }
        window.fetch = async (input, init) => {
          const requestUrl = input instanceof Request ? input.url : String(input)
          if (new URL(requestUrl, window.location.origin).pathname !== pathname) return originalFetch(input, init)
          return new Response(body, {
            status: 200,
            headers: {
              'cache-control': 'private, no-store',
              'content-type': 'application/json',
              vary: 'Cookie'
            }
          })
        }
      },
      {
        pathname: `/_api/pages/${pageId}/offline-snapshot`,
        body: JSON.stringify(withExpiry)
      }
    )
    restoreSnapshotFetch = true
  }

  try {
    await control.click()
    await expect(control).toHaveAttribute('aria-label', 'Remove offline copy', { timeout: 30_000 })
    await expect(page.locator('.page-offline-status')).toContainText('Saved on this device', { timeout: 30_000 })
  } finally {
    if (restoreSnapshotFetch) {
      await page.evaluate(() => (window as OfflineWindow).__restoreOfflineSnapshotFetch?.())
    }
  }

  const saved = (await inspectOfflineDatabase(page)).snapshots.find(record => record.pageId === pageId)
  if (!saved) throw new Error(`The saved snapshot for ${path} was not found after the product save action.`)
  return saved
}

async function saveOfflinePages(page: Page, paths: readonly string[] = SEEDED_PAGE_PATHS): Promise<void> {
  await warmFeatureWorker(page)
  await authenticateAsAdmin(page)
  for (const path of paths) await savePageFromReader(page, path)
  await page.goto(OFFLINE_PATH, { waitUntil: 'networkidle' })
  await waitForOfflineShell(page)
  await expect(page.locator('.page-card')).toHaveCount(paths.length, { timeout: 30_000 })
}

async function installClipboardRejection(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const writeText = (): Promise<void> => {
      const rejection = Promise.withResolvers<void>()
      ;(window as OfflineWindow).__rejectOfflineClipboard = () => rejection.reject(new Error('Clipboard access denied for coverage.'))
      return rejection.promise
    }
    try {
      Object.defineProperty(window, '__rejectOfflineClipboard', { configurable: true, writable: true, value: undefined })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      })
      return true
    } catch {
      try {
        const clipboard = navigator.clipboard
        if (!clipboard) return false
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: writeText })
        return true
      } catch {
        return false
      }
    }
  })
}

async function rejectClipboard(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => typeof (window as OfflineWindow).__rejectOfflineClipboard === 'function'))
    .toBe(true)
  await page.evaluate(() => (window as OfflineWindow).__rejectOfflineClipboard?.())
}

test.describe('neutral offline saved-page surface', () => {
  test.describe.configure({ timeout: 90_000 })
  test('keeps search in the first narrow viewport and reports empty actions truthfully', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(OFFLINE_PATH, { waitUntil: 'networkidle' })
    await waitForOfflineShell(page)

    const search = page.getByRole('searchbox', { name: 'Search saved pages', exact: true })
    await expectLocatorWithinViewport(search, 'Saved-page search at 390px')
    await expectResponsiveLayout(page, 'Neutral offline shell at 390px')
    await expect(page.getByText('No saved pages yet.', { exact: true })).toBeVisible()

    const removeDownloadedPages = page.getByRole('button', { name: 'Remove downloaded pages', exact: true })
    const clearOfflineData = page.getByRole('button', { name: 'Clear offline data on this device', exact: true })
    await expect(removeDownloadedPages).toBeDisabled()
    await expect(clearOfflineData).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  })

  test('downloads through the product control, warms the feature worker, and falls back to local search and reading offline', async ({ page }) => {
    await saveOfflinePages(page)
    const origin = new URL(page.url()).origin
    const database = await inspectOfflineDatabase(page)
    expect(database.databaseVersion).toBeGreaterThanOrEqual(2)
    expect(database.storeNames).toEqual(expect.arrayContaining(['meta', 'snapshots', 'drafts', 'searchDocuments']))
    expect(database.snapshots).toHaveLength(2)
    expect(database.searchDocuments).toHaveLength(2)
    expect(database.meta).toMatchObject({
      schemaVersion: 1,
      snapshotCount: 2,
      accountingComplete: true
    })
    expect(database.meta?.managedBytes).toEqual(expect.any(Number))
    expect((database.meta?.managedBytes as number) > 0).toBe(true)
    for (const row of database.snapshots) {
      expect(row.siteId).toBe(origin)
      expect(row.pageId).toBeGreaterThan(0)
      expect(row.locale).toBe('en')
      expect(row.byteSize).toBeGreaterThan(0)
      expect(row.snapshot.pageId).toBe(row.pageId)
      expect(row.snapshot.locale).toBe(row.locale)
    }
    expect(database.searchDocuments.map(row => `${row.siteId}:${row.pageId}:${row.locale}`).sort()).toEqual(
      database.snapshots.map(row => `${row.siteId}:${row.pageId}:${row.locale}`).sort()
    )

    const warmCache = await inspectOwnedCaches(page)
    expect(warmCache.ownedNames.length).toBeGreaterThan(0)
    const warmCacheUrls = Object.values(warmCache.entries).flat()
    expect(warmCacheUrls.some(url => new URL(url).pathname === OFFLINE_PATH)).toBe(true)
    for (const url of warmCacheUrls) {
      const pathname = new URL(url).pathname
      expect(pathname === OFFLINE_PATH || pathname.startsWith('/_assets/js/') || pathname.startsWith('/_assets/assets/')).toBe(true)
    }

    await page.context().setOffline(true)
    const sensitiveResults = await page.evaluate(async paths => {
      const results: Array<{ path: string; fulfilled: boolean; status?: number; body?: string }> = []
      for (const path of paths) {
        try {
          const response = await fetch(path, { headers: { Accept: 'text/html' } })
          results.push({ path, fulfilled: true, status: response.status, body: (await response.text()).slice(0, 128) })
        } catch {
          results.push({ path, fulfilled: false })
        }
      }
      return results
    }, ['/verify/token', '/login-reset/token', '/_unlock', '/u', '/_api/users/whoami'])
    expect(sensitiveResults.every(result => !result.fulfilled), JSON.stringify(sensitiveResults)).toBe(true)

    await page.evaluate(path => window.location.assign(path), `/en/${SEEDED_PAGE_PATHS[0]}`)
    await waitForOfflineShell(page)
    const search = page.getByRole('searchbox', { name: 'Search saved pages', exact: true })
    await search.fill('Visual Markdown')
    await expect(page.locator('.page-card')).toHaveCount(1)
    await page.getByRole('button', { name: 'Open saved page Visual Markdown Browser', exact: true }).click()
    const reader = page.locator('.offline-reader')
    await expect(reader).toBeVisible()
    await expect(reader.getByRole('heading', { name: 'Visual Markdown Browser', exact: true })).toBeFocused()
    await expect(reader.locator('.offline-page-body')).toContainText('Visual Markdown browser')

    const offlineCache = await inspectOwnedCaches(page)
    for (const url of Object.values(offlineCache.entries).flat()) {
      const pathname = new URL(url).pathname
      expect(pathname).not.toMatch(/^\/(?:_api|verify|login-reset|_unlock|u)(?:\/|$)/iu)
    }
    await page.context().setOffline(false)
  })

  test('opens an actual saved snapshot, focuses its heading, and restores query and opener on Back', async ({ page }) => {
    await saveOfflinePages(page)
    const search = page.getByRole('searchbox', { name: 'Search saved pages', exact: true })
    await search.fill('Visual')
    await expect(page.locator('.page-card')).toHaveCount(2)

    const firstCard = page.locator('.page-card').first()
    const firstOpen = firstCard.getByRole('button', { name: /^Open saved page / })
    await firstOpen.click()

    const reader = page.locator('.offline-reader')
    await expect(reader).toBeVisible()
    const heading = reader.getByRole('heading', { level: 3 })
    await expect(heading).toBeVisible()
    await expect(heading).toBeFocused()
    await expect(search).toHaveValue('Visual')

    const selectedUrl = new URL(page.url())
    expect(selectedUrl.pathname).toBe(OFFLINE_PATH)
    expect([...selectedUrl.searchParams.keys()].sort()).toEqual(['locale', 'pageId', 'site'])

    await reader.getByRole('button', { name: 'Back to saved pages', exact: true }).click()
    await expect(reader).not.toBeVisible()
    await expect(search).toHaveValue('Visual')
    await expect(firstOpen).toBeFocused()
    const restoredUrl = new URL(page.url())
    expect(restoredUrl.pathname).toBe(OFFLINE_PATH)
    expect(restoredUrl.search).toBe('')
  })

  test('fences denied full-text fallback to the current saved-page selection', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard rejection control is covered only where Chromium exposes a controllable clipboard surface.')
    await saveOfflinePages(page)
    const cards = page.locator('.page-card')
    const titles = await cards.locator('.page-card-title').allTextContents()
    expect(titles).toHaveLength(2)

    const firstCard = cards.filter({ hasText: titles[0] })
    const secondCard = cards.filter({ hasText: titles[1] })
    await firstCard.getByRole('button', { name: /^Open saved page / }).click()
    const reader = page.locator('.offline-reader')
    await expect(reader).toBeVisible()
    await expect(reader.getByRole('heading', { name: titles[0], exact: true })).toBeFocused()

    const clipboardControlled = await installClipboardRejection(page)
    test.skip(!clipboardControlled, 'This Chromium channel does not allow a deterministic clipboard rejection control.')

    const copyText = reader.getByRole('button', { name: 'Copy full page text', exact: true })
    await copyText.click()
    await expect
      .poll(() => page.evaluate(() => typeof (window as OfflineWindow).__rejectOfflineClipboard === 'function'))
      .toBe(true)

    await reader.getByRole('button', { name: 'Back to saved pages', exact: true }).click()
    await expect(reader).not.toBeVisible()
    await secondCard.getByRole('button', { name: /^Open saved page / }).click()
    await expect(reader.getByRole('heading', { name: titles[1], exact: true })).toBeFocused()
    await rejectClipboard(page)
    await expect(page.getByRole('textbox', { name: 'Full saved page text for manual copying', exact: true })).toHaveCount(0)
    await expect(page.getByText('Clipboard access was denied. The full page text is selected below.', { exact: true })).not.toBeVisible()

    await copyText.click()
    await rejectClipboard(page)
    const fallback = page.getByRole('textbox', { name: 'Full saved page text for manual copying', exact: true })
    await expect(fallback).toBeVisible()
    await expect(fallback).toHaveValue(new RegExp(titles[1].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
  })

  test('expires a downloaded page offline, requests revalidation after reconnecting, and commits the refreshed copy', async ({ page }) => {
    await warmFeatureWorker(page)
    await authenticateAsAdmin(page)
    const expiresAt = new Date(Date.now() + 15_000).toISOString()
    const saved = await savePageFromReader(page, SEEDED_PAGE_PATHS[0], { expiresAt })
    expect(saved.snapshot.expiresAt).toBe(expiresAt)

    await page.goto(OFFLINE_PATH, { waitUntil: 'networkidle' })
    await waitForOfflineShell(page)
    await expect(page.locator('.page-card')).toHaveCount(1)
    await page.context().setOffline(true)
    await page.waitForTimeout(Math.max(0, Date.parse(expiresAt) - Date.now() + 250))
    await page.getByRole('button', { name: 'Refresh storage', exact: true }).click()
    await expect(page.locator('.page-card')).toHaveCount(0)
    const expiredDatabase = await inspectOfflineDatabase(page)
    expect(expiredDatabase.snapshots).toHaveLength(1)
    expect(expiredDatabase.snapshots[0]?.snapshot.expiresAt).toBe(expiresAt)

    await page.context().setOffline(false)
    const revalidationRequest = page.waitForRequest(request => {
      try {
        return new URL(request.url()).pathname === `/_api/pages/${saved.pageId}/offline-snapshot`
      } catch {
        return false
      }
    })
    await page.goto(`/en/${SEEDED_PAGE_PATHS[0]}`, { waitUntil: 'domcontentloaded' })
    await revalidationRequest
    const control = page.locator('.page-offline-control')
    await expect(control).toBeVisible()
    await expect(control).toHaveAttribute('aria-label', 'Save for offline', { timeout: 30_000 })
    await control.click()
    await expect(control).toHaveAttribute('aria-label', 'Remove offline copy', { timeout: 30_000 })
    const refreshedDatabase = await inspectOfflineDatabase(page)
    expect(refreshedDatabase.snapshots).toHaveLength(1)
    expect(refreshedDatabase.searchDocuments).toHaveLength(1)
    expect(refreshedDatabase.snapshots[0]?.snapshot.expiresAt).toBeNull()
  })

  test('invalidates a second offline tab after a committed product removal', async ({ page, context }) => {
    await saveOfflinePages(page, [SEEDED_PAGE_PATHS[0]])
    const secondPage = await context.newPage()
    try {
      await secondPage.goto(OFFLINE_PATH, { waitUntil: 'networkidle' })
      await waitForOfflineShell(secondPage)
      await expect(secondPage.locator('.page-card')).toHaveCount(1)

      await page.getByRole('button', { name: 'Remove page', exact: true }).click()
      await expect(page.locator('.page-card')).toHaveCount(0)
      await expect(secondPage.locator('.page-card')).toHaveCount(0)
      const database = await inspectOfflineDatabase(secondPage)
      expect(database.snapshots).toHaveLength(0)
      expect(database.searchDocuments).toHaveLength(0)
    } finally {
      await secondPage.close()
    }
  })

  test('returns focus to the adjacent saved page and then to search after removal', async ({ page }) => {
    await saveOfflinePages(page)
    const cards = page.locator('.page-card')
    const titles = await cards.locator('.page-card-title').allTextContents()
    expect(titles).toHaveLength(2)
    const search = page.getByRole('searchbox', { name: 'Search saved pages', exact: true })

    const firstCard = cards.filter({ hasText: titles[0] })
    const secondCard = cards.filter({ hasText: titles[1] })
    await firstCard.getByRole('button', { name: 'Remove page', exact: true }).click()
    await expect(cards).toHaveCount(1)
    const secondOpen = secondCard.getByRole('button', { name: /^Open saved page / })
    await expect(secondOpen).toBeFocused()

    await secondCard.getByRole('button', { name: 'Remove page', exact: true }).click()
    await expect(cards).toHaveCount(0)
    await expect(search).toBeFocused()
    await expect(page.getByRole('heading', { name: 'No saved pages yet', exact: true })).toBeVisible()
    const database = await inspectOfflineDatabase(page)
    expect(database.snapshots).toHaveLength(0)
    expect(database.searchDocuments).toHaveLength(0)
  })

  test('keeps whole-device clear cancelable, server-preserving, and truthful after confirmation', async ({ page }) => {
    await saveOfflinePages(page)
    const cards = page.locator('.page-card')
    await expect(cards).toHaveCount(2)
    const clearOfflineData = page.getByRole('button', { name: 'Clear offline data on this device', exact: true })
    const removeDownloadedPages = page.getByRole('button', { name: 'Remove downloaded pages', exact: true })
    await expect(removeDownloadedPages).toBeEnabled()
    const beforeClear = await inspectOfflineDatabase(page)
    const previousGeneration = beforeClear.meta?.sessionGeneration

    await clearOfflineData.click()
    const dialog = page.getByRole('dialog', { name: 'Clear offline data on this device?', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('It does not delete anything from the server.')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(cards).toHaveCount(2)

    await clearOfflineData.click()
    await dialog.getByRole('button', { name: 'Clear offline data', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText(/Offline data was cleared on this device\. Local generation \d+ is active; server data was not deleted\./u)).toBeVisible()
    await expect(cards).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'No saved pages yet', exact: true })).toBeVisible()
    await expect(removeDownloadedPages).toBeDisabled()
    await expect(clearOfflineData).toBeEnabled()
    const afterClear = await inspectOfflineDatabase(page)
    expect(afterClear.snapshots).toHaveLength(0)
    expect(afterClear.searchDocuments).toHaveLength(0)
    expect(afterClear.draftCount).toBe(0)
    expect(afterClear.meta).toMatchObject({ snapshotCount: 0, managedBytes: 0, accountingComplete: true })
    expect(afterClear.meta?.sessionGeneration).toBeGreaterThan(previousGeneration as number)

    const pagesResponse = await page.request.get('/_api/pages')
    expect(pagesResponse.ok()).toBe(true)
    const pages = (await pagesResponse.json()) as PageRow[]
    expect(pages.some(candidate => candidate.path === SEEDED_PAGE_PATHS[0])).toBe(true)
  })

})
