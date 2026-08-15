import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'

const adminEmail = 'test@example.com'
const adminPassword = '12345678'

async function authenticateAsAdmin(page: Page) {
  const response = await page.request.post('/_api/auth/login', {
    data: {
      strategy: 'local',
      username: adminEmail,
      password: adminPassword
    }
  })
  expect(response.ok()).toBe(true)
  const payload = await response.json() as { jwt?: string }
  if (!payload.jwt) throw new Error('Administrator login did not return a JWT')
  await page.context().addCookies([{
    name: 'jwt',
    value: payload.jwt,
    url: new URL(response.url()).origin
  }])
}

async function openAuthenticatedPage(page: Page, path: string, readySelector: string) {
  await authenticateAsAdmin(page)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(path, { waitUntil: 'networkidle' })
    try {
      await page.locator(readySelector).first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
}

async function expectNoBlockingAccessibilityViolations(page: Page, surface: string) {
  await page.locator('.animated').evaluateAll(elements => {
    for (const element of elements) {
      for (const animation of element.getAnimations()) animation.finish()
    }
  })
  const result = await new AxeBuilder({ page })
    .exclude('.v-tooltip:not(.v-overlay--active)')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()
  const blockingViolations = result.violations.filter(violation =>
    violation.impact === 'critical' || violation.impact === 'serious'
  )
  expect(blockingViolations, `${surface} has serious or critical accessibility violations`).toEqual([])
}

function requireProject(testInfo: TestInfo, projectName: string) {
  test.skip(testInfo.project.name !== projectName, `Covered by the ${projectName} project`)
}

function requireAnyProject(testInfo: TestInfo, projectNames: readonly string[]) {
  test.skip(!projectNames.includes(testInfo.project.name), `Covered by ${projectNames.join(', ')}`)
}

async function tabToControl(page: Page, labelPattern: RegExp, maximumPresses = 60) {
  for (let press = 0; press < maximumPresses; press += 1) {
    await page.keyboard.press('Tab')
    const label = await page.evaluate(() => {
      const focused = document.activeElement
      return `${focused?.getAttribute('aria-label') ?? ''} ${focused?.textContent ?? ''}`.trim()
    })
    if (labelPattern.test(label)) return true
  }
  return false
}

test.describe('release accessibility profiles', () => {
  test('meets WCAG gates on primary desktop surfaces', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    for (const surface of ['/', '/a/dashboard', '/a/pages', '/edit/en/home']) {
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
    await expect(page.getByRole('img', { name: 'Dashboard' })).toBeVisible()
  })

  test('meets contrast and accessibility gates in dark mode', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-dark')
    test.setTimeout(45_000)
    await openAuthenticatedPage(page, '/a/theme', '.v-switch')
    const darkMode = page.getByRole('checkbox', { name: 'Dark Mode' })
    await expect(darkMode).toBeVisible()
    if (!await darkMode.isChecked()) await darkMode.click()
    await expect(page.locator('.v-theme--dark').first()).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, '/a/theme (dark)')
  })

  test('avoids horizontal overflow across release viewport profiles', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile', 'accessibility-tablet', 'accessibility-wide'])
    await authenticateAsAdmin(page)
    for (const surface of ['/', '/a/dashboard', '/a/pages']) {
      await page.goto(surface, { waitUntil: 'networkidle' })
      const layout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth
      }))
      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1)
      await expectNoBlockingAccessibilityViolations(page, `${surface} (mobile)`)
    }
  })

  test('opens and reaches primary editor actions using only the keyboard', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await openAuthenticatedPage(page, '/en/home', '.page-header-section')

    expect(await tabToControl(page, /edit page/i), 'Edit page must be reachable in the tab order').toBe(true)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/e(?:dit)?\/en\/home/)
    await expect(page.getByRole('button', { name: /save|saved/i })).toBeVisible()
    expect(await tabToControl(page, /save|saved/i), 'Save must be reachable in the editor tab order').toBe(true)
  })

  test('announces search failure, retries, and exposes the empty result state', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    let requests = 0
    await page.route('**/_api/pages/search?**', async route => {
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
    const search = page.getByRole('textbox', { name: /search/i })
    await search.focus()
    await page.keyboard.type('unavailable-query')
    await expect(page.getByRole('alert')).toContainText('Search service is unavailable.')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('status')).toContainText('Try a different term or broader scope.')
  })

  test('keeps page navigation and return-to-top controls reachable below desktop width', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-mobile')
    await page.setViewportSize({ width: 1180, height: 500 })
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.v-main')

    const drawer = page.locator('.v-navigation-drawer').first()
    await expect(drawer).toHaveClass(/v-navigation-drawer--temporary/)
    await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
    await page.getByRole('button', { name: 'Toggle navigation' }).click()
    await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
    await page.locator('.v-navigation-drawer__scrim').click({ position: { x: 500, y: 250 } })
    await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const returnToTop = page.getByRole('button', { name: /return to top/i })
    await expect(returnToTop).toBeVisible()
    await returnToTop.click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(2)
  })
})
