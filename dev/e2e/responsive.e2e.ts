import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import type { App } from 'vue'
import { waitForPageRender } from '../../client/helpers/pages-api.ts'
import { decodeWikiPagePayload, type WikiPagePayload } from '../../client/helpers/wiki-navigation.ts'
import { installEnabledAgentFixture } from './agent-fixture.ts'
import {
  authenticateAsAdmin,
  expectLocatorWithinViewport,
  expectResponsiveLayout,
  openAuthenticatedPage,
  openSearch,
  sameOriginHeaders,
  responsiveTest as test
} from './helpers.ts'

// Mocked reader HTML and API responses must own their requests; real worker coverage stays in offline.e2e.ts.
const routedReaderTest = test.extend({ serviceWorkers: 'block' })

async function openFixtureAgentFromSearch(page: Page): Promise<Locator> {
  await openAuthenticatedPage(page, '/', '.page-header-section')
  const viewport = page.viewportSize()
  const searchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
  if (viewport && viewport.width >= 960) await page.keyboard.press('ControlOrMeta+K')
  else await openSearch(page)
  await expect(searchDialog).toBeVisible()
  const search = page.locator('.nav-header-search-control input:visible').first()
  await expect(search).toBeVisible()
  await search.fill('home')
  const askAgent = searchDialog.getByRole('button', { name: 'Ask about this', exact: true })
  await expect(askAgent).toBeVisible()
  await askAgent.click()
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

type ContinuitySubmission = { currentPage?: { id: number }; knowledgeContext: { sources: Array<{ id: number }> } }

async function installAgentContinuityPages(page: Page | BrowserContext): Promise<void> {
  await page.route('**/_api/users/whoami', route =>
    route.fulfill({
      json: {
        authenticated: true,
        user: { id: 900001, authVersion: 1, name: 'Agent context fixture', email: 'context@example.invalid', permissions: ['use:agents'], localeCode: 'en' }
      }
    })
  )
  await page.route(/\/_api\/pages\/\d+\/watch$/, route => route.fulfill({ json: { watched: false, emailEnabled: false, inAppEnabled: false } }))
  await page.route(/\/_api\/pages\/\d+\/approval$/, route => route.fulfill({ json: { approval: null } }))
  await page.route('**/_api/pages/watches/notifications', route =>
    route.fulfill({ json: { ownerId: 900001, items: [], unreadCount: 0, nextCursor: null, unreadComplete: true } })
  )
  await page.route('**/_api/pages/approvals/inbox', route => route.fulfill({ json: { ownerId: 900001, items: [], nextCursor: null } }))
  await page.route('**/_api/pages/search?**', route => route.fulfill({ json: { results: [], suggestions: [], totalHits: 0, nextCursor: null } }))
  const sources = [
    ...['a', 'b', 'c'].map((suffix, index) => ({ id: 901 + index, path: `agent-context-fixture-${suffix}`, title: `Context page ${suffix.toUpperCase()}` })),
    { id: 6, path: 'release-guide', title: 'Release guide' }
  ].map(source => ({
    ...source,
    locale: 'en',
    visibility: 'public',
    description: 'A browser-only Agent source.',
    updatedAt: '2026-09-01T12:00:00.000Z',
    sourceRevision: '1',
    excerpt: 'Release evidence excerpt.',
    excerptTruncated: false
  }))
  await page.route('**/_api/pages/preview?**', route => {
    const params = new URL(route.request().url()).searchParams
    const source = sources.find(item => (params.has('id') ? item.id === Number(params.get('id')) : item.path === params.get('path')))
    return route.fulfill({ status: source ? 200 : 404, json: source ?? { error: 'Fixture source not found' } })
  })
  // Serve three public fixture page identities using the deployed app shell, without creating wiki records.
  await page.route(/\/agent-context-fixture-[abc]$/, async route => {
    const path = new URL(route.request().url()).pathname.slice(1)
    const source = sources.find(item => item.path === path)!
    const response = await route.fetch({ url: new URL('/', route.request().url()).href })
    expect(response.ok()).toBe(true)
    const html = await response.text()
    let replaced = false
    let body = html.replace(/(<wiki-page\b[^>]*\bpayload=)(["'])([^"']+)\2/u, (_match, prefix: string, quote: string, encoded: string) => {
      const payload = decodeWikiPagePayloadForTest(encoded)
      const patched = {
        ...payload,
        spaNavigation: true,
        props: {
          ...payload.props,
          pageId: source.id,
          locale: source.locale,
          path: source.path,
          title: source.title,
          updatedAt: source.updatedAt,
          sourceRevision: source.sourceRevision
        }
      }
      replaced = true
      return `${prefix}${quote}${Buffer.from(JSON.stringify(patched)).toString('base64')}${quote}`
    })
    expect(replaced, 'The deployed wiki document exposes its normal navigation payload').toBe(true)
    body = body.replace(/<template\b[^>]*\bdata-wiki-page-contents\b[^>]*>/u, opener =>
      `${opener}<nav aria-label="Fixture pages">${sources.filter(item => item.id >= 901).map(item => `<a href="/${item.path}">${item.title}</a>`).join(' ')}</nav>`
    )
    await route.fulfill({ response, body })
  })
}

async function openContinuityAgent(page: Page, path?: string, expectedComposition = 'context'): Promise<Locator> {
  if (path) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.nav-header')).toBeVisible({ timeout: 15_000 })
  }
  const search = await openSearch(page)
  await search.fill('context')
  await page.getByRole('dialog', { name: 'Search the Wiki', exact: true }).getByRole('button', { name: 'Ask Wiki about "context"', exact: true }).click()
  const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
  await expect(agent.locator('.agent-composer textarea')).toBeEnabled()
  // The search hand-off prefills the composer with the search query asynchronously;
  // wait for that hand-off to settle before the caller types over it.
  await expect(agent.locator('.agent-composer textarea')).toHaveValue(expectedComposition)
  return agent
}

async function closeContinuityAgent(page: Page): Promise<void> {
  await page.getByRole('region', { name: 'Wiki Agent', exact: true }).getByRole('button', { name: 'Close Wiki Agent', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Wiki Agent', exact: true })).toBeHidden()
}

async function sendContinuityPrompt(page: Page, agent: Locator, prompt: string): Promise<ContinuitySubmission> {
  const request = page.waitForRequest(
    request => request.method() === 'POST' && /\/_api\/agents\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)
  )
  const composer = agent.locator('.agent-composer textarea')
  // A conversation restore can land after the caller types and revert the
  // composer to the saved draft; keep the typed prompt until it sticks.
  await expect
    .poll(async () => {
      if ((await composer.inputValue()) !== prompt) await composer.fill(prompt)
      return composer.inputValue()
    }, { timeout: 15_000 })
    .toBe(prompt)
  await agent.getByRole('button', { name: 'Send', exact: true }).click()
  const body = (await request).postDataJSON() as ContinuitySubmission
  await expect(agent.locator('.agent-message--user').last()).toContainText(prompt)
  await expect(agent.locator('.agent-message--assistant').last()).toContainText('The release is ready for a deliberate review.')
  await expect(agent.locator('.agent-composer textarea')).toBeEnabled()
  return body
}

test.describe('responsive UI quality matrix', () => {
  test.beforeEach(() => {
    test.setTimeout(60_000)
  })


  test('keeps Table Helper reachable at 320px and 390px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-mobile', 'Narrow editor controls are owned by Chromium mobile')
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await openAuthenticatedPage(page, '/e/en/visual-markdown-browser', '.editor-tiptap')
      const row = page.locator('.editor-tiptap-toolbar')
      const table = row.getByRole('button', { name: 'Table Helper', exact: true })
      await expect(table).toBeVisible()
      await row.evaluate(element => { element.scrollLeft = 0 })
      expect(await row.evaluate(element => element.scrollWidth - element.clientWidth), `${width}px toolbar has a local scroll range`).toBeGreaterThan(0)
      await row.hover()
      await page.mouse.wheel(10_000, 0)
      await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
      await expectLocatorWithinViewport(table, `${width}px Table Helper`)
      await table.click()
      await expect(page.getByText('Insert table', { exact: true })).toBeVisible()
      await expectResponsiveLayout(page, `${width}px Table Helper`)
    }
  })

  test('keeps both rich-editor formats and Markdown insert actions reachable at 320px', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-mobile', 'Narrow rich-editor containment is owned by Chromium mobile')
    await page.setViewportSize({ width: 320, height: 720 })
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', 'article.contents')
    const readerTypography = await page.locator('article.contents h1').first().evaluate(element => {
      const style = getComputedStyle(element)
      const inkProbe = document.createElement('span')
      inkProbe.hidden = true
      inkProbe.style.color = 'var(--wiki-accent-ink)'
      element.append(inkProbe)
      const accentInk = getComputedStyle(inkProbe).color
      inkProbe.remove()
      return {
        color: style.color,
        accentInk,
        'font-family': style.fontFamily,
        'font-size': style.fontSize,
        'font-weight': style.fontWeight,
        'line-height': style.lineHeight,
        'letter-spacing': style.letterSpacing
      }
    })
    const { accentInk, ...expectedTypography } = readerTypography
    expect(expectedTypography.color, 'The live reader H1 uses the shared accent-ink token').toBe(accentInk)
    for (const format of ['visual-markdown', 'visual-html']) {
      await openAuthenticatedPage(page, `/e/en/${format}-browser`, '.editor-tiptap')
      const editor = page.locator('.editor-tiptap .ProseMirror')
      const paragraph = editor.locator('p').first()
      await paragraph.click({ position: { x: 5, y: 5 } })
      await page.keyboard.press('End')
      const marker = ` native-${format}-draft`
      await page.keyboard.insertText(marker)
      await expect(paragraph).toContainText(marker)
      const formattingRow = page.locator('.editor-tiptap-toolbar')
      await formattingRow.evaluate(element => { element.scrollLeft = 0 })
      const undo = formattingRow.getByRole('button', { name: 'Undo', exact: true })
      const leadingBounds = await undo.boundingBox()
      const rowBounds = await formattingRow.boundingBox()
      if (!leadingBounds || !rowBounds) throw new Error('Formatting row has no native geometry')
      expect(leadingBounds.x, 'Leading Undo is not centered outside the narrow scrollport').toBeGreaterThanOrEqual(rowBounds.x - 1)
      expect(leadingBounds.x + leadingBounds.width).toBeLessThanOrEqual(rowBounds.x + rowBounds.width + 1)
      await undo.click()
      await expect(editor).not.toContainText(marker)
      await paragraph.click({ position: { x: 5, y: 5 } })
      expect(await formattingRow.evaluate(element => element.scrollWidth - element.clientWidth), 'The narrow formatting row actually needs local horizontal scrolling').toBeGreaterThan(0)
      await formattingRow.hover()
      await page.mouse.wheel(10_000, 0)
      await expect.poll(() => formattingRow.evaluate(element => element.scrollLeft), 'Real horizontal wheel input scrolls only the formatting row').toBeGreaterThan(0)
      const trailing = formattingRow.getByRole('button', { name: format === 'visual-html' ? 'Align right' : 'Table Helper', exact: true })
      await expectLocatorWithinViewport(trailing, 'Far formatting action')
      await trailing.click()
      if (format === 'visual-html') {
        await expect(paragraph).toHaveCSS('text-align', 'right')
        await expect(page.getByRole('toolbar', { name: 'Insert tools', exact: true })).toHaveCount(0)
      } else {
        await expect(page.getByText('Insert table', { exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        const insertRow = page.getByRole('toolbar', { name: 'Insert tools', exact: true })
        await insertRow.evaluate(element => { element.scrollLeft = 0 })
        const content = insertRow.getByRole('button', { name: 'Insert content extension', exact: true })
        const [insertBounds, contentBounds] = await Promise.all([insertRow.boundingBox(), content.boundingBox()])
        if (!insertBounds || !contentBounds) throw new Error('Insertion row has no native geometry')
        expect(contentBounds.x, 'Leading insertion action is not clipped by unsafe centering').toBeGreaterThanOrEqual(insertBounds.x - 1)
        expect(contentBounds.x + contentBounds.width).toBeLessThanOrEqual(insertBounds.x + insertBounds.width + 1)
        await content.click()
        const extensions = page.getByRole('dialog', { name: 'Insert content extension', exact: true })
        await expect(extensions).toBeVisible()
        await extensions.getByRole('button', { name: 'Close content extension dialog', exact: true }).click()
        expect(await insertRow.evaluate(element => element.scrollWidth - element.clientWidth), 'Insertion tools have their own local scroll range').toBeGreaterThan(0)
        await insertRow.hover()
        await page.mouse.wheel(10_000, 0)
        await expect.poll(() => insertRow.evaluate(element => element.scrollLeft), 'Real horizontal wheel input reaches the far insertion action').toBeGreaterThan(0)
        const glyph = insertRow.getByRole('button', { name: 'Insert icon or emoji', exact: true })
        await expectLocatorWithinViewport(glyph, 'Far insertion action')
        await glyph.click()
        await expect(page.getByRole('textbox', { name: 'Search icons and emoji', exact: true })).toBeVisible()
        await page.getByRole('button', { name: 'Close icon and emoji picker', exact: true }).click()
        const layout = await page.locator('.editor-tiptap').evaluate(root => {
          const formatting = root.querySelector('.editor-tiptap-toolbar')
          const insertion = root.querySelector('.editor-tiptap-markdown-tools')
          const canvas = root.querySelector('.editor-tiptap-page-canvas')
          if (!formatting || !insertion || !canvas) throw new Error('Rich editor tool rows or canvas are not mounted')
          return {
            formattingBottom: formatting.getBoundingClientRect().bottom,
            insertionTop: insertion.getBoundingClientRect().top,
            insertionBottom: insertion.getBoundingClientRect().bottom,
            canvasTop: canvas.getBoundingClientRect().top
          }
        })
        expect(layout.insertionTop, 'Insertion row follows formatting tools').toBeGreaterThanOrEqual(layout.formattingBottom - 1)
        expect(layout.canvasTop, 'Both tool rows precede the authoring canvas').toBeGreaterThanOrEqual(layout.insertionBottom - 1)
      }
      const headingText = await paragraph.innerText()
      await paragraph.click({ position: { x: 5, y: 5 } })
      await formattingRow.evaluate(element => { element.scrollLeft = 0 })
      await formattingRow.getByRole('button', { name: /^Text style:/u }).click()
      await page.getByRole('listitem').filter({ hasText: /^Heading 1$/u }).click()
      const editorHeading = editor.getByRole('heading', { level: 1, name: headingText, exact: true })
      for (const [property, value] of Object.entries(expectedTypography)) {
        await expect(editorHeading, `Shared reader/editor heading ${property}`).toHaveCSS(property, value)
      }
      await expectResponsiveLayout(page, `${format} narrow toolbar containment`)
      await testInfo.attach(`${format}-narrow-tools`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
      await page.getByRole('button', { name: 'More editor actions', exact: true }).click()
      await page.getByRole('listitem').filter({ hasText: /^Close$/u }).click()
      const discard = page.getByRole('button', { name: 'Discard Changes', exact: true })
      await expect.poll(async () => await discard.isVisible() || new URL(page.url()).pathname === `/en/${format}-browser`).toBe(true)
      if (await discard.isVisible()) await discard.click()
      await expect(page).toHaveURL(`/en/${format}-browser`, { timeout: 30_000 })
    }
  })

  test('contains authored page CSS in the native canvas, filters imports, and removes cleared styles', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Native page CSS is owned by Chromium desktop')
    test.setTimeout(90_000)
    await openAuthenticatedPage(page, '/e/en/visual-markdown-browser', '.editor-tiptap')
    const paragraph = page.locator('.editor-tiptap .ProseMirror p').first()
    const pageAction = page.getByRole('button', { name: 'Page', exact: true })
    const outsideSpacing = await pageAction.evaluate(element => getComputedStyle(element).letterSpacing)
    const originalSpacing = await paragraph.evaluate(element => getComputedStyle(element).letterSpacing)
    const desktopViewport = page.viewportSize()
    if (!desktopViewport) throw new Error('Page CSS requires a configured viewport')
    await page.setViewportSize({ width: 320, height: 720 })
    const narrowOutsideSpacing = await pageAction.evaluate(element => getComputedStyle(element).letterSpacing)
    await page.setViewportSize(desktopViewport)
    const warnings: string[] = []
    page.on('console', message => {
      if (message.type() === 'warning' && message.text().includes('@import')) warnings.push(message.text())
    })
    await page.route('**/assets/native-editor-import.css', route => route.fulfill({ contentType: 'text/css', body: 'p, button { letter-spacing: 99px !important }' }))
    await page.evaluate(() => {
      const parserStyles: HTMLStyleElement[] = []
      Object.defineProperty(window, '__nativeParserStyles', { value: parserStyles })
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof HTMLStyleElement && node.media === 'not all') parserStyles.push(node)
        }
      }).observe(document.head, { childList: true })
    })
    const properties = page.getByRole('dialog', { name: 'Page Properties', exact: true })
    await pageAction.click()
    await properties.getByRole('tab', { name: 'Styles', exact: true }).click()
    const css = properties.getByRole('textbox', { name: 'Page CSS', exact: true })
    await css.fill('@import url("/assets/native-editor-import.css");\np, button { letter-spacing: 7px !important; }')
    await properties.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(paragraph).toHaveCSS('letter-spacing', '7px')
    await expect(pageAction, 'Matching editor chrome is outside the authored CSS scope').toHaveCSS('letter-spacing', outsideSpacing)
    const styleNode = await page.locator('#editor-script-css').elementHandle()
    if (!styleNode) throw new Error('Authored canvas CSS did not mount')
    const ruleReport = await styleNode.evaluate(element => {
      let imports = 0
      let ordinaryRule = false
      const visit = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule.type === CSSRule.IMPORT_RULE) imports += 1
          if (rule instanceof CSSStyleRule && rule.selectorText.split(',').map(selector => selector.trim()).includes('p') && rule.style.letterSpacing === '7px') ordinaryRule = true
          if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
        }
      }
      visit((element as HTMLStyleElement).sheet!.cssRules)
      return { imports, ordinaryRule }
    })
    expect(ruleReport, 'Native emitted rules retain authored declarations without importing unscoped CSS').toEqual({ imports: 0, ordinaryRule: true })
    expect(warnings, 'The unsupported-import boundary emits one diagnostic').toHaveLength(1)
    expect(await page.evaluate(() => (window as typeof window & { __nativeParserStyles: HTMLStyleElement[] }).__nativeParserStyles.every(style => !style.isConnected)), 'Transient native parser styles are removed').toBe(true)
    await expect(page.locator('head style[media="not all"]'), 'No native parser style remains attached').toHaveCount(0)
    await page.setViewportSize({ width: 320, height: 720 })
    await expect(paragraph).toHaveCSS('letter-spacing', '7px')
    await expect(pageAction, 'Matching mobile editor chrome remains outside authored CSS').toHaveCSS('letter-spacing', narrowOutsideSpacing)
    await expectResponsiveLayout(page, 'Narrow editor page-CSS containment')
    await testInfo.attach('native-page-css-narrow', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
    await page.setViewportSize(desktopViewport)
    await pageAction.click()
    await properties.getByRole('tab', { name: 'Styles', exact: true }).click()
    await css.fill('p, button { letter-spacing: 11px !important; }')
    await properties.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(paragraph).toHaveCSS('letter-spacing', '11px')
    expect(await styleNode.evaluate(element => element === document.querySelector('#editor-script-css')), 'A nonempty CSS update reuses the existing style node').toBe(true)
    await expect(pageAction).toHaveCSS('letter-spacing', outsideSpacing)
    await pageAction.click()
    await properties.getByRole('tab', { name: 'Styles', exact: true }).click()
    await css.fill('')
    await properties.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.locator('#editor-script-css')).toHaveCount(0)
    await expect(paragraph).toHaveCSS('letter-spacing', originalSpacing)
    await pageAction.click()
    await properties.getByRole('tab', { name: 'Styles', exact: true }).click()
    await css.fill('p, button { letter-spacing: 13px !important; }')
    await properties.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(paragraph).toHaveCSS('letter-spacing', '13px')
    await pageAction.click()
    await properties.getByRole('tab', { name: 'Styles', exact: true }).click()
    await page.clock.install()
    await page.clock.pauseAt(new Date(Date.now() + 1000))
    await css.fill('p, button { letter-spacing: 17px !important; }')
    await properties.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(paragraph, 'The replacement sheet is still pending at teardown').toHaveCSS('letter-spacing', '13px')
    const editorUrl = page.url()
    await page.evaluate(() => {
      const app = (window as typeof window & { WIKI: App }).WIKI
      if (!app || typeof app.unmount !== 'function') throw new Error('The native editor Vue app is not mounted')
      app.unmount()
    })
    await expect(page.locator('.editor-tiptap'), 'The actual mounted editor is torn down').toHaveCount(0)
    expect(await styleNode.evaluate(element => element.ownerDocument === document), 'Teardown retains the original document rather than clearing styles through navigation').toBe(true)
    await expect(page.locator('#editor-script-css'), 'Same-document teardown removes the existing page sheet').toHaveCount(0)
    await page.clock.fastForward(2000)
    await expect(page.locator('#editor-script-css'), 'A cancelled pending timer cannot reinsert a page sheet after teardown').toHaveCount(0)
    expect(page.url()).toBe(editorUrl)
    await styleNode.dispose()
  })
  test('keeps public pages, navigation, and fixed actions usable', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return

    for (const path of ['/en/home', '/en/visual-markdown-browser']) {
      await openAuthenticatedPage(page, path, '.page-header-section')
      await expectResponsiveLayout(page, path)
      if (viewport.width < 600) {
        const overflow = page.locator('.nav-header-mobile-actions')
        await expectLocatorWithinViewport(overflow, 'Compact header actions')
        await overflow.click()
        const browseTags = page.getByRole('link', { name: 'Browse by Tags', exact: true })
        await expect(browseTags, 'Compact headers keep Browse by Tags available through Glo').toBeVisible()
        await expect(browseTags).toHaveAttribute('href', '/t')
        await page.keyboard.press('Escape')
        await expect(browseTags).toBeHidden()
        await expect(overflow).toBeFocused()
      } else {
        const browseTags = page.locator('.nav-header .nav-header-browse:visible').first()
        await expect(browseTags, 'Public headers keep Browse by Tags available').toBeVisible()
        await expect(browseTags).toHaveAccessibleName('Browse by Tags')
      }
      if (viewport.width >= 960) {
        const command = page.locator('.nav-header-command:visible').first()
        await expect(command, 'Desktop headers keep the search command group visible').toBeVisible()
        const commandBounds = await command.boundingBox()
        expect(commandBounds).not.toBeNull()
        if (commandBounds) {
          expect(
            Math.abs(commandBounds.x + commandBounds.width / 2 - viewport.width / 2),
            'Desktop search command group is centered against the full viewport'
          ).toBeLessThanOrEqual(1)
        }
      }

      const headerPageActions = page
        .locator('.nav-header')
        .getByRole('button', { name: /page actions/i })
        .first()
      if (await headerPageActions.count()) {
        await expectLocatorWithinViewport(headerPageActions, 'Header page actions')
      }

      const heroActions = page.locator('.page-hero-actions').first()
      const tocCard = page.locator('.page-toc-card').first()
      await expect(heroActions).toBeVisible()
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
        const depth1Headings = tocCard.locator('.page-toc-item-title--depth-1')
        if (await depth1Headings.count()) {
          const primaryWeight = Number(await highestAvailableHeadings.first().evaluate(element => getComputedStyle(element).fontWeight))
          const secondaryWeight = Number(await depth1Headings.first().evaluate(element => getComputedStyle(element).fontWeight))
          expect(primaryWeight, 'Top-level contents headings remain more prominent than nested entries').toBeGreaterThan(secondaryWeight)
        }

        if (viewport.width >= 1280) {
          const railBounds = await page.locator('.page-col-sd:visible').first().boundingBox()
          expect(railBounds).not.toBeNull()
          expect(railBounds!.width, 'The contents rail leaves room for reading').toBe(220)
        } else {
          const summary = tocCard.locator('.page-toc-summary')
          const bounds = await summary.boundingBox()
          expect(bounds).not.toBeNull()
          expect(bounds!.height).toBe(40)
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
              // Anchor navigation focuses the heading only after its scroll animation finishes.
              await expect(targetHeading).toBeFocused()
              const headingBox = await targetHeading.boundingBox()
              expect(headingBox).not.toBeNull()
              if (headingBox) {
                expect(headingBox.y, 'TOC destination heading is visible below fixed chrome').toBeGreaterThanOrEqual(0)
                expect(headingBox.y, 'TOC destination heading is within viewport').toBeLessThan(viewport.height)
              }
            }
          }
        }
      }

      for (const action of await heroActions.locator('.v-btn').all()) {
        await expect(action).toHaveAccessibleName(/\S/)
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

    // The URL changes before reader navigation finishes restoring the page scroll.
    await expect(page.locator('.page-main')).not.toHaveAttribute('aria-busy', 'true')

    const pageEditFab = page.locator('.page-edit-fab')
    if (await pageEditFab.count()) {
      await expectLocatorWithinViewport(pageEditFab, 'Page actions')
    }
    const scrollExtent = await page.evaluate(async () => {
      const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      window.scrollTo(0, maximum)
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      return { maximum, actual: window.scrollY, activation: window.innerHeight * 0.33 }
    })
    expect(Math.abs(scrollExtent.actual - scrollExtent.maximum), 'Reader reaches its actual document bottom').toBeLessThanOrEqual(1)
    const returnToTop = page.getByRole('button', { name: /return to top/i })
    if (scrollExtent.maximum <= scrollExtent.activation) {
      // Wide layouts can exhaust the page before the viewport-relative action activates.
      await expect(returnToTop).toHaveCount(0)
      return
    }
    await expectLocatorWithinViewport(returnToTop, 'Return to top action')
    const returnToTopBounds = await returnToTop.boundingBox()
    expect(returnToTopBounds).not.toBeNull()
    if (returnToTopBounds) {
      expect(returnToTopBounds.x, 'Return to top stays on the right').toBeGreaterThan(viewport.width / 2)

      if (await pageEditFab.count()) {
        await pageEditFab.click()
        await expect(pageEditFab).toHaveAttribute('aria-expanded', 'true')
        const editPageAction =
          viewport.width < 840 ? page.getByText('Edit Page', { exact: true }).last() : page.getByRole('button', { name: 'Edit Page', exact: true })
        await expect(editPageAction).toBeVisible()
      }
      const neighboringFixedActions = page.locator('.page-edit-fab:visible, .v-speed-dial__content .v-btn:visible')
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
  routedReaderTest('keeps the reader Edit action reachable by pointer and keyboard', async ({ page }) => {
    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport || viewport.width < 600) return
    const editSelector = viewport.width >= 960 ? '.nav-header-edit-btn' : '.page-edit-shortcuts .v-btn'

    await authenticateAsAdmin(page)
    const readerUrl = new URL('/en/visual-markdown-browser', sameOriginHeaders().Origin)
    let patchedReaderNavigations = 0
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
        editMenuExternalBtn: false,
        // Small screens show one edit control; keep it the header button here.
        editFab: false
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
      patchedReaderNavigations += 1
    })

    for (const position of ['top', 'center', 'bottom'] as const) {
      const previousPatchedNavigations = patchedReaderNavigations
      await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')
      expect(patchedReaderNavigations, 'Each reader navigation passes through the validated HTML fixture').toBeGreaterThan(previousPatchedNavigations)
      const edit = page.locator(editSelector).first()
      await expect(edit, 'Reader Edit action is present').toBeVisible()
      const bounds = await edit.boundingBox()
      expect(bounds).not.toBeNull()
      if (!bounds) continue
      const edgeInset = Math.min(8, Math.max(2, bounds.height / 4))
      const x = bounds.x + bounds.width / 2
      const y = bounds.y + (position === 'top' ? edgeInset : position === 'center' ? bounds.height / 2 : bounds.height - edgeInset)
      const hit = await page.evaluate(
        ({ x, y, selector }) => {
          const target = document.elementFromPoint(x, y)
          return target instanceof HTMLElement && Boolean(target.closest(selector))
        },
        { x, y, selector: editSelector }
      )
      expect(hit, `Reader Edit ${position} pointer target remains interactive`).toBe(true)
      if (position === 'center') {
        await edit.focus()
        await expect(edit, 'Reader Edit action remains keyboard focusable').toBeFocused()
        await page.keyboard.press('Enter')
      } else {
        await page.mouse.click(x, y)
      }
      await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    }
  })

  test('preserves automatic and explicit TOC layouts across wide and collapsed reader transitions', async ({ page }) => {
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Reader geometry requires a configured viewport')
    await openAuthenticatedPage(page, '/en/home', '.page-header-section')
    const setPosition = async (value?: 'auto' | 'left' | 'right' | 'off'): Promise<string> => page.evaluate(position => {
      const app = (window as typeof window & { WIKI?: { config?: { globalProperties?: { $pinia?: { _s?: Map<string, { site: { tocPosition: string } }> } } } } }).WIKI
      const store = app?.config?.globalProperties?.$pinia?._s?.get('wiki')
      if (!store) throw new Error('Wiki store is unavailable for responsive TOC transition.')
      const previous = store.site.tocPosition
      if (position !== undefined) store.site.tocPosition = position
      return previous
    }, value)
    const original = await setPosition()
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      for (const position of ['auto', 'left', 'right', 'off'] as const) {
        await setPosition(position)
        const article = page.locator('.page-col-content:not(.is-page-header) > .contents')
        await expect(article).toBeVisible()
        const articleBounds = await article.boundingBox()
        if (!articleBounds) throw new Error('Reader article geometry is missing')
        if (position === 'off') {
          await expect(page.locator('.page-toc-card')).toHaveCount(0)
          const row = await page.locator('.page-body > .v-row').boundingBox()
          expect(row).not.toBeNull()
          expect(Math.abs(articleBounds.width - row!.width)).toBeLessThanOrEqual(2)
          continue
        }
        const rail = page.locator('.page-col-sd')
        await expect(rail).toBeVisible()
        const railBounds = await rail.boundingBox()
        if (!railBounds) throw new Error('Reader contents geometry is missing')
        expect(railBounds.width).toBe(220)
        if (position === 'left') expect(railBounds.x + railBounds.width).toBeLessThan(articleBounds.x)
        else {
          expect(articleBounds.x + articleBounds.width).toBeLessThan(railBounds.x)
          const prose = await article.locator('p:visible, h2:visible, h3:visible').first().boundingBox()
          expect(prose).not.toBeNull()
          expect(prose!.x, 'Actual prose does not inherit the retired left utility rail').toBeLessThanOrEqual(300)
        }
        await page.setViewportSize({ width: 1279, height: 900 })
        const toggle = page.locator('#page-inline-toc .page-toc-toggle')
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await expect(page.locator('.page-col-sd')).toBeHidden()
        await toggle.focus()
        await toggle.press('Enter')
        await expect(page.locator('#page-inline-toc #page-toc-content')).toBeVisible()
        await page.setViewportSize({ width: 1280, height: 900 })
        await expect(page.locator('#page-desktop-rail .page-toc-card')).toBeVisible()
        await page.setViewportSize({ width: 1440, height: 900 })
      }
      await setPosition('auto')
      for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
        await page.setViewportSize(size)
        await page.evaluate(() => window.scrollTo(0, 0))
        const summary = await page.locator('.page-toc-summary').boundingBox()
        expect(summary).not.toBeNull()
        expect(summary!.height).toBe(40)
        const prose = await page.locator('.contents p:visible, .contents h2:visible, .contents h3:visible').first().boundingBox()
        expect(prose).not.toBeNull()
        expect(prose!.y).toBeLessThan(260)
        await expectResponsiveLayout(page, 'Collapsed reader contents')
      }
    } finally {
      await setPosition(original as 'auto' | 'left' | 'right' | 'off')
      await page.setViewportSize(viewport)
    }
  })

  routedReaderTest('mirrors native LTR/RTL reader and sidebar geometry while keeping branding physically right', async ({ page }, testInfo) => {
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Reader geometry requires a configured viewport')
    let direction: 'ltr' | 'rtl' = 'ltr'
    const digest = 'a'.repeat(64)
    const imageUrl = `/assets/native-reader-brand.png?v=${digest}`
    await page.route(`**/assets/native-reader-brand.png?v=${digest}`, route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" rx="8" fill="#0c2238"/></svg>'
    }))
    await page.route('**/en/visual-markdown-browser', async route => {
      const response = await route.fetch()
      if (!response.ok()) throw new Error(`Reader geometry bootstrap returned HTTP ${response.status()}`)
      let body = await response.text()
      let configured = false
      let hydrated = false
      // Change the server's normal boot input, before app/Vuetify creation.
      // The application, not this test, derives all direction/layout classes.
      body = body.replace(/(var siteConfig\s*=\s*)(\{[^\n]*\})(?=\s*(?:\n|;|<\/script>))/u, (_match, prefix: string, json: string) => {
        const config = JSON.parse(json)
        configured = true
        return `${prefix}${JSON.stringify({ ...config, rtl: direction === 'rtl', tocPosition: 'left' })}`
      })
      body = body.replace(/(<wiki-page\b[^>]*\bpayload=)(["'])([^"']+)\2/u, (_match, prefix: string, quote: string, encoded: string) => {
        const payload = decodeWikiPagePayloadForTest(encoded)
        const patched = {
          ...payload,
          props: {
            ...payload.props,
            description: 'A reader description retains its text direction below the title.',
            branding: { assetId: 9001, imageUrl, sourceSha256: digest, width: 96, height: 64, accent: '#0C2238' }
          }
        }
        const value = Buffer.from(JSON.stringify(patched)).toString('base64')
        decodeWikiPagePayloadForTest(value)
        hydrated = true
        return `${prefix}${quote}${value}${quote}`
      })
      if (!configured || !hydrated) throw new Error('Reader fixture omitted its normal configuration or page payload')
      await route.fulfill({ response, body })
    })
    for (direction of ['ltr', 'rtl'] as const) {
      await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.page-header-section')
      const reader = page.locator('.wiki-page')
      const drawer = page.locator('#page-navigation-drawer')
      const article = page.locator('article.contents')
      const title = page.locator('.page-title').first()
      const headings = page.locator('.page-header-headings').first()
      const mark = headings.locator('.page-branding-mark')
      await expect(reader).toHaveCSS('direction', direction)
      await expect(article).toHaveAttribute('lang', 'en')
      await expect(article, 'English content keeps its locale direction under either shell layout').toHaveCSS('direction', 'ltr')
      await expect(mark).toBeVisible()
      await expect(mark.locator('img')).toBeVisible()
      await expect.poll(() => mark.locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(96)
      for (const text of [title, headings.locator('.page-document-label'), page.locator('.page-description').first()]) {
        await expect(text).toHaveCSS('direction', direction)
      }
      const [titleBounds, headingBounds, markBounds] = await Promise.all([title.boundingBox(), headings.boundingBox(), mark.boundingBox()])
      if (!titleBounds || !headingBounds || !markBounds) throw new Error('Native branding geometry is missing')
      const headingRightInset = await headings.evaluate(element => {
        const style = getComputedStyle(element)
        return Number.parseFloat(style.paddingRight) + Number.parseFloat(style.borderRightWidth)
      })
      expect(markBounds.x + markBounds.width, `${direction} mark remains at the physical right heading content edge`).toBeCloseTo(headingBounds.x + headingBounds.width - headingRightInset, 0)
      for (const text of [title, headings.locator('.page-document-label')]) {
        const bounds = await text.boundingBox()
        if (!bounds) throw new Error('Reader text geometry is missing')
        expect(bounds.x + bounds.width, `${direction} heading text cannot overlap the physical-right mark`).toBeLessThanOrEqual(markBounds.x + 1)
      }
      if (viewport.width < 1280) {
        await page.locator('button[aria-controls="page-navigation-drawer"]').click()
        await expect(drawer).toHaveClass(/v-navigation-drawer--active/u)
      } else {
        await expect(drawer).toHaveClass(/v-navigation-drawer--active/u)
      }
      await expect.poll(async () => {
        const bounds = await drawer.boundingBox()
        if (!bounds) throw new Error('Native sidebar geometry is missing')
        return direction === 'ltr' ? bounds.x : bounds.x + bounds.width - viewport.width
      }, `${direction} navigation settles at its physical viewport edge`).toBeCloseTo(0, 0)
      const drawerBounds = await drawer.boundingBox()
      if (!drawerBounds) throw new Error('Native sidebar geometry is missing')
      expect(drawerBounds.width, 'Sidebar retains a usable navigation width').toBeGreaterThanOrEqual(Math.min(200, viewport.width))
      expect(drawerBounds.x).toBeGreaterThanOrEqual(-1)
      expect(drawerBounds.x + drawerBounds.width).toBeLessThanOrEqual(viewport.width + 1)
      if (viewport.width >= 1280) {
        const rail = page.locator('.page-col-sd')
        const [railBounds, articleBounds] = await Promise.all([rail.boundingBox(), article.boundingBox()])
        if (!railBounds || !articleBounds) throw new Error('Native reader rail geometry is missing')
        if (direction === 'ltr') {
          expect(drawerBounds.x + drawerBounds.width, 'LTR drawer reserves space before the reader rail').toBeLessThanOrEqual(railBounds.x + 1)
          expect(railBounds.x + railBounds.width, 'LTR metadata rail stays clear of the article').toBeLessThanOrEqual(articleBounds.x + 1)
        } else {
          expect(articleBounds.x + articleBounds.width, 'RTL metadata rail is after and clear of the article').toBeLessThanOrEqual(railBounds.x + 1)
          expect(railBounds.x + railBounds.width, 'RTL drawer reserves space after the reader rail').toBeLessThanOrEqual(drawerBounds.x + 1)
        }
        const headingStartInset = direction === 'rtl' ? headingRightInset : await headings.evaluate(element => {
          const style = getComputedStyle(element)
          return Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth)
        })
        const headingStart = direction === 'rtl' ? headingBounds.x + headingBounds.width - headingStartInset : headingBounds.x + headingStartInset
        const articleStart = direction === 'rtl' ? articleBounds.x + articleBounds.width : articleBounds.x
        expect(Math.abs(headingStart - articleStart), `${direction} heading column and article share their logical outer edge`).toBeLessThanOrEqual(2)
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${direction} reader has no horizontal overflow after native layout settles`).toBeLessThanOrEqual(1)
      await testInfo.attach(`native-reader-${direction}`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
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
      const printHeadingMaxWidth = await page.evaluate(
        () => 80 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
      )

      expect(Math.abs(headerBounds.x - headerShellBounds.x), 'Print header starts at the printable shell edge').toBeLessThanOrEqual(2)
      expect(Math.abs(headerBounds.width - headerShellBounds.width), 'Print header fills the printable shell').toBeLessThanOrEqual(2)
      expect(Math.abs(headingsBounds.x - headerBounds.x), 'Print headings do not retain a metadata-rail offset').toBeLessThanOrEqual(2)
      expect(
        Math.abs(headingsBounds.width - Math.min(headerBounds.width, printHeadingMaxWidth)),
        'Print headings fill the shell up to their 80rem reading-width cap'
      ).toBeLessThanOrEqual(2)
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

  routedReaderTest('keeps search interaction and results inside every viewport', async ({ page }) => {
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
              excerpt: null,
              copySource: null,
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
              excerpt: null,
              copySource: null,
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
      await expect(page.locator('.nav-header .nav-header-browse')).toHaveCount(0)
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

    const taxonomyReview = page.getByRole('dialog').filter({
      has: page.getByRole('button', { name: /^Apply\b/i })
    })

    const applyReview = async (action: 'retirement' | 'restoration' | 'merge'): Promise<void> => {
      const dialog = taxonomyReview
      await expect(dialog).toBeVisible()
      await acknowledgeAccessIfNeeded(dialog)
      await dialog.getByRole('button', { name: `Apply ${action}`, exact: true }).click()
      await expect(page.getByText(successMessage, { exact: true })).toBeVisible()
    }

    await openAuthenticatedPage(page, '/a/dashboard', '.admin-main')
    const tagsLink = page.getByRole('main').getByRole('link', { name: /^Tags\b/i })
    await expect(tagsLink).toHaveAttribute('href', '/a/tags')
    await tagsLink.click()
    await expect(page).toHaveURL('/a/tags')

    const directoryRow = (tag: string, pressed: boolean) =>
      page.getByRole('complementary', { name: 'Tag directory', exact: true })
        .getByRole('button', { pressed })
        .filter({ has: page.getByText(tag, { exact: true }) })

    const directorySearch = page.getByRole('textbox', { name: 'Find a tag or label', exact: true })
    await directorySearch.fill(canonicalTag)
    const canonicalRow = directoryRow(canonicalTag, false)
    await expect(canonicalRow).toBeVisible()
    await canonicalRow.click()
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)

    const displayLabel = page.getByRole('textbox', { name: 'Display label', exact: true })
    const draftLabel = `${canonicalTitle} draft`
    await displayLabel.fill(draftLabel)
    await page.getByRole('button', { name: 'Review changes', exact: true }).click()
    const draftReview = taxonomyReview
    await expect(draftReview).toContainText('Update the display label')
    await expect(draftReview).toContainText(draftLabel)

    const reviewDiscard = page.getByRole('dialog', { name: 'Discard the unapplied taxonomy review?', exact: true })
    const draftDiscard = page.getByRole('dialog', { name: 'Discard the unsaved tag changes?', exact: true })
    await page.evaluate(() => window.history.back())
    await reviewDiscard.getByRole('button', { name: 'Discard', exact: true }).click()
    await draftDiscard.getByRole('button', { name: 'Keep editing', exact: true }).click()
    await expect(draftDiscard).not.toBeVisible()
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)
    await expect(draftReview).toBeVisible()
    await expect(draftReview).toContainText(draftLabel)
    await expect(displayLabel).toHaveValue(draftLabel)
    await draftReview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(displayLabel).toHaveValue(canonicalTitle)

    const ordinaryDraftLabel = `${canonicalTitle} ordinary draft`
    await displayLabel.fill(ordinaryDraftLabel)
    await page.evaluate(() => window.history.back())
    await draftDiscard.getByRole('button', { name: 'Keep editing', exact: true }).click()
    await expect(draftDiscard).not.toBeVisible()
    await expect(page).toHaveURL(`/a/tags?tag=${canonicalId}`)
    await expect(displayLabel).toHaveValue(ordinaryDraftLabel)
    await page.getByRole('button', { name: 'Reset', exact: true }).click()

    const canonicalPanel = await showLifecycle()
    await canonicalPanel.getByRole('button', { name: 'Review retirement', exact: true }).click()
    const canonicalReview = taxonomyReview
    await expect(canonicalReview).toContainText('Retire this name')
    await acknowledgeAccessIfNeeded(canonicalReview)

    await page.evaluate(() => window.history.back())
    await reviewDiscard.getByRole('button', { name: 'Keep editing', exact: true }).click()
    await expect(reviewDiscard).not.toBeVisible()
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
    await expect(directoryRow(canonicalTag, true)).toBeVisible()

    const aliasPanel = await openLifecycle(aliasSourceId)
    const destinationInput = aliasPanel.getByRole('combobox', { name: 'Canonical destination', exact: true })
    await destinationInput.fill(aliasDestinationTag)
    const destinationOption = page.getByRole('option', { name: aliasDestinationTag, exact: true })
    await expect(destinationOption).toBeVisible()
    await destinationOption.click()
    await aliasPanel.getByRole('button', { name: 'Review merge', exact: true }).click()
    await expect(taxonomyReview).toContainText('Bring two concepts together')
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
    await expect(directoryRow(aliasSourceTag, true)).toBeVisible()
    await activeAliasPanel.getByRole('button', { name: 'Review retirement', exact: true }).click()
    await expect(taxonomyReview).toContainText('Retire this name')
    await applyReview('retirement')
    await expect(page).toHaveURL(`/a/tags?tag=${aliasSourceId}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const archivedAliasPanel = await showLifecycle()
    await expect(archivedAliasPanel.getByRole('button', { name: 'Review restoration', exact: true })).toBeVisible()
    await selectVocabularyView('Archived names')
    const archivedAliasSearch = page.getByRole('textbox', { name: 'Find a tag or label', exact: true })
    await archivedAliasSearch.fill(aliasSourceTag)
    await expect(directoryRow(aliasSourceTag, true)).toBeVisible()

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(`/a/tags?tag=${canonicalId}`, { waitUntil: 'domcontentloaded' })
    const restorationPanel = await showLifecycle()
    await restorationPanel.getByRole('button', { name: 'Review restoration', exact: true }).click()
    await expect(taxonomyReview).toContainText('Restore this name')
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
    const expectEditorRelayout = async () => {
      await expect.poll(
        () => page.getByRole('textbox', { name: 'Editor content', exact: true }).evaluateAll(inputs => inputs.every(input => {
          const bounds = input.getBoundingClientRect()
          return bounds.left >= -1 && bounds.right <= window.innerWidth + 1
        })),
        'Monaco inputs finish native relayout after the documentation pane changes'
      ).toBe(true)
    }
    await page.getByRole('button', { name: 'Show Documentation Explorer', exact: true }).click()
    await expect(page.locator('.graphiql-doc-explorer')).toBeVisible()
    await expectEditorRelayout()
    await expectResponsiveLayout(page, 'GraphQL schema documentation')
    if (viewport.width <= 700) await expect(queryEditor).toBeHidden()
    await page.getByRole('button', { name: 'Hide Documentation Explorer', exact: true }).click()
    await expect(queryEditor).toBeVisible()
    await expect(queryEditor).toContainText('PaneRetention')
    await expectEditorRelayout()
    await expectResponsiveLayout(page, 'Restored GraphQL query')
  })

  test.describe('controlled phone workspace bootstrap', () => {
    test.use({ serviceWorkers: 'block' })

    test('keeps long workspace titles readable with phone Agent actions available', async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== 'responsive-chromium-mobile' && testInfo.project.name !== 'responsive-chromium-desktop',
        'Narrow header geometry covers both fine and coarse Chromium pointers.'
      )
      await authenticateAsAdmin(page)
      const workspaceTitle = 'Contract Design Team Workspace'
      await page.route('**/en/home?qa-title-fit=*', async route => {
        const response = await route.fetch()
        const html = await response.text()
        const body = html.replace(
          /(var\s+siteConfig\s*=\s*\{\s*"title"\s*:\s*)"(?:[^"\\]|\\.)*"/,
          (_, prefix: string) => prefix + JSON.stringify(workspaceTitle)
        )
        if (body === html) throw new Error('Workspace-title bootstrap fixture could not be installed')
        await route.fulfill({ status: response.status(), contentType: 'text/html; charset=utf-8', body })
      })

      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 812 })
        await openAuthenticatedPage(page, `/en/home?qa-title-fit=${width}`, '.nav-header')
        await page.evaluate(() => document.fonts.ready)
        const title = page.locator('.nav-header-title-stacked')
        await expectLocatorWithinViewport(title, 'Complete phone workspace title')
        await expect.poll(() => title.evaluate(box => {
          const lines = [...box.querySelectorAll<HTMLElement>('.nav-header-title-line')]
          return {
            title: lines.map(line => line.textContent).join(' '),
            fits: box.scrollHeight <= box.clientHeight + 1 &&
              lines.every(line => line.scrollWidth <= line.clientWidth + 1 && line.scrollHeight <= line.clientHeight + 1)
          }
        })).toEqual({ title: workspaceTitle, fits: true })
        const overflow = page.locator('.nav-header-mobile-actions')
        const search = page.getByRole('button', { name: 'Open search', exact: true })
        for (const control of [overflow, search]) {
          const bounds = await control.boundingBox()
          if (!bounds) throw new Error('Phone header action has no geometry')
          expect(bounds.width, 'Phone action target width').toBeGreaterThanOrEqual(44)
          expect(bounds.height, 'Phone action target height').toBeGreaterThanOrEqual(44)
        }
        await overflow.click()
        const entrance = page.getByRole('button', { name: 'Open Wiki Agent', exact: true })
        await expect(entrance).toBeVisible()
        await expect(page.getByRole('link', { name: 'Browse by Tags', exact: true })).toHaveAttribute('href', '/t')
        await entrance.focus()
        await entrance.press('Escape')
        await expect(overflow).toBeFocused()
        await expectResponsiveLayout(page, `Phone workspace title at ${width}px`)
      }
    })
  })

  test('restores the phone overflow opener after enabled Agent Escape from Search', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 1280) >= 600, 'Phone overflow handoff requires the xs breakpoint.')
    const fixture = await installEnabledAgentFixture(page, { mode: 'focus' })
    try {
      await page.setViewportSize({ width: 375, height: 812 })
      await openAuthenticatedPage(page, '/', '.nav-header')
      await openSearch(page)
      await expect(page.getByRole('dialog', { name: 'Search the Wiki', exact: true })).toBeVisible()
      const overflow = page.locator('.nav-header-mobile-actions')
      await overflow.click()
      await page.getByRole('button', { name: 'Open Wiki Agent', exact: true }).click()
      const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
      await expect(agent).toBeVisible()
      await expect(agent.getByRole('textbox', { name: 'Message Wiki Agent' })).toBeEnabled()
      await expect(page.locator('.v-menu.v-overlay--active')).toHaveCount(0)
      await agent.getByRole('button', { name: 'History', exact: true }).focus()
      await page.keyboard.press('Escape')
      await expect(agent).toBeHidden()
      await expect(overflow).toBeFocused()
    } finally {
      await fixture.dispose()
    }
  })

  test('keeps empty phone Agent starter actions unobstructed above the composer', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 1280) >= 600, 'Phone landing reflow requires the xs breakpoint.')
    const fixture = await installEnabledAgentFixture(page, { mode: 'focus' })
    try {
      await page.setViewportSize({ width: 375, height: 812 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openAuthenticatedPage(page, '/', '.nav-header')
      await page.locator('.nav-header-mobile-actions').click()
      await page.getByRole('button', { name: 'Open Wiki Agent', exact: true }).click()
      const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
      await expect(agent.getByRole('textbox', { name: 'Message Wiki Agent' })).toBeEnabled()
      await expect(page.locator('.v-menu.v-overlay')).toBeHidden()
      await expect.poll(async () => agent.evaluate(element => {
        const dock = element.querySelector('.inline-agent__conversation-dock')
        const controls = element.querySelectorAll('.inline-agent__composer button')
        const control = controls[controls.length - 1]
        if (!dock || !control) throw new Error('The ready workspace must expose its composer dock and controls.')
        const gap = element.getBoundingClientRect().bottom - dock.getBoundingClientRect().bottom
        return gap - control.getBoundingClientRect().height
      }), { message: 'An empty conversation must not leave its bottom dock beyond a touch target of the panel edge.' }).toBeLessThanOrEqual(1)
      const starter = agent.getByRole('button', { name: /Catch up/i }).first()
      await expect(starter).toBeEnabled()
      await starter.scrollIntoViewIfNeeded()
      await expect.poll(async () => starter.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return [rect.y + rect.height / 2, rect.bottom - Math.min(12, rect.height / 4)].every(y => {
          const target = document.elementFromPoint(rect.x + rect.width / 2, y)
          return target !== null && element.contains(target)
        })
      }), { message: 'The composer must not intercept the last starter action or its description.' }).toBe(true)
    } finally {
      await fixture.dispose()
    }
  })

  test('keeps Agent Chat readable and operable', async ({ page }) => {
    await openAuthenticatedPage(page, '/', '.page-header-section')
    const originalPageUrl = page.url()
    const originalPageTitle = (await page.locator('.page-title').first().innerText()).trim()
    const originalArticleId = await page.locator('article.contents').first().getAttribute('id')
    expect(originalPageTitle, 'The invoking page exposes a stable reader identity').not.toBe('')
    expect(originalArticleId, 'The invoking article has an identity to preserve').not.toBeNull()
    expect(await page.locator('article.contents').first().evaluate(element => document.getElementById(element.id) === element), 'The invoking article identity resolves to the original reader').toBe(true)

    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return
    const searchControl =
      viewport.width < 960 ? page.locator('.nav-header-search-toggle:visible').first() : page.locator('.nav-header-search-control input:visible').first()
    await expect(searchControl).toBeVisible()

    if (viewport.width < 600) {
      const overflow = page.locator('.nav-header-mobile-actions')
      await expectLocatorWithinViewport(overflow, 'Compact header actions')
      await searchControl.focus()
      await searchControl.press('Tab')
      await expect(overflow).toBeFocused()
      await overflow.press('Enter')
      const browse = page.getByRole('link', { name: 'Browse by Tags', exact: true })
      await expectLocatorWithinViewport(browse, 'Browse by Tags menu link')
      await expect(browse).toHaveAttribute('href', '/t')
      const entrance = page.getByRole('button', { name: 'Open Wiki Agent', exact: true })
      await entrance.focus()
      await entrance.press('Escape')
      await openSearch(page)
      await page.locator('.nav-header-search-control input:visible').first().fill('home')
      await expect(page.getByRole('dialog', { name: 'Search the Wiki', exact: true })).toBeVisible()
      await overflow.click()
      await entrance.focus()
      await entrance.press('Enter')
      const openedAgent = page.getByRole('region', { name: 'Wiki Agent' })
      await expect(openedAgent).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(openedAgent).toBeHidden()
      await expect(overflow).toBeFocused()
    } else {

      const entrance = page.getByRole('button', { name: 'Open Wiki Agent', exact: true })
      await expectLocatorWithinViewport(entrance, 'Wiki Agent entrance')
      const browse = page.getByRole('link', { name: 'Browse by Tags', exact: true })
      await expectLocatorWithinViewport(browse, 'Browse by Tags link')
      await expect(browse).toHaveAttribute('href', '/t')
      if (viewport.width >= 960) {
        const field = await page.locator('.nav-header-command .nav-header-search-control').boundingBox()
        expect(field).not.toBeNull()
        expect(Math.abs(field!.x + field!.width / 2 - viewport.width / 2), 'Search is centered in the viewport').toBeLessThanOrEqual(1)
      }

      const [searchBounds, agentBounds, browseBounds] = await Promise.all([searchControl.boundingBox(), entrance.boundingBox(), browse.boundingBox()])
      expect(searchBounds).not.toBeNull()
      expect(agentBounds).not.toBeNull()
      expect(browseBounds).not.toBeNull()
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
      const beforeSearch = viewport.width < 960 ? entrance : browse
      const afterSearch = viewport.width < 960 ? browse : entrance
      await expect(beforeSearch).toBeFocused()
      await beforeSearch.press('Tab')
      await expect(searchControl).toBeFocused()
      await searchControl.press('Tab')
      await expect(afterSearch).toBeFocused()
    }
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
    const wikiSearchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
    await expect(wikiSearchDialog).toBeVisible()
    const searchInput = page.locator('.nav-header-search-control input:visible').first()
    await expect(searchInput).toBeVisible()
    await searchInput.fill('home')
    await expect(searchInput).toHaveValue('home')
    await expect(wikiSearchDialog.locator('.search-results-item')).not.toHaveCount(0)
    const searchResultTitles = (await wikiSearchDialog.locator('.search-results-item .v-list-item-title').allTextContents()).map(title => title.trim())
    expect(searchResultTitles, 'The initial query returns at least one result').not.toHaveLength(0)

    const askAgentButton = wikiSearchDialog.getByRole('button', { name: 'Ask about this', exact: true })
    await expect(askAgentButton).toBeVisible()
    await askAgentButton.click()

    const agent = page.getByRole('region', { name: 'Wiki Agent' })
    await expect(agent).toBeVisible()
    const newChatButton = agent.getByRole('button', { name: 'New chat', exact: true })
    const settingsButton = agent.getByRole('button', { name: 'More chat actions', exact: true })
    const settingsMenu = agent.locator('.v-menu.v-overlay--active')
    await expect(newChatButton).toBeVisible()
    await settingsButton.click()
    const temporaryChatAction = settingsMenu.getByText('Temporary chat', { exact: true })
    await expect(temporaryChatAction).toBeVisible()
    // Dismiss the actions menu with a pointer press on the agent chrome.
    const dismissBounds = await agent.boundingBox()
    if (!dismissBounds) throw new Error('Wiki Agent surface has no geometry')
    await page.mouse.click(dismissBounds.x + 16, dismissBounds.y + 16)
    await expect(settingsMenu).toBeHidden()
    await expect(agent.locator('.inline-agent__starter').first()).toBeVisible()

    await expect(agent.getByRole('textbox', { name: 'Message Wiki Agent' })).toBeVisible()
    const panelFocusTarget = agent.getByRole('button', { name: 'History', exact: true })
    await expect(panelFocusTarget).toBeVisible()
    const card = agent.locator('.inline-agent__card')
    const visibleSidePanels = agent.locator('.inline-agent__side:visible')
    const scrim = agent.locator('.inline-agent__scrim')
    const historyPanel = agent.getByRole('complementary', { name: 'Conversations' })
    const memoryPanel = agent.getByRole('complementary', { name: 'Agent memory' })
    const historyDialog = agent.getByRole('dialog', { name: 'Conversations' })

    if (viewport.width >= 1024) {
      await panelFocusTarget.click()
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
      await agent.locator('.inline-agent__memory-toggle').click()
      await expect(memoryPanel).toBeVisible()
      await expect(historyPanel).toBeHidden()
      await expect(visibleSidePanels).toHaveCount(1)
      await expect(scrim).toHaveCount(0)
      await expect(memoryPanel).not.toHaveAttribute('aria-modal', 'true')
      await expect.poll(() => memoryPanel.evaluate(element => getComputedStyle(element).position)).toBe('relative')
      await expectLocatorWithinViewport(memoryPanel, 'Exclusive left Memory panel')
      await expect.poll(async () => {
        const [memoryBounds, memoryCard] = await Promise.all([memoryPanel.boundingBox(), card.boundingBox()])
        return Boolean(memoryBounds && memoryCard && memoryBounds.x + memoryBounds.width <= memoryCard.x)
      }).toBe(true)
      await memoryPanel.getByRole('button', { name: 'Close agent memory' }).click()
      await expect(memoryPanel).toBeHidden()
      await expect(visibleSidePanels).toHaveCount(0)
    } else {
      await panelFocusTarget.click()
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

    const closeChatPanel = agent.getByRole('button', { name: 'Close Wiki Agent', exact: true })
    await expect(closeChatPanel).toBeVisible()
    await closeChatPanel.click()
    await expect(agent).toBeHidden()
    if (viewport.width >= 960) await page.keyboard.press('ControlOrMeta+K')
    else await openSearch(page)
    const reopenedSearchInput = page.locator('.nav-header-search-control input:visible').first()
    await expect(wikiSearchDialog).toBeVisible()
    await expect(reopenedSearchInput).toBeFocused()
    await reopenedSearchInput.fill('home')
    await expect(reopenedSearchInput).toHaveValue('home')
    await expect(wikiSearchDialog.locator('.search-results-item .v-list-item-title')).toHaveText(searchResultTitles)
    await expect(page.locator('.search-results-search')).toBeVisible()
    expect(page.url(), 'Closing the Agent keeps the invoking page URL').toBe(originalPageUrl)
    await expect(page.locator('.page-title').first()).toHaveText(originalPageTitle)
    expect(await page.locator('article.contents').first().getAttribute('id'), 'Closing the Agent keeps the invoking article identity').toBe(originalArticleId)
    const reopenAskAgentButton = wikiSearchDialog.getByRole('button', { name: 'Ask about this', exact: true })
    await expect(reopenAskAgentButton).toBeVisible()
    await reopenAskAgentButton.click()
    await expect(agent).toBeVisible()
    await expectLocatorWithinViewport(agent, 'Wiki Agent panel')
    await expectResponsiveLayout(page, 'Wiki Agent panel')
    await page.context().clearCookies()
    const anonymousIdentityResponse = page.waitForResponse(response => {
      const request = response.request()
      return request.method() === 'GET' && new URL(response.url()).pathname === '/_api/users/whoami'
    })
    // Background channels are not reader readiness; wait for the native identity transition instead.
    await page.goto('/en/home', { waitUntil: 'domcontentloaded' })
    const anonymousIdentity = await anonymousIdentityResponse
    expect(anonymousIdentity.status(), 'The reader rechecks native identity after cookies are cleared').toBe(200)
    expect(await anonymousIdentity.json()).toEqual({ authenticated: false, user: null })
    await expect(page.locator('.page-header-section')).toBeVisible()
    await expect(page.locator('.nav-header-agent:visible')).toHaveCount(0)
    if (viewport.width < 600) await page.locator('.nav-header-mobile-actions').click()
    const browseWithoutAgent = page.getByRole('link', { name: 'Browse by Tags', exact: true })
    await expectLocatorWithinViewport(browseWithoutAgent, 'Browse by Tags link without Wiki Agent')
    await expect(browseWithoutAgent).toHaveAttribute('href', '/t')
    await expect(browseWithoutAgent).toHaveAttribute('aria-label', 'Browse by Tags')
    await browseWithoutAgent.focus()
    await expect(browseWithoutAgent).toBeFocused()
    await browseWithoutAgent.press('Enter')
    await expect(page).toHaveURL('/t')
    if (viewport.width < 600) await page.locator('.nav-header-mobile-actions').click()
    await expect(page.getByRole('link', { name: 'Browse by Tags', exact: true })).toHaveAttribute('aria-current', 'page')
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
  test('keeps Agent source controls stable and Latest navigation smoothly responsive', async ({ page }, testInfo) => {
    const desktopProject = testInfo.project.name === 'responsive-chromium-desktop' || testInfo.project.name === 'responsive-chromium-wide'
    const coarseProject = testInfo.project.name === 'responsive-chromium-mobile'
    if (!desktopProject && !coarseProject) return
    if (coarseProject) await page.setViewportSize({ width: 320, height: 640 })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: desktopProject ? 'no-preference' : 'reduce' })
    await page.route('**/_api/users/whoami', route =>
      route.fulfill({
        json: {
          authenticated: true,
          user: { id: 900001, authVersion: 1, name: 'Agent layout fixture', email: 'layout@example.invalid', permissions: ['use:agents'], localeCode: 'en' }
        }
      })
    )
    await page.route(/\/_api\/pages\/\d+\/watch$/, route => route.fulfill({ json: { watched: false, emailEnabled: false, inAppEnabled: false } }))
    await page.route(/\/_api\/pages\/\d+\/approval$/, route => route.fulfill({ json: { approval: null } }))
    await page.route('**/_api/pages/watches/notifications', route =>
      route.fulfill({ json: { ownerId: 900001, items: [], unreadCount: 0, nextCursor: null, unreadComplete: true } })
    )
    await page.route('**/_api/pages/approvals/inbox', route => route.fulfill({ json: { ownerId: 900001, items: [], nextCursor: null } }))
    const sources = Array.from({ length: 3 }, (_, index) => ({
      id: 701 + index,
      locale: 'en',
      path: `release-source-${index + 1}`,
      title: `Release evidence source ${index + 1} with a long descriptive title`,
      description: 'A deterministic source for layout checks.',
      visibility: 'public' as const,
      updatedAt: '2026-09-01T12:00:00.000Z',
      sourceRevision: '1',
      excerpt: 'Release evidence',
      excerptTruncated: false
    }))
    await page.route('**/_api/pages/search?**', route =>
      route.fulfill({
        json: {
          results: sources.map(source => ({ ...source, copySource: null, tags: [], score: 10, matchedFields: ['title'] })),
          suggestions: [],
          totalHits: sources.length,
          nextCursor: null
        }
      })
    )
    await page.route('**/_api/pages/preview?**', route => {
      const id = Number(new URL(route.request().url()).searchParams.get('id'))
      const source = sources.find(item => item.id === id)
      return source ? route.fulfill({ json: source }) : route.fulfill({ status: 404, json: { error: 'Fixture source not found' } })
    })
    const earlierImageId = '00000000-0000-4000-8000-000000000191'
    const earlierImageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="420"><rect width="180" height="420" fill="#557783"/></svg>'
    const fixture = await installEnabledAgentFixture(page, {
      mode: 'latest',
      skillsEnabled: true,
      goalsEnabled: true,
      firstMessageMedia: [{
        id: earlierImageId,
        kind: 'attachment',
        filename: 'Earlier release evidence.svg',
        mimeType: 'image/svg+xml',
        byteLength: Buffer.byteLength(earlierImageBody),
        available: true,
        detached: false
      }]
    })
    let releaseEarlierImage!: () => void
    let earlierImageRequested = false
    const earlierImageGate = new Promise<void>(resolve => { releaseEarlierImage = resolve })
    await page.route(`**/_api/agents/media/${earlierImageId}/content`, async route => {
      earlierImageRequested = true
      await earlierImageGate
      await route.fulfill({ contentType: 'image/svg+xml', body: earlierImageBody })
    })
    let releaseResponse: (() => void) | null = null
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.nav-header')).toBeVisible({ timeout: 15_000 })
      const search = await openSearch(page)
      await search.fill('release')
      const searchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
      await searchDialog.getByRole('button', { name: 'Ask about this', exact: true }).click()
      const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
      const composer = agent.locator('.agent-composer textarea')
      await expect(composer).toBeEnabled()
      const moreOptions = agent.getByRole('button', { name: 'More options', exact: true })
      const goal = agent.getByRole('button', { name: 'Goal', exact: true })
      const moreMenu = page.locator('.agent-composer__more-menu')
      await expect(moreOptions).toBeVisible()
      const skillsOption = moreMenu.locator('.v-list-item').filter({ hasText: 'Skills' })
      await moreOptions.focus()
      await moreOptions.press('Enter')
      await expect(skillsOption).toBeVisible()
      await skillsOption.focus()
      await skillsOption.press('Enter')
      const skillsDialog = page.getByRole('dialog', { name: 'Skills', exact: true })
      await expect(skillsDialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(skillsDialog).toBeHidden()
      if ((await moreOptions.getAttribute('aria-expanded')) === 'true') await page.keyboard.press('Escape')
      await expect(moreOptions).toHaveAttribute('aria-expanded', 'false')
      await expect(moreMenu).toBeHidden()
      if (!(await goal.isVisible())) {
        await moreOptions.click()
        await expect(moreMenu.getByText('Goal', { exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(moreMenu).toBeHidden()
      }
      const controlPlacement = () =>
        agent.locator('.agent-composer__context-controls').evaluate(element => {
          const group = element.getBoundingClientRect()
          return ['.agent-composer__goal-toggle', '.agent-composer__more-button'].flatMap(selector => {
            const control = element.querySelector<HTMLElement>(selector)
            if (!control) return []
            const bounds = control.getBoundingClientRect()
            return [{ selector, x: bounds.x - group.x, y: bounds.y - group.y, width: bounds.width, height: bounds.height }]
          })
        })

      const beforeSources = await controlPlacement()
      await agent.getByRole('button', { name: 'Add sources', exact: true }).click()
      const sourceDialog = page.getByRole('dialog', { name: 'Add sources', exact: true })
      await sourceDialog.getByRole('textbox', { name: 'Search pages', exact: true }).fill('release')
      await expect(sourceDialog.getByRole('checkbox')).toHaveCount(sources.length)
      for (const source of sources) {
        const row = sourceDialog.locator('.agent-context__result-label').filter({ hasText: source.title })
        await row.click()
        await expect(row.getByRole('checkbox')).toBeChecked()
      }
      await sourceDialog.getByRole('button', { name: 'Add 3 selected sources', exact: true }).click()
      await expect(sourceDialog).toBeHidden()
      await expect(agent.locator('.agent-context__sources .v-chip')).toHaveCount(3)
      const afterSources = await controlPlacement()
      expect(afterSources).toHaveLength(beforeSources.length)
      for (const [index, before] of beforeSources.entries()) {
        const after = afterSources[index]!
        expect(after.selector).toBe(before.selector)
        expect(Math.abs(after.x - before.x), 'Adding source chips keeps remaining composer controls stable').toBeLessThanOrEqual(1)
        expect(Math.abs(after.y - before.y), 'Adding source chips keeps remaining composer controls stable').toBeLessThanOrEqual(1)
      }
      const [sourceBounds, scopeBounds, editorBounds] = await Promise.all([
        agent.locator('.agent-context__sources').boundingBox(),
        agent.locator('.agent-context__scope').boundingBox(),
        agent.locator('.agent-composer__editor').boundingBox()
      ])
      expect(sourceBounds).not.toBeNull()
      expect(scopeBounds).not.toBeNull()
      expect(editorBounds).not.toBeNull()
      if (sourceBounds && scopeBounds && editorBounds) {
        // D3 keeps attached page context in the composer, after the source
        // controls and before the prompt; it must not obscure either control.
        expect(sourceBounds.y).toBeGreaterThanOrEqual(scopeBounds.y + scopeBounds.height - 1)
        expect(sourceBounds.y + sourceBounds.height).toBeLessThanOrEqual(editorBounds.y + 1)
      }
      // Remove the chips after testing placement so the small viewport can focus on reading behavior.
      for (const source of sources) await agent.getByRole('button', { name: `Remove source ${source.title}`, exact: true }).click()
      await expect(agent.locator('.agent-context__sources')).toHaveCount(0)
      const transcript = agent.locator('.inline-agent__transcript')
      await composer.fill('Show enough release evidence to inspect the latest response navigation.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.locator('.agent-message--assistant').last()).toContainText(
        'The final checkpoint keeps the newest response at the end of the conversation.'
      )
      const footer = agent.locator('.inline-agent__composer')
      const latest = agent.getByRole('button', { name: 'Jump to latest response', exact: true })
      const face = latest.locator('.inline-agent__follow-jump-face')
      const distanceFromBottom = () => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
      const captureLayout = async (name: string) => {
        await page.mouse.move(1, 1)
        const path = testInfo.outputPath(`${name}.png`)
        await page.screenshot({ path })
        await testInfo.attach(name, { path, contentType: 'image/png' })
      }
      const readAtDistance = async (distance: number) => {
        await page.mouse.move(1, 1)
        await transcript.focus()
        await transcript.evaluate(
          (element, requestedDistance) =>
            element.scrollTo({ top: Math.max(0, element.scrollHeight - element.clientHeight - requestedDistance), behavior: 'auto' }),
          distance
        )
        await expect.poll(distanceFromBottom).toBeCloseTo(distance, 0)
      }
      await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(400)
      await expect.poll(distanceFromBottom, { message: 'A newly completed assistant response is brought into view' }).toBeLessThanOrEqual(25)
      // Use the normal AgentThread attachment and an actual delayed image decode:
      // growing media above the viewport must not displace the message being read.
      await transcript.focus()
      await transcript.evaluate(element => element.scrollTo({ top: 0, behavior: 'auto' }))
      await expect.poll(() => earlierImageRequested).toBe(true)
      const earlierImage = agent.getByRole('img', { name: 'Earlier release evidence.svg', exact: true })
      expect(await earlierImage.evaluate(element => (element as HTMLImageElement).naturalHeight)).toBe(0)
      const readingMessage = agent.locator('.agent-message--assistant').first().locator('p').filter({
        hasText: /^Verification checkpoint 3:/
      })
      await readingMessage.evaluate(element => {
        const container = element.closest<HTMLElement>('.inline-agent__transcript')
        if (!container) throw new Error('The reading message has no transcript scrollport')
        container.scrollTo({
          top: container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - 32,
          behavior: 'auto'
        })
      })
      await expect(latest).toBeVisible()
      const beforeImageReadingBounds = await readingMessage.boundingBox()
      const beforeImageBounds = await earlierImage.boundingBox()
      const beforeImageTranscriptBounds = await transcript.boundingBox()
      if (!beforeImageReadingBounds || !beforeImageBounds || !beforeImageTranscriptBounds) throw new Error('The delayed image and reading message need native browser geometry')
      expect(beforeImageReadingBounds.y).toBeGreaterThanOrEqual(beforeImageTranscriptBounds.y)
      expect(beforeImageBounds.y + beforeImageBounds.height, 'The delayed attachment is above the currently read message').toBeLessThan(beforeImageTranscriptBounds.y)
      const beforeImageScrollHeight = await transcript.evaluate(element => element.scrollHeight)
      releaseEarlierImage()
      await earlierImage.evaluate(async element => {
        await (element as HTMLImageElement).decode()
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      })
      expect(await earlierImage.evaluate(element => (element as HTMLImageElement).naturalHeight)).toBe(420)
      expect(await transcript.evaluate(element => element.scrollHeight) - beforeImageScrollHeight, 'The delayed image causes genuine transcript growth').toBeGreaterThan(300)
      const afterImageReadingBounds = await readingMessage.boundingBox()
      if (!afterImageReadingBounds) throw new Error('The read message disappeared after image loading')
      expect(Math.abs(afterImageReadingBounds.y - beforeImageReadingBounds.y), 'Native anchoring preserves the read message on desktop and phone').toBeLessThanOrEqual(1)
      await expect(latest).toBeVisible()
      await latest.click()
      await expect.poll(distanceFromBottom, { message: 'Latest still resumes following after delayed earlier media' }).toBeLessThanOrEqual(25)
      await readAtDistance(400)
      await expect(latest).toBeVisible()
      await captureLayout('agent-reading-earlier-light')
      await page.emulateMedia({ colorScheme: 'dark' })
      await captureLayout('agent-reading-earlier-dark')
      await page.emulateMedia({ colorScheme: 'light' })
      const [latestBounds, faceBounds, footerBounds] = await Promise.all([latest.boundingBox(), face.boundingBox(), footer.boundingBox()])
      expect(latestBounds).not.toBeNull()
      expect(faceBounds).not.toBeNull()
      expect(footerBounds).not.toBeNull()
      if (latestBounds && faceBounds && footerBounds) {
        expect(faceBounds.y + faceBounds.height).toBeLessThanOrEqual(footerBounds.y + 1)
        if (coarseProject) expect(Math.min(latestBounds.width, latestBounds.height)).toBeGreaterThanOrEqual(44)
      }
      await readAtDistance(20)
      await expect(latest).toBeHidden()
      await readAtDistance(400)
      await latest.focus()
      await latest.press('Enter')
      await expect.poll(distanceFromBottom).toBeLessThanOrEqual(25)
      await expect(latest).toBeHidden()
      await expect(transcript).toBeFocused()
      await readAtDistance(400)
      await latest.click()
      await expect.poll(distanceFromBottom).toBeLessThanOrEqual(25)
      await expect(transcript).toBeFocused()
      await captureLayout('agent-latest-at-bottom')
      // A held provider response distinguishes submission scrolling from response-arrival scrolling.
      releaseResponse = fixture.pauseNextResponse()
      await composer.fill('Show another complete review while preserving readable earlier messages.')
      await readAtDistance(400)
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.locator('.agent-message--user').last()).toContainText('Show another complete review')
      await expect.poll(distanceFromBottom, { message: 'Submitting a message immediately returns to the newest messages' }).toBeLessThanOrEqual(25)
      await readAtDistance(400)
      const earlierScrollTop = await transcript.evaluate(element => element.scrollTop)
      releaseResponse()
      releaseResponse = null
      await expect(agent.locator('.agent-message--assistant').last()).toContainText(
        'The final checkpoint keeps the newest response at the end of the conversation.'
      )
      await expect.poll(() => transcript.evaluate(element => element.scrollTop), {
        message: 'The arriving response leaves the reader at the same earlier message'
      }).toBeCloseTo(earlierScrollTop, 0)
      await expect.poll(distanceFromBottom).toBeGreaterThan(400)
      await expect(latest).toBeVisible()
      await readAtDistance(400)
      await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active', reducedMotion: 'reduce' })
      await expect(latest).toBeVisible()
      await latest.click()
      await expect(transcript).toBeFocused()
      await expect.poll(distanceFromBottom).toBeLessThanOrEqual(25)
      expect(await agent.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await transcript.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      fixture.assertNoUnexpectedRequests()
    } finally {
      releaseResponse?.()
      releaseEarlierImage()
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
      await approvalCard.locator('.proposal-diff pre').hover()
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

      await page.keyboard.press('ControlOrMeta+K')
      const searchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
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
  test.describe('Agent browser context fixture', () => {
    test.use({ serviceWorkers: 'block' })

    test('preserves a source draft while the Agent code is still loading', async ({ page }, testInfo) => {
      test.skip(!['responsive-chromium-desktop', 'responsive-chromium-mobile'].includes(testInfo.project.name))
      const fixture = await installEnabledAgentFixture(page)
      const { promise: codeReady, resolve: releaseCode } = Promise.withResolvers<void>()
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      await page.route('**/js/inline-agent-chat-*.js', async route => {
        await codeReady
        await route.continue()
      })
      try {
        await authenticateAsAdmin(page)
        await page.goto('/en/home', { waitUntil: 'networkidle' })
        await openSearch(page)
        const searchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
        await page.locator('.nav-header-search-control:visible input').first().fill('visual')
        const result = searchDialog.locator('.search-results-row').filter({ hasText: 'visual-markdown-browser' }).first()
        await expect(result).toBeVisible()
        await result.locator('.search-results-preview').click()
        const preview = page.locator('.wiki-source-preview__panel')
        await preview.getByRole('button', { name: 'Ask about this page', exact: true }).click()
        await expect(page.locator('.search-results--ask .async-component-state[role="status"]')).toBeVisible()
        releaseCode()
        const agent = page.getByRole('region', { name: 'Wiki Agent', exact: true })
        const composer = agent.getByRole('textbox', { name: /^(?:Message|Follow up with) Wiki Agent$/ })
        await expect(composer).toHaveValue('visual')
        await expect(agent.locator('.agent-context__source-label').filter({ hasText: /Visual Markdown/ })).toBeVisible()
        if (testInfo.project.name === 'responsive-chromium-desktop') await expect(composer).toBeFocused()
        expect(fixture.requests.filter(request => request.includes('/messages'))).toEqual([])
        expect(pageErrors).toEqual([])
        fixture.assertNoUnexpectedRequests()
      } finally {
        releaseCode()
        await fixture.dispose()
      }
    })

    test('Agent continuity resumes within a working day and starts fresh only after expiry', async ({ page }, testInfo) => {
      test.skip(!['responsive-chromium-desktop', 'responsive-chromium-mobile'].includes(testInfo.project.name))
      await installAgentContinuityPages(page)
      const fixture = await installEnabledAgentFixture(page, { distinctSessionIds: true })
      const creates = () => fixture.requests.filter(value => value === 'POST /_api/agents/sessions').length
      try {
        let agent = await openContinuityAgent(page, '/agent-context-fixture-a')
        await sendContinuityPrompt(page, agent, 'Keep this conversation briefly.')
        expect(creates()).toBe(1)
        await closeContinuityAgent(page)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(page.locator('.nav-header')).toBeVisible({ timeout: 15_000 })
        const originalDateNow = await page.evaluateHandle(() => Date.now)
        await page.evaluate(() => {
          const original = Date.now
          Date.now = () => original() + 30 * 60_000
        })
        agent = await openContinuityAgent(page)
        await expect(agent.locator('.agent-message--user')).toContainText('Keep this conversation briefly.')
        expect(creates()).toBe(1)
        await closeContinuityAgent(page)
        await page.evaluate(() => {
          const original = Date.now
          Date.now = () => original() + 8 * 60 * 60_000 + 1
        })
        agent = await openContinuityAgent(page)
        await expect(agent.locator('.agent-message--user')).toHaveCount(0)
        expect(creates()).toBe(2)
        await sendContinuityPrompt(page, agent, 'A new conversation after the resume window.')
        // Return to real wall time before another document reads the bookmark.
        await originalDateNow.evaluate(original => { Date.now = original })
        await originalDateNow.dispose()
        await closeContinuityAgent(page)
        agent = await openContinuityAgent(page, '/agent-context-fixture-b')
        await expect(agent.locator('.agent-message--user')).toContainText('A new conversation after the resume window.')
        expect(creates()).toBe(2)
        // The context picker shows one compact page chip for the current page.
        await expect(agent.locator('.agent-context__page-chip')).toContainText('Context page B')
        fixture.assertNoUnexpectedRequests()
      } finally {
        await fixture.dispose()
      }
    })

    test('resumed expired Agent closes without sending and explicit reopening recovers its draft', async ({ page }, testInfo) => {
      test.skip(!['responsive-chromium-desktop', 'responsive-chromium-mobile'].includes(testInfo.project.name))
      await installAgentContinuityPages(page)
      const fixture = await installEnabledAgentFixture(page, { distinctSessionIds: true })
      let expired = false
      let expiredReads = 0
      const expireSession = async (route: import('@playwright/test').Route) => {
        const path = new URL(route.request().url()).pathname
        if (expired && route.request().method() === 'GET' && /^\/_api\/agents\/sessions\/[^/]+$/.test(path)) {
          expiredReads++
          await route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'Session expired', code: 'AGENT_RESOURCE_NOT_FOUND' }) })
          return
        }
        if (route.request().method() === 'POST' && path === '/_api/agents/sessions') expired = false
        await route.fallback()
      }
      await page.route('**/_api/agents/**', expireSession)
      try {
        const agent = await openContinuityAgent(page, '/agent-context-fixture-a')
        const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent', exact: true })
        await expect(composer).toBeEnabled()
        await composer.fill('Preserve this unsent composition across expiry.')
        const documentIdentity = await page.evaluate(() => performance.timeOrigin)
        expired = true
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expect(page.getByRole('dialog', { name: 'Wiki Agent workspace', exact: true })).toHaveCount(0)
        expect(expiredReads).toBeGreaterThan(0)
        expect(fixture.requests.filter(request => request.includes('/messages'))).toEqual([])
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentIdentity)
        // Explicit search reopening appends its new query to the recovered draft.
        await openContinuityAgent(page, undefined, 'Preserve this unsent composition across expiry.\n\ncontext')
        expect(fixture.requests.filter(request => request === 'POST /_api/agents/sessions')).toHaveLength(2)
        expect(fixture.requests.filter(request => request.includes('/messages'))).toEqual([])
        fixture.assertNoUnexpectedRequests()
      } finally {
        await page.unroute('**/_api/agents/**', expireSession)
        await fixture.dispose()
      }
    })

    test('Agent continuity follows the tab across pages without collecting visited sources', async ({ page }, testInfo) => {
      test.skip(!['responsive-chromium-desktop', 'responsive-chromium-mobile'].includes(testInfo.project.name))
      await installAgentContinuityPages(page)
      const fixture = await installEnabledAgentFixture(page, { distinctSessionIds: true })
      const creates = () => fixture.requests.filter(value => value === 'POST /_api/agents/sessions').length
      try {
        let agent = await openContinuityAgent(page, '/agent-context-fixture-a')
        const initial = await sendContinuityPrompt(page, agent, 'Start with page A.')
        expect(initial.currentPage?.id).toBe(901)
        expect(initial.knowledgeContext.sources).toEqual([])
        await agent.getByRole('button', { name: 'More chat actions', exact: true }).click()
        const actions = agent.locator('.v-menu.v-overlay--active')
        await expect(actions).toBeVisible()
        await expect(actions.getByText('Temporary chat', { exact: true })).toBeVisible()
        await expect(actions.getByText('Temporary chat', { exact: true })).toBeInViewport()
        await page.screenshot({ path: testInfo.outputPath('automatic-chat-actions.png'), animations: 'disabled' })
        const chrome = await agent.boundingBox()
        if (!chrome) throw new Error('Wiki Agent surface has no geometry')
        await page.mouse.click(chrome.x + 16, chrome.y + 16)
        await expect(actions).toBeHidden()
        await closeContinuityAgent(page)
        const originalDocument = await page.evaluate(() => performance.timeOrigin)
        await page.getByRole('link', { name: 'Context page B', exact: true }).click()
        await expect(page).toHaveURL('/agent-context-fixture-b')
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalDocument)
        agent = await openContinuityAgent(page)
        await expect(agent.locator('.agent-message--user')).toHaveCount(1)
        const second = await sendContinuityPrompt(page, agent, 'Continue on page B.')
        expect(second.currentPage?.id).toBe(902)
        expect(second.knowledgeContext.sources).toEqual([])
        await agent.locator('.agent-context__page-chip').click()
        await expect(agent.locator('.agent-context__page-chip')).toHaveAttribute('aria-pressed', 'false')
        await closeContinuityAgent(page)
        agent = await openContinuityAgent(page, '/agent-context-fixture-c')
        await expect(agent.locator('.agent-context__page-chip')).toHaveAttribute('aria-pressed', 'false')
        const third = await sendContinuityPrompt(page, agent, 'Continue without including the current page.')
        expect(third.currentPage).toBeUndefined()
        expect(third.knowledgeContext.sources).toEqual([])
        await closeContinuityAgent(page)
        agent = await openContinuityAgent(page, '/agent-context-fixture-a')
        const revisited = await sendContinuityPrompt(page, agent, 'Return without adding visited pages.')
        expect(revisited.currentPage).toBeUndefined()
        expect(revisited.knowledgeContext.sources).toEqual([])
        await expect(agent.locator('.agent-message--user')).toHaveCount(4)
        expect(creates()).toBe(1)

        await agent.getByRole('button', { name: 'New chat', exact: true }).click()
        await expect(agent.locator('.agent-message--user')).toHaveCount(0)
        await expect(agent.locator('.agent-composer textarea')).toBeEnabled()
        const fresh = await sendContinuityPrompt(page, agent, 'Start a deliberately new conversation.')
        expect(fresh.currentPage?.id).toBe(901)
        expect(fresh.knowledgeContext.sources).toEqual([])
        expect(creates()).toBe(2)
        await closeContinuityAgent(page)
        agent = await openContinuityAgent(page, '/agent-context-fixture-b')
        await expect(agent.locator('.agent-message--user')).toHaveCount(1)
        await expect(agent.locator('.agent-message--user')).toContainText('Start a deliberately new conversation.')
        expect(creates()).toBe(2)
        fixture.assertNoUnexpectedRequests()
      } finally {
        await fixture.dispose()
      }
    })

    test('Agent continuity keeps duplicated tabs independent when their current-page choices differ', async ({ page, context }, testInfo) => {
      test.skip(!['responsive-chromium-desktop', 'responsive-chromium-mobile'].includes(testInfo.project.name))
      await installAgentContinuityPages(context)
      const fixture = await installEnabledAgentFixture(context, { distinctSessionIds: true })
      let second: Page | undefined
      try {
        let agent = await openContinuityAgent(page, '/agent-context-fixture-a')
        await sendContinuityPrompt(page, agent, 'One conversation, independent tab context.')
        await closeContinuityAgent(page)
        const opened = page.waitForEvent('popup')
        await page.evaluate(() => { window.open('/agent-context-fixture-b', '_blank') })
        second = await opened
        await expect(second.locator('.page-header-section')).toBeVisible()
        let otherAgent = await openContinuityAgent(second)
        await expect(otherAgent.locator('.agent-message--user')).toContainText('One conversation, independent tab context.')
        await otherAgent.locator('.agent-context__page-chip').click()
        await expect(otherAgent.locator('.agent-context__page-chip')).toHaveAttribute('aria-pressed', 'false')
        await closeContinuityAgent(second)

        await page.reload({ waitUntil: 'domcontentloaded' })
        agent = await openContinuityAgent(page)
        await expect(agent.locator('.agent-message--user')).toContainText('One conversation, independent tab context.')
        await expect(agent.locator('.agent-context__page-chip')).toHaveAttribute('aria-pressed', 'true')
        await second.reload({ waitUntil: 'domcontentloaded' })
        otherAgent = await openContinuityAgent(second)
        await expect(otherAgent.locator('.agent-context__page-chip')).toHaveAttribute('aria-pressed', 'false')
        expect(fixture.requests.filter(value => value === 'POST /_api/agents/sessions')).toHaveLength(1)
        expect(fixture.requests.filter(value => value.includes('/messages'))).toHaveLength(1)
        fixture.assertNoUnexpectedRequests()
      } finally {
        await second?.close()
        await fixture.dispose()
      }
    })

    test('Agent structured answers retain local citations, readable containment and keyboard source previews', async ({ page }, testInfo) => {
      test.skip(!['responsive-chromium-desktop', 'responsive-chromium-mobile'].includes(testInfo.project.name))
      await installAgentContinuityPages(page)
      const fixture = await installEnabledAgentFixture(page, { mode: 'presentation' })
      try {
        const agent = await openContinuityAgent(page, '/agent-context-fixture-a')
        const input = agent.locator('.agent-composer textarea')
        const prompt = 'The first line must remain readable.\nCompare the release evidence.\nKeep the important details in view.'
        await input.fill(prompt)
        await expect(input).toHaveValue(prompt)
        expect(
          await input.evaluate(element => ({
            mask: getComputedStyle(element).maskImage,
            webkitMask: getComputedStyle(element).webkitMaskImage,
            scrollTop: element.scrollTop
          }))
        ).toEqual({ mask: 'none', webkitMask: 'none', scrollTop: 0 })
        const screenshot = testInfo.outputPath('agent-multiline-prompt.png')
        await page.screenshot({ path: screenshot })
        await testInfo.attach('agent-multiline-prompt', { path: screenshot, contentType: 'image/png' })
        await sendContinuityPrompt(page, agent, prompt)
        const markdown = agent.locator('.agent-message--assistant .agent-markdown').last()
        await expect(markdown.getByRole('heading', { level: 2, name: 'Release review', exact: true })).toBeVisible()
        await expect(markdown.getByRole('heading', { level: 3 })).toHaveText(['Review sequence', 'Evidence register'])
        await expect(markdown.locator('h2 a, h3 a, li a, td a, th a')).toHaveCount(0)
        const paragraphs = markdown.locator('p').filter({ hasText: /^The (release is ready|verification sequence is documented)/ })
        await expect(paragraphs).toHaveCount(2)
        await expect(paragraphs.nth(0)).toContainText('The release is ready for a deliberate review.')
        await expect(paragraphs.nth(1)).toContainText('The verification sequence is documented in the release guide.')
        for (const paragraph of await paragraphs.all()) {
          await expect(paragraph.locator('a[data-agent-citation]')).toHaveCount(1)
          await expect(paragraph.locator('a[data-agent-citation]')).toHaveAttribute('data-citation-number', '3')
          await expect(paragraph.locator('a[data-agent-citation]')).toHaveAttribute('href', /#verification-sequence$/)
        }
        await expect(markdown.getByRole('listitem')).toHaveText(['Review sources.', 'Confirm the evidence is complete.'])
        await expect(markdown.locator('ul + p > a[data-agent-citation]')).toHaveAttribute('data-citation-number', '3')
        const table = markdown.getByRole('table')
        await expect(table.getByRole('columnheader')).toHaveText(['Review checkpoint', 'Source record', 'Required evidence', 'Release decision'])
        await expect(table.getByRole('cell')).toHaveText([
          'Source verification', 'Release guide overview', 'Completed verification sequence', 'Deliberate publication review'
        ])
        await expect(markdown.locator('.agent-markdown__table-shell + p > a[data-agent-citation]')).toHaveAttribute('data-citation-number', '2')
        await expect(markdown.locator('a[data-agent-citation]')).toHaveCount(4)
        const tableShell = markdown.locator('.agent-markdown__table-shell')
        await tableShell.scrollIntoViewIfNeeded()
        await expectLocatorWithinViewport(tableShell, 'Agent evidence table scroll container')
        await tableShell.focus()
        await expect(tableShell).toBeFocused()
        if (testInfo.project.name === 'responsive-chromium-mobile') {
          expect(await tableShell.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
          await tableShell.press('ArrowRight')
          await expect.poll(() => tableShell.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
        }
        expect(await markdown.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        await expectResponsiveLayout(page, 'Structured Agent answer')
        const tabsBefore = page.context().pages().length
        const preview = page.getByRole('dialog', { name: 'Release guide', exact: true })
        const citation = agent.locator('a[data-agent-citation]').first()
        await expect(citation).toHaveAttribute('href', /#verification-sequence$/)
        await citation.scrollIntoViewIfNeeded()
        await expectLocatorWithinViewport(citation, 'Local source citation')
        await citation.focus()
        await expect(citation).toBeFocused()
        await citation.press('Enter')
        await expect(preview).toBeVisible()
        await expect(preview.getByRole('region', { name: 'Source excerpt' })).toContainText('Release evidence excerpt.')
        expect(page.context().pages()).toHaveLength(tabsBefore)
        await preview.press('Escape')
        await expect(preview).toBeHidden()
        await expect(citation).toBeFocused()
        await agent.locator('.agent-sources summary').click()
        await agent.locator('.agent-sources__page').first().click()
        await expect(preview).toBeVisible()
        await preview.getByRole('button', { name: 'Close source preview', exact: true }).click()
        await agent.locator('.agent-sources__sections a').filter({ hasText: 'Verification sequence' }).click()
        await expect(preview).toBeVisible()
        await preview.getByRole('button', { name: 'Ask about this page', exact: true }).click()
        await expect(preview).toBeHidden()
        await expect(agent.locator('.agent-context__sources')).toContainText('Release guide')
        await expect(input).not.toHaveValue('')
        await expect(agent.locator('.agent-message--user')).toHaveCount(1)
        expect(page.context().pages()).toHaveLength(tabsBefore)
        fixture.assertNoUnexpectedRequests()
      } finally {
        await fixture.dispose()
      }
    })
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

      await agent.getByRole('button', { name: 'History', exact: true }).click()
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

      // Page creation acknowledges the source write before its exact render is published.
      await waitForPageRender(async url => {
        const response = await page.request.get(url)
        return new Response(await response.body(), { status: response.status(), headers: response.headers() })
      }, { id: pageId, sourceRevision, locale: 'en', path, visibility: 'public' }, AbortSignal.timeout(15_000))

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
      const historyToggle = agent.getByRole('button', { name: 'History', exact: true })
      await historyToggle.click()
      const panel =
        expectedMode === 'modal' ? agent.getByRole('dialog', { name: 'Conversations' }) : agent.getByRole('complementary', { name: 'Conversations' })
      await expect(panel).toBeVisible()
      await expectLocatorWithinViewport(panel, `Agent ${expectedMode} history at ${width}px`)
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
      // History is visible even below 640px. Only Memory moves into More chat actions.
      if (expectedMode === 'modal') await expect(historyToggle).toBeFocused()
      if (expectedMode === 'modal' && width < 640) {
        const moreActions = agent.getByRole('button', { name: 'More chat actions', exact: true })
        await moreActions.click()
        await agent.locator('.inline-agent__panel-menu-item--compact').click()
        const mobileMemory = agent.getByRole('dialog', { name: 'Agent memory' })
        await expect(mobileMemory).toBeVisible()
        await expect.poll(() => mobileMemory.evaluate(root => root.contains(document.activeElement))).toBe(true)
        await page.keyboard.press('Escape')
        await expect(mobileMemory).toBeHidden()
        await expect(moreActions).toBeFocused()
      }
    }

    await page.setViewportSize({ width: 640, height: 420 })
    // From 640px up, Memory has its own toggle beside History instead of a menu entry.
    const memoryToggle = agent.locator('.inline-agent__memory-toggle')
    await memoryToggle.focus()
    await memoryToggle.press('Enter')
    await expect(memoryToggle).toHaveAttribute('aria-expanded', 'true')

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
    await expect(memoryToggle).toBeFocused()
    fixture.assertNoUnexpectedRequests()
    await fixture.dispose()
  })

  test('surfaces a partial archive failure with a focused retry', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'responsive-chromium-desktop', 'Enabled archive failure coverage is owned by Chromium desktop.')
    const fixture = await installEnabledAgentFixture(page, { archivePartialFailure: true })
    const agent = await openFixtureAgentFromSearch(page)
    await agent.getByRole('button', { name: 'History', exact: true }).click()
    const history = agent.getByRole('complementary', { name: 'Conversations' })
    await expect(history).toBeVisible()
    await expect(history.getByText('Recent', { exact: true })).toBeVisible()
    await expect(history).toContainText('Fixture archive folder failure')
    const sessionsBeforeRetry = fixture.requests.filter(request => request === 'GET /_api/agents/sessions').length
    const foldersBeforeRetry = fixture.requests.filter(request => request === 'GET /_api/agents/conversation-folders').length
    await history.getByRole('button', { name: 'Retry folders' }).click()
    await expect.poll(() => fixture.requests.filter(request => request === 'GET /_api/agents/conversation-folders').length).toBe(foldersBeforeRetry + 1)
    await expect(history.getByText('Release reviews', { exact: true })).toBeVisible()
    await expect(history.getByText('Fixture archive folder failure')).toHaveCount(0)
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

  test('sizes the authored H1 accent to its text block while preserving heading hierarchy', async ({ page }) => {
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
        const gradient = window.getComputedStyle(heading, '::after').backgroundImage
        heading.remove()
        return { width: bounds.width, pseudoWidth: pseudo?.width ?? 0, gradient }
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
    expect(decorations.h1After?.display, 'Authored H1 accent must render').not.toBe('none')
    expect(decorations.h1After?.height, 'Authored H1 accent remains visible without dominating the heading').toBeGreaterThan(0)
    expect(decorations.h1After?.height, 'Authored H1 accent remains a slim rule').toBeLessThanOrEqual(2.5)
    expect(Math.abs((decorations.h1After?.width ?? 0) - decorations.h1Width), 'Swoosh matches authored H1 text-block width').toBeLessThanOrEqual(1)
    expect(decorations.shortH1, 'Synthetic short H1 must be measurable').not.toBeNull()
    expect(decorations.longH1, 'Synthetic long H1 must be measurable').not.toBeNull()
    expect(Math.abs((decorations.shortH1?.pseudoWidth ?? 0) - (decorations.shortH1?.width ?? 0)), 'Short H1 swoosh matches its text block').toBeLessThanOrEqual(
      1
    )
    expect(Math.abs((decorations.longH1?.pseudoWidth ?? 0) - (decorations.longH1?.width ?? 0)), 'Long H1 swoosh matches its text block').toBeLessThanOrEqual(1)
    expect(decorations.longH1?.width ?? 0, 'Long H1 swoosh grows beyond short H1 swoosh').toBeGreaterThan((decorations.shortH1?.width ?? 0) + 100)
    expect(decorations.rtlH1?.gradient ?? '', 'RTL H1 accent fades toward the inline end').toContain('to left')
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

        // Scroll to the end and inspect the last column, not scrollWidth: stable scrollbar gutters can inflate it.
        wrapper.scrollLeft = wrapper.scrollWidth
        const lastColumn = table.querySelector('th:last-child')
        const reachedEnd = wrapper.scrollLeft > 0 && Boolean(lastColumn && lastColumn.getBoundingClientRect().right <= wrapper.getBoundingClientRect().right + 2)

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

  const updatedAt = '2000-02-03T12:00:00.000Z'
  const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  const authenticateReaderMetadataAdmin = async (page: Page): Promise<void> => {
    const username = process.env.READER_METADATA_ADMIN_USER
    const password = process.env.READER_METADATA_ADMIN_PASS
    if (username === undefined && password === undefined) {
      await authenticateAsAdmin(page)
    } else {
      if (username === undefined || password === undefined || !username || !password) {
        throw new Error('READER_METADATA_ADMIN_USER and READER_METADATA_ADMIN_PASS must both be configured.')
      }

      const response = await page.request.post('/_api/auth/login', {
        headers: sameOriginHeaders(),
        data: {
          strategy: 'local',
          username,
          password
        }
      })
      expect(response.ok(), `Reader metadata administrator login failed with HTTP ${response.status()}.`).toBe(true)
      const payload = (await response.json()) as { authenticated?: unknown }
      expect(payload.authenticated, 'Reader metadata administrator login did not return an authenticated session.').toBe(true)
    }

    const adminCookie = (await page.context().cookies()).find(cookie => cookie.name === 'jwt')
    expect(adminCookie, 'Reader metadata administrator login did not set the browser-context authentication cookie.').toBeDefined()
  }

  type ReaderMetadataFixturePayload = {
    pageFeatures?: {
      schemaVersion: 1
      linksVisible: false
      ratingsAllowed: true
      lastEditorVisible: boolean
    }
    props: Pick<WikiPagePayload['props'], 'updatedAt' | 'authorName' | 'authorId'>
    historyRead: boolean
  }

  const makeFixturePayload = (options: {
    authorName: string
    authorId: number
    lastEditorVisible: boolean | undefined
    historyRead: boolean
    updatedAt?: string
  }): ReaderMetadataFixturePayload => ({
    ...(options.lastEditorVisible === undefined
      ? {}
      : {
          pageFeatures: {
            schemaVersion: 1,
            linksVisible: false,
            ratingsAllowed: true,
            lastEditorVisible: options.lastEditorVisible
          }
        }),
    props: {
      updatedAt: options.updatedAt ?? updatedAt,
      authorName: options.authorName,
      authorId: options.authorId
    },
    historyRead: options.historyRead
  })

  const installReaderMetadataFixture = async (
    page: Page,
    fixturePayload: ReaderMetadataFixturePayload,
    spaFixturePayload = fixturePayload
  ): Promise<{ documents: WikiPagePayload[]; spaNavigations: WikiPagePayload[] }> => {
    const loads = { documents: [] as WikiPagePayload[], spaNavigations: [] as WikiPagePayload[] }
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

      // Metadata fixtures must retain the live page identity: reader actions still
      // call the real watch, approval, protection, and history endpoints.
      const original = decodeWikiPagePayloadForTest(match[3]!)
      const selectedFixture = isSpaNavigation ? spaFixturePayload : fixturePayload
      const permissions: unknown = JSON.parse(Buffer.from(original.props.effectivePermissions, 'base64').toString('utf8'))
      if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions) || !('history' in permissions)) {
        throw new Error('Reader metadata fixture is missing the server history permission.')
      }
      const history = permissions.history
      if (typeof history !== 'object' || history === null || Array.isArray(history) || !('read' in history) || typeof history.read !== 'boolean') {
        throw new Error('Reader metadata fixture has an invalid server history permission.')
      }
      if (selectedFixture.historyRead && !history.read) throw new Error('The reader metadata administrator must have real history access.')
      const patchedPayload = {
        ...original,
        // Undefined stays omitted in JSON, exercising the decoder's privacy default.
        pageFeatures: selectedFixture.pageFeatures,
        props: {
          ...original.props,
          ...selectedFixture.props,
          effectivePermissions: encoded({
            ...permissions,
            history: { ...history, read: selectedFixture.historyRead && history.read }
          })
        }
      }
      const fixture = encoded(patchedPayload)
      const patchedDocument = document.slice(0, match.index) + `${match[1]}${match[2]}${fixture}${match[2]}` + document.slice(match.index + match[0].length)
      const decodedFixture = decodeWikiPagePayloadForTest(fixture)
      const appliedLoads = isSpaNavigation ? loads.spaNavigations : loads.documents
      appliedLoads.push(decodedFixture)
      await route.fulfill({ response, body: patchedDocument })
    })
    return loads
  }

  const expectReaderMetadata = async (page: Page, expected: { authorName?: string; historyHref?: string; updatedAt?: string }): Promise<void> => {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    const provenance = page.locator('.page-hero .page-document-provenance')
    await expect(provenance).toHaveCount(1)
    await expect(provenance).toBeVisible()
    const date = provenance.locator('time')
    await expect(date).toHaveAttribute('datetime', expected.updatedAt ?? updatedAt)

    const author = provenance.locator('.page-provenance-author')
    if (expected.authorName === undefined) {
      await expect(provenance.locator('.page-document-author')).toHaveCount(0)
      await expect(author).toHaveCount(0)
    } else {
      await expect(author).toHaveText(expected.authorName)
      await expect(author).toHaveAttribute('title', expected.authorName)
      await expect(author.locator('*')).toHaveCount(0)
    }

    const pageActions = page.locator('[data-page-actions-activator]:visible').first()
    await pageActions.click()
    const historyAction = page.locator('.page-actions-menu:visible').getByRole('button', { name: 'History', exact: true })
    if (expected.historyHref === undefined) await expect(historyAction).toHaveCount(0)
    else await expect(historyAction).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pageActions).toBeFocused()
  }

  routedReaderTest('renders enabled page author metadata on initial and SPA reader loads', async ({ page }) => {
    test.setTimeout(60_000)
    const initialViewport = page.viewportSize()
    if (!initialViewport) throw new Error('The reader metadata test requires a configured viewport.')
    const authorName = '<strong data-e2e-author-markup="true">Ada</strong> & "quoted"'
    const spaAuthorName = '<em data-e2e-author-markup="true">Grace</em> & "next"'
    const spaUpdatedAt = '2001-04-05T09:30:00.000Z'
    const historyHrefFor = ({ props }: WikiPagePayload): string =>
      `${props.visibility === 'private' ? '/h/_private' : '/h'}/${props.locale}/${props.path}`
    await authenticateReaderMetadataAdmin(page)
    const readerLoads = await installReaderMetadataFixture(
      page,
      makeFixturePayload({
        authorName,
        authorId: 42,
        lastEditorVisible: true,
        historyRead: true
      }),
      makeFixturePayload({
        authorName: spaAuthorName,
        authorId: 43,
        lastEditorVisible: true,
        historyRead: true,
        updatedAt: spaUpdatedAt
      })
    )

    await page.goto('/home', { waitUntil: 'domcontentloaded' })
    const initialPage = readerLoads.documents[0]
    if (!initialPage) throw new Error('The initial metadata fixture was not applied.')
    const historyHref = historyHrefFor(initialPage)
    await expectReaderMetadata(page, { authorName, historyHref })
    const historyAction = page.locator('.page-actions-menu:visible').getByRole('button', { name: 'History', exact: true })
    const coarsePointer = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    const assertReaderUtilities = async (width: number): Promise<void> => {
      await page.setViewportSize({ width, height: initialViewport.height })
      const hero = page.locator('.page-hero')
      await expect(hero.locator('.page-document-provenance')).toBeVisible()
      for (const action of await hero.locator('.page-hero-actions .v-btn').all()) {
        await expectLocatorWithinViewport(action, `Labeled reader action at ${width}px`)
        await expect(action).toHaveAccessibleName(/\S/)
        if (coarsePointer) {
          const bounds = await action.boundingBox()
          expect(bounds?.height ?? 0, `Reader touch action remains at least 44px high at ${width}px`).toBeGreaterThanOrEqual(44)
        }
      }
      const focus = hero.getByRole('button', { name: 'Focus', exact: true })
      await focus.focus()
      await focus.press('Enter')
      const dock = page.getByRole('region', { name: 'Focus', exact: true })
      const exit = dock.getByRole('button', { name: 'Exit focus', exact: true })
      await expect(exit, `Keyboard Focus opens the reading controls at ${width}px`).toBeFocused()
      await expectLocatorWithinViewport(dock, `Reading controls at ${width}px`)
      await exit.press('Enter')
      await expect(dock).toHaveCount(0)
      await expect(focus, `Leaving Focus restores its keyboard target at ${width}px`).toBeFocused()

      const share = hero.getByRole('button', { name: 'Share', exact: true })
      await share.focus()
      await share.press('Enter')
      const sharingMenu = page.locator('.v-menu.v-overlay--active')
      await expect(sharingMenu).toBeVisible()
      await expect.poll(() => sharingMenu.evaluate(menu =>
        menu.contains(document.activeElement) &&
        document.activeElement?.matches('button:not(:disabled), a[href]')
      ), `Keyboard Share enters an enabled sharing control at ${width}px`).toBe(true)
      await page.keyboard.press('Escape')
      await expect(sharingMenu).toHaveCount(0)
      await expect(share, `Closing Share restores its keyboard trigger at ${width}px`).toBeFocused()
      if (coarsePointer) {
        await test.step(`Touch opens Share at ${width}px`, async () => {
          await share.tap({ timeout: 5_000 })
          await expect(sharingMenu).toBeVisible()
        })
        await test.step(`Touch closes Share at ${width}px`, async () => {
          await share.tap({ timeout: 5_000 })
          await expect(sharingMenu).toHaveCount(0)
        })
      }

      // Edit remains a separate real affordance, not another metadata utility.
      if (width < 600) await test.step(`Keyboard Edit through the header at ${width}px`, async () => {
        const pageActions = page.getByRole('banner').getByRole('button', { name: 'Page Actions', exact: true })
        await expectLocatorWithinViewport(pageActions, `Page actions at ${width}px`)
        await pageActions.focus()
        await pageActions.press('ArrowDown')
        await expect(pageActions).toHaveAttribute('aria-expanded', 'true')
        const actionsMenu = page.locator('.page-actions-menu:visible')
        const edit = actionsMenu.getByRole('button', { name: 'Edit', exact: true })
        await expect.poll(() => actionsMenu.evaluate(menu => menu.contains(document.activeElement))).toBe(true)
        for (let attempt = 0, count = await actionsMenu.getByRole('button').count(); attempt < count; attempt++) {
          if (await edit.evaluate(element => element === document.activeElement)) break
          await page.keyboard.press('ArrowDown')
        }
        await expect(edit, `Real Edit is keyboard reachable at ${width}px`).toBeFocused()
        await expectLocatorWithinViewport(edit, `Edit action at ${width}px`)
        await edit.press('Escape')
        await expect(pageActions).toHaveAttribute('aria-expanded', 'false')
        await expect(pageActions).toBeFocused()
      })
      // Focus restoration precedes the navigation drawer's opening transition.
      // Measure its settled layout rather than its intentionally off-canvas start.
      await test.step(`Settled responsive reader layout at ${width}px`, async () => {
        await page.locator('.v-navigation-drawer').evaluateAll(async drawers => {
          await Promise.all(drawers.flatMap(drawer => drawer.getAnimations().map(animation => animation.finished)))
        })
        await expectResponsiveLayout(page, `Reader utilities and metadata at ${width}px`)
      })
    }

    for (const width of [1440, 320, 375, 390]) await assertReaderUtilities(width)

    await page.setViewportSize(initialViewport)

    const logo = page.locator('.nav-header-logo:visible').first()
    await expect(logo).toBeVisible()
    const logoHref = await logo.getAttribute('href')
    if (!logoHref) throw new Error('Reader home logo does not expose a destination.')
    const currentUrl = new URL(page.url())
    const destination = new URL(logoHref, currentUrl)

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
    await logo.click()
    const navigationResponse = await spaNavigationResponse
    await navigationResponse.finished()
    await expect(page).toHaveURL(destination.href)
    const spaPage = readerLoads.spaNavigations[0]
    if (!spaPage) throw new Error('The SPA metadata fixture was not applied.')
    const spaHistoryHref = historyHrefFor(spaPage)
    await expectReaderMetadata(page, { authorName: spaAuthorName, historyHref: spaHistoryHref, updatedAt: spaUpdatedAt })
    await expect(page.getByRole('alert'), 'Real reader actions do not report fixture-induced errors.').toHaveCount(0)
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: initialViewport.height })
      await page.locator('[data-page-actions-activator]:visible').first().click()
      await expect(historyAction).toBeVisible()
      await historyAction.focus()
      await expect(historyAction, `History remains keyboard reachable at ${width}px`).toBeFocused()
      await historyAction.press('Enter')
      await expect.poll(() => new URL(page.url()).pathname).toBe(spaHistoryHref)
      if (width === 320) {
        await page.goBack({ waitUntil: 'domcontentloaded' })
        await expect(page).toHaveURL(destination.href)
      }
    }
  })

  for (const featureCase of [
    { name: 'explicitly disabled', lastEditorVisible: false },
    { name: 'omitted', lastEditorVisible: undefined }
  ]) {
    test(`preserves the update date and withholds server-redacted author metadata when last editor is ${featureCase.name}`, async ({ page }) => {
      await installReaderMetadataFixture(
        page,
        makeFixturePayload({
          authorName: 'Unknown',
          authorId: 0,
          lastEditorVisible: featureCase.lastEditorVisible,
          historyRead: false
        })
      )

      await page.goto('/home', { waitUntil: 'domcontentloaded' })
      await expectReaderMetadata(page, {})
    })
  }


  test('keeps a long enabled author inside the narrow reader card without exposing unauthorized history', async ({ page }) => {
    const authorName = 'VeryLongEditorName'.repeat(16)
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('The reader metadata test requires a configured viewport.')
    await page.setViewportSize({ width: Math.min(320, viewport.width), height: viewport.height })
    await installReaderMetadataFixture(
      page,
      makeFixturePayload({
        authorName,
        authorId: 42,
        lastEditorVisible: true,
        historyRead: false
      })
    )

    await page.goto('/home', { waitUntil: 'domcontentloaded' })
    await expectReaderMetadata(page, { authorName })

    const hero = page.locator('.page-hero')
    await expect(hero).toBeVisible()
    await expect(hero.locator('.page-document-provenance time')).toBeVisible()
    const overflow = await hero.evaluate(card => {
      const provenance = card.querySelector<HTMLElement>('.page-document-provenance')
      const author = provenance?.querySelector<HTMLElement>('.page-document-author')
      const date = provenance?.querySelector<HTMLElement>('time')
      if (!provenance || !author || !date) throw new Error('Reader hero is missing author or date metadata.')
      const provenanceBounds = provenance.getBoundingClientRect()
      const dateBounds = date.getBoundingClientRect()
      return {
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        card: card.scrollWidth - card.clientWidth,
        provenance: provenance.scrollWidth - provenance.clientWidth,
        authorWidth: author.clientWidth,
        dateFits: dateBounds.left >= provenanceBounds.left - 1 && dateBounds.right <= provenanceBounds.right + 1
      }
    })
    expect(overflow.document, 'A long author does not widen the document').toBeLessThanOrEqual(1)
    expect(overflow.card, 'A long author stays inside the unified hero').toBeLessThanOrEqual(1)
    expect(overflow.provenance, 'A long author stays inside the metadata region').toBeLessThanOrEqual(1)
    expect(overflow.authorWidth, 'The bounded author remains visible').toBeGreaterThan(0)
    expect(overflow.dateFits, 'The factual update date remains readable').toBe(true)
  })
})

