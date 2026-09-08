import { expect, type Page, type Request, type Response, type Route } from '@playwright/test'
import { responsiveTest as test } from './helpers'
import type { TextEditorHandle } from '../../client/components/editor/common/text-editor'

// Mount the shipped editor with a new-page fixture: no account, saved page, or collaboration session.
const content = Array.from(
  { length: 45 },
  (_, index) => `## Section ${index + 1}\n\nA paragraph for checking cursor alignment and independent preview scrolling.\n\n`
).join('')

type EditorFixtureOptions = {
  onTagSearch?: (route: Route) => Promise<void> | void
}

async function openEditor(page: Page, options: EditorFixtureOptions = {}) {
  let fixtureOrigin: string | undefined
  await page.route('**/_api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET') return route.fulfill({ status: 405 })
    if (path === '/_api/assets')
      return route.fulfill({
        json: [
          {
            id: 1,
            filename: 'brand-mark.png',
            description: 'Transparent brand mark',
            ext: '.png',
            fileSize: 84210,
            createdAt: '2026-09-01T12:00:00Z',
            kind: 'IMAGE'
          },
          {
            id: 2,
            filename: 'a-very-long-filename-for-a-complete-brand-reference-document.pdf',
            description: 'A long description to check wrapping and table alignment across sizes.',
            ext: '.pdf',
            fileSize: 1820000,
            createdAt: '2026-09-01T12:00:00Z',
            kind: 'BINARY'
          }
        ]
      })
    if (path === '/_api/assets/folders')
      return route.fulfill({
        json: [
          { id: 1, name: 'brand-resources', slug: 'brand-resources' },
          { id: 2, name: 'documentation-and-product-photography', slug: 'documentation-and-product-photography' }
        ]
      })
    return route.continue()
  })
  if (options.onTagSearch) {
    await page.route('**/_api/pages/tags/search?**', options.onTagSearch)
  }
  await page.route('**/u', route => route.fulfill({ status: 405 }))
  await page.route('**/editor-panel-fixture', async route => {
    fixtureOrigin = new URL(route.request().url()).origin
    const response = await page.request.get('/login')
    if (!response.ok()) {
      throw new Error(`Editor fixture login bootstrap failed: HTTP ${response.status()} ${response.statusText()}`)
    }
    const loginDocument = await response.text()
    const editorDocument = loginDocument.replace(
      /<login\b[^>]*><\/login>/,
      `<editor init-editor="markdown" init-mode="create" title="Editor review" init-content="${Buffer.from(content).toString('base64')}"></editor>`
    )
    if (editorDocument === loginDocument) throw new Error('The login document did not contain the expected application mount.')
    await route.fulfill({ response, body: editorDocument })
  })
  let rejectBootstrapFailure!: (error: Error) => void
  let bootstrapFailureReported = false
  const bootstrapFailure = new Promise<never>((_, reject) => {
    rejectBootstrapFailure = reject
  })
  const isRequiredBootstrapResource = (request: Request) => {
    if (!fixtureOrigin || !['script', 'stylesheet'].includes(request.resourceType())) return false
    return new URL(request.url()).origin === fixtureOrigin
  }
  const onRequestFailed = (request: Request) => {
    if (!isRequiredBootstrapResource(request) || bootstrapFailureReported) return
    bootstrapFailureReported = true
    rejectBootstrapFailure(new Error(`Editor bootstrap resource failed: ${request.url()} (${request.failure()?.errorText || 'unknown request failure'})`))
  }
  const onResponse = (response: Response) => {
    const request = response.request()
    if (!isRequiredBootstrapResource(request) || response.ok() || bootstrapFailureReported) return
    bootstrapFailureReported = true
    rejectBootstrapFailure(new Error(`Editor bootstrap resource failed: ${response.url()} (HTTP ${response.status()} ${response.statusText()})`))
  }
  const mountState = await (async () => {
    page.on('requestfailed', onRequestFailed)
    page.on('response', onResponse)
    try {
      await Promise.race([page.goto('/editor-panel-fixture'), bootstrapFailure])
      return await Promise.race([
        page.waitForFunction(
          () => {
            if (document.querySelector('.cm-content')) return { state: 'ready' as const }
            const asyncLoadError = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"][aria-labelledby]')).find(alert => {
              const titleId = alert.getAttribute('aria-labelledby')
              return titleId && document.getElementById(titleId)?.textContent?.trim() === 'This section could not be loaded'
            })
            if (!asyncLoadError) return null
            return { state: 'error' as const, message: 'This section could not be loaded' }
          },
          undefined,
          { timeout: 25_000 }
        ),
        bootstrapFailure
      ])
    } finally {
      page.off('requestfailed', onRequestFailed)
      page.off('response', onResponse)
    }
  })()
  const state = (await mountState.jsonValue()) as { state: 'ready' | 'error'; message?: string }
  if (state.state === 'error') throw new Error(`Editor fixture failed to mount: ${state.message}`)
  const properties = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(properties).toBeVisible()
  await properties.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(properties).not.toBeVisible()
  const markdownSource = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  await expect(markdownSource).toBeVisible()
  await expect(markdownSource).toBeEditable()
}

