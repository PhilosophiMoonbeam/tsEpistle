import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { installEnabledAgentFixture } from './agent-fixture.ts'
import { authenticateAsAdmin, expectResponsiveLayout, openAuthenticatedPage, openSearch } from './helpers.ts'

async function expectNoBlockingAccessibilityViolations(page: Page, surface: string) {
  await page.locator('.animated').evaluateAll(elements => {
    for (const element of elements) {
      for (const animation of element.getAnimations()) animation.finish()
    }
  })
  const result = await new AxeBuilder({ page }).exclude('.v-tooltip:not(.v-overlay--active)').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  const blockingViolations = result.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
  expect(blockingViolations, `${surface} has serious or critical accessibility violations`).toEqual([])
}

function requireProject(testInfo: TestInfo, projectName: string) {
  test.skip(testInfo.project.name !== projectName, `Covered by the ${projectName} project`)
}

function requireAnyProject(testInfo: TestInfo, projectNames: readonly string[]) {
  test.skip(!projectNames.includes(testInfo.project.name), `Covered by ${projectNames.join(', ')}`)
}

async function tabToControl(page: Page, control: Locator, maximumPresses = 60) {
  for (let press = 0; press < maximumPresses; press += 1) {
    await page.keyboard.press('Tab')
    if (await control.evaluate(element => element === document.activeElement)) return true
  }
  return false
}
async function openEnabledAgent(page: Page) {
  await openAuthenticatedPage(page, '/', '.page-header-section')
  const search = await openSearch(page)
  await search.fill('home')
  const searchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
  await expect(searchDialog).toBeVisible()
  const askAgent = searchDialog.getByRole('button', { name: 'Ask about this', exact: true })
  await expect(askAgent).toBeVisible()
  await askAgent.click()
  const agent = page.getByRole('region', { name: 'Wiki Agent' })
  await expect(agent).toBeVisible()
  return agent
}