test.describe('focused reading', () => {
  test('keeps the document and search reachable while returning keyboard focus to the reader control', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('.page-header-section').waitFor({ state: 'visible', timeout: 15_000 })
    const focus = page.getByRole('button', { name: 'Focus', exact: true })
    await expect(focus).toBeVisible()
    await focus.focus()
    await page.keyboard.press('Enter')
    const dock = page.getByRole('region', { name: 'Focus', exact: true })
    const exit = dock.getByRole('button', { name: 'Exit focus', exact: true })
    await expect(page.getByRole('button', { name: 'Exit focus', exact: true })).toHaveCount(1)
    await expect(exit).toBeFocused()
    await expect(page.locator('.page-navigation.v-navigation-drawer--active')).toHaveCount(0)
    await expect(page.locator('.page-toc-card')).toBeHidden()
    await expectLocatorWithinViewport(dock, 'Focused reading controls')
    const dockGlass = await dock.evaluate(element => {
      const styles = getComputedStyle(element)
      return {
        backdropFilter: styles.backdropFilter || styles.getPropertyValue('-webkit-backdrop-filter'),
        backgroundImage: styles.backgroundImage
      }
    })
    expect(dockGlass.backdropFilter).not.toBe('none')
    expect(dockGlass.backgroundImage).not.toBe('none')
    await expectResponsiveLayout(page, 'Focused reading')
    const viewport = page.viewportSize()
    if (!viewport) throw new Error('Focused reading requires a configured viewport.')
    if (viewport.width >= 960) await page.keyboard.press('ControlOrMeta+K')
    else await openSearch(page)
    await expect(page.getByRole('dialog', { name: 'Search the Wiki', exact: true })).toBeVisible()
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
    await page.locator('article.contents > div').first().evaluate(element => {
      element.replaceChildren()
      for (const title of ['Opening section', 'Visible passage', 'Closing section']) {
        const heading = document.createElement('h2')
        heading.textContent = title
        element.append(heading)
        for (let paragraph = 0; paragraph < 24; paragraph += 1) {
          const content = document.createElement('p')
          content.textContent = `Reading paragraph ${paragraph + 1}: ordinary article content gives this section enough space to read and scroll.`
          element.append(content)
        }
      }
    })
    const headings = page.locator('article.contents h2:not(details h2):visible')
    await expect(headings).toHaveText(['Opening section', 'Visible passage', 'Closing section'])
    await page.getByRole('button', { name: 'Focus', exact: true }).click()
    const passage = headings.nth(1)
    await passage.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 120))
    await expect.poll(async () => Math.abs(((await passage.boundingBox())?.y ?? 0) - 120)).toBeLessThan(2)
    await page.locator('.page-reading-dock').getByRole('button', { name: 'Exit focus', exact: true }).click()
    await expect.poll(async () => Math.abs(((await passage.boundingBox())?.y ?? 0) - 120)).toBeLessThan(2)
    await expect(page.getByRole('button', { name: 'Focus', exact: true })).toBeFocused()
  })

  test('keeps page position within bounds and excludes reader controls from print', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('.page-header-section').waitFor({ state: 'visible', timeout: 15_000 })
    // The position bar is decorative, so it is hidden from assistive technology.
    const progress = page.locator('.page-position')
    await expect(progress).toBeAttached()
    await expect(progress).toHaveAttribute('aria-hidden', 'true')
    await expect(page.getByRole('progressbar', { name: 'Page position', exact: true })).toHaveCount(0)
    const progressScale = () => progress.locator('.page-position-fill').evaluate(fill => new DOMMatrixReadOnly(getComputedStyle(fill).transform).a)
    const initial = await progressScale()
    expect(initial).toBeGreaterThanOrEqual(0)
    expect(initial).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: 'Focus', exact: true }).click()
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await expect.poll(progressScale).toBeCloseTo(1, 2)
    await expectLocatorWithinViewport(page.locator('.page-reading-dock'), 'Exit focus at the end of the document')
    await page.emulateMedia({ media: 'print' })
    await expect(progress).toBeHidden()
    await expect(page.locator('.page-reading-dock')).toBeHidden()
    await expect(page.locator('.page-focus-control')).toBeHidden()
    await expect(page.locator('article.contents')).toBeVisible()
  })
})
