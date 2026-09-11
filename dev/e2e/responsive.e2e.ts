import { expect, type Dialog, type Locator, type Page } from '@playwright/test'
import {
  authenticateAsAdmin,
  expectLocatorWithinViewport,
  expectResponsiveLayout,
  openAuthenticatedPage,
  openSearch,
  responsiveTest as test,
  sameOriginHeaders
} from './helpers.ts'
import { installEnabledAgentFixture } from './agent-fixture.ts'
import { decodeWikiPagePayload, type WikiPagePayload } from '../../client/helpers/wiki-navigation.ts'

async function openFixtureAgentFromSearch(page: Page): Promise<Locator> {
  await openAuthenticatedPage(page, '/', '.page-header-section')
  const viewport = page.viewportSize()
  const searchDialog = page.getByRole('dialog', { name: 'Wiki search', exact: true })
  if (viewport && viewport.width >= 960) {
    await page.keyboard.press('ControlOrMeta+K')
    await expect(searchDialog).toBeVisible()
    const entry = searchDialog.getByRole('button', { name: 'Open Wiki Agent', exact: true })
    await expect(entry).toBeVisible()
    await entry.click()
  } else {
    const search = await openSearch(page)
    await expect(search).toBeFocused()
    await expect(searchDialog).toBeVisible()
    const entry = searchDialog.getByRole('button', { name: 'Open Wiki Agent', exact: true })
    await expect(entry).toBeVisible()
    await entry.click()
  }
  const agent = page.getByRole('region', { name: 'Wiki Agent' })
  await expect(agent).toBeVisible()
  return agent
}