async function selectLine(page: Page, line: number) {
  await page.locator('.editor-markdown').evaluate((root, target) => {
    const editor = (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor
    editor.setSelection({ line: target, ch: 0 })
  }, line)
}

async function assertControlsContained(page: Page) {
  await expect
    .poll(
      () =>
        page.getByRole('dialog', { name: 'Assets', exact: true }).evaluate(root => {
          const failures: string[] = []
          for (const button of root.querySelectorAll<HTMLElement>('button')) {
            const box = button.getBoundingClientRect()
            if (!box.width || !box.height) continue
            let left = 0
            let right = innerWidth
            for (let parent = button.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent)
              if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
                const bounds = parent.getBoundingClientRect()
                left = Math.max(left, bounds.left)
                right = Math.min(right, bounds.right)
              }
            }
            if (box.left < left - 1 || box.right > right + 1) failures.push(button.getAttribute('aria-label') || button.textContent || 'button')
          }
          return failures
        }),
      { message: 'Every asset action fits its clipping ancestors' }
    )
    .toEqual([])
}

test('asset browser keeps folder, upload, and insertion actions contained', async ({ page }) => {
  await openEditor(page)
  const assetButton = page.getByRole('button', { name: 'Insert Assets', exact: true })
  if (!(await assetButton.isVisible())) {
    await page.getByRole('button', { name: 'More formatting tools' }).click()
    await page.locator('.v-overlay--active .v-list-item').filter({ hasText: 'Insert Assets' }).click()
  } else await assetButton.click()
  const dialog = page.getByRole('dialog', { name: 'Assets', exact: true })
  await expect(dialog.getByRole('row', { name: 'Select brand-mark.png', exact: true })).toBeVisible()
  await assertControlsContained(page)
  for (const name of ['Browse files', 'Create folder', 'Cancel', 'Insert', 'Upload']) {
    await dialog.getByRole('button', { name, exact: true }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible()
    const reachable = await dialog.getByRole('button', { name, exact: true }).evaluate(element => {
      const rect = element.getBoundingClientRect()
      const bottomBar = document.querySelector('.editor-mobile-actions')?.getBoundingClientRect().top ?? innerHeight
      return rect.top >= 0 && rect.bottom <= Math.min(innerHeight, bottomBar) + 1
    })
    expect(reachable, `${name} is fully reachable above the editor navigation`).toBe(true)
  }
  await dialog.getByRole('button', { name: 'Browse files', exact: true }).scrollIntoViewIfNeeded()
  const chooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Browse files', exact: true }).click()
  await (await chooser).setFiles({ name: 'queued-reference-document.txt', mimeType: 'text/plain', buffer: Buffer.from('Local queue only.') })
  await expect(dialog.locator('.filepond--file')).toBeVisible()
  await assertControlsContained(page)
  await dialog.getByRole('row', { name: 'Select brand-mark.png', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Insert', exact: true })).toBeEnabled()
  await assertControlsContained(page)
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const source = await page
    .locator('.editor-markdown')
    .evaluate(root => (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor.getValue())
  expect(source).toContain('brand-mark.png')
})

test('preview follows the cursor by default and stops when toggled off', async ({ page }) => {
  await openEditor(page)
  const preview = page.locator('.editor-markdown-preview-content')
  if (!(await preview.isVisible())) await page.getByRole('button', { name: 'Show preview', exact: true }).click()
  const toggle = page.getByRole('button', { name: 'Align preview to cursor', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await selectLine(page, 80)
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(500)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await preview.evaluate(element => {
    element.scrollTop = 300
  })
  await selectLine(page, 140)
  await page.waitForTimeout(400)
  expect(await preview.evaluate(element => element.scrollTop)).toBe(300)
  await page.locator('.editor-markdown').evaluate(root => {
    const editor = (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor
    editor.replaceSelection('Edited while following is disabled. ')
  })
  await page.waitForTimeout(900)
  expect(await preview.evaluate(element => element.scrollTop)).toBe(300)
  const paneToggle = page.locator('.editor-markdown-toolbar').getByRole('button', { name: /toggle preview|show editor|show preview/i })
  await paneToggle.click()
  await expect(preview).not.toBeVisible()
  await selectLine(page, 160)
  await paneToggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(preview).toBeVisible()
  expect(await preview.evaluate(element => element.scrollTop)).toBe(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(1000)
  await paneToggle.click()
  await selectLine(page, 40)
  await paneToggle.click()
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(200)
  await selectLine(page, 0)
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeLessThan(20)
  if (await page.locator('.cm-content').isVisible()) {
    await page.locator('.cm-content').focus()
    await page.keyboard.press('ControlOrMeta+End')
    await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(1000)
  }
})
test('page properties keeps tag drafts honest across suggestion, failure, removal, and cancel', async ({ page }) => {
  const searchRequests: string[] = []
  const failedQueries: Record<string, true> = {}
  const taxonomyRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname.includes('/taxonomy')) taxonomyRequests.push(request.url())
  })
  await openEditor(page, {
    onTagSearch: async route => {
      const query = new URL(route.request().url()).searchParams.get('query') ?? ''
      const normalizedQuery = query.toLowerCase()
      searchRequests.push(query)
      if (['broken', 'keyboard'].includes(normalizedQuery) && !failedQueries[normalizedQuery]) {
        failedQueries[normalizedQuery] = true
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture search failure' }) })
        return
      }
      if (normalizedQuery === 'existing') return route.fulfill({ json: ['existing-tag'] })
      await route.fulfill({ json: [] })
    }
  })

  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const properties = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(properties).toBeVisible()
  const tags = properties.getByRole('combobox', { name: /tags/i }).first()

  await tags.fill('  Existing  ')
  await expect.poll(() => searchRequests).toContain('Existing')
  const existingOption = page.getByRole('option', { name: 'existing-tag', exact: true })
  await tags.press('ArrowDown')
  await expect(existingOption).toBeFocused()
  await page.keyboard.press('Enter')
  const existingRemove = properties.getByRole('button', { name: 'Remove tag existing-tag', exact: true })
  await expect(existingRemove).toBeVisible()
  await expect(existingRemove).toBeEnabled()
  await expect(properties.getByRole('button', { name: 'Remove tag existing', exact: true })).toHaveCount(0)

  await tags.fill('  New-Tag  ')
  const candidate = page.getByRole('option', { name: /add [“"]?new-tag[”"]? to page/i })
  await expect(candidate).toBeVisible()
  await candidate.click()
  await expect(properties.getByRole('button', { name: /remove.*new-tag/i })).toBeVisible()

  await properties.getByRole('button', { name: /remove.*new-tag/i }).click()
  await expect(properties.getByRole('button', { name: /remove.*new-tag/i })).toHaveCount(0)
  await tags.fill('  Manual  ')
  await tags.press('Enter')
  await expect(properties.getByRole('button', { name: /remove.*manual/i })).toBeVisible()

  await tags.fill('broken')
  await expect.poll(() => searchRequests).toContain('broken')
  const searchError = properties.getByRole('alert').filter({ hasText: /^Unable to load suggestions/i })
  await expect(searchError).toBeVisible()
  await expect(tags).toHaveValue('broken')
  const manualRemove = properties.getByRole('button', { name: 'Remove tag manual', exact: true })
  await expect(manualRemove).toBeVisible()
  const retryButton = page.getByRole('button', { name: 'Retry tag suggestions', exact: true })
  const successfulRetry = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/_api/pages/tags/search' && url.searchParams.get('query') === 'broken' && response.ok()
  })
  await retryButton.click()
  await successfulRetry
  await expect(searchError).toHaveCount(0)
  await expect(retryButton).toHaveCount(0)
  await expect(tags).toBeFocused()
  await expect(tags).toHaveValue('broken')
  await expect(existingRemove).toBeVisible()
  await expect(manualRemove).toBeVisible()
  const brokenRemove = properties.getByRole('button', { name: 'Remove tag broken', exact: true })
  await expect(brokenRemove).toHaveCount(0)
  await tags.press('Enter')
  await expect(brokenRemove).toBeVisible()
  await brokenRemove.click()
  await expect(brokenRemove).toHaveCount(0)

  await tags.fill('keyboard')
  await expect.poll(() => searchRequests).toContain('keyboard')
  await expect(searchError).toBeVisible()
  await expect(tags).toHaveValue('keyboard')
  const keyboardResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/_api/pages/tags/search' && url.searchParams.get('query') === 'keyboard' && response.ok()
  })
  await tags.press('Tab')
  await expect(retryButton).toBeFocused()
  await page.keyboard.press('Enter')
  await keyboardResponse
  await expect(searchError).toHaveCount(0)
  await expect(retryButton).toHaveCount(0)
  await expect(tags).toBeFocused()
  await expect(tags).toHaveValue('keyboard')
  await expect(existingRemove).toBeVisible()
  await expect(manualRemove).toBeVisible()
  const keyboardRemove = properties.getByRole('button', { name: 'Remove tag keyboard', exact: true })
  await expect(keyboardRemove).toHaveCount(0)
  await tags.press('Enter')
  await expect(keyboardRemove).toBeVisible()

  await tags.fill('  Blurred  ')
  await expect.poll(() => searchRequests).toContain('Blurred')
  const blurredRemove = properties.getByRole('button', { name: 'Remove tag blurred', exact: true })
  await tags.press('Tab')
  await expect(blurredRemove).toBeVisible()
  await properties.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(properties).not.toBeVisible()
  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const reopened = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(reopened.getByRole('button', { name: /remove.*existing-tag/i })).toHaveCount(0)
  await expect(reopened.getByRole('button', { name: /remove.*manual/i })).toHaveCount(0)
  await expect(reopened.getByRole('button', { name: 'Remove tag keyboard', exact: true })).toHaveCount(0)
  await expect(reopened.getByRole('button', { name: 'Remove tag blurred', exact: true })).toHaveCount(0)

  await reopened.getByRole('combobox', { name: /tags/i }).fill('  Draft-Tag  ')
  await reopened.getByRole('combobox', { name: /tags/i }).press('Enter')
  await expect(reopened.getByRole('button', { name: /remove.*draft-tag/i })).toBeVisible()
  await reopened.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(reopened).not.toBeVisible()
  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const committed = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(committed.getByRole('button', { name: /remove.*draft-tag/i })).toBeVisible()
  expect(taxonomyRequests).toEqual([])
})

test('page properties ignores a late suggestion response for an older query', async ({ page }) => {
  let releaseSlow: (() => void) | undefined
  let slowStarted: (() => void) | undefined
  const slowResponse = new Promise<void>(resolve => {
    releaseSlow = resolve
  })
  const slowRequest = new Promise<void>(resolve => {
    slowStarted = resolve
  })
  await openEditor(page, {
    onTagSearch: async route => {
      const query = new URL(route.request().url()).searchParams.get('query') ?? ''
      if (query === 'slow') {
        slowStarted?.()
        await slowResponse
        await route.fulfill({ json: ['slow-tag'] })
        return
      }
      await route.fulfill({ json: query === 'fast' ? ['fast-tag'] : [] })
    }
  })

  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const properties = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  const tags = properties.getByRole('combobox', { name: /tags/i }).first()
  await tags.fill('slow')
  await slowRequest
  await tags.fill('fast')
  await expect(page.getByRole('option', { name: 'fast-tag', exact: true })).toBeVisible()
  const slowNetworkResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/_api/pages/tags/search' && url.searchParams.get('query') === 'slow' && response.ok()
  })
  releaseSlow?.()
  await slowNetworkResponse
  await expect(page.getByRole('option', { name: 'fast-tag', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'slow-tag', exact: true })).toHaveCount(0)
})
