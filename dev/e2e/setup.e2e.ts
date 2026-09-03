import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import tfa from 'node-2fa'
import { adminEmail, adminPassword } from './helpers.ts'

type BrowserVisualEditor = {
  commands: {
    setContent(data: string, options: { contentType: 'html' | 'markdown' }): void
  }
  getHTML(): string
  getMarkdown(): string
}
type BrowserSourceEditor = {
  getValue(): string
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

[target](/en/home)

![Example image](/_assets/svg/icon-image.svg)

[document.pdf](/assets/document.pdf)`

const visualHtmlBrowserFixture = `<h2>Visual HTML heading</h2>
<p>Text with <strong>bold</strong>, <u>underline</u>, and <a href="/en/home">an internal link</a>.</p>
<figure class="table"><table><thead><tr><th>HTML</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>One</td></tr></tbody></table></figure>
<figure class="image image-style-side"><img src="/_assets/svg/icon-image.svg" alt="Example image"><figcaption>Visual HTML caption</figcaption></figure>`

async function waitForVisualEditor(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((document.querySelector('.editor-tiptap') as HTMLElement & { __wikiEditor?: BrowserVisualEditor }).__wikiEditor))
}

async function getVisualEditorData(page: Page): Promise<string> {
  await waitForVisualEditor(page)
  return page.evaluate(() => {
    const editor = (document.querySelector('.editor-tiptap') as HTMLElement & { __wikiEditor?: BrowserVisualEditor }).__wikiEditor
    if (!editor) throw new Error('Tiptap editor instance is unavailable.')
    return document.querySelector('.editor-tiptap-markdown-tools') ? editor.getMarkdown() : editor.getHTML()
  })
}

async function setVisualEditorData(page: Page, data: string): Promise<void> {
  await waitForVisualEditor(page)
  await page.evaluate(content => {
    const editor = (document.querySelector('.editor-tiptap') as HTMLElement & { __wikiEditor?: BrowserVisualEditor }).__wikiEditor
    if (!editor) throw new Error('Tiptap editor instance is unavailable.')
    const contentType = document.querySelector('.editor-tiptap-markdown-tools') ? 'markdown' : 'html'
    editor.commands.setContent(content, { contentType })
  }, data)
}

async function getMarkdownSourceData(page: Page): Promise<string> {
  await page.waitForFunction(() =>
    Boolean((document.querySelector('.editor-markdown') as HTMLElement & { __wikiSourceEditor?: BrowserSourceEditor }).__wikiSourceEditor)
  )
  return page.evaluate(() => {
    const editor = (document.querySelector('.editor-markdown') as HTMLElement & { __wikiSourceEditor?: BrowserSourceEditor }).__wikiSourceEditor
    if (!editor) throw new Error('Markdown source editor instance is unavailable.')
    return editor.getValue()
  })
}

async function expectWelcomePage(page: Page) {
  await expect(page).toHaveURL('/')
  await expect(page).toHaveTitle('Welcome | tsEpistle')
  await expect(page.getByRole('img', { name: 'tsEpistle' })).toBeVisible()
  await expect(page.getByText('Welcome to your wiki!', { exact: true })).toBeVisible()
  await expect(page.getByText("Let's get started and create the home page.", { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create Home Page' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible()
}

async function expectAuthenticatedAdmin(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const response = await fetch('/_api/users/whoami', { credentials: 'same-origin' })
        return response.json()
      })
    )
    .toMatchObject({
      authenticated: true,
      user: { email: adminEmail }
    })
}

async function openClientPage(page: Page, path: string, readySelector = '#root > *') {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    try {
      await page.locator(readySelector).first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
}

async function loginAsAdmin(page: Page) {
  await openClientPage(page, '/login', '.login-form')
  await page.getByLabel('Email Address', { exact: true }).fill(adminEmail)
  await page.getByLabel('Password', { exact: true }).fill(adminPassword)
  await page.getByRole('button', { name: 'Log In' }).click()
  await expect(page).toHaveURL('/')
  await expectAuthenticatedAdmin(page)
}

async function authenticateAsAdmin(page: Page) {
  const response = await page.request.post('/_api/auth/login', {
    data: {
      strategy: 'local',
      username: adminEmail,
      password: adminPassword
    }
  })
  expect(response.ok()).toBe(true)
  const payload = (await response.json()) as { jwt?: unknown }
  if (typeof payload.jwt !== 'string') throw new Error('Administrator login did not return a JWT.')
  const baseUrl = test.info().project.use.baseURL
  if (typeof baseUrl !== 'string') throw new Error('Playwright base URL is unavailable.')
  await page.context().addCookies([
    {
      name: 'jwt',
      value: payload.jwt,
      url: new URL(response.url(), baseUrl).origin
    }
  ])
  await openClientPage(page, '/')
  await expectAuthenticatedAdmin(page)
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
}
async function openEditorForCurrentPage(page: Page): Promise<void> {
  await page.locator('.page-edit-fab:visible').click()
  if ((page.viewportSize()?.width ?? 1280) < 600) {
    await page.locator('.v-overlay--active').getByText('Edit Page', { exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Edit Page', exact: true }).click()
  }
}

test.describe('critical post-install workflows', () => {
  test.describe.configure({ mode: 'serial', retries: 0 })

  test('installs tsEpistle with telemetry disabled and opens the login screen', async ({ page }) => {
    test.setTimeout(90_000)

    await page.goto('/')
    await expect(page.getByText('First-run setup', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'tsEpistle', exact: true })).toBeVisible()

    const siteUrl = new URL(page.url()).origin
    await page.getByLabel('Administrator Email').fill(adminEmail)
    await page.getByLabel('Password', { exact: true }).fill(adminPassword)
    await page.getByLabel('Confirm Password', { exact: true }).fill(adminPassword)
    await page.getByLabel('Site URL').fill(siteUrl)
    const telemetry = page.getByRole('checkbox', { name: 'Allow anonymous telemetry' })
    await telemetry.uncheck()
    await expect(telemetry).not.toBeChecked()

    await page.getByRole('button', { name: 'Install tsEpistle', exact: true }).click()
    await expect(page.getByText('Installation complete!')).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL('/login', { timeout: 10_000 })
    await openClientPage(page, '/login', '.login-form')
    await expect(page.getByLabel('Email Address', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible()
  })

  test('authenticates the administrator and preserves the session on reload', async ({ page }) => {
    test.setTimeout(60_000)
    await loginAsAdmin(page)

    await page.reload()
    await expectWelcomePage(page)
  })
  test('persists the personal appearance selector independently of the device scheme', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)
    await openClientPage(page, '/a/theme', '.admin-theme')

    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('.v-application')).toHaveClass(/v-theme--light/)
    await page.getByRole('button', { name: 'Account' }).click()
    const appearanceSelector = page.locator('.v-overlay--active').getByRole('group', { name: 'Appearance' })
    await expect(appearanceSelector.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'true')

    await appearanceSelector.getByRole('button', { name: 'Light', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch('/_api/users/profile', { credentials: 'same-origin' })
          return response.json()
        })
      )
      .toMatchObject({ appearance: 'light' })
    await openClientPage(page, '/a/')
    await expect(page.locator('.v-application')).toHaveClass(/v-theme--light/)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.reload()
    await expect(page.locator('.v-application')).toHaveClass(/v-theme--light/)

    await page.getByRole('button', { name: 'Account' }).click()
    await appearanceSelector.getByRole('button', { name: 'System', exact: true }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch('/_api/users/profile', { credentials: 'same-origin' })
          return response.json()
        })
      )
      .toMatchObject({ appearance: 'system' })
    await expect(page.locator('.v-application')).toHaveClass(/v-theme--dark/)
  })

  test('navigates from the homepage to the authenticated administration dashboard', async ({ page }) => {
    await authenticateAsAdmin(page)

    await page.getByRole('link', { name: 'Administration' }).click()
    await expect(page).toHaveURL('/a/dashboard')
    await expect(page.locator('.admin-dashboard')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
    await expect(page.getByText('Recent Pages', { exact: true })).toBeVisible()
    await expect(page.getByText('Last Logins', { exact: true })).toBeVisible()
  })

  test('creates and publishes the home page with the Markdown editor', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)

    await page.getByRole('link', { name: 'Create Home Page' }).click()
    await expect(page).toHaveURL('/e/en/home')
    await openClientPage(page, '/e/en/home', '.editor-select')
    await page.getByRole('button', { name: /^Markdown Source editing with live preview/ }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Home')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Welcome home')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible({ timeout: 30_000 })
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
    await authenticateAsAdmin(page)
    await page.goto('/e/en/visual-markdown-browser')
    await page.getByRole('button', { name: /^Visual Markdown Rich text with Markdown output/ }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Visual Markdown Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Canonical Markdown from Tiptap')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.editor-tiptap .ProseMirror')
    await expect(editor).toBeVisible()
    await setVisualEditorData(page, visualMarkdownBrowserFixture)
    await expect(editor.getByRole('heading', { name: 'Heading 6' })).toBeVisible()
    await expect(editor.locator('table')).toBeVisible()
    await expect(editor.getByRole('checkbox')).toHaveCount(2)

    await expect(editor.getByRole('img', { name: 'Example image' })).toBeVisible()
    await expect(editor.getByRole('link', { name: 'document.pdf' })).toHaveAttribute('href', '/assets/document.pdf')

    const authoredMarkdown = await getVisualEditorData(page)
    expect(authoredMarkdown).toContain('# Visual Markdown browser')
    expect(authoredMarkdown).toContain('###### Heading 6')
    expect(authoredMarkdown).toContain('**bold**')
    expect(authoredMarkdown).toContain('~~strikethrough~~')
    expect(authoredMarkdown).toMatch(/1\. First\n {2,}\d+\. Nested/)
    expect(authoredMarkdown).toMatch(/[*-] \[x\] Done/)
    expect(authoredMarkdown).toContain('```javascript')
    expect(authoredMarkdown).toContain('| Name')
    expect(authoredMarkdown).toContain('![Example image](/_assets/svg/icon-image.svg)')
    expect(authoredMarkdown).toContain('[document.pdf](/assets/document.pdf)')
    expect(authoredMarkdown).toMatch(/\[target\]\(\/(?:en\/)?home\)/)

    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page).toHaveURL('/en/visual-markdown-browser', { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Visual Markdown Browser', exact: true })).toBeVisible()
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
    await expect(page.locator('.editor-tiptap-sysbar')).toContainText('Visual Markdown')
    await expect(editor).toContainText('Visual Markdown browser')

    await setVisualEditorData(page, `${authoredMarkdown}\n\nSaved with the keyboard.`)
    await editor.click()
    await page.keyboard.press('Control+s')
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 30_000 })

    await expect(editor).toContainText('Saved with the keyboard.')

    await setVisualEditorData(page, `${await getVisualEditorData(page)}\n\nUnsaved draft.`)
    await page.locator('#root').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Discard Changes' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    await page.locator('#root').getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Discard Changes' }).click()

    await expect(page).toHaveURL('/en/visual-markdown-browser')
    await expect(page.getByText('Saved with the keyboard.', { exact: true })).toBeVisible()
    await expect(page.getByText('Unsaved draft.', { exact: true })).not.toBeVisible()

    await page.goto('/e/en/visual-markdown-browser')
    await expect(page).toHaveURL('/e/en/visual-markdown-browser')
    await expect(page.locator('.editor-tiptap-sysbar')).toContainText('Visual Markdown')
    await expect(editor).toContainText('Saved with the keyboard.')
  })

  test('authors and hydrates the complete content extension catalog', async ({ page }) => {
    test.setTimeout(90_000)
    await authenticateAsAdmin(page)
    const extensionKeys = ['qr', 'gallery', 'index', 'tabs', 'spoiler', 'infobox', 'pdf', 'media', 'youtube', 'diagram', 'kroki', 'plantuml', 'map']
    const enableResults: Array<{ key: string; isEnabled: boolean }> = []
    for (const key of extensionKeys) {
      const response = await page.request.patch(`/_api/content-extensions/${key}`, {
        data: { isEnabled: true }
      })
      const body = await response.text()
      expect(response.ok(), `${key}: HTTP ${response.status()} ${body}`).toBe(true)
      enableResults.push(JSON.parse(body) as { key: string; isEnabled: boolean })
    }
    expect(enableResults).toEqual(extensionKeys.map(key => expect.objectContaining({ key, isEnabled: true })))

    await page.goto('/e/en/content-extensions-browser')
    await page.getByRole('button', { name: /^Markdown Source editing with live preview/ }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Content Extensions Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Gallery and index browser workflow')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Insert content extension' }).click()
    const extensionDialog = page.getByRole('dialog', { name: 'Insert content extension' })
    await extensionDialog.getByRole('combobox', { name: 'Extension type' }).press('ArrowDown')
    await page.getByRole('option', { name: 'Image gallery' }).click()
    await expect(extensionDialog).toBeVisible()
    const assetPaths = extensionDialog.getByRole('textbox', { name: 'Asset path' })
    const alternativeTexts = extensionDialog.getByRole('textbox', { name: 'Alternative text' })
    const captions = extensionDialog.getByRole('textbox', { name: 'Caption (optional)' })
    await assetPaths.first().fill('/_assets/svg/icon-file.svg')
    await alternativeTexts.first().fill('File icon')
    await captions.first().fill('First browser image')
    await extensionDialog.getByRole('button', { name: 'Add image' }).click()
    await assetPaths.nth(1).fill('/_assets/svg/icon-table.svg')
    await alternativeTexts.nth(1).fill('Table icon')
    await captions.nth(1).fill('Second browser image')
    await extensionDialog.getByRole('combobox', { name: 'Tile shape' }).press('ArrowDown')
    await page.getByRole('option', { name: 'Natural image ratio' }).click()
    await extensionDialog.getByRole('button', { name: 'Insert Image gallery' }).click()

    await expect.poll(() => getMarkdownSourceData(page)).toContain('"key":"gallery"')
    const galleryFence = await getMarkdownSourceData(page)
    const additionalFences = [
      { key: 'index', version: 1, props: { path: '', locale: 'en', depth: 1, columns: 2, showIcons: true, order: 'title', limit: 20 } },
      {
        key: 'tabs',
        version: 1,
        props: {
          tabs: [
            { label: 'Overview', content: 'First panel content.' },
            { label: 'Details', content: 'Second panel content.' }
          ],
          active: 0
        }
      },
      { key: 'spoiler', version: 1, props: { label: 'Reveal answer', hint: 'Show hidden content', content: 'The hidden answer is 42.' } },
      {
        key: 'infobox',
        version: 1,
        props: {
          title: 'Smoke facts',
          caption: 'Structured facts',
          facts: [
            { label: 'Status', value: 'Verified' },
            { label: 'Safe', value: true }
          ]
        }
      },
      { key: 'pdf', version: 1, props: { src: '/document.pdf', title: 'Example PDF', page: 1, height: 360 } },
      { key: 'media', version: 1, props: { kind: 'audio', src: '/audio.mp3', title: 'Example audio', caption: 'Native media controls' } },
      { key: 'youtube', version: 1, props: { videoId: 'dQw4w9WgXcQ', title: 'Consent-gated video', start: 0, controls: true } },
      {
        key: 'diagram',
        version: 1,
        props: { source: 'flowchart LR\n  A[Start] --> B[Verified]', caption: 'Local Mermaid', theme: 'default', align: 'center' }
      },
      {
        key: 'kroki',
        version: 1,
        props: { type: 'plantuml', source: '@startuml\nAlice -> Bob: Hello\n@enduml', format: 'svg', caption: 'Consent-gated Kroki', align: 'left' }
      },
      {
        key: 'plantuml',
        version: 1,
        props: { source: '@startuml\nAlice -> Bob: Hello\n@enduml', format: 'svg', caption: 'Consent-gated PlantUML', align: 'left' }
      },
      { key: 'map', version: 1, props: { latitude: 40.7128, longitude: -74.006, zoom: 12, height: 320, label: 'New York City' } }
    ]
      .map(envelope => ['```wiki-extension', JSON.stringify(envelope), '```'].join('\n'))
      .join('\n\n')
    const remoteRequests: string[] = []
    page.on('request', request => {
      if (['www.youtube-nocookie.com', 'kroki.io', 'www.plantuml.com', 'www.openstreetmap.org'].includes(new URL(request.url()).hostname)) {
        remoteRequests.push(request.url())
      }
    })
    await editor.fill(`# Content extension workflow\n\n${galleryFence.trim()}\n\n${additionalFences}\n`)
    await page.getByRole('button', { name: 'Create' }).click()

    await expect(page).toHaveURL('/en/content-extensions-browser', { timeout: 30_000 })
    const gallery = page.locator('.content-extension--gallery')
    await expect(gallery.getByRole('img', { name: 'File icon' })).toBeVisible()
    await expect(gallery.getByRole('img', { name: 'Table icon' })).toBeVisible()

    const index = page.locator('.content-extension--index')
    await expect(index).toHaveAttribute('aria-busy', 'false')
    await expect(index.getByRole('link', { name: /Home/ })).toBeVisible()

    const tabs = page.locator('.content-extension--tabs')
    await tabs.getByRole('tab', { name: 'Details' }).click()
    await expect(tabs.getByRole('tabpanel')).toContainText('Second panel content.')
    const spoiler = page.locator('.content-extension--spoiler')
    await spoiler.getByRole('button', { name: /Reveal answer/ }).click()
    await expect(spoiler).toContainText('The hidden answer is 42.')
    await expect(page.locator('.content-extension--infobox')).toContainText('Smoke facts')
    await expect(page.locator('.content-extension--pdf').getByRole('link', { name: /Example PDF/ })).toHaveAttribute('href', '/document.pdf')
    await expect(page.locator('.content-extension--media audio')).toHaveAttribute('controls', '')
    await expect(page.locator('.content-extension--diagram svg')).toBeVisible({ timeout: 30_000 })
    expect(remoteRequests).toEqual([])

    await page.route('https://www.youtube-nocookie.com/**', route => route.abort())
    await page.route('https://kroki.io/**', route => route.abort())
    await page.route('https://www.plantuml.com/**', route => route.abort())
    await page.route('https://www.openstreetmap.org/**', route => route.abort())
    const youtube = page.locator('.content-extension--youtube')
    await youtube.getByRole('button', { name: 'Load YouTube player' }).click()
    await expect(youtube.locator('iframe')).toHaveAttribute('src', /youtube-nocookie\.com/)
    const kroki = page.locator('.content-extension--kroki')
    await kroki.getByRole('button', { name: 'Render with Kroki' }).click()
    await expect(kroki.locator('img')).toHaveAttribute('src', /kroki\.io/)
    const plantuml = page.locator('.content-extension--plantuml')
    await plantuml.getByRole('button', { name: 'Render with PlantUML' }).click()
    await expect(plantuml.locator('img')).toHaveAttribute('src', /plantuml\.com/)
    const map = page.locator('.content-extension--map')
    await map.getByRole('button', { name: 'Load OpenStreetMap' }).click()
    await expect(map.locator('iframe')).toHaveAttribute('src', /openstreetmap\.org/)
    await expect(page.locator('.contents')).not.toHaveCSS('overflow-x', 'scroll')

    await gallery.getByRole('link', { name: 'View File icon full size' }).click()
    const galleryDialog = page.getByRole('dialog', { name: 'Image viewer' })
    await expect(galleryDialog).toBeVisible()
    await expect(galleryDialog.getByRole('img', { name: 'File icon' })).toBeVisible()
    await galleryDialog.getByRole('button', { name: 'Next image' }).click()
    await expect(galleryDialog.getByRole('img', { name: 'Table icon' })).toBeVisible()

    await galleryDialog.getByRole('button', { name: 'Close image viewer' }).click()
    await expect(gallery.getByRole('link', { name: 'View File icon full size' })).toBeFocused()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expectNoHorizontalOverflow(page)
    const accessibility = await new AxeBuilder({ page }).include('.contents').analyze()
    expect(accessibility.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([])
    await page.emulateMedia({ forcedColors: 'active' })
    await expectNoHorizontalOverflow(page)
  })

  test('exposes the full editor catalog through administration', async ({ page }) => {
    await authenticateAsAdmin(page)
    await page.goto('/a/editor')
    await expect(page.getByRole('heading', { name: 'Editors', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Select all', exact: true }).click()
    await expect(page.getByText('5 of 5 available', { exact: true })).toBeVisible()
    const saveChanges = page.getByRole('button', { name: 'Save changes', exact: true })
    await saveChanges.click()
    await expect(saveChanges).toBeDisabled()
  })

  test('retains the Visual HTML editor and HTML content type', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)
    await page.goto('/e/en/visual-html-browser')
    await page.getByRole('button', { name: /^Visual HTML Rich text with HTML output/ }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Visual HTML Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('HTML from Tiptap')
    await page.getByRole('button', { name: 'OK' }).click()

    const editor = page.locator('.editor-tiptap .ProseMirror')
    await expect(editor).toBeVisible()
    await expect(page.getByRole('button', { name: 'Underline' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Decrease indent' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Increase indent' })).toBeVisible()
    await setVisualEditorData(page, visualHtmlBrowserFixture)
    await expect(editor.getByRole('heading', { name: 'Visual HTML heading' })).toBeVisible()
    await expect(editor.getByRole('link', { name: 'an internal link' })).toBeVisible()
    await expect(editor.locator('table')).toBeVisible()
    await expect(editor.getByText('Visual HTML caption', { exact: true })).toBeVisible()

    await expect(editor.getByRole('img', { name: 'Example image' })).toBeVisible()
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
    await expect(page.locator('.editor-tiptap-sysbar')).toContainText('Visual Editor')
    await expect(editor.getByRole('heading', { name: 'Visual HTML heading' })).toBeVisible()
    await expect(editor.getByText('Visual HTML caption', { exact: true })).toBeVisible()
    await expect(editor.getByRole('img', { name: 'Example image' })).toBeVisible()
  })
  test('preserves extended Markdown when changing editors', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)
    await page.goto('/e/en/extended-markdown-browser')
    await page.getByRole('button', { name: /^Markdown Source editing with live preview/ }).click()
    await page.getByRole('textbox', { name: 'Title' }).fill('Extended Markdown Browser')
    await page.getByRole('textbox', { name: 'Short Description' }).fill('Extended visual syntax')
    await page.getByRole('button', { name: 'OK' }).click()

    const source = '## Callout\n\n> Preserved source\n{.is-info}'
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.fill(source)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page).toHaveURL('/en/extended-markdown-browser', { timeout: 30_000 })

    const conversion = await page.evaluate(async () => {
      const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
      const row = pages.find((candidate: { path: string }) => candidate.path === 'extended-markdown-browser')
      const details = await fetch(`/_api/pages/${row.id}`, { credentials: 'same-origin' }).then(response => response.json())
      const response = await fetch(`/_api/pages/${row.id}/convert`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor: 'visual-markdown', expectedSourceRevision: String(details.sourceRevision) })
      })
      return {
        ok: response.ok,
        payload: await response.json()
      }
    })

    expect(conversion.ok, JSON.stringify(conversion.payload)).toBe(true)

    await page.goto('/e/en/extended-markdown-browser')
    await expect(page.locator('.editor-tiptap .ProseMirror')).toBeVisible()
    await expect(page.locator('.editor-tiptap-sysbar')).toContainText('Visual Markdown')
    const convertedSource = await getVisualEditorData(page)
    expect(convertedSource).toContain('## Callout')
    expect(convertedSource).toContain('> Preserved source')
    expect(convertedSource).toContain('{.is-info}')
  })
  test('switches between source, Visual Markdown, and Visual HTML conversion paths', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)

    const convert = async (path: string, editor: string) => {
      const result = await page.evaluate(
        async ({ path, editor }) => {
          const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
          const row = pages.find((candidate: { path: string }) => candidate.path === path)
          const details = await fetch(`/_api/pages/${row.id}`, { credentials: 'same-origin' }).then(response => response.json())
          const response = await fetch(`/_api/pages/${row.id}/convert`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ editor, expectedSourceRevision: String(details.sourceRevision) })
          })
          return { ok: response.ok, body: await response.json() }
        },
        { path, editor }
      )
      expect(result.ok || result.body?.error === 'Page is already using this editor. Nothing to convert.', JSON.stringify(result.body)).toBe(true)
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
    await expect(page.locator('.editor-tiptap .ProseMirror')).toContainText('Visual Markdown browser', { timeout: 30_000 })
    await expect(page.locator('.editor-tiptap-sysbar')).toContainText('Visual Markdown')

    await convert('visual-markdown-browser', 'markdown')
    await page.goto('/e/en/visual-markdown-browser')
    await expect(page.locator('.editor-markdown')).toBeVisible({ timeout: 30_000 })
    expect(await getMarkdownSourceData(page)).toBe(markdownBefore)

    await convert('visual-markdown-browser', 'visual-markdown')
    await convert('visual-html-browser', 'visual-markdown')
    await page.goto('/e/en/visual-html-browser')
    await expect(page.locator('.editor-tiptap .ProseMirror')).toContainText('Visual HTML heading', { timeout: 30_000 })
    await expect(page.locator('.editor-tiptap-sysbar')).toContainText('Visual Markdown')

    await convert('visual-html-browser', 'ckeditor')
    await page.goto('/e/en/visual-html-browser')
    await expect(page.locator('.editor-tiptap .ProseMirror')).toContainText('Visual HTML heading', { timeout: 30_000 })
    await expect(page.locator('.editor-tiptap-sysbar')).toContainText('Visual Editor')
  })

  test('edits and renders the published home page', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)
    await page.goto('/en/home')

    await openEditorForCurrentPage(page)
    await expect(page).toHaveURL('/e/en/home')
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.fill('# Browser Workflow Updated\n\nEdited and rendered through the modern editor.')
    await page.locator('#root').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 30_000 })
    await page.locator('#root').getByRole('button', { name: 'Close', exact: true }).click()

    await expect(page).toHaveURL('/en/home')
    await expect(page.getByRole('heading', { name: 'Browser Workflow Updated' })).toBeVisible()
    await expect(page.getByText('Edited and rendered through the modern editor.')).toBeVisible()
  })

  test('searches for and opens the published home page', async ({ page }) => {
    await authenticateAsAdmin(page)
    await page.goto('/en/home')

    await page.getByRole('textbox', { name: 'Search...' }).fill('Home')
    const result = page.getByRole('option', { name: /^Home\b/ })
    await expect(result).toBeVisible()
    await result.click()

    await expect(page).toHaveURL('/en/home')
    await expect(page.getByRole('heading', { name: 'Browser Workflow Updated' })).toBeVisible()
  })

  test('opens the authenticated administrator profile', async ({ page }) => {
    await authenticateAsAdmin(page)
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

    await authenticateAsAdmin(page)
    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByText('Logout', { exact: true }).click()
    await expect(page).toHaveURL('/')
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch('/_api/users/whoami', { credentials: 'same-origin' })
          return response.json()
        })
      )
      .toMatchObject({ authenticated: false })
    await page.goto('/login')

    await page.getByLabel('Email Address', { exact: true }).fill(adminEmail)
    await page.getByLabel('Password', { exact: true }).fill(adminPassword)
    await page.getByRole('button', { name: 'Log In' }).click()
    await expect(page).toHaveURL('/')
    await expect(page).toHaveTitle('Home | tsEpistle')
    await expect(page.getByRole('heading', { name: 'Browser Workflow Updated' })).toBeVisible()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch('/_api/users/whoami', { credentials: 'same-origin' })
          return response.json()
        })
      )
      .toMatchObject({
        authenticated: true,
        user: { email: adminEmail }
      })
    expect(consoleErrors).toEqual([])
    expect(failedRequests).toEqual([])
  })

  test('keeps administration workflows within the desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 })
    await authenticateAsAdmin(page)
    await page.goto('/a/dashboard')

    await expect(page.locator('.admin-dashboard')).toBeVisible()
    await expect(page.locator('#admin-navigation')).toBeVisible()
    await page.getByRole('button', { name: 'Content & appearance', exact: true }).click()
    await expect(page.getByRole('link', { name: /^Pages\b/ })).toBeVisible()

    const sidebarLayout = await page.locator('#admin-navigation').evaluate(navigation => {
      const measure = (label: string) => {
        const item = [...navigation.querySelectorAll<HTMLElement>('.v-list-item')].find(candidate => candidate.textContent?.trim().startsWith(label))
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
    expect(sidebarLayout.pages.height).toBeGreaterThan(0)
    expect(sidebarLayout.pages.height).toBeLessThanOrEqual(sidebarLayout.dashboard.height)
    expect(sidebarLayout.pages.titleLeft).toBeGreaterThan(sidebarLayout.pages.iconRight)
    expect(Math.abs(sidebarLayout.pages.titleCenterY - sidebarLayout.pages.iconCenterY)).toBeLessThan(2)
    await expect(page.getByText('Recent Pages', { exact: true })).toBeVisible()
    await expect(page.getByText('Last Logins', { exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.goto('/a/navigation')
    await expect(page.getByRole('heading', { name: 'Navigation', exact: true })).toBeVisible()

    const modeLayouts = await page.evaluate(() => {
      const labels = ['Site Tree', 'Static Navigation', 'Custom Navigation', 'None']
      return labels.map(label => {
        const title = [...document.querySelectorAll<HTMLElement>('.v-main .v-list-item-title')].find(candidate => candidate.textContent?.trim() === label)
        const item = title?.closest<HTMLElement>('.v-list-item')
        const icon = item?.querySelector<HTMLElement>('.v-list-item__prepend .v-avatar')
        const content = item?.querySelector<HTMLElement>('.v-list-item__content')
        const selection = item?.querySelector<HTMLElement>('.v-list-item__append .v-icon')
        if (!title || !item || !icon || !content || !selection) {
          throw new Error(`Missing ${label} navigation mode layout.`)
        }
        const titleBox = title.getBoundingClientRect()
        const iconBox = icon.getBoundingClientRect()
        const contentBox = content.getBoundingClientRect()
        const selectionBox = selection.getBoundingClientRect()
        return {
          iconRight: iconBox.right,
          iconCenterY: iconBox.top + iconBox.height / 2,
          titleLeft: titleBox.left,
          titleRight: titleBox.right,
          contentCenterY: contentBox.top + contentBox.height / 2,
          selectionLeft: selectionBox.left
        }
      })
    })
    for (const layout of modeLayouts) {
      expect(layout.titleLeft).toBeGreaterThan(layout.iconRight)
      expect(Math.abs(layout.contentCenterY - layout.iconCenterY)).toBeLessThan(2)
      expect(layout.selectionLeft).toBeGreaterThan(layout.titleRight)
    }
    await expectNoHorizontalOverflow(page)

    await page.goto('/a/pages')
    await expect(page.getByRole('heading', { name: 'Pages', exact: true })).toBeVisible()
    await expect(page.locator('.admin-pages').getByRole('link', { name: 'Home', exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('keeps administration and editor controls usable at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await authenticateAsAdmin(page)
    await page.goto('/a/dashboard')

    const navigationButton = page.getByRole('button', { name: 'Open administration navigation', exact: true })
    await expect(navigationButton).toBeVisible()
    await navigationButton.click()
    await expect(page.locator('#admin-navigation')).toBeVisible()
    await page.locator('#admin-navigation').getByRole('button', { name: 'Content & appearance', exact: true }).click()
    await page
      .locator('#admin-navigation')
      .getByRole('link', { name: /^Pages\b/ })
      .click()

    await expect(page).toHaveURL('/a/pages')
    await expect(page.locator('.admin-pages').getByRole('link', { name: 'Home', exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.goto('/en/home')
    await openEditorForCurrentPage(page)
    await expect(page).toHaveURL('/e/en/home')
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Home')
    await expect(page.locator('#root').getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'More editor actions', exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await page.getByRole('button', { name: 'Show preview' }).click()
    await expect(page.locator('.editor-markdown-preview')).toBeVisible()
    await expect(page.locator('.editor-markdown-editor')).toBeHidden()
    await page.getByRole('button', { name: 'Show editor' }).click()
    await expect(page.locator('.editor-markdown-editor')).toBeVisible()

    await page.getByRole('button', { name: 'Page', exact: true }).click()
    await expect(page.getByText('Page Properties', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Scheduling' }).click()
    await expect(page.getByRole('textbox', { name: 'Publish starting on...' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Publish ending on...' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await page.getByRole('button', { name: 'OK' }).click()

    await page.getByRole('button', { name: 'More editor actions', exact: true }).click()
    await page.getByText('Close', { exact: true }).click()
    await expect(page).toHaveURL('/en/home')
  })

  test('routes private pages from the browse sidebar through the private namespace', async ({ page, browser }) => {
    await authenticateAsAdmin(page)
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

      const anonymousContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
      try {
        const anonymousPage = await anonymousContext.newPage()
        const response = await anonymousPage.goto('/_private/en/private-sidebar-link')
        expect(response?.status()).toBe(404)
        await expect(anonymousPage.getByText('Private Sidebar Page', { exact: true })).not.toBeVisible()
      } finally {
        await anonymousContext.close()
      }
    } finally {
      await page.request.delete(`/_api/pages/${privatePage.page.id}`)
    }
  })

  test('restores an earlier published page revision from history', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)
    await page.goto('/en/home')
    await page.locator('.page-edit-fab:visible').click()
    await page.getByRole('button', { name: 'History', exact: true }).click()
    await expect(page).toHaveURL('/h/en/home')

    const revisionActions = page.locator('button[aria-label^="Actions for revision "]:not([aria-label="Actions for revision live"])')
    await expect(revisionActions.first()).toBeVisible()
    await revisionActions.first().click()
    await page.locator('.v-overlay--active').getByText('Restore', { exact: true }).click()
    await page.locator('.v-dialog').getByRole('button', { name: 'Restore' }).click()

    await expect(page).toHaveURL('/en/home', { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Browser Workflow' })).toBeVisible()
    await expect(page.getByText('Published through the modern editor.')).toBeVisible()
  })

  test('uploads and inserts a linked asset through the editor file manager', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)
    await page.goto('/e/en/home')
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await editor.click()
    await page.keyboard.press('Control+End')

    await page.getByRole('button', { name: 'Insert Assets', exact: true }).click()
    const mediaDialog = page.getByRole('dialog', { name: 'Assets' })
    await expect(mediaDialog).toBeVisible()
    await mediaDialog.locator('input[type="file"]').setInputFiles({
      name: 'browser-upload.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Uploaded through the browser file manager.')
    })
    await mediaDialog.getByRole('button', { name: 'Upload', exact: true }).click()
    const uploadedAsset = mediaDialog.getByRole('row', { name: 'Select browser-upload.txt', exact: true })
    await expect(uploadedAsset).toBeVisible({ timeout: 30_000 })
    await uploadedAsset.click()
    await mediaDialog.getByRole('button', { name: 'Insert', exact: true }).click()

    expect(await getMarkdownSourceData(page)).toContain('[browser-upload.txt](')
    await page.locator('#root').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 30_000 })
    await page.locator('#root').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('link', { name: 'browser-upload.txt' })).toBeVisible()
  })

  test('creates a group, updates its settings, and assigns a new user', async ({ page }) => {
    test.setTimeout(60_000)
    const groupName = 'Browser Operators'
    const userEmail = 'browser-operator@example.com'
    await authenticateAsAdmin(page)
    await page.goto('/a/groups')
    await page.getByRole('button', { name: 'New group' }).click()
    await page.getByLabel('Group Name').fill(groupName)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const groupRow = page.getByText(groupName, { exact: true })
    await expect(groupRow).toBeVisible()
    await groupRow.click()
    await page.getByRole('textbox', { name: 'Redirect on Login' }).fill('/en/home')
    await page.getByRole('button', { name: 'Update group' }).click()
    await expect(page.getByRole('textbox', { name: 'Redirect on Login' })).toHaveValue('/en/home')

    await page.goto('/a/users')
    await page.getByRole('button', { name: 'New user' }).click()
    await page.getByRole('textbox', { name: 'Email Address *', exact: true }).fill(userEmail)
    await page.getByRole('textbox', { name: 'Password *', exact: true }).fill('browser-password')
    await page.getByRole('textbox', { name: 'Name *', exact: true }).fill('Browser Operator')
    await page.getByRole('combobox', { name: 'Assign to Group(s)...', exact: true }).press('ArrowDown')
    await page.getByRole('option', { name: groupName, exact: true }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    await expect(page.getByText(userEmail, { exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Browser Operator', exact: true }).click()
    await expect(page).toHaveURL(/\/a\/users\/\d+$/)
    await expect(page.getByText(groupName, { exact: true })).toBeVisible()
  })

  test('applies authentication provider configuration through administration', async ({ page }) => {
    await authenticateAsAdmin(page)
    await page.goto('/a/auth')
    const displayName = page.getByLabel('Display Name')
    await expect(displayName).toHaveValue('Local')
    await displayName.fill('Local Browser')
    const saved = page.waitForResponse(response => response.url().endsWith('/_api/auth/strategies') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Apply' }).click()
    expect((await saved).ok()).toBe(true)
    await expect(displayName).toHaveValue('Local Browser')
  })

  test('applies the PostgreSQL search configuration and rebuilds its index', async ({ page }) => {
    test.setTimeout(60_000)
    await authenticateAsAdmin(page)
    await page.goto('/a/search')
    await expect(page.getByRole('radio', { name: /^Database - PostgreSQL\b/ })).toBeChecked()
    const saved = page.waitForResponse(response => response.url().endsWith('/_api/search/engines') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Apply' }).click()
    expect((await saved).ok()).toBe(true)

    const rebuilt = page.waitForResponse(response => response.url().endsWith('/_api/search/rebuild-index') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Rebuild Index' }).click()
    expect((await rebuilt).ok()).toBe(true)
  })

  test('requires and recovers from two-factor authentication', async ({ page }) => {
    test.setTimeout(90_000)
    await authenticateAsAdmin(page)
    const setEnforce2FA = (enabled: boolean) =>
      page.evaluate(async value => {
        const configResponse = await fetch('/_api/site/config', { credentials: 'same-origin' })
        const config = await configResponse.json()
        const response = await fetch('/_api/site/config', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...config, authEnforce2FA: value })
        })
        if (!response.ok) throw new Error(`2FA policy update failed: ${response.status}`)
      }, enabled)
    await setEnforce2FA(true)

    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByText('Logout', { exact: true }).click()
    await page.goto('/login')
    await page.getByLabel('Email Address', { exact: true }).fill(adminEmail)
    await page.getByLabel('Password', { exact: true }).fill(adminPassword)
    await page.getByRole('button', { name: 'Log In' }).click()

    const manualSecret = page.locator('.login-tfa-secret')
    await expect(manualSecret).toBeVisible()
    const secret = (await manualSecret.textContent())?.trim()
    if (!secret) throw new Error('TFA setup did not provide a manual setup key.')
    const setupToken = tfa.generateToken(secret)?.token
    if (!setupToken) throw new Error('TFA setup token generation failed.')
    const setupDialog = page.getByRole('dialog', { name: 'Your administrator has required Two-Factor Authentication (2FA) to be enabled on your account.' })
    await setupDialog.getByLabel('XXXXXX', { exact: true }).fill(setupToken)
    await setupDialog.getByRole('button', { name: 'Verify' }).click()
    await expect(page).toHaveURL('/', { timeout: 30_000 })

    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByText('Logout', { exact: true }).click()
    await page.goto('/login')
    await page.getByLabel('Email Address', { exact: true }).fill(adminEmail)
    await page.getByLabel('Password', { exact: true }).fill(adminPassword)
    await page.getByRole('button', { name: 'Log In' }).click()
    const challengeDialog = page.getByRole('dialog', { name: 'Enter the security code generated from your trusted device:' })
    await expect(challengeDialog).toBeVisible()
    const challengeToken = tfa.generateToken(secret)?.token
    if (!challengeToken) throw new Error('TFA challenge token generation failed.')
    await challengeDialog.getByLabel('XXXXXX', { exact: true }).fill(challengeToken)
    await challengeDialog.getByRole('button', { name: 'Verify' }).click()
    await expect(page).toHaveURL('/', { timeout: 30_000 })

    await setEnforce2FA(false)
    await page.evaluate(async () => {
      const whoami = await fetch('/_api/users/whoami', { credentials: 'same-origin' }).then(response => response.json())
      const response = await fetch(`/_api/users/${whoami.user.id}/tfa`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false })
      })
      if (!response.ok) throw new Error(`TFA recovery reset failed: ${response.status}`)
    })

    await page.getByRole('button', { name: 'Account' }).click()
    await page.getByText('Logout', { exact: true }).click()
    await loginAsAdmin(page)
  })

  test('unlocks password-protected page content and rejects a wrong password', async ({ page, browser }) => {
    test.setTimeout(60_000)
    const password = 'browser-page-password'
    await authenticateAsAdmin(page)
    const pageId = await page.evaluate(async () => {
      const pages = await fetch('/_api/pages', { credentials: 'same-origin' }).then(response => response.json())
      return pages.find((candidate: { path: string }) => candidate.path === 'visual-html-browser').id as number
    })
    const protection = await page.request.put(`/_api/pages/${pageId}/protection`, { data: { password } })
    expect(protection.ok()).toBe(true)

    const anonymousContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
    try {
      const protectedPage = await anonymousContext.newPage()
      await protectedPage.goto('/en/visual-html-browser')
      await expect(protectedPage.getByRole('heading', { name: 'Protected page' })).toBeVisible()
      await protectedPage.getByLabel('Page password').fill('wrong-password')
      await protectedPage.getByRole('button', { name: 'Unlock page' }).click()
      await expect(protectedPage.getByText('Access denied', { exact: true })).toBeVisible()
      await protectedPage.getByLabel('Page password').fill(password)
      const [unlockResponse] = await Promise.all([
        protectedPage.waitForResponse(response => response.url().endsWith(`/_unlock/${pageId}`) && response.request().method() === 'POST'),
        protectedPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        protectedPage.getByRole('button', { name: 'Unlock page' }).click()
      ])
      expect(unlockResponse.status()).toBe(303)
      await expect(protectedPage).toHaveURL('/en/visual-html-browser')
      await expect(protectedPage.getByRole('heading', { name: 'Visual HTML heading' })).toBeVisible({ timeout: 30_000 })
    } finally {
      await anonymousContext.close()
      const removal = await page.request.delete(`/_api/pages/${pageId}/protection`)
      expect(removal.ok()).toBe(true)
    }
  })

  test('keeps the primary page within local Core Web Vitals budgets', async ({ page }) => {
    await authenticateAsAdmin(page)
    await page.addInitScript(() => {
      const metrics = { cls: 0, lcp: 0 }
      Object.defineProperty(window, '__wikiReleaseMetrics', { value: metrics })
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
          if (!shift.hadRecentInput) metrics.cls += shift.value ?? 0
        }
      }).observe({ type: 'layout-shift', buffered: true })
      new PerformanceObserver(list => {
        const entry = list.getEntries().at(-1)
        if (entry) metrics.lcp = entry.startTime
      }).observe({ type: 'largest-contentful-paint', buffered: true })
    })
    await page.goto('/en/home', { waitUntil: 'networkidle' })

    const metrics = await page.evaluate(() => {
      const releaseMetrics = (
        window as unknown as {
          __wikiReleaseMetrics: { cls: number; lcp: number }
        }
      ).__wikiReleaseMetrics
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      return {
        cls: releaseMetrics.cls,
        domContentLoaded: navigation.domContentLoadedEventEnd,
        lcp: releaseMetrics.lcp,
        transferredBytes: performance
          .getEntriesByType('resource')
          .reduce((total, entry) => total + (entry as PerformanceResourceTiming).transferSize, navigation.transferSize)
      }
    })

    expect(metrics.lcp).toBeGreaterThan(0)
    expect(metrics.lcp).toBeLessThanOrEqual(2_500)
    expect(metrics.cls).toBeLessThanOrEqual(0.1)
    expect(metrics.domContentLoaded).toBeLessThanOrEqual(3_000)
    expect(metrics.transferredBytes).toBeLessThanOrEqual(5 * 1024 * 1024)
  })
})
