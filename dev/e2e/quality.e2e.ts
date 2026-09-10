import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { authenticateAsAdmin, expectResponsiveLayout, openAuthenticatedPage, openSearch } from './helpers.ts'
import { installEnabledAgentFixture } from './agent-fixture.ts'

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
  await openSearch(page)
  await expect(page.locator('.search-results-agent-entry')).toBeVisible()
  await page.locator('.search-results-agent-entry').click()
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
    await openSearch(page)
    await expect(page.locator('.search-results-agent-entry')).toBeVisible()
    await page.locator('.search-results-agent-entry').click()
    await expect(page.getByRole('region', { name: 'Wiki Agent' })).toBeVisible()
    await expect(page.getByText(/Agent inference is currently disabled/)).toBeVisible()
    await expectResponsiveLayout(page, `inline agent (${testInfo.project.name})`)
    await expectNoBlockingAccessibilityViolations(page, `inline agent (${testInfo.project.name})`)
    if (testInfo.project.name === 'accessibility-keyboard') {
      const history = page.getByRole('button', { name: 'Open agent conversation history' })
      expect(await tabToControl(page, history), 'Agent history must be reachable in the tab order').toBe(true)
    }
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
          .evaluate(element => ({
            ariaHidden: element.getAttribute('aria-hidden'),
            inert: element.inert
          }))
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
