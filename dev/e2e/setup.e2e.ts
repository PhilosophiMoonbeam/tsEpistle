import { expect, test, type Page } from '@playwright/test'

const adminEmail = 'test@example.com'
const adminPassword = '12345678'

async function expectWelcomePage(page: Page) {
  await expect(page).toHaveURL('/')
  await expect(page).toHaveTitle('Welcome | Wiki.js')
  await expect(page.getByRole('img', { name: 'Wiki.js' })).toBeVisible()
  await expect(page.getByText('Welcome to your wiki!', { exact: true })).toBeVisible()
  await expect(page.getByText("Let's get started and create the home page.", { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create Home Page' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible()
}

async function loginAsAdmin(page: Page) {
  await page.goto('/login')
  await page.getByPlaceholder('Email Address').fill(adminEmail)
  await page.getByPlaceholder('Password').fill(adminPassword)
  await page.getByRole('button', { name: 'Log In' }).click()
  await expectWelcomePage(page)
}

test.describe('critical post-install workflows', () => {
  test.describe.configure({ mode: 'serial', retries: 0 })

  test('installs Wiki.js with telemetry disabled and opens the login screen', async ({ page }) => {
    test.setTimeout(45_000)

    await page.goto('/')
    await expect(page.getByText('You are about to install Wiki.js')).toBeVisible()

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
})
