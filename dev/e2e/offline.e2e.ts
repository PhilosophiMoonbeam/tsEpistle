import { createHash } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { authenticateAsAdmin, expectLocatorWithinViewport, expectResponsiveLayout, responsiveTest as test } from './helpers.ts'
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

const OFFLINE_PATH = '/_offline' // Immutable cached bootstrap, not an application destination.
const OFFLINE_SETTINGS_PATH = '/p/offline'
const SEEDED_PAGE_PATHS = ['visual-markdown-browser', 'visual-html-browser'] as const
const OWNED_CACHE_NAME_PATTERN = /^tsepistle-pwa-precache-v1-[0-9a-f]{16}(?:-candidate-[0-9a-z-]+)?$/u

async function waitForOfflineSettings(page: Page): Promise<void> {
  await expect(page.locator('.nav-header')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.offline-settings')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Offline access', level: 1, exact: true })).toBeVisible()
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
  await page.goto(OFFLINE_SETTINGS_PATH, { waitUntil: 'networkidle' })
  await waitForOfflineSettings(page)
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
  const header = page.locator('.page-header-section')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(`/en/${path}`, { waitUntil: 'domcontentloaded' })
    try {
      await header.waitFor({ state: 'visible', timeout: 30_000 })
      break
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
  const control = page.locator('.page-offline-control')
  await expect(control).toHaveCount(1)
  await expect(control).toBeVisible({ timeout: 30_000 })
  await expect(control).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => control.getAttribute('aria-label'), { timeout: 30_000 }).toMatch(/^(?:Save offline copy|Remove offline copy)$/u)
  await expect(control).toHaveAttribute('aria-describedby', /offline-status$/u)

  let currentLabel = await control.getAttribute('aria-label')
  if (currentLabel === 'Remove offline copy' && !options.expiresAt) {
    await expect(control).toHaveAttribute('aria-pressed', 'true')
    const current = (await inspectOfflineDatabase(page)).snapshots.find(record => record.pageId === pageId)
    if (!current) throw new Error(`The saved snapshot for ${path} was not found.`)
    return current
  }

  if (currentLabel === 'Remove offline copy' && options.expiresAt) {
    await control.click()
    await expect(control).toHaveAttribute('aria-label', 'Save offline copy', { timeout: 30_000 })
    await expect(control).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 })
    currentLabel = 'Save offline copy'
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
    await expect(control).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
    await expect(page.locator('.page-offline-status')).toContainText('readable offline copy is saved on this device', { timeout: 30_000 })
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
  await page.goto(OFFLINE_SETTINGS_PATH, { waitUntil: 'networkidle' })
  await waitForOfflineSettings(page)
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
  await expect.poll(() => page.evaluate(() => typeof (window as OfflineWindow).__rejectOfflineClipboard === 'function')).toBe(true)
  await page.evaluate(() => (window as OfflineWindow).__rejectOfflineClipboard?.())
}

