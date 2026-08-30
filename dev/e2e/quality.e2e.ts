import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'
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
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  })

  test('meets contrast and accessibility gates in dark mode', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-dark')
    test.setTimeout(45_000)
    await openAuthenticatedPage(page, '/a/theme', '.v-switch')
    const darkMode = page.getByRole('checkbox', { name: 'Dark Mode' })
    await expect(darkMode).toBeVisible()
    if (!(await darkMode.isChecked())) await darkMode.click()
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

    const pageActions = page.getByRole('button', { name: 'Page Actions', exact: true })
    expect(await tabToControl(page, pageActions), 'Page actions must be reachable in the tab order').toBe(true)
    await page.keyboard.press('Enter')
    const editPage = page.getByRole('button', { name: 'Edit', exact: true })
    await expect(editPage, 'Edit must receive focus when page actions open').toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/e(?:dit)?\/en\/home/)
    const save = page.getByRole('button', { name: /save|saved/i })
    await expect(save).toBeVisible()
    expect(await tabToControl(page, save), 'Save must be reachable in the editor tab order').toBe(true)
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
    await expect(page.getByRole('status')).toContainText('try a different term or scope.')
  })

  test('keeps the inline agent keyboard-accessible at desktop and mobile widths', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    await authenticateAsAdmin(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await openSearch(page)
    await expect(page.getByRole('button', { name: /^ask$/i })).toBeVisible()
    await page.getByRole('button', { name: /^ask$/i }).click()
    await expect(page.getByRole('region', { name: 'Wiki Agent' })).toBeVisible()
    await expect(page.getByText(/Agent inference is currently disabled/)).toBeVisible()
    await expectResponsiveLayout(page, `inline agent (${testInfo.project.name})`)
    await expectNoBlockingAccessibilityViolations(page, `inline agent (${testInfo.project.name})`)
    if (testInfo.project.name === 'accessibility-keyboard') {
      const history = page.getByRole('button', { name: 'Open agent conversation history' })
      expect(await tabToControl(page, history), 'Agent history must be reachable in the tab order').toBe(true)
    }
  })

  test('contains Ask keyboard focus and restores the invoking search control', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const search = await openSearch(page)
    const ask = page.getByRole('button', { name: /^ask$/i })
    expect(await tabToControl(page, ask), 'Ask must be reachable from the search control').toBe(true)
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Wiki Agent workspace' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate(root => root.contains(document.activeElement))).toBe(true)
    const backgroundState = await page
      .locator('.v-main')
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

    const composer = dialog.getByRole('combobox', { name: 'Message Wiki Agent' })
    const escapeSource = (await composer.isEnabled()) ? composer : dialog.locator('.inline-agent__transcript')
    await escapeSource.focus()
    await expect(escapeSource).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(search).toBeFocused()
    await expect
      .poll(() =>
        page
          .locator('.v-main')
          .first()
          .evaluate(element => ({
            ariaHidden: element.getAttribute('aria-hidden'),
            inert: element.inert
          }))
      )
      .toEqual({ ariaHidden: null, inert: false })
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
