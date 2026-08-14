import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const adminEmail = 'test@example.com'
const adminPassword = '12345678'
type BrowserVisualEditor = {
  getData(): string
  setData(data: string): void
}
type BrowserSourceEditor = {
  getValue(): string
}


type BrowserVueInstance = {
  parent?: BrowserVueInstance | null
  proxy?: {
    cm?: BrowserSourceEditor | null
    editor?: BrowserVisualEditor | null
  }
}

const visualMarkdownBrowserFixture = `# Visual Markdown browser

## Heading 2

### Heading 3

#### Heading 4

##### Heading 5

###### Heading 6

Paragraph with **bold**, *italic*, ~~strikethrough~~, and \`inline code\`.

---

> A blockquote.

1. First
   1. Nested
2. Second

- Bullet
- [x] Done
- [ ] Pending

\`\`\`javascript
const answer = 42
\`\`\`

| Name | Value |
| --- | --- |
| Alpha | One |

Internal target`

const visualHtmlBrowserFixture = `<h2>Visual HTML heading</h2>
<p>Text with <strong>bold</strong>, <u>underline</u>, and <a href="/en/home">an internal link</a>.</p>
<figure class="table"><table><thead><tr><th>HTML</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>One</td></tr></tbody></table></figure>
<figure class="image image-style-side"><img src="/_assets/svg/icon-image.svg" alt="Example image"><figcaption>Visual HTML caption</figcaption></figure>`

async function getCkEditorData(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.editor-ckeditor')
    let instance = (host as HTMLElement & { __vueParentComponent?: BrowserVueInstance }).__vueParentComponent
    while (instance && !instance.proxy?.editor) instance = instance.parent
    const editor = instance?.proxy?.editor
    if (!editor) throw new Error('CKEditor instance is unavailable.')
    return editor.getData()
  })
}

async function setCkEditorData(page: Page, data: string): Promise<void> {
  await page.evaluate(content => {
    const host = document.querySelector<HTMLElement>('.editor-ckeditor')
    let instance = (host as HTMLElement & { __vueParentComponent?: BrowserVueInstance }).__vueParentComponent
    while (instance && !instance.proxy?.editor) instance = instance.parent
    const editor = instance?.proxy?.editor
    if (!editor) throw new Error('CKEditor instance is unavailable.')
    editor.setData(content)
  }, data)
}

