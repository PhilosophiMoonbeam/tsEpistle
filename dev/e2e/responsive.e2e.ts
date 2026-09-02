import { expect } from '@playwright/test'
import { expectLocatorWithinViewport, expectResponsiveLayout, openAuthenticatedPage, openSearch, responsiveTest as test } from './helpers.ts'

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

      const tocCard = page.locator('.page-toc-card').first()
      if (await tocCard.count()) {
        await expect(tocCard).toBeVisible()
        const headingLinks = tocCard.locator('.page-toc-item')
        for (const headingLink of await headingLinks.all()) {
          await expect(headingLink).toHaveAttribute('href', /^#[^#].*$/)
        }

        if (viewport.width >= 1280) {
          const hero = page.locator('.page-hero').first()
          const title = page.locator('.page-title').first()
          const [heroBounds, titleBounds, tocBounds] = await Promise.all([hero.boundingBox(), title.boundingBox(), tocCard.boundingBox()])
          expect(heroBounds).not.toBeNull()
          expect(titleBounds).not.toBeNull()
          expect(tocBounds).not.toBeNull()
          if (heroBounds && titleBounds && tocBounds) {
            expect(tocBounds.y, 'Page Contents begins inside the title gradient').toBeGreaterThanOrEqual(heroBounds.y)
            expect(tocBounds.y, 'Page Contents begins before the title gradient ends').toBeLessThan(heroBounds.y + heroBounds.height)
            expect(Math.abs(tocBounds.y - titleBounds.y), 'Page Contents aligns with the title row').toBeLessThanOrEqual(4)
            expect(tocBounds.height, 'Page Contents retains useful empty geometry').toBeGreaterThanOrEqual(128)
          }

          if (await tocCard.locator('.page-toc-empty').count()) {
            const firstMetadataCard = page.locator('.page-col-sd > :is(.page-tags-card, .page-comments-card, .page-author-card, .page-shortcuts-card)').first()
            const [metadataBounds, currentHeroBounds] = await Promise.all([firstMetadataCard.boundingBox(), hero.boundingBox()])
            expect(metadataBounds).not.toBeNull()
            expect(currentHeroBounds).not.toBeNull()
            if (metadataBounds && currentHeroBounds) {
              expect(metadataBounds.y, 'Reader metadata follows the empty Page Contents card without dead space').toBeLessThanOrEqual(
                currentHeroBounds.y + currentHeroBounds.height + 4
              )
            }
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
    const markdownCopy = article.locator('> div:not(.page-gutter-ornament)').first()

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
    expect(metadataBounds.x + metadataBounds.width, 'Reader metadata rail must not overlap the primary article').toBeLessThanOrEqual(
      articleBounds.x + 1
    )

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
      expect(copyGrowth, 'Wide Markdown copy is approximately 20% wider than the legacy 76ch measure').toBeGreaterThanOrEqual(1.19)
      expect(copyGrowth, 'Wide Markdown copy is approximately 20% wider than the legacy 76ch measure').toBeLessThanOrEqual(1.22)
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

      const [titleBounds, railBounds, articleBounds] = await Promise.all([
        title.boundingBox(),
        rail.boundingBox(),
        article.boundingBox()
      ])
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
    } finally {
      await page.evaluate(state => {
        const reader = document.querySelector<HTMLElement>('.wiki-page')
        const header = document.querySelector<HTMLElement>('.page-header-section > .is-page-header')
        const rail = document.querySelector<HTMLElement>('.page-col-sd')
        const article = document.querySelector<HTMLElement>('.page-col-content:not(.is-page-header)')
        if (state.documentDirection === null) document.documentElement.removeAttribute('dir')
        else document.documentElement.setAttribute('dir', state.documentDirection)
        if (reader) {
          reader.className = state.readerClass
          if (state.readerDirection === null) reader.removeAttribute('dir')
          else reader.setAttribute('dir', state.readerDirection)
        }
        if (header) header.className = state.headerClass
        if (rail) rail.className = state.railClass
        if (article) article.className = state.articleClass
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
  })

  test('keeps Agent Chat readable and operable', async ({ page }) => {
    await openAuthenticatedPage(page, '/', '.page-header-section')
    await openSearch(page)
    await expect(page.getByRole('button', { name: /^ask$/i })).toBeVisible()
    await page.getByRole('button', { name: /^ask$/i }).click()

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

    if (viewport.width >= 1440) {
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

    await expect(agent.getByText('How this session uses the model')).toHaveCount(0)
    const profileCount = await page.evaluate(async () =>
      (await fetch('/_api/agents/profiles')).json().then((value: { profiles?: unknown[] }) => value.profiles?.length ?? 0)
    )
    const settingsButton = agent.getByRole('button', { name: 'Session configuration' })
    await expect(settingsButton).toBeVisible()
    await settingsButton.click()
    const sessionScope = agent.getByText('Session scope', { exact: true })
    await expect(sessionScope).toBeVisible()
    await expect(agent.getByText('Pinned skills (always loaded)')).toHaveCount(0)
    if (profileCount > 0) {
      await expect(agent.getByText('Provider profile')).toBeVisible()
    }
    const settings = agent.locator('.inline-agent__settings')
    const settingsLayout = await settings.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return {
        bottom: bounds.bottom,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight
      }
    })
    expect(settingsLayout.overflowY).toBe('auto')
    expect(settingsLayout.bottom).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1)
    if (settingsLayout.scrollHeight > settingsLayout.clientHeight) {
      await settings.evaluate(element => {
        element.scrollTop = element.scrollHeight
      })
      await expect.poll(() => settings.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    }
    await settingsButton.click()
    await expect(sessionScope).toBeHidden()
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
})
