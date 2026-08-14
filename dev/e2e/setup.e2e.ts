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

async function expectNoHorizontalOverflow(page: Page) {
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1)
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
  test('creates, publishes, and reopens a Visual Markdown page', async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsAdmin(page)
    await page.goto('/e/en/visual-markdown-browser')
    await page.getByText('Visual Markdown', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Visual Markdown Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Canonical Markdown from CKEditor')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.editor-ckeditor > .ck-editor__editable')
    await expect(editor).toBeVisible()
    await editor.fill('Visual Markdown browser workflow.')
    await page.getByRole('button', { name: 'Create' }).click()

    await expect(page).toHaveURL('/en/visual-markdown-browser', { timeout: 30_000 })
    await expect(page.getByText('Visual Markdown browser workflow.', { exact: true })).toBeVisible()

    const details = await page.evaluate(async () => {
      const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
      const row = pages.find((candidate: { path: string }) => candidate.path === 'visual-markdown-browser')
      return fetch(`/_api/pages/${row.id}`, { credentials: 'same-origin' }).then(response => response.json())
    })
    expect(details).toMatchObject({
      editor: 'visual-markdown',
      contentType: 'markdown'
    })

    await page.getByRole('button', { name: 'Edit Page' }).click()
    await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    await expect(page.getByText('Visual Markdown', { exact: true })).toBeVisible()
    await expect(editor).toContainText('Visual Markdown browser workflow.')
    await editor.fill('Visual Markdown browser workflow updated.')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page).toHaveURL('/en/visual-markdown-browser')
    await expect(page.getByText('Visual Markdown browser workflow updated.', { exact: true })).toBeVisible()
  })

  test('retains the Visual HTML editor and HTML content type', async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsAdmin(page)
    await page.goto('/e/en/visual-html-browser')
    await page.getByText('Visual Editor', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Visual HTML Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('HTML from CKEditor')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.editor-ckeditor > .ck-editor__editable')
    await expect(editor).toBeVisible()
    await editor.fill('Visual HTML browser workflow.')
    await page.waitForTimeout(350)
    await page.getByRole('button', { name: 'Create' }).click()

    await expect(page).toHaveURL('/en/visual-html-browser', { timeout: 30_000 })
    await expect(page.getByText('Visual HTML browser workflow.', { exact: true })).toBeVisible()

    const details = await page.evaluate(async () => {
      const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
      const row = pages.find((candidate: { path: string }) => candidate.path === 'visual-html-browser')
      return fetch(`/_api/pages/${row.id}`, { credentials: 'same-origin' }).then(response => response.json())
    })
    expect(details).toMatchObject({
      editor: 'ckeditor',
      contentType: 'html'
    })

    await page.getByRole('button', { name: 'Edit Page' }).click()
    await expect(page).toHaveURL('/e/en/visual-html-browser')
    await expect(page.getByText('Visual Editor', { exact: true })).toBeVisible()
    await expect(editor).toContainText('Visual HTML browser workflow.')
  })
  test('blocks unsupported extended Markdown before changing editors', async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsAdmin(page)
    await page.goto('/e/en/extended-markdown-browser')
    await page.getByText('Markdown', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Extended Markdown Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Unsupported visual syntax')
    await page.getByRole('button', { name: 'OK' }).click()

    const source = '## Callout\n\n> Preserved source\n{.is-info}'
    await page.locator('.cm-content').fill(source)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page).toHaveURL('/en/extended-markdown-browser', { timeout: 30_000 })

    const conversion = await page.evaluate(async () => {
      const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
      const row = pages.find((candidate: { path: string }) => candidate.path === 'extended-markdown-browser')
      const response = await fetch(`/_api/pages/${row.id}/convert`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor: 'visual-markdown' })
      })
      return {
        ok: response.ok,
        payload: await response.json()
      }
    })

    expect(conversion.ok).toBe(false)
    expect(JSON.stringify(conversion.payload)).toContain('Markdown attributes')

    await page.goto('/e/en/extended-markdown-browser')
    await expect(page.locator('.editor-markdown')).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText('## Callout')
    await expect(page.locator('.cm-content')).toContainText('{.is-info}')
  })
  test('switches between source, Visual Markdown, and Visual HTML conversion paths', async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsAdmin(page)

    const convert = async (path: string, editor: string) => {
      const result = await page.evaluate(async ({ path, editor }) => {
        const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
        const row = pages.find((candidate: { path: string }) => candidate.path === path)
        const response = await fetch(`/_api/pages/${row.id}/convert`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ editor })
        })
        return { ok: response.ok, body: await response.json() }
      }, { path, editor })
      expect(result.ok, JSON.stringify(result.body)).toBe(true)
    }

    await convert('visual-markdown-browser', 'markdown')
    await page.goto('/e/en/visual-markdown-browser')
    await expect(page.locator('.editor-markdown')).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText('Visual Markdown browser workflow updated.')

    await convert('visual-markdown-browser', 'visual-markdown')
    await page.goto('/e/en/visual-markdown-browser')
    await expect(page.locator('.editor-ckeditor > .ck-editor__editable')).toContainText('Visual Markdown browser workflow updated.')
    await expect(page.getByText('Visual Markdown', { exact: true })).toBeVisible()

    await convert('visual-html-browser', 'visual-markdown')
    await page.goto('/e/en/visual-html-browser')
    await expect(page.locator('.editor-ckeditor > .ck-editor__editable')).toContainText('Visual HTML browser workflow.')
    await expect(page.getByText('Visual Markdown', { exact: true })).toBeVisible()

    await convert('visual-html-browser', 'ckeditor')
    await page.goto('/e/en/visual-html-browser')
    await expect(page.locator('.editor-ckeditor > .ck-editor__editable')).toContainText('Visual HTML browser workflow.')
    await expect(page.getByText('Visual Editor', { exact: true })).toBeVisible()
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

  test('keeps administration workflows within the desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 })
    await loginAsAdmin(page)
    await page.goto('/a/dashboard')

    await expect(page.getByText('Administration Area', { exact: true })).toBeVisible()
    await expect(page.locator('#admin-navigation')).toBeVisible()
    await expect(page.getByText('Recent Pages', { exact: true })).toBeVisible()
    await expect(page.getByText('Last Logins', { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.goto('/a/pages')
    await expect(page.locator('.admin-header').getByText('Pages', { exact: true })).toBeVisible()
    await expect(page.locator('.admin-responsive-table')).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('keeps administration and editor controls usable at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsAdmin(page)
    await page.goto('/a/dashboard')

    const navigationButton = page.getByRole('button', { name: 'Administration navigation', exact: true })
    await expect(navigationButton).toBeVisible()
    await navigationButton.click()
    await expect(page.locator('#admin-navigation')).toBeVisible()
    await page.locator('#admin-navigation').getByText('Pages', { exact: true }).click()

    await expect(page).toHaveURL('/a/pages')
    await expect(page.locator('.admin-mobile-table-row').first()).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.goto('/en/home')
    await page.getByRole('button', { name: 'Edit Page' }).click()
    await expect(page).toHaveURL('/e/en/home')
    await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('Home')
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Editor actions' })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.getByRole('button', { name: 'Show preview' }).click()
    await expect(page.locator('.editor-markdown-preview')).toBeVisible()
    await expect(page.locator('.editor-markdown-editor')).toBeHidden()
    await page.getByRole('button', { name: 'Show editor' }).click()
    await expect(page.locator('.editor-markdown-editor')).toBeVisible()

    await page.getByRole('button', { name: 'Editor actions' }).click()
    await page.getByText('Page settings', { exact: true }).click()
    await expect(page.getByText('Page Properties', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Scheduling' }).click()
    await expect(page.getByRole('textbox', { name: 'Publish starting on...' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Publish ending on...' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await page.getByRole('button', { name: 'OK' }).click()

    await page.getByRole('button', { name: 'Editor actions' }).click()
    await page.getByText('Close editor', { exact: true }).click()
    await expect(page).toHaveURL('/en/home')
  })
})
