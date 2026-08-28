import { expect } from '@playwright/test'
import {
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
    for (const path of ['/en/home', '/en/visual-markdown-browser']) {
      await openAuthenticatedPage(page, path, '.page-header-section')
      await expectResponsiveLayout(page, path)
    }

    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (!viewport) return

    const drawer = page.locator('.v-navigation-drawer').first()
    if (viewport.width < 1280) {
      await expect(drawer).toHaveClass(/v-navigation-drawer--temporary/)
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
      await page.getByRole('button', { name: 'Toggle navigation' }).click()
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
      await expectLocatorWithinViewport(drawer, 'Open page navigation')
      await expectResponsiveLayout(page, 'Open page navigation')
      await page.locator('.v-navigation-drawer__scrim').click({
        position: { x: viewport.width - 16, y: viewport.height / 2 }
      })
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
    } else {
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--temporary/)
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
    }

    const editPage = page.getByRole('button', { name: /edit page/i })
    await expectLocatorWithinViewport(editPage, 'Quick edit action')
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const returnToTop = page.getByRole('button', { name: /return to top/i })
    await expectLocatorWithinViewport(returnToTop, 'Return to top action')
    await returnToTop.click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(2)
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
    const toggle = page.getByRole('button', { name: 'Administration navigation', exact: true })
    if (viewport.width < 840) {
      await expect(toggle).toBeVisible()
      await expect(drawer).toHaveClass(/v-navigation-drawer--temporary/)
      await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
      await toggle.click()
      await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
      await expectLocatorWithinViewport(drawer, 'Administration navigation')
      await expectResponsiveLayout(page, 'Open administration navigation')
      await page.getByRole('button', { name: 'Close administration navigation' }).click()
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
    await expect(agent.getByRole('combobox', { name: 'Message Wiki Agent' })).toBeVisible()
    await expect(agent.getByRole('button', { name: 'Open agent conversation history' })).toBeVisible()
    await expect(agent.getByText('How this session uses the model')).toHaveCount(0)
    const profileCount = await page.evaluate(async () => (await fetch('/_api/agents/profiles')).json().then((value: { profiles?: unknown[] }) => value.profiles?.length ?? 0))
    const settingsButton = agent.getByRole('button', { name: 'Session configuration' })
    if (profileCount > 1) {
      await expect(settingsButton).toBeVisible()
      await settingsButton.click()
      await expect(agent.getByText('Provider profile')).toBeVisible()
      await expect(agent.getByText('Pinned skills (always loaded)')).toHaveCount(0)
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
        await settings.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect.poll(() => settings.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      }
    } else {
      await expect(settingsButton).toHaveCount(0)
    }
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
