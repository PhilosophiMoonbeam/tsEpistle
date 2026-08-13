import { expect, test, type Page } from '@playwright/test'

const adminEmail = 'test@example.com'
const adminPassword = '12345678'

async function expectWelcomePage(page: Page) {
  await expect(page).toHaveURL('/')
  await expect(page).toHaveTitle('Welcome | Wiki.ts Preview')
  await expect(page.getByRole('img', { name: 'Wiki.js' })).toBeVisible()
  await expect(page.getByText('Welcome to your wiki!', { exact: true })).toBeVisible()
  await expect(page.getByText("Let's get started and create the home page.", { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create Home Page' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible()
}

async function loginAsAdmin(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.getByPlaceholder('Email Address').fill(adminEmail)
  await page.getByPlaceholder('Password').fill(adminPassword)
  await page.getByRole('button', { name: 'Log In' }).click()
  await expect(page).toHaveURL('/')
  await expect.poll(async () => page.evaluate(async () => {
    const response = await fetch('/_api/users/whoami', { credentials: 'same-origin' })
    return response.json()
  })).toMatchObject({
    authenticated: true,
    user: { email: adminEmail }
  })
}

test.describe('critical post-install workflows', () => {
  test.describe.configure({ mode: 'serial', retries: 0 })

  test('installs Wiki.ts Preview with telemetry disabled and opens the login screen', async ({ page }) => {
    test.setTimeout(45_000)

    await page.goto('/')
    await expect(page.getByText('You are about to install Wiki.ts Preview')).toBeVisible()

    const siteUrl = new URL(page.url()).origin
    await page.getByLabel('Administrator Email').fill(adminEmail)
    await page.getByLabel('Password', { exact: true }).fill(adminPassword)
    await page.getByLabel('Confirm Password', { exact: true }).fill(adminPassword)
    await page.getByLabel('Site URL').fill(siteUrl)
    await page.getByRole('checkbox', { name: 'Allow Telemetry' }).uncheck()
    await expect(page.getByRole('checkbox', { name: 'Allow Telemetry' })).not.toBeChecked()

    await page.getByRole('button', { name: 'Install' }).click()
    await expect(page.getByText('Installation complete!')).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL('/login', { timeout: 10_000 })
    await expect(page.getByPlaceholder('Email Address')).toBeVisible()
    await expect(page.getByPlaceholder('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible()
  })

  test('authenticates the administrator and preserves the session on reload', async ({ page }) => {
    await loginAsAdmin(page)

    await page.reload()
    await expectWelcomePage(page)
  })

  test('navigates from the homepage to the authenticated administration dashboard', async ({ page }) => {
    await loginAsAdmin(page)

    await page.getByRole('link', { name: 'Administration' }).click()
    await expect(page).toHaveURL('/a/dashboard')
    await expect(page.getByText('Administration Area', { exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('Recent Pages', { exact: true })).toBeVisible()
    await expect(page.getByText('Last Logins', { exact: true })).toBeVisible()
  })

  test('creates and publishes the home page with the Markdown editor', async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsAdmin(page)

    await page.getByRole('link', { name: 'Create Home Page' }).click()
    await expect(page).toHaveURL('/e/en/home')
    await page.getByText('Markdown', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Home')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Welcome home')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible()
    await editor.fill('# Browser Workflow\n\nPublished through the modern editor.')
    await page.getByRole('button', { name: 'Create' }).click()

    await expect(page).toHaveURL('/en/home', { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Browser Workflow' })).toBeVisible()
    await expect(page.getByText('Published through the modern editor.')).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Browser Workflow' })).toBeVisible()
  })

  test('edits and renders the published home page', async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsAdmin(page)
    await page.goto('/en/home')

    await page.getByRole('button', { name: 'Edit Page' }).click()
    await expect(page).toHaveURL('/e/en/home')
    const editor = page.locator('.cm-content')
    await editor.fill('# Browser Workflow Updated\n\nEdited and rendered through the modern editor.')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Close' }).click()

    await expect(page).toHaveURL('/en/home')
    await expect(page.getByRole('heading', { name: 'Browser Workflow Updated' })).toBeVisible()
    await expect(page.getByText('Edited and rendered through the modern editor.')).toBeVisible()
  })

  test('searches for and opens the published home page', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/en/home')

    await page.getByRole('textbox', { name: 'Search...' }).fill('Home')
    const result = page.locator('.search-results-items').getByText('Home', { exact: true })
    await expect(result).toBeVisible()
    await result.click()

    await expect(page).toHaveURL('/en/home')
    await expect(page.getByRole('heading', { name: 'Browser Workflow Updated' })).toBeVisible()
  })

  test('opens the authenticated administrator profile', async ({ page }) => {
    await loginAsAdmin(page)
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByText('Profile', { exact: true }).click()

    await expect(page).toHaveURL('/p/profile')
    await expect(page.getByText('My personal info', { exact: true })).toBeVisible()
    await expect(page.getByText('Administrator', { exact: true })).toBeVisible()
    await expect(page.getByText('Local', { exact: true })).toBeVisible()
  })

  test('logs out and authenticates again without browser runtime failures', async ({ page }) => {
    const consoleErrors: string[] = []
    const failedRequests: string[] = []
    page.on('console', message => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })
    page.on('requestfailed', request => {
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'unknown failure'}`)
    })

    await loginAsAdmin(page)
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByText('Logout', { exact: true }).click()
    await expect(page).toHaveURL('/')
    await expect.poll(async () => page.evaluate(async () => {
      const response = await fetch('/_api/users/whoami', { credentials: 'same-origin' })
      return response.json()
    })).toMatchObject({ authenticated: false })
    await page.goto('/login')

    await page.getByPlaceholder('Email Address').fill(adminEmail)
    await page.getByPlaceholder('Password').fill(adminPassword)
    await page.getByRole('button', { name: 'Log In' }).click()
    await expect(page).toHaveURL('/')
    await expect(page).toHaveTitle('Home | Wiki.ts Preview')
    await expect(page.getByRole('heading', { name: 'Browser Workflow Updated' })).toBeVisible()
    await expect.poll(async () => page.evaluate(async () => {
      const response = await fetch('/_api/users/whoami', { credentials: 'same-origin' })
      return response.json()
    })).toMatchObject({
      authenticated: true,
      user: { email: adminEmail }
    })
    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })
})