test.describe('release accessibility profiles', () => {
  test('meets WCAG gates on primary desktop surfaces', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    for (const surface of ['/', '/a/dashboard', '/a/pages', '/e/en/home']) {
      await page.goto(surface, { waitUntil: 'networkidle' })
      await expectNoBlockingAccessibilityViolations(page, surface)
    }
  })

  test('reaches administration using only the keyboard', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await openAuthenticatedPage(page, '/', 'a[href="/a"]')

    let reachedAdministration = false
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press('Tab')
      const label = await page.evaluate(() => {
        const focused = document.activeElement
        return `${focused?.getAttribute('aria-label') ?? ''} ${focused?.textContent ?? ''}`
      })
      if (label.includes('Administration')) {
        reachedAdministration = true
        break
      }
    }

    expect(reachedAdministration, 'Administration must be reachable in the tab order').toBe(true)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/a/dashboard')
  })

  test('meets contrast and accessibility gates in dark mode', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-dark')
    test.setTimeout(45_000)
    await openAuthenticatedPage(page, '/a/theme', '#theme-form')
    const darkMode = page.getByRole('button', { name: 'Dark', exact: true })
    await expect(darkMode).toBeVisible()
    await expect(darkMode).toBeEnabled()
    if ((await darkMode.getAttribute('aria-pressed')) !== 'true') await darkMode.click()
    await expect(darkMode).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.v-theme--dark').first()).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, '/a/theme (dark)')
  })

  test('avoids horizontal overflow across release viewport profiles', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile', 'accessibility-tablet', 'accessibility-wide'])
    await authenticateAsAdmin(page)
    for (const surface of ['/', '/a/dashboard', '/a/pages']) {
      await page.goto(surface, { waitUntil: 'networkidle' })
      await expectResponsiveLayout(page, surface)
      await expectNoBlockingAccessibilityViolations(page, `${surface} (mobile)`)
    }
  })

  test('opens and reaches primary editor actions using only the keyboard', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await openAuthenticatedPage(page, '/en/home', '.page-header-section')

    const pageActions = page.locator('.nav-header button[aria-label="Page Actions"]')
    expect(await tabToControl(page, pageActions), 'Page actions must be reachable in the tab order').toBe(true)
    await page.keyboard.press('Enter')
    const editPage = page.getByRole('button', { name: 'Edit', exact: true })
    await expect(editPage, 'Edit must receive focus when page actions open').toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/e/en/home')
    const save = page.getByRole('button', { name: /^(?:save|saved)$/i })
    await expect(save).toBeVisible()
    expect(await tabToControl(page, save), 'Save must be reachable in the editor tab order').toBe(true)
  })

  test('announces search failure, retries, and exposes the empty result state', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    let requests = 0
    await page.route(/\/_api\/pages\/search\?/, async route => {
      requests += 1
      if (requests === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Search service is unavailable.' })
        })
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ results: [], suggestions: [], totalHits: 0 })
        })
      }
    })
    await page.goto('/', { waitUntil: 'networkidle' })
    const search = await openSearch(page)
    await page.keyboard.type('unavailable-query')
    await expect(page.getByRole('alert')).toContainText('Search service is unavailable.')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'try a different term or scope.' })).toBeVisible()
  })

  test('keeps the inline agent keyboard-accessible at desktop and mobile widths', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    await authenticateAsAdmin(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const search = await openSearch(page)
    await search.fill('home')
    const searchDialog = page.getByRole('dialog', { name: 'Wiki search', exact: true })
    await expect(searchDialog).toBeVisible()
    const askAgent = searchDialog.getByRole('button', { name: 'Ask about this', exact: true })
    await expect(askAgent).toBeVisible()
    await askAgent.click()
    await expect(page.getByRole('region', { name: 'Wiki Agent' })).toBeVisible()
    await expect(page.getByText(/Agent inference is currently disabled/)).toBeVisible()
    await expectResponsiveLayout(page, `inline agent (${testInfo.project.name})`)
    await expectNoBlockingAccessibilityViolations(page, `inline agent (${testInfo.project.name})`)
    if (testInfo.project.name === 'accessibility-keyboard') {
      const history = page.getByRole('button', { name: 'Open agent conversation history' })
      expect(await tabToControl(page, history), 'Agent history must be reachable in the tab order').toBe(true)
    }
  })
  test('uses header glass around search results at desktop and mobile widths', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    await openAuthenticatedPage(page, '/', '.page-header-section')
    const input = await openSearch(page)
    // A physical click catches overlays covering the mobile header extension.
    await input.click()
    const search = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
    await expect(search).toBeVisible()
    const headerGlass = await page.locator('.nav-header').evaluate(element => {
      const styles = getComputedStyle(element)
      return { background: styles.backgroundColor, blur: styles.backdropFilter }
    })
    await expect(search).toHaveCSS('background-color', headerGlass.background)
    await expect(search).toHaveCSS('backdrop-filter', headerGlass.blur)
    expect(headerGlass.blur).toContain('blur(')
    await expectResponsiveLayout(page, 'search glass')
  })
  test('runs enabled Agent failure, retry, and header activation through a real workspace', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    const fixture = await installEnabledAgentFixture(page, { mode: 'retry' })
    test.setTimeout(60_000)
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openAuthenticatedPage(page, '/', '.page-header-section')
      await page.getByRole('button', { name: 'Open Wiki Agent' }).click()
      const agent = page.getByRole('region', { name: 'Wiki Agent' })
      await expect(agent).toBeVisible()
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Please retry this release evidence request.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      const failedResponse = agent.locator('article.agent-message--assistant.agent-message--failed')
      await expect(failedResponse.getByText('Response could not be completed', { exact: true })).toBeVisible()
      await agent.getByRole('button', { name: 'Try again', exact: true }).click()
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('The release is ready for a deliberate review.', { exact: true })).toBeVisible()
      await expect(agent.locator('[data-agent-citation]')).not.toHaveCount(0)
      await expect(agent.getByRole('img', { name: 'Mermaid diagram', exact: true })).toBeVisible()
      await expectResponsiveLayout(page, 'enabled Agent retry')
      await expectNoBlockingAccessibilityViolations(page, 'enabled Agent retry')
      expect(fixture.requests.some(request => request.includes('/events'))).toBe(true)
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('shows Agent glass throughout its opening animation', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    const fixture = await installEnabledAgentFixture(page, { mode: 'success' })
    try {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      // This visual check uses public page content and browser-local Agent fixtures.
      await page.route('**/_api/users/whoami', route =>
        route.fulfill({
          json: {
            authenticated: true,
            user: { id: 1, authVersion: 1, name: 'Visual test', email: 'visual@example.test', permissions: ['use:agents'] }
          }
        })
      )
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.page-header-section')).toBeVisible()
      await page.getByRole('button', { name: 'Open Wiki Agent' }).click()
      const agent = page.locator('.inline-agent--contextual')
      await expect(agent).toBeVisible()
      const container = page.locator('.search-results-container--ask')
      // Seek the actual entrance animation: inspecting only its settled state misses
      // opacity on an ancestor temporarily cutting glass off from the page backdrop.
      const frames = await container.evaluate(element => {
        const animation = element.getAnimations()[0]
        if (!animation) throw new Error('Expected the Agent entrance animation')
        animation.pause()
        const duration = Number(animation.effect?.getTiming().duration)
        return [0, 0.25, 0.5, 0.99].flatMap(progress => {
          animation.currentTime = duration * progress
          return Array.from(element.querySelectorAll('.inline-agent__toolbar, .inline-agent__body')).map(surface => {
            const style = getComputedStyle(surface)
            const blockedBy: string[] = []
            for (let parent = surface.parentElement; parent; parent = parent.parentElement) {
              if (Number(getComputedStyle(parent).opacity) < 1) blockedBy.push(parent.className)
            }
            return { progress, blur: style.backdropFilter, background: style.backgroundColor, blockedBy }
          })
        })
      })
      expect(frames).toHaveLength(8)
      for (const frame of frames) {
        expect(frame.blockedBy, `Glass must see the page at entrance progress ${frame.progress}`).toEqual([])
        expect(frame.blur).toContain('blur(')
        expect(frame.background).toMatch(/^rgba\(/u)
      }
      await page.screenshot({ path: testInfo.outputPath('agent-opening-glass.png') })
      await container.evaluate(element => {
        for (const animation of element.getAnimations()) animation.finish()
      })
      await expect(agent.getByRole('textbox', { name: 'Message Wiki Agent' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(agent).toBeHidden()
      // Escape returns to Search by design; its glass uses the same visual tokens.
      const search = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
      await expect(search).toBeVisible()
      await expect(page.locator('.nav-header-search-control input:visible').first()).toBeFocused()
      await expect(search).toHaveCSS('backdrop-filter', frames[0].blur)
      await expect(search).toHaveCSS('background-color', frames[0].background)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByRole('button', { name: 'Open Wiki Agent' }).click()
      await expect(agent).toBeVisible()
      await expect(container).toHaveCSS('animation-name', 'none')
      await expect(agent.locator('.inline-agent__body')).toHaveCSS('opacity', '1')
      await expect(agent.locator('.inline-agent__toolbar > *').first()).toHaveCSS('animation-name', 'none')
      await expect(agent.locator('.inline-agent__body > *').first()).toHaveCSS('animation-name', 'none')
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
      })
      await expect(agent.locator('.inline-agent__body')).toHaveCSS('backdrop-filter', 'none')
      await cdp.detach()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('keeps contextual Agent glass isolated from opaque surfaces', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    test.setTimeout(60_000)
    const fixture = await installEnabledAgentFixture(page, { mode: 'success' })
    const cdp = await page.context().newCDPSession(page)
    try {
      const agent = await openEnabledAgent(page)
      await expect(agent).toHaveClass(/inline-agent--contextual/)
      const composerSurround = agent.locator('.inline-agent__composer')
      await expect(composerSurround).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(composerSurround).toHaveCSS('box-shadow', 'none')
      const greetingBackdrop = await agent.locator('.inline-agent__welcome h2').evaluate(element => {
        const styles = getComputedStyle(element, '::before')
        return { background: styles.backgroundImage, filter: styles.filter, pointerEvents: styles.pointerEvents }
      })
      expect(greetingBackdrop.background).toContain('radial-gradient')
      expect(greetingBackdrop.filter).toContain('blur')
      expect(greetingBackdrop.pointerEvents).toBe('none')
      const greetingOpacity = () => agent.locator('.inline-agent__welcome h2').evaluate(element => getComputedStyle(element, '::before').opacity)
      await expect.poll(greetingOpacity).toBe('1')
      const transcriptWidth = await agent
        .locator('.inline-agent__transcript')
        .evaluate(element => ({ content: element.scrollWidth, viewport: element.clientWidth }))
      expect(transcriptWidth.content, 'The oval does not add horizontal scrolling').toBeLessThanOrEqual(transcriptWidth.viewport)
      await expect(agent.getByRole('button', { name: 'Understand This Page' })).toBeVisible()
      await agent.getByRole('button', { name: 'Exclude current page', exact: true }).click()
      await expect.poll(greetingOpacity).toBe('0')
      await expect(agent.getByRole('button', { name: 'Understand This Page' })).toHaveCount(0)
      await expect(agent.getByRole('button', { name: 'Explore the Wiki' })).toBeVisible()
      await agent.getByRole('button', { name: 'Include current page', exact: true }).click()
      await expect(agent.getByRole('button', { name: 'Understand This Page' })).toBeVisible()
      await expect.poll(greetingOpacity).toBe('1')
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
      })
      await expect.poll(greetingOpacity).toBe('0')
      await cdp.send('Emulation.setEmulatedMedia', { features: [] })
      await expect.poll(greetingOpacity).toBe('1')
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Inspect the contextual Agent surface hierarchy.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('The release is ready for a deliberate review.', { exact: true })).toBeVisible()

      const toolbar = agent.locator('.inline-agent__toolbar')
      const body = agent.locator('.inline-agent__body')
      const readSurfaceStyle = async (locator: Locator) =>
        locator.evaluate(element => {
          const styles = getComputedStyle(element)
          const color = styles.backgroundColor
          const alphaMatch = color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)/u)
          return {
            backgroundAlpha: alphaMatch ? Number(alphaMatch[1]) : color === 'transparent' ? 0 : 1,
            opacity: Number(styles.opacity),
            backdropFilter: styles.backdropFilter
          }
        })
      const expectOpaque = async (locator: Locator, surface: string): Promise<void> => {
        const styles = await readSurfaceStyle(locator)
        expect(styles.backgroundAlpha, `${surface} keeps an opaque background`).toBe(1)
        expect(styles.opacity, `${surface} keeps full element opacity`).toBe(1)
        expect(styles.backdropFilter, `${surface} does not become a glass layer`).toBe('none')
      }
      const expectContextualGlass = async (reduced: boolean): Promise<void> => {
        const [toolbarStyles, bodyStyles] = await Promise.all([readSurfaceStyle(toolbar), readSurfaceStyle(body)])
        if (reduced) {
          expect(toolbarStyles.backgroundAlpha, 'Reduced transparency makes the Agent toolbar opaque').toBe(1)
          expect(bodyStyles.backgroundAlpha, 'Reduced transparency makes the Agent body opaque').toBe(1)
          expect(toolbarStyles.backdropFilter, 'Reduced transparency removes toolbar blur').toBe('none')
          expect(bodyStyles.backdropFilter, 'Reduced transparency removes body blur').toBe('none')
        } else {
          expect(toolbarStyles.backgroundAlpha, 'Normal transparency keeps the Agent toolbar translucent').toBeLessThan(1)
          expect(bodyStyles.backgroundAlpha, 'Normal transparency keeps the Agent body translucent').toBeLessThan(1)
          expect(toolbarStyles.backdropFilter, 'Normal transparency blurs the Agent toolbar').toContain('blur')
          expect(bodyStyles.backdropFilter, 'Normal transparency blurs the Agent body').toContain('blur')
        }
        expect(toolbarStyles.opacity).toBe(1)
        expect(bodyStyles.opacity).toBe(1)
      }
      const expectOpaqueWorkspaceSurfaces = async (): Promise<void> => {
        const messageSurfaces = agent.locator('.agent-message__surface')
        await expect(messageSurfaces).toHaveCount(2)
        for (const surface of await messageSurfaces.all()) await expectOpaque(surface, 'Agent message surface')
        await expectOpaque(agent.locator('.agent-composer'), 'Agent composer')
        await expect(composerSurround).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        await expect(composerSurround).toHaveCSS('box-shadow', 'none')

        const historyTrigger = agent.getByRole('button', { name: 'Open agent conversation history' })
        if (await historyTrigger.isVisible()) await historyTrigger.click()
        else {
          await agent.getByRole('button', { name: 'Open Agent panels: conversation history and memory' }).click()
          await agent.locator('.v-menu.v-overlay--active').getByText('Conversation history', { exact: true }).click()
        }
        const history = agent.locator('.inline-agent__side--history')
        await expect(history).toBeVisible()
        await expectOpaque(history, 'Agent history')
        await history.getByRole('button', { name: 'Close chat history' }).click()
        await expect(history).toBeHidden()

        const memoryTrigger = agent.getByRole('button', { name: 'Manage agent memory' })
        if (await memoryTrigger.isVisible()) await memoryTrigger.click()
        else {
          await agent.getByRole('button', { name: 'Open Agent panels: conversation history and memory' }).click()
          await agent.locator('.v-menu.v-overlay--active').getByText('Agent memory', { exact: true }).click()
        }
        const memory = agent.locator('.inline-agent__side--memory')
        await expect(memory).toBeVisible()
        await expectOpaque(memory, 'Agent memory')
        await memory.getByRole('button', { name: 'Close agent memory' }).click()
        await expect(memory).toBeHidden()
      }

      await expectContextualGlass(false)
      const headerGlass = await readSurfaceStyle(page.locator('.nav-header'))
      expect(await readSurfaceStyle(toolbar)).toEqual(headerGlass)
      expect(await readSurfaceStyle(body)).toEqual(headerGlass)
      const card = agent.locator('.inline-agent__card')
      const included = agent.getByRole('button', { name: 'Exclude current page', exact: true })
      await expect(included).toBeEnabled()
      const fadingColor = await included.evaluate(async element => {
        const body = document.querySelector('.inline-agent__body')!
        // Capture the transition as it starts: slow rendering must not let the
        // whole animation finish before the test can inspect it.
        const started = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Excluding the current page must animate the workspace background')), 3000)
          body.addEventListener(
            'transitionrun',
            event => {
              if ((event as TransitionEvent).propertyName !== 'background-color') return
              const fade = body.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'background-color')!
              fade.pause()
              fade.currentTime = Number(fade.effect?.getComputedTiming().duration) / 2
              clearTimeout(timeout)
              resolve(getComputedStyle(body).backgroundColor)
            },
            { once: true }
          )
        })
        ;(element as HTMLElement).click()
        return await started
      })
      const fadingAlpha = Number(fadingColor.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)/u)?.[1] ?? 1)
      expect(fadingAlpha, 'Excluding the page fades the glass towards opaque').toBeGreaterThan(headerGlass.backgroundAlpha)
      expect(fadingAlpha, 'Excluding the page does not snap to opaque').toBeLessThan(1)
      await body.evaluate(element =>
        element.getAnimations().forEach(animation => {
          animation.play()
        })
      )
      await expect.poll(async () => (await readSurfaceStyle(body)).backgroundAlpha).toBe(1)
      await expect.poll(async () => (await readSurfaceStyle(card)).backgroundAlpha).toBe(1)
      await agent.getByRole('button', { name: 'Include current page', exact: true }).click()
      await expect.poll(async () => (await readSurfaceStyle(body)).backgroundAlpha).toBe(headerGlass.backgroundAlpha)
      await expect.poll(async () => (await readSurfaceStyle(card)).backgroundAlpha).toBe(0)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const surface of [card, toolbar, body]) {
        // The global accessibility reset retains a 1µs transition for events.
        const duration = await surface.evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration))
        expect(duration, 'Reduced motion removes any perceptible background fade').toBeLessThanOrEqual(0.000001)
      }
      await included.click()
      expect((await readSurfaceStyle(body)).backgroundAlpha).toBe(1)
      await agent.getByRole('button', { name: 'Include current page', exact: true }).click()
      await expectContextualGlass(false)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expectOpaqueWorkspaceSurfaces()

      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
      })
      await expect.poll(() => page.evaluate(() => window.matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true)
      await expectContextualGlass(true)
      await expectOpaqueWorkspaceSurfaces()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => undefined)
      await fixture.dispose()
    }
  })

  test('exposes Stop response while an enabled Agent stream is active', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    const fixture = await installEnabledAgentFixture(page, { mode: 'stop' })
    try {
      const agent = await openEnabledAgent(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Stop this response after streaming begins.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      const stop = agent.getByRole('button', { name: 'Stop response', exact: true })
      await expect(stop).toBeVisible()
      await stop.click()
      const stoppedResponse = agent.locator('article.agent-message--assistant.agent-message--cancelled')
      await expect(stoppedResponse.getByText('You can continue by retrying the request.', { exact: true })).toBeVisible()
      await expect(stop).toBeHidden()
      const followUpComposer = agent.getByRole('textbox', { name: 'Follow up with Wiki Agent' })
      await expect(followUpComposer).toBeEnabled()
      await expect(agent.getByRole('status', { name: 'Ready', exact: true })).toBeVisible()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })

  test('renders pending approval and resolves it without leaving the Agent surface', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    const fixture = await installEnabledAgentFixture(page, { mode: 'approval' })
    try {
      const agent = await openEnabledAgent(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Prepare the reviewed release note and ask for approval.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('Awaiting approval', { exact: true })).toBeVisible()
      const deny = agent.getByRole('button', { name: 'Deny', exact: true })
      await expect(deny).toBeVisible()
      await deny.click()
      const deniedHeading = agent.locator('strong').filter({ hasText: /^Change denied$/u })
      await expect(deniedHeading).toBeVisible()
      await expect(deny).toBeHidden()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })

  test('contains Ask keyboard focus and restores the invoking search control', async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const search = page.locator('.nav-header-search-control input:visible').first()
    await expect(search).toBeVisible()
    await search.focus()
    await page.keyboard.press('Control+Shift+A')

    const dialog = page.getByRole('dialog', { name: 'Wiki Agent workspace' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate(root => root.contains(document.activeElement))).toBe(true)
    const backgroundState = await page
      .locator('main')
      .first()
      .evaluate(element => {
        const isolatedAncestor = element.closest<HTMLElement>('[inert][aria-hidden="true"]')
        return {
          ariaHidden: isolatedAncestor?.getAttribute('aria-hidden'),
          inert: isolatedAncestor?.inert === true
        }
      })
    expect(backgroundState).toEqual({ ariaHidden: 'true', inert: true })
    await expect
      .poll(() =>
        search.evaluate(element => {
          const isolatedAncestor = element.closest<HTMLElement>('[inert][aria-hidden="true"]')
          return isolatedAncestor?.inert === true
        })
      )
      .toBe(true)

    const tabbableCount = await dialog.evaluate(
      root =>
        Array.from(
          root.querySelectorAll<HTMLElement>(
            [
              'a[href]',
              'button:not([disabled])',
              'input:not([disabled]):not([type="hidden"])',
              'select:not([disabled])',
              'textarea:not([disabled])',
              '[contenteditable="true"]',
              '[tabindex]:not([tabindex="-1"])'
            ].join(',')
          )
        ).filter(element => {
          const style = window.getComputedStyle(element)
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
        }).length
    )
    expect(tabbableCount).toBeGreaterThan(1)
    for (let press = 0; press <= tabbableCount; press += 1) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate(root => root.contains(document.activeElement)), `Tab ${press + 1} left the Ask dialog`).toBe(true)
    }
    for (let press = 0; press <= tabbableCount; press += 1) {
      await page.keyboard.press('Shift+Tab')
      expect(await dialog.evaluate(root => root.contains(document.activeElement)), `Shift+Tab ${press + 1} left the Ask dialog`).toBe(true)
    }

    const escapeSource = dialog.getByRole('region', { name: 'Conversation transcript' })
    await escapeSource.focus()
    await expect(escapeSource).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(search).toBeFocused()
    await page.keyboard.press('Escape')
    await expect
      .poll(() =>
        page
          .locator('main')
          .first()
          .evaluate(element => {
            if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML main element')
            return {
              ariaHidden: element.getAttribute('aria-hidden'),
              inert: element.inert
            }
          })
      )
      .toEqual({ ariaHidden: null, inert: false })
  })
  test('leaves the denied agent shortcut unconsumed', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await page.goto('/en/home', { waitUntil: 'networkidle' })

    const search = await openSearch(page)
    const dispatchResult = await search.evaluate(element => {
      const event = new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
      return { dispatched: element.dispatchEvent(event), defaultPrevented: event.defaultPrevented }
    })

    expect(dispatchResult).toEqual({ dispatched: true, defaultPrevented: false })
    await expect(search).toBeFocused()
    await expect(page.getByRole('dialog', { name: 'Wiki Agent workspace' })).toHaveCount(0)
  })

  test('keeps page navigation and return-to-top controls reachable below desktop width', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-mobile')
    await page.setViewportSize({ width: 1180, height: 500 })
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.v-main')

    const drawer = page.locator('.v-navigation-drawer').first()
    await expect(drawer).toHaveClass(/v-navigation-drawer--temporary/)
    await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
    await page.getByRole('button', { name: 'Close navigation' }).click()
    await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const returnToTop = page.getByRole('button', { name: /return to top/i })
    await expect(returnToTop).toBeVisible()
    await returnToTop.click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(2)
  })
})
