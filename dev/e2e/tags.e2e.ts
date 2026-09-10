import { expect, type Page } from '@playwright/test'

import { expectResponsiveLayout, responsiveTest as test } from './helpers'

type PageApiRow = {
  id: number
  locale: string
  path: string
  title: string | null
  description: string | null
  visibility: 'public' | 'private'
  ownerId: number | null
  contentType: string
  createdAt: string
  updatedAt: string
  tags: string[]
}

type TagSiteLang = {
  code: string
  name: string
}

type TagApiOptions = {
  failTagLoads?: number
  failPageLoads?: number
  siteLangs?: TagSiteLang[]
  pageResponse?: (selection: string[], locale?: string) => PageApiRow[] | Promise<PageApiRow[]>
}

const ordinaryTagLabel = 'Ordinary topic'
const longTagLabel = 'Long editorial vocabulary label for containment geometry'
const longTagCanonical = 'long-editorial-vocabulary-label-for-containment-geometry'

const tagRows = [
  { id: 1, tag: 'alpha', title: 'Alpha', createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' },
  { id: 2, tag: 'beta', title: 'Beta', createdAt: '2026-09-02T12:00:00.000Z', updatedAt: '2026-09-02T12:00:00.000Z' },
  { id: 3, tag: 'untitled-topic', title: null, createdAt: '2026-09-03T12:00:00.000Z', updatedAt: '2026-09-03T12:00:00.000Z' },
  { id: 4, tag: 'unicode-topic', title: '東京の知識', createdAt: '2026-09-04T12:00:00.000Z', updatedAt: '2026-09-04T12:00:00.000Z' },
  { id: 5, tag: 'ordinary-topic', title: ordinaryTagLabel, createdAt: '2026-09-05T12:00:00.000Z', updatedAt: '2026-09-05T12:00:00.000Z' },
  { id: 6, tag: longTagCanonical, title: longTagLabel, createdAt: '2026-09-06T12:00:00.000Z', updatedAt: '2026-09-06T12:00:00.000Z' }
]

function pageRow(overrides: Partial<PageApiRow> = {}): PageApiRow {
  return {
    id: 11,
    locale: 'en',
    path: 'guide/start',
    title: 'Guide start',
    description: 'A page returned by the tag browse fixture.',
    visibility: 'public',
    ownerId: null,
    contentType: 'markdown',
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-05T12:00:00.000Z',
    tags: ['alpha'],
    ...overrides
  }
}

function defaultPageResponse(selection: string[]): PageApiRow[] {
  if (selection.length === 0) return []
  if (selection.join(',') === 'alpha,beta') {
    return [pageRow({ id: 22, title: 'Latest result', description: 'Matches both selected concepts.', tags: ['alpha', 'beta'] })]
  }
  if (selection.length === 1 && selection[0] === 'alpha') {
    return [pageRow()]
  }
  if (selection.includes('untitled-topic')) {
    return [pageRow({ id: 33, path: 'guide/untitled-topic', title: null, description: null, tags: ['untitled-topic'] })]
  }
  return []
}

async function installTagApi(page: Page, options: TagApiOptions = {}) {
  let tagFailures = options.failTagLoads ?? 0
  let pageFailures = options.failPageLoads ?? 0

  if (options.siteLangs !== undefined) {
    await page.addInitScript(siteLangs => {
      let currentSiteLangs: unknown
      Object.defineProperty(window, 'siteLangs', {
        configurable: true,
        get: () => currentSiteLangs,
        set: () => {
          currentSiteLangs = siteLangs
        }
      })
    }, options.siteLangs)
  }

  await page.route(/\/_api\/pages(?:\/tags)?(?:\?.*)?$/, async route => {
    const request = route.request()
    if (request.method() !== 'GET') return route.continue()

    const url = new URL(request.url())
    if (url.pathname === '/_api/pages/tags') {
      if (tagFailures > 0) {
        tagFailures -= 1
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary tag index failure' }) })
      }
      return route.fulfill({ json: tagRows })
    }

    if (url.pathname !== '/_api/pages') return route.continue()
    if (pageFailures > 0) {
      pageFailures -= 1
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary result failure' }) })
    }

    const selection = url.searchParams.get('tags')?.split(',').filter(Boolean) ?? []
    const locale = url.searchParams.get('locale') ?? undefined
    const payload = options.pageResponse ? await options.pageResponse(selection, locale) : defaultPageResponse(selection)
    return route.fulfill({ json: payload })
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tagButton(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}(?:\\b|\\s|$)`, 'i') }).first()
}

async function revealTagButton(page: Page, label: string) {
  const button = tagButton(page, label)
  if (!(await button.isVisible())) {
    const showTags = page.getByRole('button', { name: 'Show tags', exact: true })
    if (await showTags.isVisible()) await showTags.click()
  }
  await expect(button).toBeVisible()
  return button
}

async function expectTagIndexGeometry(page: Page, expectedTreeColumns: number, expectedIndexWidth: number | undefined, surface: string) {
  const geometry = await page.evaluate(
    ({ shortLabel, longLabel }) => {
      const index = document.querySelector<HTMLElement>('.tags-index')
      const tree = document.querySelector<HTMLElement>('.tags-index-tree')
      const items = [...document.querySelectorAll<HTMLElement>('.tags-index-item')]
      const shortItem = items.find(item => item.getAttribute('aria-label')?.startsWith(shortLabel))
      const longItem = items.find(item => item.getAttribute('aria-label')?.startsWith(longLabel))
      const shortLabelElement = shortItem?.querySelector<HTMLElement>('.tags-index-item-label')
      const longCopy = longItem?.querySelector<HTMLElement>('.tags-index-item-copy')
      if (!index || !tree || !shortItem || !longItem || !shortLabelElement || !longCopy) return null

      const shortLabelRect = shortLabelElement.getBoundingClientRect()
      const longItemRect = longItem.getBoundingClientRect()
      const treeColumns = window.getComputedStyle(tree).gridTemplateColumns.trim().split(/\s+/).filter(Boolean)

      return {
        treeColumns: treeColumns.length,
        indexWidth: index.getBoundingClientRect().width,
        indexRight: index.getBoundingClientRect().right,
        longItemRight: longItemRect.right,
        longCopyClientWidth: longCopy.clientWidth,
        longCopyScrollWidth: longCopy.scrollWidth,
        shortLabelHeight: shortLabelRect.height,
        shortLabelLineHeight: Number.parseFloat(window.getComputedStyle(shortLabelElement).lineHeight),
        shortLabelWidth: shortLabelRect.width,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth
      }
    },
    { shortLabel: ordinaryTagLabel, longLabel: longTagLabel }
  )

  expect(geometry, `${surface} must expose ordinary and long tag item geometry`).not.toBeNull()
  if (!geometry) throw new Error(`${surface} did not expose ordinary and long tag item geometry.`)

  expect(geometry.treeColumns, `${surface} must use the expected tag index column count`).toBe(expectedTreeColumns)
  expect(geometry.shortLabelLineHeight, `${surface} must expose a measurable short tag line height`).toBeGreaterThan(0)
  expect(geometry.shortLabelHeight, `${surface} short labels must not stack glyph-by-glyph`).toBeLessThanOrEqual(geometry.shortLabelLineHeight * 1.5)
  expect(geometry.longCopyScrollWidth, `${surface} long labels must remain contained in their item`).toBeLessThanOrEqual(geometry.longCopyClientWidth + 1)
  expect(geometry.longItemRight, `${surface} long labels must remain inside the tag index rail`).toBeLessThanOrEqual(geometry.indexRight + 1)
  expect(geometry.documentWidth, `${surface} must not overflow its viewport`).toBeLessThanOrEqual(geometry.viewportWidth + 1)

  if (expectedIndexWidth !== undefined) {
    expect(geometry.indexWidth, `${surface} must preserve the 280px tag index rail`).toBeGreaterThanOrEqual(expectedIndexWidth - 1)
    expect(geometry.indexWidth, `${surface} must preserve the 280px tag index rail`).toBeLessThanOrEqual(expectedIndexWidth + 1)
  }
}

async function openTags(page: Page, path = '/t', options: TagApiOptions = {}) {
  await installTagApi(page, options)
  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: /tags/i }).first()).toBeVisible()
}
async function expectTagFooterReachability(page: Page, resultName: RegExp, surface: string) {
  const resultLink = page.getByRole('link', { name: resultName }).last()
  await expect(resultLink).toBeVisible()

  const footerDocumentTopBeforeScroll = await page.evaluate(() => {
    const footer = document.querySelector('footer')
    if (!(footer instanceof HTMLElement)) return null
    return footer.getBoundingClientRect().top + window.scrollY
  })
  expect(footerDocumentTopBeforeScroll, `${surface} must expose a footer before scrolling`).not.toBeNull()
  if (footerDocumentTopBeforeScroll === null) throw new Error(`${surface} did not expose a footer before scrolling.`)

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await resultLink.evaluate(element => {
    if (element instanceof HTMLElement) element.focus({ preventScroll: true })
  })
  await expect(resultLink).toBeFocused()

  const geometry = await page.evaluate(() => {
    const footer = document.querySelector('footer')
    const bottomContent = document.querySelector('main article:last-of-type')
    const focused = document.activeElement
    if (!(footer instanceof HTMLElement) || !(bottomContent instanceof HTMLElement) || !(focused instanceof HTMLElement)) return null

    const bounds = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        documentTop: rect.top + window.scrollY,
        documentBottom: rect.bottom + window.scrollY
      }
    }

    return {
      footer: bounds(footer),
      bottomContent: bounds(bottomContent),
      focused: bounds(focused),
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight
    }
  })

  expect(geometry, `${surface} must expose footer and bottom content geometry`).not.toBeNull()
  if (!geometry) throw new Error(`${surface} did not expose footer and bottom content geometry.`)

  expect(Math.abs(geometry.scrollY + geometry.viewportHeight - geometry.scrollHeight), `${surface} must reach the document end`).toBeLessThanOrEqual(1)
  expect(geometry.footer.top, `${surface} footer must be visible at the document end`).toBeGreaterThanOrEqual(0)
  expect(geometry.footer.bottom, `${surface} footer must fit in the viewport`).toBeLessThanOrEqual(geometry.viewportHeight + 1)
  expect(geometry.focused.top, `${surface} focused final control must be fully visible`).toBeGreaterThanOrEqual(-1)
  expect(geometry.focused.bottom, `${surface} focused final control must be fully visible`).toBeLessThanOrEqual(geometry.viewportHeight + 1)
  expect(geometry.focused.bottom, `${surface} footer must not occlude the focused final control`).toBeLessThanOrEqual(geometry.footer.top + 1)
  expect(
    Math.abs(geometry.footer.documentTop - footerDocumentTopBeforeScroll),
    `${surface} footer must stay at one document position while scrolling`
  ).toBeLessThanOrEqual(1)
  expect(geometry.footer.documentTop, `${surface} footer must follow bottom content in document flow`).toBeGreaterThanOrEqual(
    geometry.bottomContent.documentBottom - 1
  )
}

test('public tag library supports local filtering, AND selection, and mobile result focus', async ({ page }) => {
  const longResultDescription = Array.from(
    { length: 80 },
    (_, index) => `Long result detail ${index + 1} keeps the public tag result content meaningfully tall for end-of-document checks.`
  ).join(' ')
  await openTags(page, '/t', {
    siteLangs: [
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'French' }
    ],
    pageResponse: (selection, locale) => {
      const rows = defaultPageResponse(selection)
      if (selection.length === 1 && selection[0] === 'alpha' && locale === 'fr') {
        return [
          pageRow({
            id: 44,
            locale: 'fr',
            path: 'guide/french-start',
            title: 'French guide result',
            description: 'A French result returned after choosing the configured locale.',
            tags: ['alpha']
          })
        ]
      }
      if (selection.join(',') !== 'alpha,beta') return rows
      return [
        ...rows.map(row => ({ ...row, locale: locale ?? row.locale, description: longResultDescription })),
        pageRow({
          id: 56,
          locale: locale ?? 'en',
          path: 'guide/trailing-result',
          title: 'Trailing result',
          description: 'A short final result keeps the last actionable control compact.',
          tags: ['alpha', 'beta']
        })
      ]
    }
  })

  const browseLink = page.getByRole('banner').getByRole('link', { name: /^browse(?: by)? tags$/i })
  await expect(browseLink).toHaveAttribute('href', '/t')
  await expect(browseLink).toHaveAttribute('aria-current', 'page')
  await browseLink.focus()
  await expect(browseLink).toBeFocused()

  const indexSearch = page.getByRole('textbox', { name: /search tags/i }).first()
  await expect(indexSearch).toBeVisible()
  await indexSearch.fill('does-not-exist')
  await expect(page.getByText(/no .*tags|no matching/i).first()).toBeVisible()
  const noMatchingTagsHeading = page.getByRole('heading', { name: 'No matching tags', exact: true, level: 3 })
  await expect(noMatchingTagsHeading).toBeVisible()

  await expect(tagButton(page, 'Alpha')).toHaveCount(0)
  const clearIndexSearch = page.locator('.tags-index-empty').getByRole('button', { name: 'Clear search', exact: true })
  await expect(clearIndexSearch).toBeVisible()
  await clearIndexSearch.click()
  await expect(indexSearch).toHaveValue('')
  await expect(indexSearch).toBeFocused()
  await expect(await revealTagButton(page, 'Alpha')).toBeVisible()
  await expect(await revealTagButton(page, 'untitled-topic')).toBeVisible()

  const alpha = await revealTagButton(page, 'Alpha')
  await alpha.click()
  await expect(alpha).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('link', { name: /guide start/i })).toBeVisible()

  const resultsSearch = page.getByRole('textbox', { name: /search (within results|these pages)/i }).first()
  await expect(resultsSearch).toBeVisible()
  await resultsSearch.fill('does-not-exist')
  const clearResultsSearch = page.locator('.tags-results .tags-state').getByRole('button', { name: 'Clear search', exact: true })
  await expect(clearResultsSearch).toBeVisible()
  await clearResultsSearch.click()
  await expect(resultsSearch).toHaveValue('')
  await expect(resultsSearch).toBeFocused()

  const initialViewport = page.viewportSize()
  if (!initialViewport) throw new Error('Responsive tag coverage requires a configured viewport.')
  const desktopViewport = { width: 1440, height: 900 }
  const mobileViewport = { width: 390, height: 844 }

  await page.setViewportSize(desktopViewport)
  await indexSearch.focus()
  await expect(indexSearch).toBeFocused()
  await page.setViewportSize(mobileViewport)
  await expect(indexSearch).toBeFocused()
  const expandedDisclosure = page.getByRole('button', { name: 'Hide tags', exact: true })
  await expect(expandedDisclosure).toBeVisible()
  await expect(expandedDisclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#tags-index-panel')).toBeVisible()

  await expandedDisclosure.focus()
  await expect(expandedDisclosure).toBeFocused()
  await page.setViewportSize(desktopViewport)
  await expect(indexSearch).toBeFocused()
  await expect(page.locator('#tags-index-panel')).toBeVisible()
  await expect(page.locator('.tags-index-disclosure')).toBeHidden()

  await page.setViewportSize(mobileViewport)
  const viewPages = page.getByRole('button', { name: 'View pages', exact: true })
  await expect(viewPages).toBeVisible()
  await viewPages.focus()
  await expect(viewPages).toBeFocused()
  await page.setViewportSize(desktopViewport)
  const resultHeading = page.getByRole('heading', { name: /pages|results/i }).last()
  await expect(resultHeading).toBeFocused()

  await page.setViewportSize(mobileViewport)
  await expect(resultHeading).toBeFocused()
  const collapsedDisclosure = page.getByRole('button', { name: 'Show tags', exact: true })
  await expect(collapsedDisclosure).toBeVisible()
  await expect(collapsedDisclosure).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#tags-index-panel')).toBeHidden()
  await collapsedDisclosure.focus()
  await expect(collapsedDisclosure).toBeFocused()
  await expect(indexSearch).toBeVisible()
  await page.setViewportSize(desktopViewport)
  await expect(indexSearch).toBeFocused()
  await expect(indexSearch).toBeVisible()
  await expect(page.locator('#tags-index-panel')).toBeVisible()
  await expect(page.locator('.tags-index-disclosure')).toBeHidden()
  await page.setViewportSize(initialViewport)

  const locale = page.getByRole('combobox', { name: 'Locale', exact: true })
  await expect(locale).toBeVisible()
  await expect(locale).toHaveAccessibleName('Locale')
  const orderBy = page.getByRole('combobox', { name: 'Order By', exact: true })
  await expect(orderBy).toBeVisible()
  await expect(orderBy).toHaveAccessibleName('Order By')

  await locale.focus()
  await expect(locale).toBeFocused()
  await locale.press('Enter')
  await page.getByRole('option', { name: 'French', exact: true }).click()
  await expect(page).toHaveURL(/\/t\/alpha\?lang=fr(?:$|#)/)
  const frenchResult = page.getByRole('link', { name: /french guide result/i })
  await expect(frenchResult).toBeVisible()
  await expect(frenchResult).toHaveAttribute('href', '/fr/guide/french-start')
  await expectTagFooterReachability(page, /french guide result/i, 'short tag result')

  const beta = await revealTagButton(page, 'Beta')
  await beta.click()
  await expect(beta).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/\/t\/alpha\/beta\?lang=fr(?:$|#)/)
  await expect(page.getByRole('link', { name: /latest result/i })).toBeVisible()
  await expectTagFooterReachability(page, /trailing result/i, 'long tag result')

  const viewportWidth = page.viewportSize()?.width
  if (viewportWidth === undefined) throw new Error('Responsive tag coverage requires a configured viewport width.')
  if (viewportWidth < 960) {
    const viewPages = page.getByRole('button', { name: 'View pages', exact: true })
    await expect(viewPages).toBeVisible()
    await viewPages.click()
    const resultHeading = page.getByRole('heading', { name: /pages|results/i }).last()
    await expect(resultHeading).toBeFocused()
  }
  const betaRemove = page.getByRole('button', { name: /remove.*beta/i }).first()
  await expect(betaRemove).toBeVisible()
  await betaRemove.click()
  await expect(page).toHaveURL(/\/t\/alpha(?:\?|$)/)
  await page.getByRole('button', { name: /^clear selection$/i }).click()
  await expect(page).toHaveURL(/\/t(?:\?|$)/)
  await expectResponsiveLayout(page, 'public tag library')
})

test('public tag index keeps selected desktop labels readable and contained', async ({ page }) => {
  await openTags(page)

  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(await revealTagButton(page, ordinaryTagLabel)).toBeVisible()
  await expectTagIndexGeometry(page, 2, undefined, 'unselected tag index at 1024px')

  const ordinary = tagButton(page, ordinaryTagLabel)
  await ordinary.click()
  await expect(ordinary).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/\/t\/ordinary-topic(?:$|[?#])/)
  await expectTagIndexGeometry(page, 1, 280, 'selected tag index at 1024px')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: /tags/i }).first()).toBeVisible()
  const reloadedOrdinary = await revealTagButton(page, ordinaryTagLabel)
  await expect(reloadedOrdinary).toHaveAttribute('aria-pressed', 'true')
  await expectTagIndexGeometry(page, 1, 280, 'reloaded selected tag index at 1024px')

  await page.setViewportSize({ width: 1440, height: 900 })
  await expectTagIndexGeometry(page, 1, 280, 'selected tag index at 1440px')

  await page.locator('.tags-clear-selection').click()
  await expect(page).toHaveURL(/\/t(?:\?|$)/)
  await expect(await revealTagButton(page, ordinaryTagLabel)).toBeVisible()
  await expectTagIndexGeometry(page, 3, undefined, 'cleared tag index at 1440px')

  await page.setViewportSize({ width: 390, height: 844 })
  await expectResponsiveLayout(page, 'mobile tag label containment')
})

test('public tag library omits locale filtering when locale namespacing is disabled', async ({ page }) => {
  await openTags(page, '/t', {
    siteLangs: []
  })

  const alpha = await revealTagButton(page, 'Alpha')
  await alpha.click()
  await expect(page.getByRole('link', { name: /guide start/i })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Locale', exact: true })).toHaveCount(0)

  const orderBy = page.getByRole('combobox', { name: 'Order By', exact: true })
  await expect(orderBy).toBeVisible()
  await expect(orderBy).toHaveAccessibleName('Order By')
})

test('public tag index exposes an initial failure retry without a false empty state', async ({ page }) => {
  await openTags(page, '/t', { failTagLoads: 1 })
  const failure = page
    .getByRole('alert')
    .filter({ hasText: /tag|load/i })
    .first()
  await expect(failure).toBeVisible()
  await failure.getByRole('button', { name: /try again|retry/i }).click()
  await expect(await revealTagButton(page, 'Alpha')).toBeVisible()
  await expectResponsiveLayout(page, 'tag index retry')
})

test('public tag bookmarks keep unknown names removable', async ({ page }) => {
  await openTags(page, '/t/archived-name')

  const unknownRemove = page.getByRole('button', { name: /remove.*archived-name/i }).first()
  await expect(unknownRemove).toBeVisible()
  await unknownRemove.click()
  await expect(page).toHaveURL('/t')
  await expect(await revealTagButton(page, 'Alpha')).toBeVisible()
  await expectResponsiveLayout(page, 'removable unknown tag bookmark')
})

test('public tag result failures expose retry instead of a false zero-match state', async ({ page }) => {
  await openTags(page, '/t', { failPageLoads: 1 })
  const alpha = await revealTagButton(page, 'Alpha')
  await alpha.click()
  const failure = page
    .getByRole('alert')
    .filter({ hasText: /result|load|temporary/i })
    .first()
  await expect(failure).toBeVisible()
  await page
    .getByRole('button', { name: /try again|retry/i })
    .last()
    .click()
  await expect(page.getByRole('link', { name: /guide\/start/i })).toBeVisible()
  await expectResponsiveLayout(page, 'tag result retry')
})

test('public tag results keep the latest selection when responses resolve out of order', async ({ page }) => {
  let releaseFirst: (() => void) | undefined
  let firstStarted: (() => void) | undefined
  const firstResponse = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const firstRequest = new Promise<void>(resolve => {
    firstStarted = resolve
  })

  await openTags(page, '/t', {
    pageResponse: async selection => {
      if (selection.length === 1 && selection[0] === 'alpha') {
        firstStarted?.()
        await firstResponse
        return [pageRow({ id: 44, title: 'Stale result', tags: ['alpha'] })]
      }
      if (selection.join(',') === 'alpha,beta') {
        return [pageRow({ id: 55, title: 'Latest result', tags: ['alpha', 'beta'] })]
      }
      return defaultPageResponse(selection)
    }
  })

  const alpha = await revealTagButton(page, 'Alpha')
  await alpha.click()
  await firstRequest
  const beta = await revealTagButton(page, 'Beta')
  await beta.click()
  await expect(page.getByRole('link', { name: /latest result/i })).toBeVisible()

  const staleResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/_api/pages' && url.searchParams.get('tags') === 'alpha' && response.ok()
  })
  releaseFirst?.()
  await staleResponse
  await expect(page.getByRole('link', { name: /stale result/i })).toHaveCount(0)
  await expectResponsiveLayout(page, 'latest tag result response')
})
