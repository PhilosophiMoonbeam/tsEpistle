import { expect } from '@playwright/test'
import {
  authenticateAsAdmin,
  expectLocatorWithinViewport,
  expectResponsiveLayout,
  openAuthenticatedPage,
  openSearch,
  responsiveTest as test
} from './helpers.ts'

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
          const [heroBounds, titleBounds, shortcutBounds, tocBounds] = await Promise.all([
            hero.boundingBox(),
            title.boundingBox(),
            shortcutCard.boundingBox(),
            tocCard.boundingBox()
          ])
          expect(heroBounds).not.toBeNull()
          expect(titleBounds).not.toBeNull()
          expect(shortcutBounds).not.toBeNull()
          expect(tocBounds).not.toBeNull()
          if (heroBounds && titleBounds && shortcutBounds && tocBounds) {
            expect(shortcutBounds.y, 'Reader shortcuts begin inside the title gradient').toBeGreaterThanOrEqual(heroBounds.y)
            expect(shortcutBounds.y, 'Reader shortcuts begin before the title gradient ends').toBeLessThan(heroBounds.y + heroBounds.height)
            expect(Math.abs(shortcutBounds.y - titleBounds.y), 'Reader shortcuts align with the title row').toBeLessThanOrEqual(4)
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
    expect(metadataBounds.width, 'Reader metadata rail is at least 18rem').toBeGreaterThanOrEqual(18 * shellSizing.rootFontSize - 1)
    expect(metadataBounds.width, 'Reader metadata rail stays within 21rem').toBeLessThanOrEqual(21 * shellSizing.rootFontSize + 1)
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
      const rootFontSize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
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
      expect(Math.abs(headerBounds.width - bodyBounds.width)).toBeLessThanOrEqual(2)
      expect(railBounds.width, 'Right metadata rail is at least 18rem').toBeGreaterThanOrEqual(18 * rootFontSize - 1)
      expect(railBounds.width, 'Right metadata rail stays within 21rem').toBeLessThanOrEqual(21 * rootFontSize + 1)
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
    await openSearch(page)
    await expect(page.locator('.search-results-agent-entry')).toBeVisible()
    await page.locator('.search-results-agent-entry').click()

    const agent = page.getByRole('region', { name: 'Wiki Agent' })
    await expect(agent).toBeVisible()
    await expect(page.getByText(/Agent inference is currently disabled/)).toBeVisible()
    await expect(agent.getByRole('textbox', { name: 'Message Wiki Agent' })).toBeVisible()
    const historyButton = agent.getByRole('button', { name: 'Open agent conversation history' })
    const mobilePanelButton = agent.getByRole('button', { name: 'Open Agent panels: conversation history and memory' })
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return
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

    if (viewport.width >= 1760) {
      await page.locator('.search-results--ask').evaluate(async element => {
        await Promise.all(element.getAnimations().map(animation => animation.finished))
      })
      const initialCard = await card.boundingBox()
      expect(initialCard).not.toBeNull()

      await openHistory()
      const historyPanel = agent.getByRole('complementary', { name: 'Chat history panel' })
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
      const memoryPanel = agent.getByRole('complementary', { name: 'Agent memory panel' })
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
      const historyPanel = agent.getByRole('complementary', { name: 'Chat history panel' })
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
      const historyDialog = agent.getByRole('dialog', { name: 'Chat history panel' })
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
        h1AnchorContained: !h1AnchorBounds || !articleBounds || (
          h1AnchorBounds.left >= articleBounds.left &&
          h1AnchorBounds.right <= articleBounds.right
        ),
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
    expect(Math.abs((decorations.shortH1?.pseudoWidth ?? 0) - (decorations.shortH1?.width ?? 0)), 'Short H1 swoosh matches its text block').toBeLessThanOrEqual(1)
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