const decodeWikiPagePayloadForTest = (encoded: string): WikiPagePayload => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const atob = globalThis.atob
  if (typeof atob !== 'function') throw new Error('Bun atob is unavailable for wiki payload decoding.')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { atob }
  })
  try {
    return decodeWikiPagePayload(encoded)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test.describe('responsive UI quality matrix', () => {
  test.beforeEach(() => {
    test.setTimeout(60_000)
  })

  test('keeps public pages, navigation, and fixed actions usable', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return

    for (const path of ['/en/home', '/en/visual-markdown-browser']) {
      await openAuthenticatedPage(page, path, '.page-header-section')
      await expectResponsiveLayout(page, path)

      const headerPageActions = page
        .locator('.nav-header')
        .getByRole('button', { name: /page actions/i })
        .first()
      if (await headerPageActions.count()) {
        await expectLocatorWithinViewport(headerPageActions, 'Header page actions')
      }

      const shortcutCard = page.locator('.page-shortcuts-card').first()
      const tocCard = page.locator('.page-toc-card').first()
      await expect(shortcutCard).toBeVisible()
      if (await tocCard.count()) {
        await expect(tocCard).toBeVisible()
        const tocToggle = tocCard.locator('.page-toc-toggle')
        if (await tocToggle.isVisible()) {
          const isExpanded = await tocToggle.getAttribute('aria-expanded')
          if (isExpanded !== 'true') {
            await tocToggle.click()
            await expect(tocCard.locator('#page-toc-content')).toBeVisible()
          }
        }
        const headingLinks = tocCard.locator('.page-toc-item')
        for (const headingLink of await headingLinks.all()) {
          await expect(headingLink).toHaveAttribute('href', /^#[^#].*$/)
        }
        const highestAvailableHeadings = tocCard.locator('.page-toc-item-title--depth-0')
        expect(await highestAvailableHeadings.count(), 'Page Contents emphasizes at least one highest-level heading').toBeGreaterThan(0)
        for (const heading of await highestAvailableHeadings.all()) {
          await expect(heading).toHaveCSS('font-weight', '700')
        }
        const depth1Headings = tocCard.locator('.page-toc-item-title--depth-1')
        for (const heading of await depth1Headings.all()) {
          await expect(heading).toHaveCSS('font-weight', '550')
        }

        if (await headingLinks.count()) {
          const firstLink = headingLinks.first()
          const targetHref = await firstLink.getAttribute('href')
          if (targetHref && targetHref.startsWith('#')) {
            const targetId = targetHref.slice(1)
            const targetHeading = page.locator(`id=${targetId}`).first()
            if (await targetHeading.count()) {
              await firstLink.click()
              await expect(targetHeading).toBeVisible()
              const headingBox = await targetHeading.boundingBox()
              expect(headingBox).not.toBeNull()
              if (headingBox) {
                expect(headingBox.y, 'TOC destination heading is visible below fixed chrome').toBeGreaterThanOrEqual(0)
                expect(headingBox.y, 'TOC destination heading is within viewport').toBeLessThan(viewport.height)
              }
            }
          }
        }

        if (viewport.width >= 1280) {
          const hero = page.locator('.page-hero').first()
          const title = page.locator('.page-title').first()
          const rail = page.locator('.page-col-sd:visible').first()
          const [heroBounds, titleBounds, railBounds, shortcutBounds, tocBounds] = await Promise.all([
            hero.boundingBox(),
            title.boundingBox(),
            rail.boundingBox(),
            shortcutCard.boundingBox(),
            tocCard.boundingBox()
          ])
          expect(heroBounds).not.toBeNull()
          expect(titleBounds).not.toBeNull()
          expect(railBounds).not.toBeNull()
          expect(shortcutBounds).not.toBeNull()
          expect(tocBounds).not.toBeNull()
          if (heroBounds && titleBounds && railBounds && shortcutBounds && tocBounds) {
            const titleMidpoint = titleBounds.y + titleBounds.height / 2
            expect(railBounds.y, 'Reader rail begins inside the title hero').toBeGreaterThanOrEqual(heroBounds.y)
            expect(railBounds.y, 'Reader rail begins before the title hero ends').toBeLessThan(heroBounds.y + heroBounds.height)
            expect(Math.abs(railBounds.y - titleMidpoint), 'Reader rail aligns with the title midpoint').toBeLessThanOrEqual(4)
            expect(shortcutBounds.y, 'Reader shortcuts begin at the rail top').toBeGreaterThanOrEqual(railBounds.y - 1)
            expect(tocBounds.y, 'Page Contents follows the reader shortcuts').toBeGreaterThanOrEqual(shortcutBounds.y + shortcutBounds.height)
            expect(tocBounds.height, 'Page Contents retains useful empty geometry').toBeGreaterThanOrEqual(128)

            if (await tocCard.locator('.page-toc-empty').count()) {
              const firstMetadataCard = page.locator('.page-col-sd > :is(.page-tags-card, .page-comments-card, .page-author-card)').first()
              const metadataBounds = await firstMetadataCard.boundingBox()
              expect(metadataBounds).not.toBeNull()
              if (metadataBounds) {
                expect(metadataBounds.y, 'Reader metadata follows the empty Page Contents card').toBeGreaterThanOrEqual(tocBounds.y + tocBounds.height)
                expect(
                  metadataBounds.y - (tocBounds.y + tocBounds.height),
                  'Reader metadata follows the empty Page Contents card without dead space'
                ).toBeLessThanOrEqual(24)
              }
            }
          }

          if (path === '/en/home') {
            const sidebar = page.locator('.page-col-sd').first()
            const lastMetadataCard = page.locator('.page-col-sd > .v-card').last()
            const initialPageScroll = await page.evaluate(() => window.scrollY)
            await sidebar.evaluate(element => {
              element.scrollTop = element.scrollHeight
            })
            const [sidebarBounds, lastMetadataBounds, pageScrollAfterSidebar] = await Promise.all([
              sidebar.boundingBox(),
              lastMetadataCard.boundingBox(),
              page.evaluate(() => window.scrollY)
            ])
            expect(sidebarBounds).not.toBeNull()
            expect(lastMetadataBounds).not.toBeNull()
            expect(pageScrollAfterSidebar, 'Metadata scrolling does not move the Markdown page').toBe(initialPageScroll)
            if (sidebarBounds && lastMetadataBounds) {
              expect(sidebarBounds.y + sidebarBounds.height, 'Metadata scrollbar remains inside the viewport').toBeLessThanOrEqual(viewport.height)
              expect(lastMetadataBounds.y + lastMetadataBounds.height, 'The final metadata card is reachable inside its own scroller').toBeLessThanOrEqual(
                sidebarBounds.y + sidebarBounds.height + 1
              )
            }
            await sidebar.evaluate(element => {
              element.scrollTop = 0
            })
          }
        }
      }

      const shortcutButtons = page.locator('.page-shortcuts-card .v-btn')
      for (const shortcutButton of await shortcutButtons.all()) {
        const bounds = await shortcutButton.boundingBox()
        expect(bounds).not.toBeNull()
        if (bounds) {
          expect(bounds.width, 'Reader shortcut target remains compact and usable').toBeGreaterThanOrEqual(38)
          expect(bounds.width, 'Reader shortcut target remains compact and usable').toBeLessThanOrEqual(44)
          expect(bounds.height, 'Reader shortcut target remains compact and usable').toBeGreaterThanOrEqual(38)
          expect(bounds.height, 'Reader shortcut target remains compact and usable').toBeLessThanOrEqual(44)
        }
      }

      if (path === '/en/visual-markdown-browser' && viewport.width < 1280) {
        const article = page.locator('.page-col-content:not(.is-page-header) > .contents').first()
        const sidebar = page.locator('.page-col-sd').first()
        await expect(article).toBeVisible()
        await expect(sidebar).toBeVisible()
        await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible()

        const articleBounds = await article.boundingBox()
        const sidebarBounds = await sidebar.boundingBox()
        expect(articleBounds).not.toBeNull()
        expect(sidebarBounds).not.toBeNull()
        if (articleBounds && sidebarBounds) {
          expect(articleBounds.y, 'Article content must precede the reader sidebar').toBeLessThan(sidebarBounds.y)
        }
      }
    }

    const drawer = page.locator('.v-navigation-drawer').first()
    if (viewport.width < 1280) {
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
      await expectLocatorWithinViewport(drawer, 'Open page navigation')
      await expectResponsiveLayout(page, 'Open page navigation')

      await drawer.getByRole('button', { name: 'Home', exact: true }).click()
      await expect(page).toHaveURL('/')
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)

      await page.getByRole('button', { name: 'Open navigation' }).click()
      await drawer.getByRole('button', { name: 'Browse', exact: true }).click()
      const browseDestination = drawer.locator('a[href="/en/visual-markdown-browser"]').first()
      await expect(browseDestination).toBeVisible()
      await browseDestination.click()
      await expect(page).toHaveURL('/en/visual-markdown-browser')
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
    } else {
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
      await drawer.getByRole('button', { name: 'Home', exact: true }).click()
      await expect(page).toHaveURL('/')
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
      await drawer.getByRole('button', { name: 'Browse', exact: true }).click()
      const browseDestination = drawer.locator('a[href="/en/visual-markdown-browser"]').first()
      await expect(browseDestination).toBeVisible()
      await browseDestination.click()
      await expect(page).toHaveURL('/en/visual-markdown-browser')
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
    }

    const pageEditFab = page.locator('.page-edit-fab')
    if (await pageEditFab.count()) {
      await expectLocatorWithinViewport(pageEditFab, 'Page actions')
    }
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const returnToTop = page.getByRole('button', { name: /return to top/i })
    await expectLocatorWithinViewport(returnToTop, 'Return to top action')
    const returnToTopBounds = await returnToTop.boundingBox()
    expect(returnToTopBounds).not.toBeNull()
    if (returnToTopBounds) {
      expect(returnToTopBounds.x, 'Return to top stays on the right').toBeGreaterThan(viewport.width / 2)
      expect(viewport.width - returnToTopBounds.x - returnToTopBounds.width, 'Return to top keeps a safe right inset').toBeGreaterThanOrEqual(0)
      expect(viewport.width - returnToTopBounds.x - returnToTopBounds.width, 'Return to top keeps a safe right inset').toBeLessThanOrEqual(32)

      if (await pageEditFab.count()) {
        await pageEditFab.click()
        await expect(pageEditFab).toHaveAttribute('aria-expanded', 'true')
        const editPageAction =
          viewport.width < 840 ? page.getByText('Edit Page', { exact: true }).last() : page.getByRole('button', { name: 'Edit Page', exact: true })
        await expect(editPageAction).toBeVisible()
      }
      const neighboringFixedActions = page.locator('.page-nav-toggle:visible, .page-edit-fab:visible, .v-speed-dial__content .v-btn:visible')
      for (const neighboringAction of await neighboringFixedActions.all()) {
        const neighboringBounds = await neighboringAction.boundingBox()
        expect(neighboringBounds).not.toBeNull()
        if (neighboringBounds) {
          const controlsOverlap = !(
            returnToTopBounds.x + returnToTopBounds.width <= neighboringBounds.x ||
            neighboringBounds.x + neighboringBounds.width <= returnToTopBounds.x ||
            returnToTopBounds.y + returnToTopBounds.height <= neighboringBounds.y ||
            neighboringBounds.y + neighboringBounds.height <= returnToTopBounds.y
          )
          expect(controlsOverlap, 'Return to top must not overlap navigation or page actions').toBe(false)
        }
      }
    }
    await returnToTop.click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(2)
  })
  test('keeps the reader Edit hit area interactive from top through bottom', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 600) return

    await authenticateAsAdmin(page)
    const readerUrl = new URL('/en/visual-markdown-browser', sameOriginHeaders().Origin)
    await page.route(`${readerUrl.origin}${readerUrl.pathname}**`, async route => {
      const request = route.request()
      const requestUrl = new URL(request.url())
      const isDocumentNavigation = request.resourceType() === 'document' && request.isNavigationRequest()
      const isSpaNavigation = request.headers()['x-wiki-navigation'] === '1'
      const isExpectedReaderRequest =
        request.method() === 'GET' &&
        requestUrl.origin === readerUrl.origin &&
        requestUrl.pathname === readerUrl.pathname &&
        (isDocumentNavigation || isSpaNavigation)
      if (!isExpectedReaderRequest) {
        await route.continue()
        return
      }

      const response = await route.fetch()
      const contentType = response.headers()['content-type'] ?? ''
      const document = await response.text()
      if (!response.ok() || !/^text\/html(?:;|$)/iu.test(contentType)) {
        throw new Error(`Reader fixture returned ${response.status()} ${contentType || 'without a content type'}.`)
      }

      const payloadAttribute = /(<wiki-page\b[^>]*\bpayload=)(["'])([^"']+)\2/gu
      const payloadMatches = Array.from(document.matchAll(payloadAttribute))
      if (payloadMatches.length !== 1) throw new Error(`Reader fixture returned ${payloadMatches.length} wiki payloads instead of exactly one.`)
      const match = payloadMatches[0]
      if (!match || match.index === undefined) throw new Error('Reader fixture payload did not expose a replacement offset.')

      let decodedPayload: WikiPagePayload
      try {
        decodedPayload = decodeWikiPagePayloadForTest(match[3]!)
      } catch (error) {
        throw new Error(`Reader fixture wiki payload failed validation: ${error instanceof Error ? error.message : String(error)}`)
      }

      let rawPayload: unknown
      try {
        rawPayload = JSON.parse(Buffer.from(match[3]!, 'base64').toString('utf8'))
      } catch (error) {
        throw new Error(`Reader fixture wiki payload failed raw decoding: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) throw new Error('Reader fixture wiki payload was not an object.')
      const rawPayloadRecord = rawPayload as Record<string, unknown>
      const rawProps = rawPayloadRecord.props
      if (
        typeof rawProps !== 'object' ||
        rawProps === null ||
        Array.isArray(rawProps) ||
        typeof (rawProps as Record<string, unknown>).editShortcuts !== 'string'
      ) {
        throw new Error('Reader fixture wiki payload did not contain encoded edit shortcuts.')
      }
      const rawPropsRecord = rawProps as Record<string, unknown>
      if (rawPropsRecord.editShortcuts !== decodedPayload.props.editShortcuts) {
        throw new Error('Reader fixture wiki payload decoding changed the edit shortcuts encoding.')
      }

      let editShortcuts: unknown
      try {
        editShortcuts = JSON.parse(Buffer.from(decodedPayload.props.editShortcuts, 'base64').toString('utf8'))
      } catch (error) {
        throw new Error(`Reader fixture edit shortcuts failed decoding: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (typeof editShortcuts !== 'object' || editShortcuts === null || Array.isArray(editShortcuts))
        throw new Error('Reader fixture edit shortcuts were not an object.')

      const patchedEditShortcuts = {
        ...(editShortcuts as Record<string, unknown>),
        editMenuBar: true,
        editMenuBtn: true,
        editMenuExternalBtn: false
      }
      const encodedEditShortcuts = Buffer.from(JSON.stringify(patchedEditShortcuts), 'utf8').toString('base64')
      const patchedRawPayload = {
        ...rawPayloadRecord,
        props: {
          ...rawPropsRecord,
          editShortcuts: encodedEditShortcuts
        }
      }
      const encodedPatchedPayload = Buffer.from(JSON.stringify(patchedRawPayload), 'utf8').toString('base64')
      let reExtractedRawPayload: unknown
      try {
        reExtractedRawPayload = JSON.parse(Buffer.from(encodedPatchedPayload, 'base64').toString('utf8'))
      } catch (error) {
        throw new Error(`Patched reader fixture wiki payload failed round-trip decoding: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (JSON.stringify(reExtractedRawPayload) !== JSON.stringify(patchedRawPayload)) {
        throw new Error('Patched reader fixture wiki payload did not preserve its exact JSON round trip.')
      }

      let roundTripPayload: WikiPagePayload
      try {
        roundTripPayload = decodeWikiPagePayloadForTest(encodedPatchedPayload)
      } catch (error) {
        throw new Error(`Patched reader fixture wiki payload failed schema validation: ${error instanceof Error ? error.message : String(error)}`)
      }
      const expectedPayload = {
        ...decodedPayload,
        props: {
          ...decodedPayload.props,
          editShortcuts: encodedEditShortcuts
        }
      }
      if (JSON.stringify(roundTripPayload) !== JSON.stringify(expectedPayload)) {
        throw new Error('Patched reader fixture wiki payload changed fields outside edit shortcuts.')
      }
      let roundTripEditShortcuts: unknown
      try {
        roundTripEditShortcuts = JSON.parse(Buffer.from(roundTripPayload.props.editShortcuts, 'base64').toString('utf8'))
      } catch (error) {
        throw new Error(`Patched reader fixture edit shortcuts failed round-trip decoding: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (JSON.stringify(roundTripEditShortcuts) !== JSON.stringify(patchedEditShortcuts)) {
        throw new Error('Patched reader fixture edit shortcuts did not survive their exact round trip.')
      }

      const patchedDocument =
        document.slice(0, match.index) + `${match[1]}${match[2]}${encodedPatchedPayload}${match[2]}` + document.slice(match.index + match[0].length)
      await route.fulfill({ response, body: patchedDocument })
    })

    for (const position of ['top', 'center', 'bottom'] as const) {
      await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')
      const edit = page.locator('.page-edit-shortcuts .v-btn').first()
      await expect(edit, 'Reader Edit action is present').toBeVisible()
      const bounds = await edit.boundingBox()
      expect(bounds).not.toBeNull()
      if (!bounds) continue
      const edgeInset = Math.min(8, Math.max(2, bounds.height / 4))
      const x = bounds.x + bounds.width / 2
      const y = bounds.y + (position === 'top' ? edgeInset : position === 'center' ? bounds.height / 2 : bounds.height - edgeInset)
      const hit = await page.evaluate(
        ({ x, y }) => {
          const target = document.elementFromPoint(x, y)
          return target instanceof HTMLElement && Boolean(target.closest('.page-edit-shortcuts .v-btn'))
        },
        { x, y }
      )
      expect(hit, `Reader Edit ${position} pointer target remains interactive`).toBe(true)
      await page.mouse.click(x, y)
      await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    }
  })

  test('uses expanded and aligned desktop reader geometry', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 1280) return

    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const headerShell = page.locator('.page-header-section').first()
    const bodyShell = page.locator('.page-body').first()
    const title = page.locator('.page-header--toc-left .page-title').first()
    const description = page.locator('.page-header--toc-left .page-description').first()
    const metadataRail = page.locator('.page-col-sd.page-col-sd--toc-left').first()
    const article = page.locator('.page-col-content.page-col-content--toc-left:not(.is-page-header) > .contents').first()
    const markdownCopy = article.locator('> div').first()

    await expect(headerShell).toBeVisible()
    await expect(bodyShell).toBeVisible()
    await expect(title).toBeVisible()
    await expect(metadataRail).toBeVisible()
    await expect(article).toBeVisible()
    await expect(markdownCopy).toBeVisible()

    const shellSizing = await page.evaluate(() => {
      const containingBlockWidth = (selector: string): number => {
        const element = document.querySelector<HTMLElement>(selector)
        const parent = element?.parentElement
        if (!parent) return 0
        const styles = getComputedStyle(parent)
        return parent.clientWidth - (Number.parseFloat(styles.paddingLeft) || 0) - (Number.parseFloat(styles.paddingRight) || 0)
      }
      const bodyRow = document.querySelector<HTMLElement>('.page-body > .v-row')
      if (!bodyRow) throw new Error('Reader body row is missing')

      return {
        rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        headerAvailableWidth: containingBlockWidth('.page-header-section'),
        bodyAvailableWidth: containingBlockWidth('.page-body'),
        columnGap: Number.parseFloat(getComputedStyle(bodyRow).getPropertyValue('--v-col-gap-x'))
      }
    })

    const [headerShellBounds, bodyShellBounds, titleBounds, metadataBounds, articleBounds, markdownCopyBounds] = await Promise.all([
      headerShell.boundingBox(),
      bodyShell.boundingBox(),
      title.boundingBox(),
      metadataRail.boundingBox(),
      article.boundingBox(),
      markdownCopy.boundingBox()
    ])
    expect(headerShellBounds).not.toBeNull()
    expect(bodyShellBounds).not.toBeNull()
    expect(titleBounds).not.toBeNull()
    expect(metadataBounds).not.toBeNull()
    expect(articleBounds).not.toBeNull()
    expect(markdownCopyBounds).not.toBeNull()
    if (!headerShellBounds || !bodyShellBounds || !titleBounds || !metadataBounds || !articleBounds || !markdownCopyBounds) return

    for (const [name, bounds] of [
      ['Page header shell', headerShellBounds],
      ['Page body shell', bodyShellBounds]
    ] as const) {
      expect(bounds.x, `${name} stays inside the viewport`).toBeGreaterThanOrEqual(-1)
      expect(bounds.x + bounds.width, `${name} stays inside the viewport`).toBeLessThanOrEqual(viewport.width + 1)
    }
    expect(Math.abs(headerShellBounds.x - bodyShellBounds.x), 'Reader header and body shells share a left edge').toBeLessThanOrEqual(2)
    expect(Math.abs(headerShellBounds.width - bodyShellBounds.width), 'Reader header and body shells share a width').toBeLessThanOrEqual(2)

    const legacyShellMax = 110 * shellSizing.rootFontSize
    const readerShellMax = 132 * shellSizing.rootFontSize
    for (const [name, bounds, availableWidth] of [
      ['Page header shell', headerShellBounds, shellSizing.headerAvailableWidth],
      ['Page body shell', bodyShellBounds, shellSizing.bodyAvailableWidth]
    ] as const) {
      expect(bounds.width, `${name} does not exceed the reader maximum`).toBeLessThanOrEqual(readerShellMax + 1)
      if (availableWidth > legacyShellMax + 2) {
        expect(bounds.width, `${name} uses the wider reader allowance`).toBeGreaterThan(legacyShellMax)
        expect(
          Math.abs(bounds.width - Math.min(availableWidth, readerShellMax)),
          `${name} fills the available reader width up to its maximum`
        ).toBeLessThanOrEqual(2)
      }
      if (viewport.width >= 2560) {
        expect(Math.abs(bounds.width - readerShellMax), `${name} remains exactly 132rem on the wide project`).toBeLessThanOrEqual(2)
      }
    }

    expect(Math.abs(titleBounds.x - articleBounds.x), 'Page title aligns with the article card outer edge').toBeLessThanOrEqual(2)
    if (await description.isVisible()) {
      const descriptionBounds = await description.boundingBox()
      expect(descriptionBounds).not.toBeNull()
      if (descriptionBounds) {
        expect(Math.abs(descriptionBounds.x - articleBounds.x), 'Page description aligns with the article card outer edge').toBeLessThanOrEqual(2)
      }
    }
    expect(Math.abs(metadataBounds.y - (titleBounds.y + titleBounds.height / 2)), 'Left metadata rail aligns with the title midpoint').toBeLessThanOrEqual(4)
    expect(metadataBounds.x, 'Reader metadata rail remains before the primary article').toBeLessThan(articleBounds.x)
    expect(metadataBounds.x + metadataBounds.width, 'Reader metadata rail must not overlap the primary article').toBeLessThanOrEqual(articleBounds.x + 1)

    if (viewport.width >= 2560) {
      expect(shellSizing.columnGap, 'Reader row exposes the rendered column gap').toBeGreaterThan(0)
      const legacyRowWidth = 106 * shellSizing.rootFontSize
      const legacyRailWidth = (2.2 * (legacyRowWidth + shellSizing.columnGap)) / 12 - shellSizing.columnGap
      const legacyArticleWidth = (9.8 * (legacyRowWidth + shellSizing.columnGap)) / 12 - shellSizing.columnGap
      const railGrowth = metadataBounds.width / legacyRailWidth
      expect(railGrowth, 'Wide metadata rail is approximately 15% wider than the legacy capped rail').toBeGreaterThanOrEqual(1.14)
      expect(railGrowth, 'Wide metadata rail is approximately 15% wider than the legacy capped rail').toBeLessThanOrEqual(1.16)
      expect(articleBounds.width, 'Wide article is observably wider than its legacy article width').toBeGreaterThan(
        legacyArticleWidth + shellSizing.rootFontSize
      )
      const legacyCopyWidth = await markdownCopy.evaluate(element => {
        const probe = document.createElement('span')
        probe.style.position = 'absolute'
        probe.style.display = 'block'
        probe.style.visibility = 'hidden'
        probe.style.width = '76ch'
        probe.style.padding = '0'
        probe.style.border = '0'
        element.append(probe)
        const width = probe.getBoundingClientRect().width
        probe.remove()
        return width
      })
      const copyGrowth = markdownCopyBounds.width / legacyCopyWidth
      expect(copyGrowth, 'Wide Markdown copy is approximately 33% wider than the legacy 76ch measure').toBeGreaterThanOrEqual(1.32)
      expect(copyGrowth, 'Wide Markdown copy is approximately 33% wider than the legacy 76ch measure').toBeLessThanOrEqual(1.34)
    }
  })

  test('keeps right-side TOC geometry ordered and aligned', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 1280) return
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const originalClasses = await page.evaluate(() => {
      const get = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) throw new Error(`Missing reader element: ${selector}`)
        return element
      }
      return {
        header: get('.page-header-section > .is-page-header').className,
        rail: get('.page-col-sd').className,
        article: get('.page-col-content:not(.is-page-header)').className
      }
    })
    try {
      await page.evaluate(() => {
        document.querySelector('.page-header--toc-left')?.classList.replace('page-header--toc-left', 'page-header--toc-right')
        document.querySelector('.page-col-sd--toc-left')?.classList.replace('page-col-sd--toc-left', 'page-col-sd--toc-right')
        document
          .querySelector('.page-col-content--toc-left:not(.is-page-header)')
          ?.classList.replace('page-col-content--toc-left', 'page-col-content--toc-right')
      })
      const headerShell = page.locator('.page-header-section').first()
      const bodyShell = page.locator('.page-body').first()
      const title = page.locator('.page-header--toc-right .page-title').first()
      const rail = page.locator('.page-col-sd--toc-right').first()
      const article = page.locator('.page-col-content--toc-right:not(.is-page-header) > .contents').first()
      const [headerBounds, bodyBounds, titleBounds, railBounds, articleBounds] = await Promise.all([
        headerShell.boundingBox(),
        bodyShell.boundingBox(),
        title.boundingBox(),
        rail.boundingBox(),
        article.boundingBox()
      ])
      expect(headerBounds).not.toBeNull()
      expect(bodyBounds).not.toBeNull()
      expect(titleBounds).not.toBeNull()
      expect(railBounds).not.toBeNull()
      expect(articleBounds).not.toBeNull()
      if (!headerBounds || !bodyBounds || !titleBounds || !railBounds || !articleBounds) return
      expect(Math.abs(headerBounds.x - bodyBounds.x)).toBeLessThanOrEqual(2)
      expect(Math.abs(railBounds.y - (titleBounds.y + titleBounds.height / 2)), 'Right metadata rail aligns with the title midpoint').toBeLessThanOrEqual(4)
      expect(Math.abs(headerBounds.width - bodyBounds.width)).toBeLessThanOrEqual(2)
      expect(articleBounds.x + articleBounds.width, 'Article remains before and clear of the right rail').toBeLessThan(railBounds.x)
      expect(Math.abs(titleBounds.x - articleBounds.x), 'Right-mode title aligns with the article').toBeLessThanOrEqual(2)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'Right TOC has no horizontal overflow'
      ).toBeLessThanOrEqual(1)
    } finally {
      await page.evaluate(classes => {
        const header = document.querySelector<HTMLElement>('.page-header-section > .is-page-header')
        const rail = document.querySelector<HTMLElement>('.page-col-sd')
        const article = document.querySelector<HTMLElement>('.page-col-content:not(.is-page-header)')
        if (header) header.className = classes.header
        if (rail) rail.className = classes.rail
        if (article) article.className = classes.article
      }, originalClasses)
    }
  })
  test('tracks the title midpoint for long, sparse, and branded reader headers', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 1280) return
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const assertAligned = async (label: string): Promise<void> => {
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const title = document.querySelector<HTMLElement>('.page-title')
              const rail = document.querySelector<HTMLElement>('.page-col-sd')
              if (!title || !rail) return Number.POSITIVE_INFINITY
              const titleBounds = title.getBoundingClientRect()
              const railBounds = rail.getBoundingClientRect()
              return Math.abs(railBounds.top - (titleBounds.top + titleBounds.height / 2))
            }),
          label
        )
        .toBeLessThanOrEqual(4)
    }

    await assertAligned('Default reader rail aligns with the title midpoint')
    await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>('.page-title')
      if (!title) throw new Error('Reader title is missing')
      title.textContent = 'A deliberately long reader title that wraps across multiple lines to exercise midpoint alignment'
    })
    await assertAligned('Long reader title keeps the rail aligned with its midpoint')

    await page.evaluate(() => document.querySelector('.page-description')?.remove())
    await assertAligned('Reader rail stays aligned when the description is absent')

    await page.evaluate(() => {
      const headings = document.querySelector<HTMLElement>('.page-header-headings')
      if (!headings) throw new Error('Reader heading group is missing')
      headings.classList.add('page-header-headings--branded')
      const mark = document.createElement('div')
      mark.className = 'page-branding-mark'
      mark.setAttribute('aria-hidden', 'true')
      mark.style.width = '128px'
      mark.style.height = '128px'
      headings.append(mark)
    })
    await assertAligned('Branded reader rail stays aligned with the title midpoint')
  })
  test('realigns a dirty rail after a scrolled title resize and eligibility transitions', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 1280) return

    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const title = page.locator('.page-title').first()
    const rail = page.locator('.page-col-sd').first()
    const alignment = async (): Promise<number> =>
      page.evaluate(() => {
        const title = document.querySelector<HTMLElement>('.page-title')
        const rail = document.querySelector<HTMLElement>('.page-col-sd')
        if (!title || !rail) return Number.POSITIVE_INFINITY
        const titleBounds = title.getBoundingClientRect()
        const railBounds = rail.getBoundingClientRect()
        return Math.abs(railBounds.top - (titleBounds.top + titleBounds.height / 2))
      })
    const railState = async (): Promise<{ alignmentOffset: string; maxHeight: string; tocPosition: string }> =>
      page.evaluate(() => {
        const rail = document.querySelector<HTMLElement>('.page-col-sd')
        const app = (
          window as typeof window & {
            WIKI?: {
              config?: {
                globalProperties?: {
                  $pinia?: {
                    _s?: Map<string, { site: { tocPosition: string } }>
                  }
                }
              }
            }
          }
        ).WIKI
        const store = app?.config?.globalProperties?.$pinia?._s?.get('wiki')
        return {
          alignmentOffset: rail?.style.getPropertyValue('--page-desktop-rail-align-offset') ?? '',
          maxHeight: rail?.style.getPropertyValue('--page-desktop-rail-max-height') ?? '',
          tocPosition: store?.site.tocPosition ?? ''
        }
      })
    const setTocPosition = async (tocPosition: 'left' | 'right' | 'off'): Promise<void> => {
      await page.evaluate(value => {
        const app = (
          window as typeof window & {
            WIKI?: {
              config?: {
                globalProperties?: {
                  $pinia?: {
                    _s?: Map<string, { site: { tocPosition: string } }>
                  }
                }
              }
            }
          }
        ).WIKI
        const store = app?.config?.globalProperties?.$pinia?._s?.get('wiki')
        if (!store) throw new Error('Wiki store is unavailable for responsive TOC transition.')
        store.site.tocPosition = value
      }, tocPosition)
    }

    const initialTitle = await title.textContent()
    const initialWidth = viewport.width
    const resizedDesktopWidth = initialWidth === 1280 ? 1360 : Math.max(1280, initialWidth - 80)
    const longTitle = 'A deliberately long reader title that wraps after a scrolled resize and remains aligned when the reader returns to the top'
    const originalTocPosition = (await railState()).tocPosition as 'left' | 'right' | 'off'
    if (originalTocPosition === 'off') {
      await setTocPosition('left')
      await expect(page.locator('.page-header--toc-left')).toBeVisible()
    }

    try {
      await expect.poll(alignment, 'Initial desktop rail alignment').toBeLessThanOrEqual(4)
      const initialRailState = await railState()
      expect(initialRailState.maxHeight, 'Desktop rail keeps its footer-bounded max-height').not.toBe('')

      await page.evaluate(() => window.scrollTo(0, Math.max(1, Math.floor(document.documentElement.scrollHeight / 2))))
      await expect.poll(() => page.evaluate(() => window.scrollY), 'Reader scrolls away from the title').toBeGreaterThan(1)

      await page.evaluate(text => {
        const title = document.querySelector<HTMLElement>('.page-title')
        if (!title) throw new Error('Reader title is missing')
        title.textContent = text
        title.style.maxWidth = '18rem'
        window.dispatchEvent(new Event('resize'))
      }, longTitle)
      await expect.poll(() => title.evaluate(element => element.getBoundingClientRect().height), 'Reader title wraps while scrolled').toBeGreaterThan(40)

      await page.setViewportSize({ width: resizedDesktopWidth, height: viewport.height })
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect.poll(() => page.evaluate(() => window.scrollY), 'Reader returns to the top').toBeLessThan(2)
      await expect.poll(alignment, 'Dirty reader rail realigns after returning to the top').toBeLessThanOrEqual(4)

      await page.setViewportSize({ width: 1279, height: viewport.height })
      await expect
        .poll(async () => {
          const state = await railState()
          return `${state.alignmentOffset}|${state.maxHeight}`
        }, 'Ineligible breakpoint clears desktop rail measurements')
        .toBe('|')

      await page.setViewportSize({ width: resizedDesktopWidth, height: viewport.height })
      await expect.poll(alignment, 'Desktop rail realigns after crossing the breakpoint').toBeLessThanOrEqual(4)
      await expect.poll(async () => (await railState()).maxHeight, 'Desktop rail restores its footer-bounded max-height after the breakpoint').not.toBe('')

      await setTocPosition('off')
      await expect(page.locator('.page-header--toc-off')).toBeVisible()
      await expect
        .poll(async () => {
          const state = await railState()
          return `${state.alignmentOffset}|${state.maxHeight}`
        }, 'TOC-off clears desktop rail measurements')
        .toBe('|')

      await setTocPosition('right')
      await expect(page.locator('.page-header--toc-right')).toBeVisible()
      await expect.poll(alignment, 'Right TOC rail realigns after eligibility returns').toBeLessThanOrEqual(4)
      await expect.poll(async () => (await railState()).maxHeight, 'Right TOC rail keeps its footer-bounded max-height').not.toBe('')
    } finally {
      await setTocPosition(originalTocPosition)
      await page.evaluate(text => {
        const title = document.querySelector<HTMLElement>('.page-title')
        if (!title) return
        title.textContent = text ?? ''
        title.style.removeProperty('max-width')
      }, initialTitle)
    }
  })

  test('keeps TOC-off columns full width and in reading order', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 1280) return
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const originalClasses = await page.evaluate(() => {
      const get = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) throw new Error(`Missing reader element: ${selector}`)
        return element
      }
      return {
        header: get('.page-header-section > .is-page-header').className,
        rail: get('.page-col-sd').className,
        article: get('.page-col-content:not(.is-page-header)').className
      }
    })
    try {
      await page.evaluate(() => {
        document.querySelector('.page-header--toc-left')?.classList.replace('page-header--toc-left', 'page-header--toc-off')
        const rail = document.querySelector('.page-col-sd')
        rail?.classList.remove('page-col-sd--with-toc')
        rail?.classList.add('page-col-sd--toc-off')
        const article = document.querySelector('.page-col-content:not(.is-page-header)')
        article?.classList.remove('page-col-content--with-toc')
        article?.classList.add('page-col-content--toc-off')
        const toc = document.querySelector<HTMLElement>('.page-toc-card')
        if (toc) toc.hidden = true
      })
      const headerShell = page.locator('.page-header-section').first()
      const header = page.locator('.page-header--toc-off').first()
      const row = page.locator('.page-body > .v-row').first()
      const rail = page.locator('.page-col-sd--toc-off').first()
      const articleColumn = page.locator('.page-col-content--toc-off:not(.is-page-header)').first()
      const article = articleColumn.locator('> .contents')
      const [headerShellBounds, headerBounds, rowBounds, railBounds, articleColumnBounds, articleBounds] = await Promise.all([
        headerShell.boundingBox(),
        header.boundingBox(),
        row.boundingBox(),
        rail.boundingBox(),
        articleColumn.boundingBox(),
        article.boundingBox()
      ])
      expect(headerShellBounds).not.toBeNull()
      expect(headerBounds).not.toBeNull()
      expect(rowBounds).not.toBeNull()
      expect(railBounds).not.toBeNull()
      expect(articleColumnBounds).not.toBeNull()
      expect(articleBounds).not.toBeNull()
      if (!headerShellBounds || !headerBounds || !rowBounds || !railBounds || !articleColumnBounds || !articleBounds) return
      expect(Math.abs(headerBounds.width - headerShellBounds.width), 'TOC-off header uses its full shell').toBeLessThanOrEqual(2)
      expect(Math.abs(articleColumnBounds.width - rowBounds.width), 'TOC-off article uses the full row').toBeLessThanOrEqual(2)
      expect(Math.abs(railBounds.width - rowBounds.width), 'TOC-off metadata uses the full row').toBeLessThanOrEqual(2)
      expect(articleBounds.width, 'TOC-off article does not retain a collapsed rail').toBeGreaterThan(rowBounds.width * 0.9)
      expect(Math.abs(articleColumnBounds.x - railBounds.x), 'TOC-off columns share a row edge').toBeLessThanOrEqual(2)
      expect(articleColumnBounds.y + articleColumnBounds.height, 'TOC-off article precedes metadata').toBeLessThanOrEqual(railBounds.y + 1)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'TOC-off has no horizontal overflow'
      ).toBeLessThanOrEqual(1)
    } finally {
      await page.evaluate(classes => {
        const header = document.querySelector<HTMLElement>('.page-header-section > .is-page-header')
        const rail = document.querySelector<HTMLElement>('.page-col-sd')
        const article = document.querySelector<HTMLElement>('.page-col-content:not(.is-page-header)')
        if (header) header.className = classes.header
        if (rail) rail.className = classes.rail
        if (article) article.className = classes.article
        const toc = document.querySelector<HTMLElement>('.page-toc-card')
        if (toc) toc.hidden = false
      }, originalClasses)
    }
  })

  test('mirrors RTL reader geometry without overlap', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 1280) return
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const originalState = await page.evaluate(() => {
      const get = (selector: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) throw new Error(`Missing reader element: ${selector}`)
        return element
      }
      const reader = get('.wiki-page')
      return {
        documentDirection: document.documentElement.getAttribute('dir'),
        readerDirection: reader.getAttribute('dir'),
        readerClass: reader.className,
        headerClass: get('.page-header-section > .is-page-header').className,
        railClass: get('.page-col-sd').className,
        articleClass: get('.page-col-content:not(.is-page-header)').className
      }
    })
    try {
      await page.evaluate(() => {
        const reader = document.querySelector<HTMLElement>('.wiki-page')
        const header = document.querySelector<HTMLElement>('.page-header-section > .is-page-header')
        const rail = document.querySelector<HTMLElement>('.page-col-sd')
        const article = document.querySelector<HTMLElement>('.page-col-content:not(.is-page-header)')
        if (!reader || !header || !rail || !article) throw new Error('Reader geometry is incomplete')

        document.documentElement.setAttribute('dir', 'rtl')
        reader.setAttribute('dir', 'rtl')
        reader.classList.remove('is-ltr', 'v-locale--is-ltr')
        reader.classList.add('is-rtl', 'v-locale--is-rtl')
        header.classList.remove('page-header--toc-left', 'page-header--toc-off', 'pl-4')
        header.classList.add('page-header--toc-right', 'pr-4')
        rail.classList.remove('page-col-sd--toc-left', 'page-col-sd--toc-off')
        rail.classList.add('page-col-sd--toc-right', 'page-col-sd--with-toc')
        article.classList.remove('page-col-content--toc-left', 'page-col-content--toc-off')
        article.classList.add('page-col-content--toc-right', 'page-col-content--with-toc')
      })

      const title = page.locator('.page-header--toc-right .page-title').first()
      const rail = page.locator('.page-col-sd--toc-right').first()
      const article = page.locator('.page-col-content--toc-right:not(.is-page-header) > .contents').first()
      await expect(title).toBeVisible()
      await expect(rail).toBeVisible()
      await expect(article).toBeVisible()

      const [titleBounds, railBounds, articleBounds] = await Promise.all([title.boundingBox(), rail.boundingBox(), article.boundingBox()])
      expect(titleBounds).not.toBeNull()
      expect(railBounds).not.toBeNull()
      expect(articleBounds).not.toBeNull()
      if (!titleBounds || !railBounds || !articleBounds) return

      expect(Math.abs(titleBounds.x - articleBounds.x), 'RTL title and article share their mirrored outer edge').toBeLessThanOrEqual(2)
      expect(articleBounds.x + articleBounds.width, 'RTL rail is placed after the article').toBeLessThan(railBounds.x)
      expect(articleBounds.x + articleBounds.width, 'RTL metadata rail remains clear of the article').toBeLessThanOrEqual(railBounds.x + 1)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'RTL reader has no horizontal overflow'
      ).toBeLessThanOrEqual(1)
      const rtlH1Info = await page.evaluate(() => {
        const h1 = document.querySelector('article.contents h1')
        if (!h1) return null
        const h1Style = window.getComputedStyle(h1)
        const after = window.getComputedStyle(h1, '::after')
        const height = parseFloat(after.height) || parseFloat(after.getPropertyValue('block-size')) || 0
        const width = parseFloat(after.width) || parseFloat(after.getPropertyValue('inline-size')) || 0
        const insetInlineStart = after.getPropertyValue('inset-inline-start')
        const bg = after.backgroundImage || after.background
        const mask = after.maskImage || after.webkitMaskImage || ''
        return {
          direction: h1Style.direction,
          afterContent: after.content,
          afterHeight: height,
          afterWidth: width,
          insetInlineStart,
          afterRight: after.right,
          background: bg,
          maskImage: mask
        }
      })
      expect(rtlH1Info, 'Authored H1 must exist in RTL reader').not.toBeNull()
      if (rtlH1Info) {
        expect(rtlH1Info.direction, 'RTL authored H1 inherits RTL direction').toBe('rtl')
        expect(rtlH1Info.afterContent, 'RTL authored H1 swoosh has content').not.toMatch(/^(?:none|""|normal)$/)
        expect(rtlH1Info.afterHeight, 'RTL authored H1 swoosh retains 3.5px height').toBeGreaterThanOrEqual(3)
        expect(rtlH1Info.afterHeight, 'RTL authored H1 swoosh retains 3.5px height').toBeLessThanOrEqual(4)
        expect(rtlH1Info.afterWidth, 'RTL authored H1 swoosh width is positive').toBeGreaterThan(0)
        expect(rtlH1Info.afterWidth, 'RTL authored H1 swoosh width is bounded to 10rem').toBeLessThanOrEqual(165)

        const isAnchoredAtInlineStart = rtlH1Info.insetInlineStart === '0px' || rtlH1Info.afterRight === '0px'
        expect(isAnchoredAtInlineStart, 'RTL authored H1 swoosh is anchored at inline start (right: 0)').toBe(true)

        const isGradientReversed = /to left|270deg/.test(rtlH1Info.background) && !/to right|90deg/.test(rtlH1Info.background)
        expect(isGradientReversed, 'RTL authored H1 gradient fades toward inline end (to left)').toBe(true)

        const isMaskReversed = /V35.*C70 35 40 10 0 10/i.test(rtlH1Info.maskImage) || /0 0 H100 V35/i.test(rtlH1Info.maskImage)
        expect(isMaskReversed, 'RTL authored H1 mask silhouette mirrors taper toward inline end').toBe(true)
      }

      // Repeat with an authored H1 inside an authentic nested dir='rtl' region
      const nestedRtlH1Info = await page.evaluate(() => {
        const contents = document.querySelector('article.contents')
        if (!contents) return null

        const nestedRegion = document.createElement('div')
        nestedRegion.className = 'test-nested-rtl-region'
        nestedRegion.setAttribute('dir', 'rtl')

        const nestedH1 = document.createElement('h1')
        nestedH1.className = 'test-nested-rtl-h1'
        nestedH1.textContent = 'Nested RTL Heading'
        nestedRegion.appendChild(nestedH1)
        contents.appendChild(nestedRegion)

        const h1Style = window.getComputedStyle(nestedH1)
        const after = window.getComputedStyle(nestedH1, '::after')
        const height = parseFloat(after.height) || parseFloat(after.getPropertyValue('block-size')) || 0
        const width = parseFloat(after.width) || parseFloat(after.getPropertyValue('inline-size')) || 0
        const insetInlineStart = after.getPropertyValue('inset-inline-start')
        const bg = after.backgroundImage || after.background
        const mask = after.maskImage || after.webkitMaskImage || ''

        const info = {
          direction: h1Style.direction,
          afterContent: after.content,
          afterHeight: height,
          afterWidth: width,
          insetInlineStart,
          afterRight: after.right,
          background: bg,
          maskImage: mask
        }

        nestedRegion.remove()
        return info
      })
      expect(nestedRtlH1Info, 'Nested RTL H1 evaluation must succeed').not.toBeNull()
      if (nestedRtlH1Info) {
        expect(nestedRtlH1Info.direction, 'Nested RTL authored H1 inherits RTL direction').toBe('rtl')
        expect(nestedRtlH1Info.afterContent, 'Nested RTL authored H1 swoosh has content').not.toMatch(/^(?:none|""|normal)$/)
        expect(nestedRtlH1Info.afterHeight, 'Nested RTL authored H1 swoosh retains 3.5px height').toBeGreaterThanOrEqual(3)
        expect(nestedRtlH1Info.afterHeight, 'Nested RTL authored H1 swoosh retains 3.5px height').toBeLessThanOrEqual(4)
        expect(nestedRtlH1Info.afterWidth, 'Nested RTL authored H1 swoosh width is positive').toBeGreaterThan(0)
        expect(nestedRtlH1Info.afterWidth, 'Nested RTL authored H1 swoosh width is bounded to 10rem').toBeLessThanOrEqual(165)

        const isNestedAnchored = nestedRtlH1Info.insetInlineStart === '0px' || nestedRtlH1Info.afterRight === '0px'
        expect(isNestedAnchored, 'Nested RTL authored H1 swoosh is anchored at inline start (right: 0)').toBe(true)

        const isNestedGradientReversed = /to left|270deg/.test(nestedRtlH1Info.background) && !/to right|90deg/.test(nestedRtlH1Info.background)
        expect(isNestedGradientReversed, 'Nested RTL authored H1 gradient fades toward inline end (to left)').toBe(true)

        const isNestedMaskReversed = /V35.*C70 35 40 10 0 10/i.test(nestedRtlH1Info.maskImage) || /0 0 H100 V35/i.test(nestedRtlH1Info.maskImage)
        expect(isNestedMaskReversed, 'Nested RTL authored H1 mask silhouette mirrors taper toward inline end').toBe(true)
      }
    } finally {
      await page.evaluate(state => {
        try {
          document.querySelector('.test-nested-rtl-region')?.remove()
        } catch {}
        try {
          if (state.documentDirection === null) document.documentElement.removeAttribute('dir')
          else document.documentElement.setAttribute('dir', state.documentDirection)
        } catch {}
        try {
          const reader = document.querySelector<HTMLElement>('.wiki-page')
          if (reader) {
            if (state.readerDirection === null) reader.removeAttribute('dir')
            else reader.setAttribute('dir', state.readerDirection)
            reader.className = state.readerClass
          }
        } catch {}
        try {
          const header = document.querySelector<HTMLElement>('.page-header-section > .is-page-header')
          if (header && state.headerClass) header.className = state.headerClass
        } catch {}
        try {
          const rail = document.querySelector<HTMLElement>('.page-col-sd')
          if (rail && state.railClass) rail.className = state.railClass
        } catch {}
        try {
          const article = document.querySelector<HTMLElement>('.page-col-content:not(.is-page-header)')
          if (article && state.articleClass) article.className = state.articleClass
        } catch {}
      }, originalState)
    }
  })

  test('uses the full printable reader width without the metadata rail', async ({ page }) => {
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    try {
      await page.emulateMedia({ media: 'print' })

      const headerShell = page.locator('.page-header-section').first()
      const header = headerShell.locator('> .is-page-header').first()
      const headings = header.locator('.page-header-headings').first()
      const bodyRow = page.locator('.page-body > .v-row').first()
      const rail = page.locator('.page-col-sd').first()
      const articleColumn = page.locator('.page-col-content:not(.is-page-header)').first()
      const article = articleColumn.locator('> .contents').first()

      await expect(rail).toBeHidden()
      await expect(header).toBeVisible()
      await expect(headings).toBeVisible()
      await expect(article).toBeVisible()

      const [headerShellBounds, headerBounds, headingsBounds, rowBounds, articleColumnBounds, articleBounds] = await Promise.all([
        headerShell.boundingBox(),
        header.boundingBox(),
        headings.boundingBox(),
        bodyRow.boundingBox(),
        articleColumn.boundingBox(),
        article.boundingBox()
      ])
      expect(headerShellBounds).not.toBeNull()
      expect(headerBounds).not.toBeNull()
      expect(headingsBounds).not.toBeNull()
      expect(rowBounds).not.toBeNull()
      expect(articleColumnBounds).not.toBeNull()
      expect(articleBounds).not.toBeNull()
      if (!headerShellBounds || !headerBounds || !headingsBounds || !rowBounds || !articleColumnBounds || !articleBounds) return

      expect(Math.abs(headerBounds.x - headerShellBounds.x), 'Print header starts at the printable shell edge').toBeLessThanOrEqual(2)
      expect(Math.abs(headerBounds.width - headerShellBounds.width), 'Print header fills the printable shell').toBeLessThanOrEqual(2)
      expect(Math.abs(headingsBounds.x - headerBounds.x), 'Print headings do not retain a metadata-rail offset').toBeLessThanOrEqual(2)
      expect(Math.abs(headingsBounds.width - headerBounds.width), 'Print headings do not retain a metadata-rail width reservation').toBeLessThanOrEqual(2)
      expect(Math.abs(articleColumnBounds.x - rowBounds.x), 'Print article starts at the printable row edge').toBeLessThanOrEqual(2)
      expect(Math.abs(articleColumnBounds.width - rowBounds.width), 'Print article fills the printable row').toBeLessThanOrEqual(2)
      expect(articleBounds.width, 'Print article does not retain a hidden metadata-rail reservation').toBeGreaterThan(rowBounds.width * 0.9)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        'Print reader has no horizontal overflow'
      ).toBeLessThanOrEqual(1)
    } finally {
      await page.emulateMedia({ media: 'screen' })
    }
  })

  test('keeps search interaction and results inside every viewport', async ({ page }) => {
    await page.route('**/_api/pages/search?**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            {
              id: 101,
              title: 'Responsive Search Result',
              description: 'A deterministic result with enough copy to exercise wrapping at narrow widths.',
              path: 'responsive-search-result',
              locale: 'en',
              visibility: 'public',
              tags: ['responsive'],
              score: 10,
              matchedFields: ['title']
            },
            {
              id: 102,
              title: 'Private Responsive Result',
              description: 'A second result verifies that multiple cards remain readable.',
              path: 'private-responsive-result',
              locale: 'en',
              visibility: 'private',
              tags: ['private'],
              score: 8,
              matchedFields: ['title']
            }
          ],
          suggestions: ['responsive layout'],
          totalHits: 2
        })
      })
    })
    await openAuthenticatedPage(page, '/', '.page-header-section')
    const search = await openSearch(page)
    await search.pressSequentially('responsive')

    const result = page.getByText('Responsive Search Result', { exact: true }).first()
    await expect(result).toBeVisible()
    await expect(page.getByText('Private Responsive Result', { exact: true }).first()).toBeVisible()
    await result.scrollIntoViewIfNeeded()
    await expectLocatorWithinViewport(result, 'Search result title')
    await expectResponsiveLayout(page, 'Search results')
  })

  test('keeps the Admin Dashboard and page management responsive', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return

    for (const path of ['/a/dashboard', '/a/pages']) {
      await openAuthenticatedPage(page, path, '.admin-main')
      await expectResponsiveLayout(page, path)
    }

    const drawer = page.locator('#admin-navigation')
    const toggle = page.getByRole('button', { name: 'Open administration navigation' })
    if (viewport.width < 840) {
      await expect(toggle).toBeVisible()
      await expect(drawer).toHaveClass(/v-navigation-drawer--temporary/)
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
      await toggle.click()
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
      await expectLocatorWithinViewport(drawer, 'Administration navigation')
      await expectResponsiveLayout(page, 'Open administration navigation')
      await drawer.getByRole('button', { name: 'Close administration navigation' }).click()
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
    } else {
      await expect(toggle).toBeHidden()
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--temporary/)
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
    }

    await page.getByRole('link', { name: 'All administration settings', exact: true }).click()
    await expect(page.locator('#dashboard-settings-title')).toBeInViewport()
    const settingsSearch = page.locator('.dashboard-directory__search input')
    await settingsSearch.fill('MCP')
    await expect(page.locator('.dashboard-directory__link')).toHaveCount(2)
    await settingsSearch.fill('no-matching-setting')
    await expect(page.getByText('No matching settings', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Clear search', exact: true }).click()
    await expect(page.locator('.dashboard-directory__link')).toHaveCount(27)
    const directory = page.locator('#settings')
    for (const link of await directory.locator('.dashboard-directory__link').all()) {
      await expect(link).toHaveAttribute('href', /^\/(?:a\/[^/]+|graphql)$/)
    }
    const pagesLink = directory.getByRole('link', { name: /^Pages / })
    await pagesLink.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/a/pages')
  })

  test('keeps tag taxonomy lifecycle review and navigation safe', async ({ page }) => {
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('This responsive test requires a configured viewport.')
    if (viewport.width < 960) await page.setViewportSize({ width: 320, height: viewport.height })

    await page.emulateMedia({ colorScheme: 'light' })
    await authenticateAsAdmin(page)

    const projectSuffix = test
      .info()
      .project.name.replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase()
      .slice(0, 20)
    const suffix = `${projectSuffix}-${Date.now().toString(36)}`
    const canonicalTag = `e2e-lifecycle-canonical-${suffix}`
    const canonicalTitle = `E2E lifecycle canonical ${suffix}`
    const aliasSourceTag = `e2e-lifecycle-source-${suffix}`
    const aliasSourceTitle = `E2E lifecycle source ${suffix}`
    const aliasDestinationTag = `e2e-lifecycle-destination-${suffix}`
    const aliasDestinationTitle = `E2E lifecycle destination ${suffix}`
    const successMessage = 'Taxonomy updated. The change has been saved.'
    const accessAcknowledgement = 'I understand that these tag-based access rules will match different pages.'

    const createTag = async (tag: string, title: string): Promise<number> => {
      const response = await page.request.post('/_api/taxonomy', { data: { tag, title }, headers: sameOriginHeaders() })
      expect(response.ok(), `Creating disposable taxonomy tag ${tag}`).toBe(true)
      const payload = (await response.json()) as { id?: unknown }
      expect(typeof payload.id, `Creating disposable taxonomy tag ${tag} returns an id`).toBe('number')
      return payload.id as number
    }

    const canonicalId = await createTag(canonicalTag, canonicalTitle)
    const aliasSourceId = await createTag(aliasSourceTag, aliasSourceTitle)
    const aliasDestinationId = await createTag(aliasDestinationTag, aliasDestinationTitle)

    const showLifecycle = async (): Promise<Locator> => {
      const lifecycleTab = page.getByRole('tab', { name: 'Lifecycle', exact: true })
      await expect(lifecycleTab).toBeVisible()
      await lifecycleTab.click()
      const panel = page.locator('#taxonomy-panel-lifecycle')
      await expect(panel).toBeVisible()
      return panel
    }

    const selectVocabularyView = async (name: string): Promise<void> => {
      const view = page.getByRole('combobox', { name: 'Vocabulary view', exact: true })
      await expect(view).toBeVisible()
      await view.focus()
      await view.press('Enter')
      const option = page.getByRole('option', { name, exact: true })
      await expect(option).toBeVisible()
      await option.click()
    }

    const openLifecycle = async (id: number): Promise<Locator> => {
      await page.goto(`/a/tags?tag=${id}`, { waitUntil: 'domcontentloaded' })
      return showLifecycle()
    }

    const acknowledgeAccessIfNeeded = async (dialog: Locator): Promise<void> => {
      const checkbox = dialog.getByRole('checkbox', { name: accessAcknowledgement, exact: true })
      if (await checkbox.count()) {
        await checkbox.check()
        await expect(checkbox).toBeChecked()
      }
    }

    const applyReview = async (action: 'retirement' | 'restoration' | 'merge'): Promise<void> => {
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await acknowledgeAccessIfNeeded(dialog)
      await dialog.getByRole('button', { name: `Apply ${action}`, exact: true }).click()
      await expect(page.getByText(successMessage, { exact: true })).toBeVisible()
    }

    await openAuthenticatedPage(page, '/a/dashboard', '.admin-main')
    const tagsLink = page.getByRole('link', { name: /Tags\. Topics connecting knowledge\.$/i })
    await expect(tagsLink).toHaveAttribute('href', '/a/tags')
    await tagsLink.click()
    await expect(page).toHaveURL('/a/tags')

    const directorySearch = page.getByRole('textbox', { name: 'Find a tag or label', exact: true })
    await directorySearch.fill(canonicalTag)
    const canonicalRow = page.getByRole('button', { name: `${canonicalTitle}, active`, exact: true })
    await expect(canonicalRow).toBeVisible()
    await canonicalRow.click()
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)

    const displayLabel = page.getByRole('textbox', { name: 'Display label', exact: true })
    const draftLabel = `${canonicalTitle} draft`
    await displayLabel.fill(draftLabel)
    await page.getByRole('button', { name: 'Review changes', exact: true }).click()
    const draftReview = page.getByRole('dialog')
    await expect(draftReview).toContainText('Update the display label')
    await expect(draftReview).toContainText(draftLabel)

    const navigationPrompts = new Promise<void>(resolve => {
      const acceptReviewPrompt = async (dialog: Dialog) => {
        page.off('dialog', acceptReviewPrompt)
        const rejectDraftPrompt = async (nextDialog: Dialog) => {
          page.off('dialog', rejectDraftPrompt)
          expect(nextDialog.message()).toContain('Discard the unsaved tag changes?')
          await nextDialog.dismiss()
          resolve()
        }
        page.on('dialog', rejectDraftPrompt)
        expect(dialog.message()).toContain('Discard the unapplied taxonomy review?')
        await dialog.accept()
      }
      page.on('dialog', acceptReviewPrompt)
    })
    await page.evaluate(() => window.history.back())
    await navigationPrompts
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)
    await expect(draftReview).toBeVisible()
    await expect(draftReview).toContainText(draftLabel)
    await expect(displayLabel).toHaveValue(draftLabel)
    await draftReview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(displayLabel).toHaveValue(canonicalTitle)

    const ordinaryDraftLabel = `${canonicalTitle} ordinary draft`
    await displayLabel.fill(ordinaryDraftLabel)
    const rejectedDirtyNavigation = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toContain('Discard the unsaved tag changes?')
      await dialog.dismiss()
    })
    await page.evaluate(() => window.history.back())
    await rejectedDirtyNavigation
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)
    await expect(displayLabel).toHaveValue(ordinaryDraftLabel)
    await page.getByRole('button', { name: 'Reset', exact: true }).click()

    const canonicalPanel = await showLifecycle()
    await canonicalPanel.getByRole('button', { name: 'Review retirement', exact: true }).click()
    const canonicalReview = page.getByRole('dialog')
    await expect(canonicalReview).toContainText('Retire this name')
    await acknowledgeAccessIfNeeded(canonicalReview)

    const rejectedReviewNavigation = page.waitForEvent('dialog').then(async dialog => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toContain('Discard the unapplied taxonomy review?')
      await dialog.dismiss()
    })
    await page.evaluate(() => window.history.back())
    await rejectedReviewNavigation
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)
    await expect(canonicalReview).toBeVisible()
    const preservedAcknowledgement = canonicalReview.getByRole('checkbox', { name: accessAcknowledgement, exact: true })
    if (await preservedAcknowledgement.count()) await expect(preservedAcknowledgement).toBeChecked()

    await applyReview('retirement')
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const archivedCanonicalPanel = await showLifecycle()
    await expect(archivedCanonicalPanel.getByRole('button', { name: 'Review restoration', exact: true })).toBeVisible()
    await selectVocabularyView('Archived names')
    const archivedCanonicalSearch = page.getByRole('textbox', { name: 'Find a tag or label', exact: true })
    await archivedCanonicalSearch.fill(canonicalTag)
    await expect(page.getByRole('button', { name: `${canonicalTitle}, archived, selected`, exact: true })).toBeVisible()

    const aliasPanel = await openLifecycle(aliasSourceId)
    const destinationInput = aliasPanel.getByRole('combobox', { name: 'Canonical destination', exact: true })
    await destinationInput.fill(aliasDestinationTag)
    const destinationOption = page.getByRole('option', { name: aliasDestinationTag, exact: true })
    await expect(destinationOption).toBeVisible()
    await destinationOption.click()
    await aliasPanel.getByRole('button', { name: 'Review merge', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Bring two concepts together')
    await applyReview('merge')
    await expect(page).toHaveURL(`/a/tags?tag=${aliasDestinationId}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const mergedDestinationPanel = await showLifecycle()
    await expect(mergedDestinationPanel.getByRole('button', { name: 'Review retirement', exact: true })).toBeVisible()

    const activeAliasPanel = await openLifecycle(aliasSourceId)
    await expect(page.getByText(`Loaded ${aliasSourceTitle}`, { exact: true })).toBeVisible()
    await expect(activeAliasPanel.getByRole('button', { name: 'Review retirement', exact: true })).toBeVisible()
    await selectVocabularyView('Aliases')
    const aliasSearch = page.getByRole('textbox', { name: 'Find a tag or label', exact: true })
    await aliasSearch.fill(aliasSourceTag)
    await expect(page.getByRole('button', { name: `${aliasSourceTitle}, alias, selected`, exact: true })).toBeVisible()
    await activeAliasPanel.getByRole('button', { name: 'Review retirement', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Retire this name')
    await applyReview('retirement')
    await expect(page).toHaveURL(`/a/tags?tag=${aliasSourceId}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const archivedAliasPanel = await showLifecycle()
    await expect(archivedAliasPanel.getByRole('button', { name: 'Review restoration', exact: true })).toBeVisible()
    await selectVocabularyView('Archived names')
    const archivedAliasSearch = page.getByRole('textbox', { name: 'Find a tag or label', exact: true })
    await archivedAliasSearch.fill(aliasSourceTag)
    await expect(page.getByRole('button', { name: `${aliasSourceTitle}, archived, selected`, exact: true })).toBeVisible()

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(`/a/tags?tag=${canonicalId}`, { waitUntil: 'domcontentloaded' })
    const restorationPanel = await showLifecycle()
    await restorationPanel.getByRole('button', { name: 'Review restoration', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Restore this name')
    await applyReview('restoration')
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const restoredPanel = await showLifecycle()
    await expect(restoredPanel.getByRole('button', { name: 'Review retirement', exact: true })).toBeVisible()
    await expect(page.locator('.taxonomy-detail')).toHaveAttribute('aria-busy', 'false')
    await page.evaluate(async () => {
      await document.fonts.ready
      const animations = (document.querySelector('.admin-main')?.getAnimations({ subtree: true }) ?? []).filter(animation => {
        if (animation.playState !== 'running') return false
        const endTime = animation.effect?.getComputedTiming().endTime
        return typeof endTime === 'number' && Number.isFinite(endTime)
      })
      await Promise.allSettled(animations.map(animation => animation.finished))
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    await expectResponsiveLayout(page, 'Admin taxonomy lifecycle')
  })

  test('keeps GraphQL documentation usable without losing the current query', async ({ page }) => {
    await authenticateAsAdmin(page)
    await page.goto('/graphql', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.graphiql-execute-button')).toBeVisible()
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('This responsive test requires a configured viewport.')
    expect(await page.evaluate(() => window.innerWidth)).toBe(viewport.width)
    await page.getByRole('textbox', { name: 'Editor content' }).first().focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText('query PaneRetention { __typename }')
    const queryEditor = page.locator('.graphiql-query-editor')
    await expect(queryEditor).toContainText('PaneRetention')
    await page.getByRole('button', { name: 'Show Documentation Explorer', exact: true }).click()
    await expect(page.locator('.graphiql-doc-explorer')).toBeVisible()
    await expectResponsiveLayout(page, 'GraphQL schema documentation')
    if (viewport.width <= 700) await expect(queryEditor).toBeHidden()
    await page.getByRole('button', { name: 'Hide Documentation Explorer', exact: true }).click()
    await expect(queryEditor).toBeVisible()
    await expect(queryEditor).toContainText('PaneRetention')
    await expectResponsiveLayout(page, 'Restored GraphQL query')
  })

  test('keeps Agent Chat readable and operable', async ({ page }) => {
    await openAuthenticatedPage(page, '/', '.page-header-section')
    const entrance = page.locator('.nav-header-agent')
    await expectLocatorWithinViewport(entrance, 'Wiki Agent entrance')
    await expect(entrance.locator('.v-icon')).toBeVisible()
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return

    const browse = page.locator('.nav-header-browse:visible').first()
    await expectLocatorWithinViewport(browse, 'Browse by Tags link')
    await expect(browse).toHaveAttribute('href', '/t')
    await expect(browse).toHaveAttribute('aria-label', 'Browse by Tags')
    await expect(browse.locator('.nav-header-browse-label')).toHaveCount(0)
    await expect(browse).not.toContainText('Browse by Tags')

    const searchControl =
      viewport.width < 960 ? page.locator('.nav-header-search-toggle:visible').first() : page.locator('.nav-header-search-control input:visible').first()
    await expect(searchControl).toBeVisible()
    const actionOrder = await page.locator('.nav-header').evaluate(header => {
      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0
      }
      return Array.from(
        header.querySelectorAll<HTMLElement>('.nav-header-search-control input, .nav-header-search-toggle, .nav-header-agent, .nav-header-browse')
      )
        .filter(isVisible)
        .map(element => {
          if (element.matches('.nav-header-agent')) return 'agent'
          if (element.matches('.nav-header-browse')) return 'browse'
          return 'search'
        })
    })
    expect(actionOrder, 'Header actions stay in Agent, search, Browse DOM order').toEqual(['agent', 'search', 'browse'])

    const [searchBounds, agentBounds, browseBounds] = await Promise.all([searchControl.boundingBox(), entrance.boundingBox(), browse.boundingBox()])
    expect(searchBounds).not.toBeNull()
    expect(agentBounds).not.toBeNull()
    expect(browseBounds).not.toBeNull()
    if (browseBounds) {
      expect(Math.abs(browseBounds.width - browseBounds.height), 'Browse tag link remains square').toBeLessThanOrEqual(1)
    }
    if (searchBounds && agentBounds && browseBounds) {
      const actionBounds = [
        { name: 'Agent', bounds: agentBounds },
        { name: 'search', bounds: searchBounds },
        { name: 'Browse', bounds: browseBounds }
      ]
      for (let firstIndex = 0; firstIndex < actionBounds.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < actionBounds.length; secondIndex += 1) {
          const first = actionBounds[firstIndex]!.bounds
          const second = actionBounds[secondIndex]!.bounds
          const overlaps =
            first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height
          expect(overlaps, `${actionBounds[firstIndex]!.name} and ${actionBounds[secondIndex]!.name} must not overlap`).toBe(false)
        }
      }
    }

    await searchControl.focus()
    await expect(searchControl).toBeFocused()
    await searchControl.press('Shift+Tab')
    await expect(entrance).toBeFocused()
    await entrance.press('Tab')
    await expect(searchControl).toBeFocused()
    await searchControl.press('Tab')
    await expect(browse).toBeFocused()
    await expect
      .poll(() =>
        page.locator('.nav-header').evaluate(
          header =>
            Array.from(header.querySelectorAll('button')).filter(button => {
              const bounds = button.getBoundingClientRect()
              return bounds.width > 0 && (bounds.left < 0 || bounds.right > window.innerWidth)
            }).length
        )
      )
      .toBe(0)
    if (viewport.width >= 960) await page.keyboard.press('ControlOrMeta+K')
    else await openSearch(page)
    const wikiSearchDialog = page.getByRole('dialog', { name: 'Wiki search', exact: true })
    await expect(wikiSearchDialog).toBeVisible()
    const openWikiAgentButton = wikiSearchDialog.getByRole('button', { name: 'Open Wiki Agent', exact: true })
    await expect(openWikiAgentButton).toBeVisible()
    await openWikiAgentButton.click()

    const agent = page.getByRole('region', { name: 'Wiki Agent' })
    await expect(agent).toBeVisible()
    await expect(page.getByText(/Agent inference is currently disabled/)).toBeVisible()
    const newConversationButton = agent.getByRole('button', { name: 'New conversation', exact: true })
    const temporaryConversationButton = agent.getByRole('button', { name: 'Temporary conversation', exact: true })
    const chatPinButton = agent.locator('.agent-composer__chat-pin')
    await expect(newConversationButton).toBeVisible()
    await expect(temporaryConversationButton).toBeVisible()
    await expect(chatPinButton).toHaveAttribute('aria-pressed', 'false')
    await chatPinButton.click()
    await expect(chatPinButton).toHaveAttribute('aria-pressed', 'true')
    await chatPinButton.click()
    await expect(chatPinButton).toHaveAttribute('aria-pressed', 'false')
    await expect(agent.locator('.inline-agent__starter').first()).toBeVisible()

    await expect(agent.getByRole('textbox', { name: 'Message Wiki Agent' })).toBeVisible()
    const historyButton = agent.getByRole('button', { name: 'Open agent conversation history' })
    const mobilePanelButton = agent.getByRole('button', { name: 'Open Agent panels: conversation history and memory' })
    const usesMobilePanelMenu = await mobilePanelButton.isVisible()
    const panelFocusTarget = usesMobilePanelMenu ? mobilePanelButton : historyButton
    const openHistory = async (): Promise<void> => {
      await panelFocusTarget.click()
      if (usesMobilePanelMenu) {
        const historyMenuItem = page.locator('.v-overlay--active [role="menuitem"]:visible').filter({ hasText: 'Conversation history' })
        await historyMenuItem.focus()
        await historyMenuItem.press('Enter')
      }
    }
    await expect(panelFocusTarget).toBeVisible()

    const card = agent.locator('.inline-agent__card')
    const visibleSidePanels = agent.locator('.inline-agent__side:visible')
    const scrim = agent.locator('.inline-agent__scrim')
    const historyPanel = agent.getByRole('complementary', { name: 'Conversations' })
    const memoryPanel = agent.getByRole('complementary', { name: 'Agent memory' })
    const historyDialog = agent.getByRole('dialog', { name: 'Conversations' })

    if (viewport.width >= 1760) {
      await page.locator('.search-results--ask').evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished))
      })
      const initialCard = await card.boundingBox()
      expect(initialCard).not.toBeNull()

      await openHistory()
      await expect(historyPanel).toBeVisible()
      await expect(historyPanel).not.toHaveAttribute('aria-modal', 'true')
      await expect(historyPanel).not.toHaveAttribute('role', 'dialog')
      await expect(scrim).toHaveCount(0)
      await expect(visibleSidePanels).toHaveCount(1)
      await expect.poll(() => historyPanel.evaluate(element => getComputedStyle(element).position)).toBe('relative')
      const historyCard = await card.boundingBox()
      const historyBounds = await historyPanel.boundingBox()
      expect(historyCard).not.toBeNull()
      expect(historyBounds).not.toBeNull()
      if (initialCard && historyCard && historyBounds) {
        expect(historyCard.width).toBeGreaterThanOrEqual(initialCard.width * 0.75)
        expect(historyCard.x + historyCard.width).toBeLessThanOrEqual(viewport.width + 1)
        expect(historyBounds.x + historyBounds.width).toBeLessThanOrEqual(historyCard.x)
      }

      const memoryButton = agent.getByRole('button', { name: 'Manage agent memory' })
      await memoryButton.click()
      await expect(memoryPanel).toBeVisible()
      await expect(scrim).toHaveCount(0)
      await expect(memoryPanel).not.toHaveAttribute('aria-modal', 'true')
      await expect(memoryPanel).not.toHaveAttribute('role', 'dialog')
      await expect.poll(() => memoryPanel.evaluate(element => getComputedStyle(element).position)).toBe('relative')
      const memoryCard = await card.boundingBox()
      const memoryBounds = await memoryPanel.boundingBox()
      expect(memoryCard).not.toBeNull()
      expect(memoryBounds).not.toBeNull()
      if (initialCard && memoryCard && memoryBounds) {
        expect(memoryCard.width).toBeGreaterThanOrEqual(initialCard.width * 0.6)
        expect(memoryCard.x + memoryCard.width).toBeLessThanOrEqual(viewport.width + 1)
        expect(memoryBounds.x).toBeGreaterThanOrEqual(memoryCard.x + memoryCard.width)
      }
      await memoryPanel.getByRole('button', { name: 'Close agent memory' }).click()
      await expect(memoryPanel).toBeHidden()
      await historyPanel.getByRole('button', { name: 'Close chat history' }).click()
      await expect(historyPanel).toBeHidden()
    } else if (viewport.width >= 1024) {
      await openHistory()
      await expect(historyPanel).toBeVisible()
      await expect(historyPanel).not.toHaveAttribute('aria-modal', 'true')
      await expect(scrim).toHaveCount(0)
      await expect(visibleSidePanels).toHaveCount(1)
      await expect.poll(() => historyPanel.evaluate(element => getComputedStyle(element).position)).toBe('relative')
      const cardBounds = await card.boundingBox()
      const historyBounds = await historyPanel.boundingBox()
      expect(cardBounds).not.toBeNull()
      expect(historyBounds).not.toBeNull()
      if (cardBounds && historyBounds) {
        expect(historyBounds.x + historyBounds.width).toBeLessThanOrEqual(cardBounds.x)
      }
      await historyPanel.getByRole('button', { name: 'Close chat history' }).click()
      await expect(historyPanel).toBeHidden()
    } else {
      await openHistory()
      await expect(historyDialog).toBeVisible()
      await expect(historyDialog).toHaveAttribute('aria-modal', 'true')
      await expect(scrim).toBeVisible()
      await expect(visibleSidePanels).toHaveCount(1)
      await historyDialog.getByRole('button', { name: 'Close chat history' }).click()
      await expect(historyDialog).toBeHidden()
      await expect(scrim).toBeHidden()
      await expect(visibleSidePanels).toHaveCount(0)
      await expect(panelFocusTarget).toBeFocused()
    }

    if (viewport.width <= 639.98) {
      await expect(page.locator('.search-results-agent-nav')).toBeHidden()
      await expect(agent.getByRole('button', { name: 'Return to Wiki Search' })).toBeVisible()
      await expect(agent.getByRole('button', { name: 'Close Wiki Agent' })).toBeVisible()
    }

    await expect(agent.getByRole('button', { name: 'Return to Wiki Search' })).toBeVisible()
    await expect(agent.getByRole('button', { name: 'Close Wiki Agent' })).toBeVisible()
    await agent.getByRole('button', { name: 'Return to Wiki Search' }).click()
    await expect(page.locator('.search-results-search')).toBeVisible()
    await page.locator('.search-results-agent-entry').click()
    await expect(agent).toBeVisible()
    await expectLocatorWithinViewport(agent, 'Wiki Agent panel')
    await expectResponsiveLayout(page, 'Wiki Agent panel')
    await page.context().clearCookies()
    await page.goto('/en/home', { waitUntil: 'networkidle' })
    await expect(page.locator('.page-header-section')).toBeVisible()
    await expect(page.locator('.nav-header-agent:visible')).toHaveCount(0)
    const browseWithoutAgent = page.locator('.nav-header-browse:visible').first()
    await expectLocatorWithinViewport(browseWithoutAgent, 'Browse by Tags link without Wiki Agent')
    await expect(browseWithoutAgent).toHaveAttribute('href', '/t')
    await expect(browseWithoutAgent).toHaveAttribute('aria-label', 'Browse by Tags')
    await browseWithoutAgent.focus()
    await expect(browseWithoutAgent).toBeFocused()
    await browseWithoutAgent.press('Enter')
    await expect(page).toHaveURL('/t')
    await expect(page.locator('.nav-header-browse:visible').first()).toHaveAttribute('aria-current', 'page')
  })
  test('exercises enabled Agent streaming, trusted citations, and runtime Mermaid', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled Agent runtime coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { mode: 'focus' })
    try {
      const agent = await openFixtureAgentFromSearch(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Explain the release evidence and show the verification flow.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('The release is ready for a deliberate review.', { exact: true })).toBeVisible()
      const repeatedLinks = agent.locator('a[href="/en/release-guide#title-only"]').filter({ hasText: 'Follow-up reading' })
      await expect(repeatedLinks).toHaveCount(2)
      await repeatedLinks.nth(1).focus()
      await expect(repeatedLinks.nth(1)).toBeFocused()
      await expect(agent.getByText('The streamed review context is still current.', { exact: true })).toBeVisible()
      await expect(repeatedLinks).toHaveCount(2)
      await expect(repeatedLinks.nth(1)).toBeFocused()

      await expect(agent.getByText('The streamed review context gained another link.', { exact: true })).toBeVisible()
      await expect(repeatedLinks).toHaveCount(3)
      await expect(repeatedLinks.nth(0)).not.toBeFocused()
      await expect(agent.locator('[data-agent-citation]')).not.toHaveCount(0)
      await expect(agent.locator('.agent-markdown svg')).not.toHaveCount(0)
      await expect(agent.locator('[data-copy-code]')).toBeVisible()
      expect(fixture.requests.some(request => request.includes('/messages'))).toBe(true)
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('keeps the Latest response control visible, safe, and operable', async ({ page }, testInfo) => {
    const desktopProject = testInfo.project.name === 'responsive-chromium-desktop' || testInfo.project.name === 'responsive-chromium-wide'
    const coarseProject = testInfo.project.name === 'responsive-chromium-mobile'
    if (!desktopProject && !coarseProject) return
    if (coarseProject) await page.setViewportSize({ width: 320, height: 640 })
    const fixture = await installEnabledAgentFixture(page, { mode: 'latest' })
    try {
      const agent = await openFixtureAgentFromSearch(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Show enough release evidence to inspect the latest response navigation.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.locator('.agent-message--assistant').last()).toContainText(
        'The final checkpoint keeps the newest response at the end of the conversation.'
      )

      const transcript = agent.locator('.inline-agent__transcript')
      await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100)
      await transcript.evaluate(element => element.scrollTo({ top: 0, behavior: 'auto' }))
      const latest = agent.getByRole('button', { name: 'Jump to latest response', exact: true })
      const face = latest.locator('.inline-agent__follow-jump-face')
      const halo = latest.locator('.inline-agent__follow-jump-halo')
      const jumpDock = agent.locator('.inline-agent__jump-dock')
      const card = agent.locator('.inline-agent__card')
      const body = agent.locator('.inline-agent__body')
      const composerFooter = agent.locator('.inline-agent__composer')
      const addSources = agent.getByText('Add sources', { exact: true })
      await expect(latest).toBeVisible()
      await expect(addSources).toBeVisible()

      const assertJumpGeometry = async (scheme: 'light' | 'dark'): Promise<void> => {
        await page.emulateMedia({ colorScheme: scheme, forcedColors: 'none', reducedMotion: 'no-preference' })
        await expect(latest).toBeVisible()
        const [cardBounds, jumpBounds, faceBounds, haloBounds, bodyBounds, composerBounds, addSourcesBounds] = await Promise.all([
          card.boundingBox(),
          jumpDock.boundingBox(),
          face.boundingBox(),
          halo.boundingBox(),
          body.boundingBox(),
          composerFooter.boundingBox(),
          addSources.boundingBox()
        ])
        expect(cardBounds).not.toBeNull()
        expect(jumpBounds).not.toBeNull()
        expect(faceBounds).not.toBeNull()
        expect(haloBounds).not.toBeNull()
        expect(bodyBounds).not.toBeNull()
        expect(composerBounds).not.toBeNull()
        expect(addSourcesBounds).not.toBeNull()
        if (cardBounds && jumpBounds && faceBounds && haloBounds && bodyBounds && composerBounds && addSourcesBounds) {
          expect(faceBounds.height).toBeGreaterThanOrEqual(35)
          expect(faceBounds.height).toBeLessThanOrEqual(37)
          expect(faceBounds.x).toBeGreaterThanOrEqual(jumpBounds.x)
          expect(faceBounds.x + faceBounds.width).toBeLessThanOrEqual(jumpBounds.x + jumpBounds.width)
          const paintOutset = 4
          expect(haloBounds.x - paintOutset).toBeGreaterThanOrEqual(cardBounds.x - 1)
          expect(haloBounds.x + haloBounds.width + paintOutset).toBeLessThanOrEqual(cardBounds.x + cardBounds.width + 1)
          expect(haloBounds.y - paintOutset).toBeGreaterThanOrEqual(cardBounds.y - 1)
          expect(haloBounds.y + haloBounds.height + paintOutset).toBeLessThanOrEqual(composerBounds.y + 1)
          expect(haloBounds.y - paintOutset).toBeGreaterThanOrEqual(bodyBounds.y + bodyBounds.height - 1)
          const overlapsAddSources =
            faceBounds.x < addSourcesBounds.x + addSourcesBounds.width &&
            addSourcesBounds.x < faceBounds.x + faceBounds.width &&
            faceBounds.y < addSourcesBounds.y + addSourcesBounds.height &&
            addSourcesBounds.y < faceBounds.y + faceBounds.height
          expect(overlapsAddSources, `Latest response face overlaps Add sources in ${scheme} mode`).toBe(false)
        }
        const [haloStyles, faceStyles, transcriptStyles] = await Promise.all([
          halo.evaluate(element => {
            const styles = getComputedStyle(element)
            return { filter: styles.filter, opacity: Number(styles.opacity) }
          }),
          face.evaluate(element => {
            const styles = getComputedStyle(element)
            return { background: styles.backgroundColor, border: styles.borderColor }
          }),
          transcript.evaluate(element => getComputedStyle(element).scrollBehavior)
        ])
        expect(haloStyles.filter, `Latest response halo remains painted in ${scheme} mode`).toContain('blur')
        expect(haloStyles.opacity, `Latest response halo remains visible in ${scheme} mode`).toBeGreaterThan(0)
        expect(faceStyles.background, `Latest response face has a visible background in ${scheme} mode`).not.toBe('rgba(0, 0, 0, 0)')
        expect(faceStyles.border, `Latest response face has a visible border in ${scheme} mode`).not.toBe('rgba(0, 0, 0, 0)')
        expect(transcriptStyles).toBe('smooth')
      }

      if (desktopProject) {
        await assertJumpGeometry('light')
        await assertJumpGeometry('dark')
        await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active', reducedMotion: 'reduce' })
        await expect(latest).toBeVisible()
        const forcedStyles = await halo.evaluate(element => {
          const styles = getComputedStyle(element)
          return { display: styles.display, filter: styles.filter }
        })
        expect(forcedStyles.display).toBe('none')
        expect(forcedStyles.filter).toBe('blur(4px)')
        expect(await transcript.evaluate(element => getComputedStyle(element).scrollBehavior)).toBe('auto')
      } else {
        await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none', reducedMotion: 'reduce' })
        const [outerBounds, compactFaceBounds] = await Promise.all([latest.boundingBox(), face.boundingBox()])
        expect(outerBounds).not.toBeNull()
        expect(compactFaceBounds).not.toBeNull()
        if (outerBounds && compactFaceBounds) {
          expect(Math.min(outerBounds.width, outerBounds.height)).toBeGreaterThanOrEqual(44)
          expect(compactFaceBounds.height).toBeGreaterThanOrEqual(35)
          expect(compactFaceBounds.height).toBeLessThanOrEqual(37)
        }
      }

      const moveAwayFromLatest = async (): Promise<void> => {
        await transcript.evaluate(element => element.scrollTo({ top: 0, behavior: 'auto' }))
        await expect(latest).toBeVisible()
      }
      const expectLatestReached = async (): Promise<void> => {
        await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(160)
        await expect(latest).toBeHidden()
        await expect(transcript).toBeFocused()
      }
      await moveAwayFromLatest()
      await latest.click()
      await expectLatestReached()
      await moveAwayFromLatest()
      await latest.focus()
      await latest.press('Enter')
      await expectLatestReached()

      const [agentBounds, transcriptBounds, composerBounds] = await Promise.all([agent.boundingBox(), transcript.boundingBox(), composerFooter.boundingBox()])
      expect(agentBounds).not.toBeNull()
      expect(transcriptBounds).not.toBeNull()
      expect(composerBounds).not.toBeNull()
      if (agentBounds && transcriptBounds && composerBounds) {
        expect(agentBounds.x).toBeGreaterThanOrEqual(-1)
        expect(agentBounds.x + agentBounds.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1)
        expect(transcriptBounds.x + transcriptBounds.width).toBeLessThanOrEqual(composerBounds.x + composerBounds.width + 1)
      }
      expect(await agent.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await transcript.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('keeps approval navigation ahead of the Latest response jump', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled approval navigation priority is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { mode: 'approval' })
    try {
      const agent = await openFixtureAgentFromSearch(page)
      const approvalPrompt = Array.from(
        { length: 22 },
        (_, index) =>
          `Review section ${index + 1}: confirm the source revision, evidence owner, validation result, rollback note, and publication decision before proceeding with this bounded release operation.`
      ).join('\n\n')
      await agent.getByRole('textbox', { name: /^(?:Message|Follow up with) Wiki Agent$/ }).fill(approvalPrompt)
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('Awaiting approval', { exact: true })).toBeVisible()
      const transcript = agent.locator('.inline-agent__transcript')
      const approvalCard = agent.locator('.agent-operation').first()
      await expect(approvalCard).toBeVisible()
      const approvalJump = agent.getByRole('button', { name: 'Approval required', exact: true })
      await transcript.hover()
      await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
      await page.mouse.wheel(0, 50000)
      const scrollTopAtBottom = await transcript.evaluate(element => element.scrollTop)
      expect(scrollTopAtBottom, 'Approval fixture scrolls to the bottom of its overflowing transcript').toBeGreaterThan(0)
      await page.mouse.wheel(0, -50000)
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBe(0)
      await expect
        .poll(() =>
          approvalCard.evaluate(element => {
            const container = element.closest<HTMLElement>('.inline-agent__transcript')
            if (!container) return false
            return element.getBoundingClientRect().top >= container.getBoundingClientRect().bottom
          })
        )
        .toBe(true)
      await expect(approvalJump).toBeVisible()
      const latestJump = agent.getByRole('button', { name: 'Jump to latest response', exact: true })
      await expect(latestJump).toHaveCount(0)
      await approvalJump.click()
      await expect
        .poll(() =>
          approvalCard.evaluate(element => {
            const container = element.closest<HTMLElement>('.inline-agent__transcript')
            if (!container) return false
            const containerBounds = container.getBoundingClientRect()
            const cardBounds = element.getBoundingClientRect()
            return Math.min(cardBounds.bottom, containerBounds.bottom) - Math.max(cardBounds.top, containerBounds.top) > 0
          })
        )
        .toBe(true)
      await expect(approvalCard).toBeFocused()
      await expect(approvalJump).toHaveCount(0)
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('admits the current-page starter once and preserves source handoff as a draft', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled Agent starter and source handoff coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page)
    const messagePath = (request: { method(): string; url(): string }): boolean =>
      request.method() === 'POST' && /\/_api\/agents\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)
    try {
      await authenticateAsAdmin(page)
      await page.goto('/en/home', { waitUntil: 'networkidle' })
      await expect(page.locator('.page-header-section')).toBeVisible()
      await page.locator('.nav-header-agent:visible').first().click()
      const agent = page.getByRole('region', { name: 'Wiki Agent' })
      await expect(agent).toBeVisible()
      const starterPrompt = 'Summarize the current Wiki page and cite the key sections.'
      const starter = agent.locator('.inline-agent__starter').filter({ hasText: 'Understand this page' }).first()
      await expect(starter).toBeVisible()
      const starterRequestPromise = page.waitForRequest(messagePath)
      await starter.click()
      const starterRequest = await starterRequestPromise
      const starterBody = starterRequest.postDataJSON() as {
        content?: unknown
        currentPage?: { id?: unknown; locale?: unknown; path?: unknown; observedUpdatedAt?: unknown }
        knowledgeContext?: { scope?: { kind?: unknown }; sources?: unknown }
      }
      expect(starterBody.content).toBe(starterPrompt)
      expect(starterBody.currentPage).toEqual(
        expect.objectContaining({
          id: expect.any(Number),
          locale: 'en',
          path: 'home',
          observedUpdatedAt: expect.any(String)
        })
      )
      expect(starterBody.knowledgeContext).toEqual(expect.objectContaining({ scope: { kind: 'all' }, sources: [] }))
      await expect(agent.locator('.agent-message--user')).toHaveCount(1)
      await expect(agent.locator('.agent-message--user').first()).toContainText(starterPrompt)
      await expect(agent.locator('.agent-message--assistant').last()).toContainText('The release is ready for a deliberate review.')
      expect(fixture.requests.filter(request => request.includes('/messages'))).toHaveLength(1)

      await agent.getByRole('button', { name: 'Add sources', exact: true }).click()
      const searchDialog = page.getByRole('dialog', { name: 'Wiki search', exact: true })
      await expect(searchDialog).toBeVisible()
      const searchInput = page.locator('.nav-header-search-control:visible input').first()
      await searchInput.fill('visual')
      const visualResult = searchDialog.locator('.search-results-row').filter({ hasText: 'visual-markdown-browser' }).first()
      await expect(visualResult).toBeVisible()
      await visualResult.locator('.search-results-preview').click()
      const sourcePreview = page.locator('.wiki-source-preview__panel')
      await expect(sourcePreview).toBeVisible()
      await sourcePreview.getByRole('button', { name: 'Ask about this page', exact: true }).click()
      await expect(agent).toBeVisible()
      const draft = agent.getByRole('textbox', { name: /^(?:Message|Follow up with) Wiki Agent$/ })
      await expect(draft).toBeEditable()
      await expect(draft).toHaveValue('visual')
      await expect(agent.locator('.agent-context__source-label').filter({ hasText: /Visual Markdown/ })).toBeVisible()
      expect(fixture.requests.filter(request => request.includes('/messages'))).toHaveLength(1)
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('reopens a pinned conversation across pages and creates a fresh session only after unpinning', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Pinned Agent retention coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { mode: 'pin', distinctSessionIds: true })
    const messagePath = (request: { method(): string; url(): string }): boolean =>
      request.method() === 'POST' && /\/_api\/agents\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)
    const sessionPath = (request: { method(): string; url(): string }): boolean =>
      request.method() === 'GET' && /\/_api\/agents\/sessions\/[^/]+$/.test(new URL(request.url()).pathname)
    const createSessionPath = (response: { request(): { method(): string }; url(): string }): boolean =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/_api/agents/sessions'
    try {
      await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')
      await expect(page.locator('.page-header-section')).toBeVisible()
      const firstCreatePromise = page.waitForResponse(createSessionPath)
      await page.locator('.nav-header-agent:visible').first().click()
      const firstCreateResponse = await firstCreatePromise
      expect(firstCreateResponse.status()).toBe(201)
      const firstCreated = (await firstCreateResponse.json()) as { session?: { id?: unknown; retention?: unknown } }
      const sessionA = firstCreated.session?.id
      expect(firstCreated.session?.retention).toBe('saved')
      expect(typeof sessionA).toBe('string')
      if (typeof sessionA !== 'string') throw new Error('The fixture did not return the first created session ID.')
      const agent = page.getByRole('region', { name: 'Wiki Agent' })
      await expect(agent).toBeVisible()
      const pin = agent.locator('.agent-composer__chat-pin')
      const composerInput = agent.getByRole('textbox', { name: /^(?:Message|Follow up with) Wiki Agent$/ })
      await expect(pin).toHaveAttribute('aria-pressed', 'false')
      await pin.click()
      await expect(pin).toHaveAttribute('aria-pressed', 'true')
      await expect(pin).toHaveAttribute('title', 'Unpin chat')

      const promptA = 'Remember the first page context.'
      const messageARequestPromise = page.waitForRequest(messagePath)
      await composerInput.fill(promptA)
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      const messageARequest = await messageARequestPromise
      const bodyA = messageARequest.postDataJSON() as {
        content?: unknown
        currentPage?: { id?: unknown; locale?: unknown; path?: unknown; observedUpdatedAt?: unknown }
      }
      expect(bodyA.content).toBe(promptA)
      expect(bodyA.currentPage).toEqual(expect.objectContaining({ locale: 'en', path: 'visual-markdown-browser' }))
      await expect(agent.locator('.agent-message--assistant').last()).toContainText('The release is ready for a deliberate review.')

      await page.keyboard.press('Escape')
      const firstSearchDialog = page.getByRole('dialog', { name: 'Wiki search', exact: true })
      await expect(firstSearchDialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(firstSearchDialog).toBeHidden()

      await openAuthenticatedPage(page, '/en/home', '.page-header-section')
      await expect(page.locator('.page-header-section')).toBeVisible()
      const reopenAResponsePromise = page.waitForResponse(response => {
        const request = response.request()
        return sessionPath(request) && new URL(response.url()).pathname === `/_api/agents/sessions/${sessionA}`
      })
      const createsBeforeReopen = fixture.requests.filter(request => request === 'POST /_api/agents/sessions').length
      await page.locator('.nav-header-agent:visible').first().click()
      const reopenAResponse = await reopenAResponsePromise
      expect(reopenAResponse.status()).toBe(200)
      const reopenedA = (await reopenAResponse.json()) as { session?: { id?: unknown } }
      expect(reopenedA.session?.id).toBe(sessionA)
      expect(fixture.requests.filter(request => request === 'POST /_api/agents/sessions')).toHaveLength(createsBeforeReopen)
      await expect(agent.getByText('Current page · en/home', { exact: true })).toBeVisible()
      await expect(pin).toHaveAttribute('aria-pressed', 'true')
      await expect(pin).toHaveAttribute('title', 'Unpin chat')

      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.locator('.page-header-section')).toBeVisible()
      const reloadAResponsePromise = page.waitForResponse(response => {
        const request = response.request()
        return sessionPath(request) && new URL(response.url()).pathname === `/_api/agents/sessions/${sessionA}`
      })
      const createsBeforeReload = fixture.requests.filter(request => request === 'POST /_api/agents/sessions').length
      await page.locator('.nav-header-agent:visible').first().click()
      const reloadAResponse = await reloadAResponsePromise
      expect(reloadAResponse.status()).toBe(200)
      const reloadedA = (await reloadAResponse.json()) as { session?: { id?: unknown } }
      expect(reloadedA.session?.id).toBe(sessionA)
      expect(fixture.requests.filter(request => request === 'POST /_api/agents/sessions')).toHaveLength(createsBeforeReload)
      await expect(agent.getByText('Current page · en/home', { exact: true })).toBeVisible()
      await expect(pin).toHaveAttribute('aria-pressed', 'true')
      await expect(pin).toHaveAttribute('title', 'Unpin chat')

      const promptB = 'Remember the newly visited page context.'
      const messageBRequestPromise = page.waitForRequest(messagePath)
      await composerInput.fill(promptB)
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      const messageBRequest = await messageBRequestPromise
      const bodyB = messageBRequest.postDataJSON() as {
        content?: unknown
        currentPage?: { id?: unknown; locale?: unknown; path?: unknown; observedUpdatedAt?: unknown }
      }
      expect(bodyB.content).toBe(promptB)
      expect(bodyB.currentPage).toEqual(expect.objectContaining({ locale: 'en', path: 'home' }))
      expect(bodyA.currentPage).toEqual(expect.objectContaining({ locale: 'en', path: 'visual-markdown-browser' }))
      await expect(agent.locator('.agent-message--user')).toHaveCount(2)
      await expect(agent.locator('.agent-message--user').filter({ hasText: promptA })).toBeVisible()
      await expect(agent.locator('.agent-message--user').filter({ hasText: promptB })).toBeVisible()

      await pin.click()
      await expect(pin).toHaveAttribute('aria-pressed', 'false')
      await page.keyboard.press('Escape')
      const secondSearchDialog = page.getByRole('dialog', { name: 'Wiki search', exact: true })
      await expect(secondSearchDialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(secondSearchDialog).toBeHidden()

      const freshCreateResponsePromise = page.waitForResponse(createSessionPath)
      const createsBeforeFresh = fixture.requests.filter(request => request === 'POST /_api/agents/sessions').length
      await page.locator('.nav-header-agent:visible').first().click()
      const freshCreateResponse = await freshCreateResponsePromise
      expect(freshCreateResponse.status()).toBe(201)
      const freshCreated = (await freshCreateResponse.json()) as { session?: { id?: unknown; retention?: unknown } }
      expect(typeof freshCreated.session?.id).toBe('string')
      expect(freshCreated.session?.id).not.toBe(sessionA)
      expect(freshCreated.session?.retention).toBe('saved')
      expect(fixture.requests.filter(request => request === 'POST /_api/agents/sessions')).toHaveLength(createsBeforeFresh + 1)
      await expect(agent.locator('.agent-message--user')).toHaveCount(0)
      await expect(agent.getByText('Current page · en/home', { exact: true })).toBeVisible()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('creates and moves a conversation folder from the empty drop target', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Agent history folder coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { seedFolders: false })
    try {
      const sessionListResponsePromise = page.waitForResponse(response => {
        const request = response.request()
        return request.method() === 'GET' && new URL(response.url()).pathname === '/_api/agents/sessions'
      })
      const agent = await openFixtureAgentFromSearch(page)
      const sessionListResponse = await sessionListResponsePromise
      expect(sessionListResponse.ok()).toBe(true)
      const sessionListPayload = (await sessionListResponse.json()) as { sessions?: Array<{ id?: unknown; title?: unknown }> }
      const source = sessionListPayload.sessions?.find(session => session.title === 'Release evidence review')
      const sourceId = source?.id
      expect(typeof sourceId, 'The dragged conversation has a server-provided session ID').toBe('string')
      if (typeof sourceId !== 'string') throw new Error('The fixture session summary omitted the dragged conversation ID.')

      await agent.getByRole('button', { name: 'Open agent conversation history' }).click()
      const history = agent.locator('.inline-agent__side--history:visible')
      await expect(history).toBeVisible()
      const emptyFolderTarget = history.locator('.agent-history__empty--folders[data-drop-target="new-folder"]')
      const recentSession = history.locator('.agent-history__recent .agent-history__session').filter({ hasText: 'Release evidence review' }).first()
      await expect(emptyFolderTarget).toBeVisible()
      await expect(recentSession).toBeVisible()
      await recentSession.dragTo(emptyFolderTarget)

      const folderDialog = page.getByRole('dialog', { name: 'New folder', exact: true })
      await expect(folderDialog).toHaveCount(1)
      await expect(folderDialog).toBeVisible()
      await folderDialog.getByRole('textbox', { name: 'Folder name' }).fill('Release archive')
      const folderCreateResponsePromise = page.waitForResponse(response => {
        const request = response.request()
        return request.method() === 'POST' && new URL(response.url()).pathname === '/_api/agents/conversation-folders'
      })
      const sessionMoveResponsePromise = page.waitForResponse(response => {
        const request = response.request()
        return request.method() === 'PUT' && new URL(response.url()).pathname === `/_api/agents/sessions/${sourceId}/folder`
      })
      await folderDialog.getByRole('button', { name: 'Create folder', exact: true }).click()
      const [folderCreateResponse, sessionMoveResponse] = await Promise.all([folderCreateResponsePromise, sessionMoveResponsePromise])
      expect(folderCreateResponse.status(), 'Folder creation succeeds').toBe(201)
      expect(sessionMoveResponse.status(), 'Moving the source conversation succeeds').toBe(200)
      const folderPayload = (await folderCreateResponse.json()) as { folder?: { id?: unknown } }
      const folderId = folderPayload.folder?.id
      expect(typeof folderId, 'Folder creation returns the destination folder ID').toBe('string')
      if (typeof folderId !== 'string') throw new Error('The fixture folder response omitted the destination folder ID.')
      const moveBody = sessionMoveResponse.request().postDataJSON() as { folderId?: unknown; expectedSessionVersion?: unknown }
      expect(moveBody.folderId, 'The move uses the returned destination folder ID').toBe(folderId)
      expect(typeof moveBody.expectedSessionVersion, 'The move carries the source session version').toBe('number')
      expect(new URL(sessionMoveResponse.url()).pathname, 'The move uses the returned source session ID').toBe(`/_api/agents/sessions/${sourceId}/folder`)

      const mutationRequests = fixture.requests.filter(
        request => request === 'POST /_api/agents/conversation-folders' || request === `PUT /_api/agents/sessions/${sourceId}/folder`
      )
      expect(mutationRequests, 'Folder creation commits before moving the source conversation').toEqual([
        'POST /_api/agents/conversation-folders',
        `PUT /_api/agents/sessions/${sourceId}/folder`
      ])

      await expect(folderDialog).toBeHidden()
      const destination = history.locator('.v-expansion-panel').filter({
        has: page.locator('.agent-history__folder-name').filter({ hasText: 'Release archive' })
      })
      await expect(destination).toHaveCount(1)
      await expect(destination).toBeVisible()
      await expect(destination.locator('.agent-history__folder-title')).toHaveAttribute('aria-expanded', 'true')
      const destinationConversations = destination.locator('.agent-history__list--folder[aria-label="Release archive conversations"] .agent-history__session')
      await expect(destinationConversations).toHaveCount(1)
      await expect(destinationConversations.locator('.v-list-item-title')).toHaveText('Release evidence review')
      await expect(history.locator('.agent-history__recent .agent-history__session').filter({ hasText: 'Release evidence review' })).toHaveCount(0)
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('keeps hostile Agent Mermaid local with truthful source fallback', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled Mermaid security coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { mode: 'security' })
    const hostileRequests: string[] = []
    page.on('request', request => {
      if (request.url().startsWith('https://mermaid-hostile.invalid/')) hostileRequests.push(request.url())
    })
    try {
      const agent = await openFixtureAgentFromSearch(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Render the hostile Mermaid theme safely.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      const sourceDisclosure = agent.locator('details.agent-markdown__diagram-source').filter({
        has: page.locator('pre').filter({ hasText: 'mermaid-hostile.invalid' })
      })
      await expect(sourceDisclosure).toHaveCount(1)
      await expect(sourceDisclosure).toBeVisible()
      await expect(sourceDisclosure).not.toHaveAttribute('open', '')
      await expect(sourceDisclosure.locator('summary')).toBeVisible()
      await expect(sourceDisclosure.locator('pre')).toBeHidden()

      const output = agent.locator('.agent-markdown__diagram-output').first()
      await expect(output).toBeVisible()
      await expect(output).not.toHaveAttribute('aria-busy', 'true')
      const fallback = output.getByRole('alert')
      if (await fallback.count()) {
        await expect(fallback).toHaveText('Diagram could not be rendered safely. Mermaid source remains available below.')
      } else {
        await expect(output.getByRole('img', { name: 'Mermaid diagram', exact: true })).toBeVisible()
      }
      expect(hostileRequests).toEqual([])

      await sourceDisclosure.locator('summary').click()
      await expect(sourceDisclosure).toHaveAttribute('open', '')
      await expect(sourceDisclosure.locator('pre')).toBeVisible()
      await expect(sourceDisclosure.locator('pre')).toContainText('mermaid-hostile.invalid')
      expect(hostileRequests).toEqual([])
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })

  test('caps mixed Agent Mermaid roots while preserving excess source', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled Mermaid cap coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { mode: 'cap' })
    try {
      const agent = await openFixtureAgentFromSearch(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Render the complete Mermaid review set.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByRole('img', { name: 'Mermaid diagram', exact: true })).toHaveCount(8)
      await expect(agent.getByText('Mermaid source', { exact: true })).toHaveCount(9)
      await expect(
        agent.getByText(/Additional diagrams remain available as source because only 8 diagrams are rendered automatically per message\./)
      ).toBeVisible()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('shares one eight-diagram allowance across reader Mermaid host kinds', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Reader Mermaid root coverage is owned by Chromium desktop.')
    await authenticateAsAdmin(page)
    const path = `mermaid-reader-cap-${Date.now()}`
    const legacyBlocks = Array.from(
      { length: 5 },
      (_, index) => `<div class="mermaid">graph TD; L${index}[Legacy ${index + 1}] --> M${index}[Ready]</div>`
    ).join('\n\n')
    const extensionFences = Array.from({ length: 5 }, (_, index) =>
      [
        '```wiki-extension',
        JSON.stringify({
          key: 'diagram',
          version: 1,
          props: {
            source: `graph TD\n  E${index}[Extension ${index + 1}] --> F${index}[Ready]`,
            caption: `Extension Mermaid ${index + 1}`,
            theme: 'default',
            align: 'center'
          }
        }),
        '```'
      ].join('\n')
    ).join('\n\n')
    const content = `# Mixed Mermaid reader\n\n${legacyBlocks}\n\n${extensionFences}\n`
    let pageId: number | undefined
    let sourceRevision: string | undefined
    try {
      const created = await page.request.post('/_api/pages', {
        headers: { ...sameOriginHeaders(), Accept: 'application/json' },
        data: {
          content,
          description: 'Reader Mermaid cap fixture',
          editor: 'markdown',
          visibility: 'public',
          isPublished: true,
          locale: 'en',
          path,
          publishEndDate: '',
          publishStartDate: '',
          scriptCss: '',
          scriptJs: '',
          tags: [],
          title: 'Mixed Mermaid reader'
        }
      })
      expect(created.ok(), `Reader Mermaid fixture creation returned HTTP ${created.status()}`).toBe(true)
      const payload = (await created.json()) as { page?: { id?: number; sourceRevision?: string } }
      pageId = payload.page?.id
      sourceRevision = payload.page?.sourceRevision
      expect(pageId).toEqual(expect.any(Number))
      expect(sourceRevision).toEqual(expect.any(String))
      if (pageId === undefined || sourceRevision === undefined) throw new Error('Reader Mermaid fixture response omitted page identity.')

      await openAuthenticatedPage(page, `/en/${path}`, '.page-header-section')
      const reader = page.locator('article.contents')
      await expect(reader).toBeVisible()
      const legacyHosts = reader.locator('.mermaid')
      const extensionHosts = reader.locator('.content-extension--diagram')
      await expect(legacyHosts).toHaveCount(5)
      await expect(extensionHosts).toHaveCount(5)
      await expect(reader.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 })
      await expect(reader.locator('.mermaid svg')).toHaveCount(5)
      await expect(reader.locator('.content-extension--diagram svg')).toHaveCount(3)
      await expect(reader.locator('.mermaid svg, .content-extension--diagram svg')).toHaveCount(8)
      const renderOrder = await reader.locator('.mermaid, .content-extension--diagram').evaluateAll(hosts =>
        hosts.map(host => ({
          kind: host.classList.contains('mermaid') ? 'legacy' : 'extension',
          rendered: host.querySelector('svg') !== null
        }))
      )
      expect(renderOrder).toEqual([
        ...Array.from({ length: 5 }, () => ({ kind: 'legacy', rendered: true })),
        ...Array.from({ length: 3 }, () => ({ kind: 'extension', rendered: true })),
        ...Array.from({ length: 2 }, () => ({ kind: 'extension', rendered: false }))
      ])
      await expect(reader.locator('.content-extension--diagram .content-extension-diagram__source code')).toHaveCount(2)
      await expect(reader.locator('.content-extension--diagram .content-extension-diagram__source code').nth(0)).toContainText('Extension 4')
      await expect(reader.locator('.content-extension--diagram .content-extension-diagram__source code').nth(1)).toContainText('Extension 5')
      await expect(reader.getByText('Additional diagrams remain available as source because automatic rendering is limited.', { exact: true })).toBeVisible()
    } finally {
      if (pageId !== undefined && sourceRevision !== undefined) {
        const removal = await page.request.delete(`/_api/pages/${pageId}`, {
          headers: sameOriginHeaders(),
          data: { expectedSourceRevision: sourceRevision }
        })
        expect(removal.ok(), `Reader Mermaid fixture removal returned HTTP ${removal.status()}`).toBe(true)
      }
    }
  })

  test('keeps enabled Agent panels modal, docked, and wide with nested focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled Agent panel geometry is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page)
    const agent = await openFixtureAgentFromSearch(page)
    const widths: readonly [number, 'modal' | 'docked' | 'wide'][] = [
      [320, 'modal'],
      [390, 'modal'],
      [430, 'modal'],
      [639, 'modal'],
      [640, 'modal'],
      [1023, 'modal'],
      [1024, 'docked'],
      [1759, 'docked'],
      [1760, 'wide']
    ]
    for (const [width, expectedMode] of widths) {
      await page.setViewportSize({ width, height: 420 })
      await expect(agent).toHaveAttribute('data-panel-mode', expectedMode)
      await expectResponsiveLayout(page, `enabled Agent at ${width}px`)
      const directHistory = agent.getByRole('button', { name: /open agent conversation history/i })
      const panels = agent.getByRole('button', { name: /open Agent panels: conversation history and memory/i })
      const trigger = (await panels.isVisible()) ? panels : directHistory
      await trigger.click()
      if (trigger === panels) await page.getByText('Conversation history', { exact: true }).click()
      const panel =
        expectedMode === 'modal' ? agent.getByRole('dialog', { name: 'Conversations' }) : agent.getByRole('complementary', { name: 'Conversations' })
      await expect(panel).toBeVisible()
      const bounds = await panel.boundingBox()
      expect(bounds).not.toBeNull()
      if (bounds) {
        expect(bounds.x).toBeGreaterThanOrEqual(-1)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
        expect(bounds.y).toBeGreaterThanOrEqual(-1)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(421)
      }
      if (expectedMode === 'modal') {
        await page.keyboard.press('Tab')
        await expect.poll(() => panel.evaluate(root => root.contains(document.activeElement))).toBe(true)
        await page.keyboard.press('Shift+Tab')
        await expect.poll(() => panel.evaluate(root => root.contains(document.activeElement))).toBe(true)
        await page.keyboard.press('Escape')
      } else {
        await panel.getByRole('button', { name: 'Close chat history' }).click()
      }
      await expect(panel).toBeHidden()
    }

    await page.setViewportSize({ width: 640, height: 420 })
    const panels = agent.getByRole('button', { name: /open Agent panels: conversation history and memory/i })
    const selectFromPanelsMenu = async (title: string, activation: 'pointer' | 'keyboard'): Promise<void> => {
      if (activation === 'pointer') {
        await panels.click()
      } else {
        await panels.focus()
        await panels.press('Enter')
      }
      const panelMenu = page.locator('.v-overlay--active').filter({ hasText: title }).first()
      const menuItem = panelMenu.getByRole('listitem').filter({ hasText: title })
      await expect(menuItem).toHaveCount(1)
      if (activation === 'pointer') {
        await menuItem.click()
      } else {
        await menuItem.focus()
        await menuItem.press('Enter')
      }
      await expect(panels).toHaveAttribute('aria-expanded', 'false')
      await expect(panelMenu).toBeHidden()
    }

    await selectFromPanelsMenu('Conversation history', 'pointer')
    const historyPanel = agent.getByRole('dialog', { name: 'Conversations' })
    await expect(historyPanel).toBeVisible()
    await expect.poll(() => historyPanel.evaluate(root => root.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(historyPanel).toBeHidden()
    await expect(panels).toBeFocused()

    await selectFromPanelsMenu('Agent memory', 'keyboard')
    const memoryPanel = agent.getByRole('dialog', { name: 'Agent memory' })
    await expect(memoryPanel).toBeVisible()
    await expect.poll(() => memoryPanel.evaluate(root => root.contains(document.activeElement))).toBe(true)
    await memoryPanel.getByRole('button', { name: /Remove memory:/i }).click()
    const removeDialog = page.getByRole('dialog').filter({ hasText: 'Remove this memory?' })
    await expect(removeDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(removeDialog).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(memoryPanel).toBeHidden()
    await expect(panels).toBeFocused()
    fixture.assertNoUnexpectedRequests()
    await fixture.dispose()
  })

  test('surfaces a partial archive failure with a focused retry', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled archive failure coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { archivePartialFailure: true })
    const agent = await openFixtureAgentFromSearch(page)
    await agent.getByRole('button', { name: /open agent conversation history/i }).click()
    const history = agent.getByRole('complementary', { name: 'Conversations' })
    await expect(history).toBeVisible()
    await expect(history.getByText('Recent', { exact: true })).toBeVisible()
    await expect(history).toContainText('Fixture archive folder failure')
    const sessionsBeforeRetry = fixture.requests.filter(request => request === 'GET /_api/agents/sessions').length
    const foldersBeforeRetry = fixture.requests.filter(request => request === 'GET /_api/agents/conversation-folders').length
    await history.getByRole('button', { name: 'Retry folders' }).click()
    await expect(history.getByText('Release reviews', { exact: true })).toBeVisible()
    expect(fixture.requests.filter(request => request === 'GET /_api/agents/sessions').length, 'retrying folders must not refetch conversations').toBe(
      sessionsBeforeRetry
    )
    expect(
      fixture.requests.filter(request => request === 'GET /_api/agents/conversation-folders').length,
      'retrying folders must issue one folder request'
    ).toBe(foldersBeforeRetry + 1)
    fixture.assertNoUnexpectedRequests()
    await fixture.dispose()
  })

  test('keeps login and not-found surfaces responsive', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' })
    const loginForm = page.locator('form.login-form').first()
    await expect(loginForm).toBeVisible()
    await expectLocatorWithinViewport(loginForm, 'Login form')
    await expectResponsiveLayout(page, '/login')

    await page.goto('/en/responsive-quality-control-not-found', { waitUntil: 'networkidle' })
    const notFound = page.locator('.notfound-content')
    await expect(notFound).toBeVisible()
    await expectLocatorWithinViewport(notFound, 'Not-found content')
    await expectResponsiveLayout(page, 'Not-found page')
  })

  test('sizes the authored H1 swoosh to its text block while preserving heading hierarchy', async ({ page }) => {
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const decorations = await page.evaluate(() => {
      const article = document.querySelector<HTMLElement>('article.contents')
      const heroTitle = document.querySelector('.page-header-section .page-title')
      const authoredH1 = article?.querySelector('h1') ?? null
      const authoredH2 = article?.querySelector('h2') ?? null
      const authoredH3 = article?.querySelector('h3') ?? null
      const authoredH4 = article?.querySelector('h4') ?? null
      const authoredH5 = article?.querySelector('h5') ?? null
      const authoredH6 = article?.querySelector('h6') ?? null

      const getPseudo = (el: Element | null, pseudo: string) => {
        if (!el) return null
        const cs = window.getComputedStyle(el, pseudo)
        return {
          content: cs.content,
          height: parseFloat(cs.height) || parseFloat(cs.getPropertyValue('block-size')) || 0,
          width: parseFloat(cs.width) || parseFloat(cs.getPropertyValue('inline-size')) || 0,
          display: cs.display,
          transform: cs.transform
        }
      }

      const getBorder = (el: Element | null) => {
        if (!el) return null
        const cs = window.getComputedStyle(el)
        return {
          borderBottomWidth: parseFloat(cs.borderBottomWidth) || parseFloat(cs.getPropertyValue('border-block-end-width')) || 0
        }
      }

      const measureSyntheticH1 = (text: string, dir: 'ltr' | 'rtl' = 'ltr') => {
        if (!article) return null
        const heading = document.createElement('h1')
        heading.dir = dir
        heading.textContent = text
        article.append(heading)
        const bounds = heading.getBoundingClientRect()
        const pseudo = getPseudo(heading, '::after')
        heading.remove()
        return { width: bounds.width, pseudoWidth: pseudo?.width ?? 0, transform: pseudo?.transform ?? 'none' }
      }

      const h1Bounds = authoredH1?.getBoundingClientRect() ?? null
      const articleBounds = article?.getBoundingClientRect() ?? null
      const h1AnchorBounds = authoredH1?.querySelector('.toc-anchor')?.getBoundingClientRect() ?? null
      const footnoteTarget = document.createElement('li')
      footnoteTarget.className = 'footnote-item'
      article?.append(footnoteTarget)
      const footnoteScrollMargin = parseFloat(window.getComputedStyle(footnoteTarget).scrollMarginBlockStart) || 0
      footnoteTarget.remove()

      return {
        hasAuthoredH1: Boolean(authoredH1),
        heroAfter: getPseudo(heroTitle, '::after'),
        h1After: getPseudo(authoredH1, '::after'),
        h1Width: h1Bounds?.width ?? 0,
        h1AnchorContained: !h1AnchorBounds || !articleBounds || (h1AnchorBounds.left >= articleBounds.left && h1AnchorBounds.right <= articleBounds.right),
        shortH1: measureSyntheticH1('FAQ'),
        longH1: measureSyntheticH1('Comprehensive Technical Documentation and Guidelines'),
        rtlH1: measureSyntheticH1('الأسئلة الشائعة', 'rtl'),
        footnoteScrollMargin,
        h2After: getPseudo(authoredH2, '::after'),
        h2Border: getBorder(authoredH2),
        h3After: getPseudo(authoredH3, '::after'),
        h3Border: getBorder(authoredH3),
        h4After: getPseudo(authoredH4, '::after'),
        h4Border: getBorder(authoredH4),
        h5After: getPseudo(authoredH5, '::after'),
        h5Border: getBorder(authoredH5),
        h6After: getPseudo(authoredH6, '::after'),
        h6Border: getBorder(authoredH6)
      }
    })

    expect(decorations.hasAuthoredH1, 'Authored H1 must exist in article.contents').toBe(true)
    expect(decorations.h1After, 'Authored H1 ::after must exist').not.toBeNull()
    expect(decorations.h1After?.display, 'Authored H1 swoosh must render').not.toBe('none')
    expect(decorations.h1After?.height, 'Authored H1 swoosh has ~3.5px block size').toBeGreaterThanOrEqual(3)
    expect(decorations.h1After?.height, 'Authored H1 swoosh has ~3.5px block size').toBeLessThanOrEqual(4)
    expect(Math.abs((decorations.h1After?.width ?? 0) - decorations.h1Width), 'Swoosh matches authored H1 text-block width').toBeLessThanOrEqual(1)
    expect(decorations.shortH1, 'Synthetic short H1 must be measurable').not.toBeNull()
    expect(decorations.longH1, 'Synthetic long H1 must be measurable').not.toBeNull()
    expect(Math.abs((decorations.shortH1?.pseudoWidth ?? 0) - (decorations.shortH1?.width ?? 0)), 'Short H1 swoosh matches its text block').toBeLessThanOrEqual(
      1
    )
    expect(Math.abs((decorations.longH1?.pseudoWidth ?? 0) - (decorations.longH1?.width ?? 0)), 'Long H1 swoosh matches its text block').toBeLessThanOrEqual(1)
    expect(decorations.longH1?.width ?? 0, 'Long H1 swoosh grows beyond short H1 swoosh').toBeGreaterThan((decorations.shortH1?.width ?? 0) + 100)
    expect(decorations.rtlH1?.transform ?? 'none', 'RTL H1 mirrors the swoosh').toMatch(/^matrix\(-1,\s*0,\s*0,\s*1,/)
    expect(decorations.footnoteScrollMargin, 'Footnote target clears fixed page chrome').toBeGreaterThanOrEqual(64)
    expect(decorations.h1AnchorContained, 'H1 permalink remains inside the article').toBe(true)

    expect(decorations.heroAfter?.content ?? 'none', 'Hero title must not have pseudo-element decoration').toMatch(/^(?:none|normal)$/)

    expect(decorations.h2After?.display ?? 'none', 'H2 must not have swoosh ::after').toBe('none')
    expect(decorations.h2Border?.borderBottomWidth ?? 0, 'H2 has positive bottom border').toBeGreaterThan(0)

    const lowerHeadings = [
      { level: 'H3', pseudo: decorations.h3After, border: decorations.h3Border },
      { level: 'H4', pseudo: decorations.h4After, border: decorations.h4Border },
      { level: 'H5', pseudo: decorations.h5After, border: decorations.h5Border },
      { level: 'H6', pseudo: decorations.h6After, border: decorations.h6Border }
    ]
    for (const { level, pseudo, border } of lowerHeadings) {
      expect(pseudo?.display ?? 'none', `${level} must not have swoosh ::after`).toBe('none')
      expect(border?.borderBottomWidth ?? 0, `${level} has no bottom border`).toBe(0)
    }
  })

  test('opens native disclosures only for printing and restores their state', async ({ page }) => {
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const states = await page.evaluate(() => {
      const article = document.querySelector<HTMLElement>('article.contents')
      if (!article) return null

      const closed = document.createElement('details')
      closed.innerHTML = '<summary>Closed disclosure</summary><p>Printable content</p>'
      const nested = document.createElement('details')
      nested.open = true
      nested.innerHTML = '<summary>Nested disclosure</summary><p>Nested printable content</p>'
      closed.append(nested)
      const opened = document.createElement('details')
      opened.open = true
      opened.innerHTML = '<summary>Open disclosure</summary><p>Printable content</p>'
      article.append(closed, opened)

      window.dispatchEvent(new Event('beforeprint'))
      const duringPrint = { closed: closed.open, nested: nested.open, opened: opened.open }
      window.dispatchEvent(new Event('afterprint'))
      const afterPrint = { closed: closed.open, nested: nested.open, opened: opened.open }
      closed.remove()
      opened.remove()
      return { duringPrint, afterPrint }
    })

    expect(states?.duringPrint).toEqual({ closed: true, nested: true, opened: true })
    expect(states?.afterPrint).toEqual({ closed: false, nested: true, opened: true })
  })

  test('prevents horizontal document overflow at 320px mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 })
    for (const path of ['/en/visual-markdown-browser', '/en/home']) {
      await openAuthenticatedPage(page, path, '.page-header-section')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `${path} document has no horizontal overflow at 320px`).toBeLessThanOrEqual(1)
    }
  })

  test('ensures wrapped published tables and raw preview tables have exactly one scroll owner', async ({ page }) => {
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')

    const tableEvaluation = await page.evaluate(() => {
      const contents = document.querySelector('.contents')
      if (!contents) throw new Error('Missing .contents container')

      const createWideTable = () => {
        const table = document.createElement('table')
        const headers = Array.from({ length: 16 }, (_, i) => `<th style="min-width: 120px;">Header Column ${i}</th>`).join('')
        const cells = Array.from({ length: 16 }, (_, i) => `<td>Cell Data Content ${i}</td>`).join('')
        table.innerHTML = `<thead><tr>${headers}</tr></thead><tbody><tr>${cells}</tr></tbody>`
        return table
      }

      // 1. Real wrapped fixtures for every supported published wrapper: .table-container, figure.table, .tableWrapper
      const wrapperConfigs = [
        { tag: 'div', className: 'table-container', name: '.table-container' },
        { tag: 'figure', className: 'table', name: 'figure.table' },
        { tag: 'div', className: 'tableWrapper', name: '.tableWrapper' }
      ]

      const wrappedHosts: HTMLElement[] = []
      const wrappedResults = []

      for (const config of wrapperConfigs) {
        const wrapper = document.createElement(config.tag)
        wrapper.className = config.className
        const table = createWideTable()
        wrapper.appendChild(table)
        contents.appendChild(wrapper)
        wrappedHosts.push(wrapper)

        const wrapperStyle = window.getComputedStyle(wrapper)
        const tableStyle = window.getComputedStyle(table)

        // Wrapper owns overflow
        const wrapperHasScroller = /auto|scroll/.test(wrapperStyle.overflowX) && wrapper.scrollWidth > wrapper.clientWidth
        // Descendant table is not a second scroller
        const tableIsSecondScroller = /auto|scroll/.test(tableStyle.overflowX) && table.scrollWidth > table.clientWidth + 1

        // Verify table itself is not scrollable
        table.scrollLeft = 50
        const tableScrollable = table.scrollLeft > 0

        // Reachability: scroll wrapper to end and check last column is reached
        const maxScroll = wrapper.scrollWidth - wrapper.clientWidth
        wrapper.scrollLeft = maxScroll
        const reachedEnd = wrapper.scrollLeft > 0 && Math.abs(wrapper.scrollLeft - maxScroll) <= 2

        wrappedResults.push({
          name: config.name,
          wrapperOverflowX: wrapperStyle.overflowX,
          tableOverflowX: tableStyle.overflowX,
          wrapperHasScroller,
          tableIsSecondScroller,
          tableScrollable,
          lastColumnReachable: reachedEnd
        })
      }

      // Clean up wrapped fixtures
      for (const host of wrappedHosts) {
        host.remove()
      }

      // 2. Separate check for unwrapped raw preview table fallback behavior
      const rawHost = document.createElement('div')
      rawHost.className = 'test-raw-table-host'
      const rawTable = createWideTable()
      rawTable.className = 'test-raw-table'
      rawHost.appendChild(rawTable)
      contents.appendChild(rawHost)

      const rawTableStyle = window.getComputedStyle(rawTable)
      const hostStyle = window.getComputedStyle(rawHost)
      const rawTableScrollable = /auto|scroll/.test(rawTableStyle.overflowX) && rawTable.scrollWidth > rawTable.clientWidth
      const hostScrollable = /auto|scroll/.test(hostStyle.overflowX) && rawHost.scrollWidth > rawHost.clientWidth

      // Verify raw table local scroll reachability
      const maxRawScroll = rawTable.scrollWidth - rawTable.clientWidth
      rawTable.scrollLeft = maxRawScroll
      const rawReachable = rawTable.scrollLeft > 0 && Math.abs(rawTable.scrollLeft - maxRawScroll) <= 2

      // CRITICAL: Measure document overflow WHILE rawHost and rawTable are still attached!
      const documentOverflowWithRawTable = document.documentElement.scrollWidth - document.documentElement.clientWidth

      // Clean up raw table host afterward
      rawHost.remove()

      return {
        wrappedResults,
        rawResult: {
          rawTableScrollable,
          hostScrollable,
          reachable: rawReachable,
          rawOverflowX: rawTableStyle.overflowX,
          documentOverflow: documentOverflowWithRawTable
        },
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      }
    })

    // Assert that test cannot pass with zero wrappers
    expect(tableEvaluation.wrappedResults.length, 'Must evaluate all supported published table wrappers').toBeGreaterThanOrEqual(3)

    // Published wrapped table has wrapper as sole scroll owner, descendant table not scrollable, last column reachable
    for (const res of tableEvaluation.wrappedResults) {
      expect(res.wrapperHasScroller, `Published wrapper ${res.name} must own horizontal overflow`).toBe(true)
      expect(res.tableIsSecondScroller, `Table inside ${res.name} must not be a second scroll container`).toBe(false)
      expect(res.tableScrollable, `Table inside ${res.name} must not own scrolling`).toBe(false)
      expect(res.lastColumnReachable, `Last column in ${res.name} must be reachable via wrapper scroll`).toBe(true)
    }

    // Unwrapped raw table scrolls locally without creating outer document overflow
    expect(tableEvaluation.rawResult).not.toBeNull()
    if (tableEvaluation.rawResult) {
      expect(tableEvaluation.rawResult.rawTableScrollable, 'Raw table must own horizontal overflow locally').toBe(true)
      expect(tableEvaluation.rawResult.hostScrollable, 'Parent container must not duplicate scroll ownership').toBe(false)
      expect(tableEvaluation.rawResult.reachable, 'Wide raw table content is reachable via local scrolling').toBe(true)
      expect(tableEvaluation.rawResult.documentOverflow, 'Attached wide raw table does not cause horizontal document overflow').toBeLessThanOrEqual(1)
    }

    expect(tableEvaluation.documentOverflow, 'Page document has no horizontal overflow from tables').toBeLessThanOrEqual(1)
  })
})

test.describe('reader metadata rendering', () => {
  test.use({ locale: 'en-US', timezoneId: 'UTC' })
  test('renders deterministic dates and literal authors on initial and SPA reader loads', async ({ page }) => {
    test.setTimeout(60_000)
    const updatedAt = '2000-02-03T12:00:00.000Z'
    const expectedDateText = 'Updated 02/03/2000'
    const expectedDateTitle = 'Thursday, February 3, 2000 12:00 PM'
    const authorName = '<strong data-e2e-author-markup="true">Ada</strong> & "quoted"'
    const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
    const fixturePayload = {
      version: 1,
      spaNavigation: true,
      props: {
        pageId: 9001,
        locale: 'en',
        path: 'reader-metadata-fixture',
        title: 'Reader metadata fixture',
        description: 'A deterministic reader metadata fixture.',
        createdAt: updatedAt,
        updatedAt,
        sourceRevision: 'reader-metadata-fixture',
        tags: [],
        authorName,
        authorId: 42,
        editor: 'markdown',
        isPublished: true,
        visibility: 'public',
        toc: encoded([]),
        sidebar: encoded([]),
        navMode: 'NONE',
        navExpandParent: true,
        commentsEnabled: false,
        effectivePermissions: encoded({
          comments: { read: false, write: false, manage: false },
          history: { read: true },
          source: { read: false },
          pages: { write: false, manage: false, delete: false, script: false, style: false },
          system: { manage: false }
        }),
        commentsExternal: false,
        editShortcuts: encoded({
          editFab: false,
          editMenuBar: false,
          editMenuBtn: false,
          editMenuExternalBtn: false,
          editMenuExternalName: '',
          editMenuExternalIcon: '',
          editMenuExternalUrl: ''
        }),
        filename: 'en/reader-metadata-fixture.md',
        branding: null
      }
    }

    await page.route('**/*', async route => {
      const request = route.request()
      const isDocumentNavigation = request.resourceType() === 'document' && request.isNavigationRequest()
      const isSpaNavigation = request.method() === 'GET' && request.headers()['x-wiki-navigation'] === '1'
      if (!isDocumentNavigation && !isSpaNavigation) {
        await route.continue()
        return
      }

      const response = await route.fetch()
      const document = await response.text()
      const payloadAttribute = /(<wiki-page\b[^>]*\bpayload=)(["'])([^"']+)\2/u
      const match = payloadAttribute.exec(document)
      if (!match) {
        await route.fulfill({ response, body: document })
        return
      }

      const fixture = Buffer.from(JSON.stringify(fixturePayload), 'utf8').toString('base64')
      const patchedDocument = document.slice(0, match.index) + `${match[1]}${match[2]}${fixture}${match[2]}` + document.slice(match.index + match[0].length)
      await route.fulfill({ response, body: patchedDocument })
    })

    const expectReaderMetadata = async (): Promise<void> => {
      const date = page.locator('.page-document-row--date time')
      await expect(date).toHaveText(new RegExp(`^${expectedDateText}$`))
      await expect(date).toHaveAttribute('datetime', updatedAt)
      await expect(date).toHaveAttribute('title', expectedDateTitle)

      const author = page.locator('bdi.page-provenance-author')
      await expect(author).toHaveText(new RegExp(`^${authorName}$`))
      await expect(author.locator('*')).toHaveCount(0)
    }

    await page.goto('/home', { waitUntil: 'networkidle' })
    await page.locator('.page-header-section').waitFor({ state: 'visible', timeout: 15_000 })
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expectReaderMetadata()

    const logo = page.locator('.nav-header-logo:visible').first()
    await expect(logo).toBeVisible()
    const logoHref = await logo.getAttribute('href')
    expect(logoHref).not.toBeNull()
    if (!logoHref) throw new Error('Reader home logo does not expose a destination.')
    const currentUrl = new URL(page.url())
    const destination = new URL(logoHref, currentUrl)
    expect(destination.pathname).not.toBe(currentUrl.pathname)

    const spaNavigationResponse = page.waitForResponse(response => {
      const request = response.request()
      return (
        request.method() === 'GET' &&
        request.headers()['x-wiki-navigation'] === '1' &&
        response.url() === destination.href &&
        response.headers()['x-wiki-page'] === '1' &&
        response.ok()
      )
    })
    const navigationEvent = page.evaluate(
      () =>
        new Promise<string>(resolve => {
          window.addEventListener(
            'wiki:navigation',
            event => {
              const detail = (event as CustomEvent<{ url?: unknown }>).detail
              resolve(typeof detail?.url === 'string' ? detail.url : '')
            },
            { once: true }
          )
        })
    )
    await logo.click()
    const navigationResponse = await spaNavigationResponse
    await navigationResponse.finished()
    const navigationUrl = await navigationEvent
    expect(navigationUrl).toBe(destination.href)
    await expect(page).toHaveURL(destination.href)
    await expectReaderMetadata()
  })
})

test.describe('focused reading', () => {
  test('keeps the document and search reachable while returning keyboard focus to the reader control', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('.page-header-section').waitFor({ state: 'visible', timeout: 15_000 })
    const focus = page.getByRole('button', { name: 'Focus reading', exact: true })
    await expect(focus).toBeVisible()
    await focus.focus()
    await page.keyboard.press('Enter')
    const dock = page.getByRole('region', { name: 'Focus reading', exact: true })
    const exit = dock.getByRole('button', { name: 'Exit focus', exact: true })
    await expect(exit).toBeFocused()
    await expect(page.locator('.page-navigation.v-navigation-drawer--active')).toHaveCount(0)
    await expect(page.locator('.page-toc-card')).toBeHidden()
    await expectLocatorWithinViewport(dock, 'Focused reading controls')
    await expectResponsiveLayout(page, 'Focused reading')
    await openSearch(page)
    await expect(page.getByRole('dialog', { name: 'Wiki search', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await exit.click()
    await expect(dock).toHaveCount(0)
    await expect(focus).toBeFocused()
    if ((page.viewportSize()?.width ?? 0) >= 1280) await expectLocatorWithinViewport(page.locator('.page-navigation'), 'Restored navigation')
    await expectResponsiveLayout(page, 'Restored reader')
  })

  test('preserves the visible passage when leaving focus mode', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('.page-header-section').waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: 'Focus reading', exact: true }).click()
    const headings = page.locator('article.contents h2:not(details h2):visible')
    test.skip((await headings.count()) < 2, 'This document has fewer than two visible sections')
    const passage = headings.nth(1)
    await passage.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 120))
    await expect.poll(async () => Math.abs(((await passage.boundingBox())?.y ?? 0) - 120)).toBeLessThan(2)
    await page.locator('.page-reading-dock').getByRole('button', { name: 'Exit focus', exact: true }).click()
    await expect.poll(async () => Math.abs(((await passage.boundingBox())?.y ?? 0) - 120)).toBeLessThan(2)
    await expect(page.getByRole('button', { name: 'Focus reading', exact: true })).toBeFocused()
  })

  test('keeps page position within bounds and excludes reader controls from print', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('.page-header-section').waitFor({ state: 'visible', timeout: 15_000 })
    const progress = page.getByRole('progressbar', { name: 'Page position', exact: true })
    await expect(progress).toBeAttached()
    const initial = Number(await progress.getAttribute('aria-valuenow'))
    expect(initial).toBeGreaterThanOrEqual(0)
    expect(initial).toBeLessThanOrEqual(100)
    await page.getByRole('button', { name: 'Focus reading', exact: true }).click()
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect(progress).toHaveAttribute('aria-valuenow', '100')
    await expectLocatorWithinViewport(page.locator('.page-reading-dock'), 'Exit focus at the end of the document')
    await page.emulateMedia({ media: 'print' })
    await expect(progress).toBeHidden()
    await expect(page.locator('.page-reading-dock')).toBeHidden()
    await expect(page.locator('.page-focus-control')).toBeHidden()
    await expect(page.locator('article.contents')).toBeVisible()
  })
})