test.describe('integrated offline access', () => {
  test.describe.configure({ timeout: 90_000 })
  test('keeps search in the first narrow viewport and reports empty actions truthfully', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(OFFLINE_SETTINGS_PATH, { waitUntil: 'networkidle' })
    await waitForOfflineSettings(page)

    const search = page.getByRole('searchbox', { name: 'Search saved pages', exact: true })
    await expectLocatorWithinViewport(search, 'Saved-page search at 390px')
    await expectResponsiveLayout(page, 'Offline profile settings at 390px')
    await expect(page.getByText('No saved pages yet.', { exact: true })).toBeVisible()

    const removeDownloadedPages = page.getByRole('button', { name: 'Remove saved pages', exact: true })
    const clearOfflineData = page.getByRole('button', { name: 'Clear offline data on this device', exact: true })
    await expect(removeDownloadedPages).toBeDisabled()
    await expect(clearOfflineData).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  })

  test('downloads through the product control, warms the feature worker, and falls back to local search and reading offline', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Playwright Firefox setOffline leaves network requests online.')
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
    const sensitiveResults = await page.evaluate(
      async paths => {
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
      },
      ['/verify/token', '/login-reset/token', '/_unlock', '/u', '/_api/users/whoami']
    )
    expect(
      sensitiveResults.every(result => !result.fulfilled),
      JSON.stringify(sensitiveResults)
    ).toBe(true)

    const saved = database.snapshots.find(row => row.snapshot.path === SEEDED_PAGE_PATHS[0])!
    await page.goto(saved.snapshot.canonicalPath, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.nav-header')).toBeVisible()
    const reader = page.locator('.offline-reader')
    await expect(reader).toBeVisible()
    await expect(reader.getByRole('heading', { name: saved.snapshot.title, level: 1, exact: true })).toBeFocused()
    await expect(reader.locator('.offline-page-body')).toContainText('Visual Markdown browser')
    expect(new URL(page.url()).pathname).toBe(saved.snapshot.canonicalPath)

    await reader.getByRole('button', { name: 'Back to saved pages', exact: true }).click()
    await expect(page).toHaveURL(new URL(`${OFFLINE_SETTINGS_PATH}#downloaded-pages-title`, origin).href)
    await waitForOfflineSettings(page)
    const search = page.getByRole('searchbox', { name: 'Search saved pages', exact: true })
    await search.fill('Visual Markdown')
    await expect(page.locator('.page-card')).toHaveCount(1)
    await page.getByRole('button', { name: 'Open saved page Visual Markdown Browser', exact: true }).click()
    await expect(page.locator('#offline-reader-title')).toHaveText(saved.snapshot.title)
    expect(new URL(page.url()).pathname).toBe(saved.snapshot.canonicalPath)

    const offlineCache = await inspectOwnedCaches(page)
    for (const url of Object.values(offlineCache.entries).flat()) {
      const pathname = new URL(url).pathname
      expect(pathname).not.toMatch(/^\/(?:_api|verify|login-reset|_unlock|u)(?:\/|$)/iu)
    }
    await page.context().setOffline(false)
  })

  test('opens saved pages at their normal URLs and returns to profile settings', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Playwright Firefox setOffline leaves network requests online.')
    await saveOfflinePages(page)
    const savedPages = (await inspectOfflineDatabase(page)).snapshots
    await page.context().setOffline(true)
    await page.goto(`${OFFLINE_SETTINGS_PATH}#downloaded-pages-title`, { waitUntil: 'domcontentloaded' })
    await waitForOfflineSettings(page)
    const search = page.getByRole('searchbox', { name: 'Search saved pages', exact: true })
    await search.fill('Visual')
    await expect(page.locator('.page-card')).toHaveCount(2)

    const firstCard = page.locator('.page-card').first()
    const title = (await firstCard.locator('.page-card-title').textContent())!.trim()
    const saved = savedPages.find(row => row.snapshot.title === title)!
    await firstCard.getByRole('button', { name: /^Open saved page / }).click()
    await expect(page.locator('.nav-header')).toBeVisible()
    await expect(page.locator('#offline-reader-title')).toHaveText(title)
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeFocused()
    expect(new URL(page.url()).pathname).toBe(saved.snapshot.canonicalPath)
    expect(new URL(page.url()).search).toBe('')

    // Full document navigation preserves the canonical page in browser history.
    await page.goBack({ waitUntil: 'domcontentloaded' })
    await waitForOfflineSettings(page)
    expect(new URL(page.url()).pathname).toBe(OFFLINE_SETTINGS_PATH)
    await page.goForward({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('#offline-reader-title')).toHaveText(title)
    await page.getByRole('button', { name: 'Back to saved pages', exact: true }).click()
    await waitForOfflineSettings(page)
    expect(new URL(page.url()).pathname).toBe(OFFLINE_SETTINGS_PATH)
    expect(new URL(page.url()).hash).toBe('#downloaded-pages-title')
    await page.context().setOffline(false)
  })

  test('offers the current saved page text when clipboard access is denied', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard rejection control is covered only where Chromium exposes a controllable clipboard surface.')
    await saveOfflinePages(page)
    const saved = (await inspectOfflineDatabase(page)).snapshots[0]!
    await page.context().setOffline(true)
    await page.goto(saved.snapshot.canonicalPath, { waitUntil: 'domcontentloaded' })
    const reader = page.locator('.offline-reader')
    await expect(reader.getByRole('heading', { name: saved.snapshot.title, level: 1, exact: true })).toBeFocused()
    const clipboardControlled = await installClipboardRejection(page)
    test.skip(!clipboardControlled, 'This Chromium channel does not allow a deterministic clipboard rejection control.')
    await reader.getByRole('button', { name: 'Copy full page text', exact: true }).click()
    await rejectClipboard(page)
    const fallback = page.getByRole('textbox', { name: 'Full saved page text for manual copying', exact: true })
    await expect(fallback).toBeVisible()
    expect(await fallback.inputValue()).toContain(saved.snapshot.title)
    await expect(page.getByText('Clipboard access was denied. The full page text is selected below.', { exact: true })).toBeVisible()
    await expect(fallback).toBeFocused()
    const copiedText = await fallback.inputValue()
    expect(await fallback.evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart)).toBe(copiedText.length)

    // Leaving the document cannot carry its clipboard fallback into another page.
    await reader.getByRole('button', { name: 'Back to saved pages', exact: true }).click()
    await waitForOfflineSettings(page)
    await expect(fallback).toHaveCount(0)
    const other = (await inspectOfflineDatabase(page)).snapshots.find(row => row.pageId !== saved.pageId)!
    await page.goto(other.snapshot.canonicalPath, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#offline-reader-title')).toHaveText(other.snapshot.title)
    await expect(fallback).toHaveCount(0)
    await page.context().setOffline(false)
  })

  test('keeps the canonical page on reconnect and offers offline preferences in the account menu', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Playwright Firefox setOffline leaves network requests online.')
    await saveOfflinePages(page, [SEEDED_PAGE_PATHS[0]])
    const saved = (await inspectOfflineDatabase(page)).snapshots[0]!
    await page.context().setOffline(true)
    await page.goto(saved.snapshot.canonicalPath, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#offline-reader-title')).toHaveText(saved.snapshot.title)
    await page.locator('.account-menu__trigger').click()
    const settingsLink = page.locator('.account-menu').getByRole('link', { name: 'Offline preferences', exact: true })
    await expect(settingsLink).toHaveAttribute('href', OFFLINE_SETTINGS_PATH)
    await settingsLink.click()
    await waitForOfflineSettings(page)
    expect(new URL(page.url()).pathname).toBe(OFFLINE_SETTINGS_PATH)

    await page.goto(saved.snapshot.canonicalPath, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#offline-reader-title')).toHaveText(saved.snapshot.title)
    await page.context().setOffline(false)
    await expect(page.locator('.page-header-section')).toBeVisible({ timeout: 30_000 })
    expect(new URL(page.url()).pathname).toBe(saved.snapshot.canonicalPath)
    await expect(page.locator('.offline-application')).toHaveCount(0)
    await expect(page.locator('.nav-header')).toBeVisible()
    await page.locator('.account-menu__trigger').click()
    await expect(settingsLink).toHaveAttribute('href', OFFLINE_SETTINGS_PATH)
  })

  test('treats an expired offline selection as removable rather than a refresh action', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Playwright Firefox setOffline leaves network requests online.')
    await warmFeatureWorker(page)
    await authenticateAsAdmin(page)
    const expiresAt = new Date(Date.now() + 30_000).toISOString()
    const saved = await savePageFromReader(page, SEEDED_PAGE_PATHS[0], { expiresAt })
    expect(saved.snapshot.expiresAt).toBe(expiresAt)

    await page.goto(OFFLINE_SETTINGS_PATH, { waitUntil: 'networkidle' })
    await waitForOfflineSettings(page)
    await expect(page.locator('.page-card')).toHaveCount(1)
    await page.context().setOffline(true)
    await page.waitForTimeout(Math.max(0, Date.parse(expiresAt) - Date.now() + 250))
    await page.getByRole('button', { name: 'Refresh storage', exact: true }).click()
    await expect(page.locator('.page-card')).toHaveCount(0)
    const expiredDatabase = await inspectOfflineDatabase(page)
    expect(expiredDatabase.snapshots).toHaveLength(1)
    expect(expiredDatabase.snapshots[0]?.snapshot.expiresAt).toBe(expiresAt)

    await page.context().setOffline(false)
    await page.goto(`/en/${SEEDED_PAGE_PATHS[0]}`, { waitUntil: 'domcontentloaded' })
    const control = page.locator('.page-offline-control')
    await expect(control).toBeVisible()
    await expect(control).toHaveAttribute('aria-label', 'Remove offline copy', { timeout: 30_000 })
    await expect(control).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
    await control.click()
    await expect(control).toHaveAttribute('aria-label', 'Save offline copy', { timeout: 30_000 })
    await expect(control).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 })
    const removedDatabase = await inspectOfflineDatabase(page)
    expect(removedDatabase.snapshots).toHaveLength(0)
    expect(removedDatabase.searchDocuments).toHaveLength(0)
  })

  test('invalidates a second offline tab after a committed product removal', async ({ page, context }) => {
    await saveOfflinePages(page, [SEEDED_PAGE_PATHS[0]])
    const secondPage = await context.newPage()
    try {
      await secondPage.goto(OFFLINE_SETTINGS_PATH, { waitUntil: 'networkidle' })
      await waitForOfflineSettings(secondPage)
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
    const removeDownloadedPages = page.getByRole('button', { name: 'Remove saved pages', exact: true })
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
    await expect(page.getByText('Offline data was cleared on this device. Your server data was not deleted.', { exact: true })).toBeVisible()
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

test('account and navigation remain useful through offline startup and reconnect', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', 'Playwright Firefox setOffline leaves network requests online.')
  test.setTimeout(90_000)
  await warmFeatureWorker(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  const account = page.locator('.account-menu__trigger')
  await account.click()
  const menu = page.locator('.account-menu')
  await expect(menu.getByRole('link', { name: 'Connection and offline access', exact: true })).toHaveAttribute('href', '/p/offline')
  await expect(menu.locator('.pwa-status-panel')).toHaveCount(0)
  await expect(menu.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  const indicator = account.locator('[data-connectivity-indicator]')
  await expect(indicator).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(indicator).toHaveCSS('border-top-width', '0px')
  await account.click()

  await page.context().setOffline(true)
  if ((page.viewportSize()?.width ?? 1280) < 960) await page.getByRole('button', { name: /open navigation/i }).click()
  await expect(page.locator('.nav-sidebar-offline')).toContainText('You’re offline')
  await expect(page.locator('.nav-sidebar-offline a')).toHaveAttribute('href', '/p/offline')
  await expect(page.locator('.nav-sidebar .async-state--error')).toHaveCount(0)
  await page.goto(OFFLINE_SETTINGS_PATH, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.offline-application')).toBeVisible()
  await waitForOfflineSettings(page)
  await account.click()
  await expect(menu).toContainText('Reconnect to verify your session')
  await expect(menu.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0)
  await expect(menu.getByRole('link', { name: 'Connection and offline access', exact: true })).toHaveAttribute('href', '/p/offline')
  await expectResponsiveLayout(page, 'offline account menu')
  await account.click()

  await page.context().setOffline(false)
  await expect(page.locator('.offline-connection')).toContainText('Connected.', { timeout: 30_000 })
  await account.click()
  await expect(menu.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(menu.locator('.account-menu__unverified')).toHaveCount(0)
  await expect(page).toHaveURL(OFFLINE_SETTINGS_PATH)
  await expect(page.locator('.offline-application')).toBeVisible()
})
