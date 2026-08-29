import { expect, test as base } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

export const adminEmail = 'test@example.com'
export const adminPassword = '12345678'

export async function authenticateAsAdmin(page: Page) {
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
  const baseUrl = base.info().project.use.baseURL
  if (typeof baseUrl !== 'string') throw new Error('Playwright base URL is unavailable.')
  await page.context().addCookies([{
    name: 'jwt',
    value: payload.jwt,
    url: new URL(response.url(), baseUrl).origin
  }])
}

export async function openAuthenticatedPage(page: Page, path: string, readySelector: string) {
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

export async function openSearch(page: Page) {
  const search = page.getByRole('textbox', { name: /search/i }).first()
  if (!await search.isVisible()) {
    await page.getByRole('button', { name: /^search/i }).click()
  }
  await expect(search).toBeVisible()
  await search.focus()
  return search
}

export async function expectLocatorWithinViewport(locator: Locator, surface: string) {
  await expect(locator, `${surface} must be visible`).toBeVisible()
  await expect.poll(async () => locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return rect.left >= -1
      && rect.top >= -1
      && rect.right <= window.innerWidth + 1
      && rect.bottom <= window.innerHeight + 1
  }), `${surface} must fit inside the viewport`).toBe(true)
}

export async function expectResponsiveLayout(page: Page, surface: string) {
  await page.locator('.animated').evaluateAll(elements => {
    for (const element of elements) {
      for (const animation of element.getAnimations()) {
        try {
          animation.finish()
        } catch {
          animation.cancel()
        }
      }
    }
  })

  const report = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const documentWidth = document.documentElement.scrollWidth
    const candidates = Array.from(document.querySelectorAll<HTMLElement>([
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="dialog"]',
      '[role="region"]',
      '[tabindex]:not([tabindex="-1"])',
      'header',
      'main',
      'footer'
    ].join(',')))

    const isVisible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0
    }
    const isInInactiveLayer = (element: HTMLElement) => Boolean(element.closest(
      '.v-navigation-drawer:not(.v-navigation-drawer--active), .v-overlay:not(.v-overlay--active), [aria-hidden="true"]'
    ))
    const isInHorizontalScroller = (element: HTMLElement) => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent)
        if (/auto|scroll/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return true
      }
      return false
    }
    const describe = (element: HTMLElement) => {
      const label = element.getAttribute('aria-label') || element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80)
      const classes = Array.from(element.classList).slice(0, 3).join('.')
      const rect = element.getBoundingClientRect()
      const position = `[${rect.left.toFixed(1)}, ${rect.right.toFixed(1)}]`
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes ? `.${classes}` : ''}${label ? ` (${label})` : ''} ${position}`
    }

    const offscreen = candidates.flatMap(element => {
      if (!isVisible(element) || isInInactiveLayer(element) || isInHorizontalScroller(element)) return []
      const rect = element.getBoundingClientRect()
      return rect.left < -1 || rect.right > viewportWidth + 1 ? [describe(element)] : []
    })

    return { documentWidth, offscreen, viewportWidth }
  })

  expect(
    report.documentWidth,
    `${surface} document width ${report.documentWidth}px exceeds its ${report.viewportWidth}px viewport`
  ).toBeLessThanOrEqual(report.viewportWidth + 1)
  expect(report.offscreen, `${surface} has horizontally clipped visible controls or landmarks`).toEqual([])
}

type ResponsiveFixtures = {
  pageErrors: string[]
}

export const responsiveTest = base.extend<ResponsiveFixtures>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => {
      if (error.message !== 'ResizeObserver loop completed with undelivered notifications.') {
        errors.push(error.message)
      }
    })
    await use(errors)
    expect(errors, 'The responsive surface raised uncaught browser errors').toEqual([])
  }, { auto: true }]
})