async function getMarkdownSourceData(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.editor-markdown')
    let instance = (host as HTMLElement & { __vueParentComponent?: BrowserVueInstance }).__vueParentComponent
    while (instance && !instance.proxy?.cm) instance = instance.parent
    const editor = instance?.proxy?.cm
    if (!editor) throw new Error('Markdown source editor instance is unavailable.')
    return editor.getValue()
  })
}


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
    test.setTimeout(90_000)
    await loginAsAdmin(page)
    await page.goto('/e/en/visual-markdown-browser')
    await page.getByText('Visual Markdown', { exact: true }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Visual Markdown Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Canonical Markdown from CKEditor')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.editor-ckeditor > .ck-editor__editable')
    await expect(editor).toBeVisible()
    await setCkEditorData(page, visualMarkdownBrowserFixture)
    await expect(editor.getByRole('heading', { name: 'Heading 6' })).toBeVisible()
    await expect(editor.locator('table')).toBeVisible()
    await expect(editor.getByRole('checkbox')).toHaveCount(2)


    await editor.click()
    await page.keyboard.press('Control+End')
    for (let index = 0; index < 'target'.length; index += 1) {
      await page.keyboard.press('Shift+ArrowLeft')
    }
    await page.evaluate(async () => {
      const clientOrigin = new URL(document.querySelector<HTMLScriptElement>('script[src*="/client/index-app"]')?.src ?? window.location.href).origin
      const { emitEditorLinkToPage } = await import(`${clientOrigin}/client/helpers/editor-link-events.ts`)
      emitEditorLinkToPage({})
    })
    await page.locator('.page-selector .v-card-actions input:not([role="combobox"])').fill('home')
    await page.getByRole('button', { name: 'Select' }).click()

    await editor.click()
    await page.keyboard.press('Control+End')
    await page.evaluate(async () => {
      const clientOrigin = new URL(document.querySelector<HTMLScriptElement>('script[src*="/client/index-app"]')?.src ?? window.location.href).origin
      const { emitEditorInsert } = await import(`${clientOrigin}/client/helpers/editor-insert-events.ts`)
      emitEditorInsert({ kind: 'IMAGE', path: '/_assets/svg/icon-image.svg', text: 'Example image' })
    })
    await expect(editor.getByRole('img', { name: 'Example image' })).toBeVisible()

    await editor.click()
    await page.keyboard.press('Control+End')
    await page.evaluate(async () => {
      const clientOrigin = new URL(document.querySelector<HTMLScriptElement>('script[src*="/client/index-app"]')?.src ?? window.location.href).origin
      const { emitEditorInsert } = await import(`${clientOrigin}/client/helpers/editor-insert-events.ts`)
      emitEditorInsert({ kind: 'BINARY', path: '/assets/document.pdf', text: 'document.pdf' })
    })
    await expect(editor.getByRole('link', { name: 'document.pdf' })).toHaveAttribute('href', '/assets/document.pdf')

    const beforeDiagram = await getCkEditorData(page)
    await page.evaluate(async () => {
      const clientOrigin = new URL(document.querySelector<HTMLScriptElement>('script[src*="/client/index-app"]')?.src ?? window.location.href).origin
      const { emitEditorInsert } = await import(`${clientOrigin}/client/helpers/editor-insert-events.ts`)
      emitEditorInsert({ kind: 'DIAGRAM', text: 'PHN2Zz48L3N2Zz4=' })
    })
    await expect(page.getByText(/Diagrams are not supported by Visual Markdown/)).toBeVisible()
    expect(await getCkEditorData(page)).toBe(beforeDiagram)

    const authoredMarkdown = await getCkEditorData(page)
    expect(authoredMarkdown).toContain('# Visual Markdown browser')
    expect(authoredMarkdown).toContain('###### Heading 6')
    expect(authoredMarkdown).toContain('**bold**')
    expect(authoredMarkdown).toContain('~~strikethrough~~')
    expect(authoredMarkdown).toMatch(/1\. First\n {3,}\d+\. Nested/)
    expect(authoredMarkdown).toMatch(/[*-] \[x\] Done/)
    expect(authoredMarkdown).toContain('```javascript')
    expect(authoredMarkdown).toContain('| Name')
    expect(authoredMarkdown).toContain('![Example image](/_assets/svg/icon-image.svg)')
    expect(authoredMarkdown).toContain('[document.pdf](/assets/document.pdf)')
    expect(authoredMarkdown).toMatch(/\[target\]\(\/(?:en\/)?home\)/)

    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page).toHaveURL('/en/visual-markdown-browser', { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Visual Markdown browser' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Heading 6' })).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('img', { name: 'Example image' })).toBeVisible()

    const details = await page.evaluate(async () => {
      const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
      const row = pages.find((candidate: { path: string }) => candidate.path === 'visual-markdown-browser')
      return fetch(`/_api/pages/${row.id}`, { credentials: 'same-origin' }).then(response => response.json())
    })
    expect(details).toMatchObject({
      editor: 'visual-markdown',
      contentType: 'markdown'
    })

    await page.goto('/e/en/visual-markdown-browser')
    await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    await expect(page.getByText('Visual Markdown', { exact: true })).toBeVisible()
    await expect(editor).toContainText('Visual Markdown browser')

    await setCkEditorData(page, `${authoredMarkdown}\n\nSaved with the keyboard.`)
    await editor.click()
    await page.keyboard.press('Control+s')
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 30_000 })

    await page.evaluate(async () => {
      const clientOrigin = new URL(document.querySelector<HTMLScriptElement>('script[src*="/client/index-app"]')?.src ?? window.location.href).origin
      const { emitEditorSaveConflict } = await import(`${clientOrigin}/client/helpers/editor-conflict-events.ts`)
      emitEditorSaveConflict()
    })
    await expect(page.getByRole('button', { name: /Use Remote/i })).toBeVisible()
    await page.getByRole('button', { name: /Use Remote/i }).click()
    await page.getByRole('button', { name: 'Confirm' }).click()
    await expect(editor).toContainText('Saved with the keyboard.')

    await setCkEditorData(page, `${await getCkEditorData(page)}\n\nUnsaved draft.`)
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('button', { name: 'Discard Changes' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'Discard Changes' }).click()

    await expect(page).toHaveURL('/en/visual-markdown-browser')
    await expect(page.getByText('Saved with the keyboard.', { exact: true })).toBeVisible()
    await expect(page.getByText('Unsaved draft.', { exact: true })).not.toBeVisible()

    await page.goto('/e/en/visual-markdown-browser')
    await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    await expect(page.getByText('Visual Markdown', { exact: true })).toBeVisible()
    await expect(editor).toContainText('Saved with the keyboard.')
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
    await expect(page.getByRole('button', { name: 'Underline' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Decrease indent' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Increase indent' })).toBeVisible()
    await setCkEditorData(page, visualHtmlBrowserFixture)
    await expect(editor.getByRole('heading', { name: 'Visual HTML heading' })).toBeVisible()
    await expect(editor.getByRole('link', { name: 'an internal link' })).toBeVisible()
    await expect(editor.locator('table')).toBeVisible()
    await expect(editor.getByText('Visual HTML caption', { exact: true })).toBeVisible()

    await expect(editor.locator('figure.image-style-side')).toBeVisible()
    await page.waitForTimeout(350)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page).toHaveURL('/en/visual-html-browser', { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Visual HTML heading' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'an internal link' })).toHaveAttribute('href', '/en/home')
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByText('Visual HTML caption', { exact: true })).toBeVisible()

    const details = await page.evaluate(async () => {
      const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
      const row = pages.find((candidate: { path: string }) => candidate.path === 'visual-html-browser')
      return fetch(`/_api/pages/${row.id}`, { credentials: 'same-origin' }).then(response => response.json())
    })
    expect(details).toMatchObject({
      editor: 'ckeditor',
      contentType: 'html'
    })

    await page.goto('/e/en/visual-html-browser')
    await expect(page).toHaveURL('/e/en/visual-html-browser')
    await expect(page.getByText('Visual Editor', { exact: true })).toBeVisible()
    await expect(editor.getByRole('heading', { name: 'Visual HTML heading' })).toBeVisible()
    await expect(editor.getByText('Visual HTML caption', { exact: true })).toBeVisible()
    await expect(editor.locator('figure.image-style-side')).toBeVisible()
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
    await expect(page.locator('.editor-markdown')).toBeVisible({ timeout: 30_000 })
    const markdownBefore = await getMarkdownSourceData(page)
    expect(markdownBefore).toContain('# Visual Markdown browser')
    expect(markdownBefore).toContain('###### Heading 6')
    expect(markdownBefore).toContain('![Example image](/_assets/svg/icon-image.svg)')
    expect(markdownBefore).toMatch(/\[target\]\(\/(?:en\/)?home\)/)

    await convert('visual-markdown-browser', 'visual-markdown')
    await page.goto('/e/en/visual-markdown-browser')
    await expect(page.locator('.editor-ckeditor > .ck-editor__editable')).toContainText('Visual Markdown browser', { timeout: 30_000 })
    await expect(page.getByText('Visual Markdown', { exact: true })).toBeVisible()

    await convert('visual-markdown-browser', 'markdown')
    await page.goto('/e/en/visual-markdown-browser')
    await expect(page.locator('.editor-markdown')).toBeVisible({ timeout: 30_000 })
    expect(await getMarkdownSourceData(page)).toBe(markdownBefore)

    await convert('visual-markdown-browser', 'visual-markdown')
    await convert('visual-html-browser', 'visual-markdown')
    await page.goto('/e/en/visual-html-browser')
    await expect(page.locator('.editor-ckeditor > .ck-editor__editable')).toContainText('Visual HTML heading', { timeout: 30_000 })
    await expect(page.getByText('Visual Markdown', { exact: true })).toBeVisible()

    await convert('visual-html-browser', 'ckeditor')
    await page.goto('/e/en/visual-html-browser')
    await expect(page.locator('.editor-ckeditor > .ck-editor__editable')).toContainText('Visual HTML heading', { timeout: 30_000 })
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

    const sidebarLayout = await page.locator('#admin-navigation').evaluate(navigation => {
      const measure = (label: string) => {
        const item = [...navigation.querySelectorAll<HTMLElement>('.v-list-item')]
          .find(candidate => candidate.textContent?.trim().startsWith(label))
        const icon = item?.querySelector<HTMLElement>('.v-icon')
        const title = item?.querySelector<HTMLElement>('.v-list-item-title')
        if (!item || !icon || !title) throw new Error(`Missing ${label} navigation item layout.`)
        const itemBox = item.getBoundingClientRect()
        const iconBox = icon.getBoundingClientRect()
        const titleBox = title.getBoundingClientRect()
        return {
          height: itemBox.height,
          iconRight: iconBox.right,
          iconCenterY: iconBox.top + iconBox.height / 2,
          titleLeft: titleBox.left,
          titleCenterY: titleBox.top + titleBox.height / 2
        }
      }
      return {
        dashboard: measure('Dashboard'),
        pages: measure('Pages')
      }
    })
    expect(sidebarLayout.dashboard.titleLeft).toBeGreaterThan(sidebarLayout.dashboard.iconRight)
    expect(Math.abs(sidebarLayout.dashboard.titleCenterY - sidebarLayout.dashboard.iconCenterY)).toBeLessThan(2)
    expect(sidebarLayout.pages.height).toBe(sidebarLayout.dashboard.height)
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

  test('routes private pages from the browse sidebar through the private namespace', async ({ page }) => {
    await loginAsAdmin(page)
    const privatePage = await page.evaluate(async () => {
      const response = await fetch('/_api/pages', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content: '# Private Sidebar Page',
          description: 'Private browse link regression',
          editor: 'markdown',
          visibility: 'private',
          isPublished: true,
          locale: 'en',
          path: 'private-sidebar-link',
          publishEndDate: '',
          publishStartDate: '',
          scriptCss: '',
          scriptJs: '',
          tags: [],
          title: 'Private Sidebar Link'
        })
      })
      if (!response.ok) throw new Error(`Private page creation failed: ${response.status}`)
      return response.json() as Promise<{ page: { id: number } }>
    })

    try {
      await page.goto('/en/home')
      await page.getByRole('button', { name: 'Browse', exact: true }).click()
      const privateLink = page.getByRole('link', { name: 'Private Sidebar Link', exact: true })
      await expect(privateLink).toHaveAttribute('href', '/_private/en/private-sidebar-link')
      await privateLink.click()
      await expect(page).toHaveURL('/_private/en/private-sidebar-link')
      await expect(page.getByRole('heading', { name: 'Private Sidebar Page' })).toBeVisible()
    } finally {
      await page.request.delete(`/_api/pages/${privatePage.page.id}`)
    }
  })
})
