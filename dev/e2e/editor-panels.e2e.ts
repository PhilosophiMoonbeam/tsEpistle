import { expect, type Locator, type Page, type Request, type Response, type Route } from '@playwright/test'
import { authenticateAsAdmin, openAuthenticatedPage, responsiveTest as test } from './helpers'
import type { TextEditorHandle } from '../../client/components/editor/common/text-editor'

// These editor fixtures route API reads; a controlling worker can bypass page.route.
const routedEditorTest = test.extend({ serviceWorkers: 'block', trace: 'retain-on-failure' })

// Mount the shipped editor with a cookie-backed actor, but no saved page or collaboration session.
const content = Array.from(
  { length: 45 },
  (_, index) => `## Section ${index + 1}\n\nA paragraph for checking cursor alignment and independent preview scrolling.\n\n`
).join('')

type EditorFixtureOptions = {
  onTagSearch?: (route: Route) => Promise<void> | void
  largeAssetFixture?: boolean
}

async function openEditor(page: Page, options: EditorFixtureOptions = {}) {
  await authenticateAsAdmin(page)
  let fixtureOrigin: string | undefined
  await page.route('**/_api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    // This read-only credential handshake binds the real offline session; denying
    // it locks the editor and clears its plaintext. All document writes stay denied.
    if (request.method() === 'POST' && path === '/_api/offline/draft-key') return route.continue()
    if (request.method() !== 'GET') return route.fulfill({ status: 405 })
    if (path === '/_api/assets') {
      const assets = [
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
      if (options.largeAssetFixture) {
        assets.push(
          ...Array.from({ length: 14 }, (_, index) => ({
            id: index + 3,
            filename: `identity-reference-asset-${String(index + 1).padStart(2, '0')}.png`,
            description:
              'A deliberately long page identity description keeps the results list tall enough to exercise its internal scroller at every supported desktop viewport.',
            ext: '.png',
            fileSize: 84210 + index,
            createdAt: '2026-09-01T12:00:00Z',
            kind: 'IMAGE'
          }))
        )
      }
      return route.fulfill({ json: assets })
    }
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
  await expect
    .poll(() =>
      page.locator('.editor-markdown').evaluate(root => (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor.getValue())
    )
    .toBe(content)
}

async function closeVisualEditor(page: Page, readerPath: string, expectUnsavedChanges = false) {
  const selector = page.getByRole('dialog').filter({ has: page.locator('.page-selector') })
  if (await selector.isVisible()) await selector.getByRole('button', { name: 'Cancel', exact: true }).click()
  const close = page.getByRole('button', { name: 'Close', exact: true })
  if (await close.isVisible()) {
    await close.click()
  } else {
    await page.getByRole('button', { name: 'More editor actions', exact: true }).click()
    await page
      .getByRole('listitem')
      .filter({ hasText: /^Close$/u })
      .click()
  }
  const discard = page.getByRole('button', { name: 'Discard Changes', exact: true })
  if (expectUnsavedChanges) await expect(discard).toBeVisible()
  else await expect.poll(async () => (await discard.isVisible()) || new URL(page.url()).pathname === readerPath).toBe(true)
  if (await discard.isVisible()) await discard.click()
  await page.waitForURL(readerPath, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.editor-tiptap')).toHaveCount(0)
  await expect(page.locator('article.contents')).toBeVisible({ timeout: 15_000 })
}

for (const format of ['visual-markdown', 'visual-html'] as const) {
  for (const selection of ['empty selection', 'selected text'] as const) {
    test(`${format} links to a page from the actual toolbar with ${selection} and discards on teardown`, async ({ page }, testInfo) => {
      test.setTimeout(90_000)
      const readerPath = `/en/${format}-browser`
      const targetPath = format === 'visual-markdown' ? 'visual-html-browser' : 'visual-markdown-browser'
      const targetTitle = format === 'visual-markdown' ? 'Visual HTML Browser' : 'Visual Markdown Browser'
      await openAuthenticatedPage(page, `/e${readerPath}`, '.editor-tiptap')
      const editor = page.locator('.editor-tiptap .ProseMirror')
      const originalText = await editor.textContent()
      try {
        // Replace only the unsaved draft through the real contenteditable.
        // Selection and page-link insertion below remain native UI interactions.
        await editor.getByRole('heading').first().click()
        // A real draft edit retires the editor's first-focus reconciliation.
        await page.keyboard.insertText('x')
        await expect(page.getByRole('button', { name: /^Save \(/ }).first()).toBeVisible()
        const selectionReady = await editor.evaluateHandle(root => {
          const doc = root.ownerDocument
          const controller = new AbortController()
          const state = {
            ready: false,
            dispose() {
              controller.abort()
            }
          }
          doc.addEventListener(
            'selectionchange',
            () => {
              const selection = doc.getSelection()
              if (!selection?.rangeCount) return
              const range = selection.getRangeAt(0)
              if (!root.contains(range.commonAncestorContainer) || range.toString() !== root.textContent) return
              state.ready = true
              controller.abort()
            },
            { signal: controller.signal }
          )
          return state
        })
        try {
          await editor.selectText()
          await expect.poll(() => selectionReady.evaluate(state => state.ready)).toBe(true)
          await page.keyboard.press('Backspace')
          await expect(editor).toHaveText('')
        } finally {
          await selectionReady.evaluate(state => state.dispose())
          await selectionReady.dispose()
        }
        const label = selection === 'selected text' ? 'Chosen page' : 'Link: '
        await page.keyboard.insertText(label)
        await expect(editor).toHaveText(label)
        if (selection === 'selected text') await page.keyboard.press('Shift+Home')
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection === 'selected text' ? label : '')

        await page.getByRole('button', { name: 'Insert Link', exact: true }).click()
        const selector = page.getByRole('dialog').filter({ has: page.locator('.page-selector') })
        await expect(selector).toBeVisible()
        await selector.locator('.page-selector__pages-list').getByText(targetTitle, { exact: true }).click()
        await expect(selector.getByRole('textbox', { name: 'Page path', exact: true })).toHaveValue(targetPath)
        await selector.getByRole('button', { name: 'Select', exact: true }).click()
        await expect(selector).not.toBeVisible()

        const link = editor.getByRole('link', { name: selection === 'selected text' ? label : targetPath, exact: true })
        // This single-language fixture uses the canonical unprefixed internal link.
        await expect(link).toHaveAttribute('href', `/${targetPath}`)
        await expect(editor).toHaveText(selection === 'selected text' ? label : `${label}${targetPath}`)
        await testInfo.attach(`${format}-${selection}-page-link`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
        await closeVisualEditor(page, readerPath, true)

        // Reopen in the same authenticated session to prove the draft was discarded.
        await page.goto(`/e${readerPath}`, { waitUntil: 'networkidle' })
        await expect(editor).toBeVisible({ timeout: 15_000 })
        await expect.poll(() => editor.textContent()).toBe(originalText)
        await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
        await expect(page.getByRole('status').filter({ hasText: /^Unsaved changes$/u })).toHaveCount(0)
        await closeVisualEditor(page, readerPath)
      } finally {
        if (!page.isClosed() && (await page.locator('.editor-tiptap').count())) await closeVisualEditor(page, readerPath)
      }
    })
  }
}

async function withVisibleSource(page: Page, interaction: (source: Locator) => Promise<void>) {
  const source = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  const reopenPreview = !(await source.isVisible())
  if (reopenPreview) await page.getByRole('button', { name: 'Show editor', exact: true }).click()
  await expect(source).toBeVisible()
  await source.focus()
  await expect(source).toBeFocused()
  await interaction(source)
  if (reopenPreview) {
    await page.getByRole('button', { name: 'Show preview', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Page preview', exact: true })).toBeVisible()
  }
  return reopenPreview
}

async function selectLine(page: Page, line: number) {
  return withVisibleSource(page, async source => {
    // Seed the target, then let the shipped native cursor command reveal it.
    // setSelection alone deliberately does not scroll the source viewport.
    await page.locator('.editor-markdown').evaluate((root, target) => {
      const editor = (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor
      editor.setSelection({ line: target, ch: 0 })
    }, line)
    await source.press('End')
    await expect
      .poll(() =>
        page.locator('.editor-markdown').evaluate((root, target) => {
          const editor = (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor
          const activeLine = root.querySelector('.cm-activeLine')
          const scroller = root.querySelector('.cm-scroller')
          const cursor = editor.cursor()
          if (!activeLine || !scroller || cursor.line !== target || cursor.ch === 0 || activeLine.textContent !== editor.getLine(target)) return false
          const selection = root.ownerDocument.getSelection()
          if (!selection?.isCollapsed || !selection.rangeCount || !selection.focusNode || !activeLine.contains(selection.focusNode)) return false
          // End may reveal only the last visual row of a wrapped logical line.
          // Prove the actual native caret is visible, not the whole line box.
          const caret = selection.getRangeAt(0).getBoundingClientRect()
          const viewport = scroller.getBoundingClientRect()
          return (
            viewport.width > 0 &&
            viewport.height > 0 &&
            caret.height > 0 &&
            caret.left >= viewport.left - 1 &&
            caret.right <= viewport.right + 1 &&
            caret.top >= viewport.top - 1 &&
            caret.bottom <= viewport.bottom + 1
          )
        }, line)
      )
      .toBe(true)
  })
}
async function selectText(page: Page, line: number, from: number, to: number) {
  await page.locator('.editor-markdown').evaluate(
    (root, selection) => {
      const editor = (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor
      editor.setSelection({ line: selection.line, ch: selection.from }, { line: selection.line, ch: selection.to })
    },
    { line, from, to }
  )
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

routedEditorTest('asset browser keeps folder, upload, and insertion actions contained', async ({ page }) => {
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
  const preview = page.locator('.editor-markdown-preview-content')
  if (!(await preview.isVisible())) await page.getByRole('button', { name: 'Show preview', exact: true }).click()
  const image = preview.getByRole('img', { name: 'brand-mark.png', exact: true })
  await expect(image).toHaveJSProperty('src', new URL('/brand-mark.png', page.url()).href)
})
routedEditorTest('page identity asset results stay within the viewport and scroll internally', async ({ page }) => {
  await openEditor(page, { largeAssetFixture: true })
  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const properties = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(properties).toBeVisible()
  await properties.getByRole('button', { name: 'Select', exact: true }).click()

  const picker = page.locator('.editor-modal-media.is-editor-embedded.is-page-branding')
  await expect(picker).toBeVisible()
  await expect
    .poll(
      () =>
        picker.evaluate(root => {
          const rect = root.getBoundingClientRect()
          return rect.top >= -1 && rect.bottom <= innerHeight + 1
        }),
      'The page identity selector must fit inside the viewport'
    )
    .toBe(true)

  const results = picker.locator('.editor-media-table .v-table__wrapper')
  await expect
    .poll(() => results.evaluate(element => element.scrollHeight > element.clientHeight), 'Page identity assets must scroll within the results area')
    .toBe(true)
  await results.evaluate(element => {
    element.scrollTop = element.scrollHeight
  })
  const lastAsset = picker.getByRole('row', { name: 'Select brand-mark.png', exact: true })
  await expect(lastAsset).toBeVisible()
  await expect
    .poll(() =>
      lastAsset.evaluate(element => {
        const resultBounds = element.closest('.v-table__wrapper')?.getBoundingClientRect()
        const assetBounds = element.getBoundingClientRect()
        return Boolean(resultBounds && assetBounds.top >= resultBounds.top - 1 && assetBounds.bottom <= resultBounds.bottom + 1)
      })
    )
    .toBe(true)
  await lastAsset.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      lastAsset.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return bounds.top >= 0 && bounds.bottom <= innerHeight
      })
    )
    .toBe(true)

  for (const name of ['Browse files', 'Upload']) {
    const action = picker.getByRole('button', { name, exact: true })
    await action.scrollIntoViewIfNeeded()
    await expect(action).toBeInViewport({ ratio: 1 })
  }
})

routedEditorTest('preview follows the cursor by default and stops when toggled off', async ({ page }) => {
  await openEditor(page)
  const preview = page.locator('.editor-markdown-preview-content')
  if (!(await preview.isVisible())) await page.getByRole('button', { name: 'Show preview', exact: true }).click()
  const assertBoundedCanvas = async () => {
    await expect
      .poll(
        () =>
          page.locator('.editor-markdown').evaluate(root => {
            const failures: string[] = []
            const surface = root.closest('.editor-main-surface')
            const main = root.querySelector('.editor-markdown-main')
            const status = root.querySelector('.editor-markdown-sysbar')
            const position = root.querySelector('.editor-markdown-sysbar-position')
            const application = root.closest('.v-application')
            if (!surface || !main || !status || !application) return ['Editor layout did not mount']
            if (innerWidth >= 960 && !position) return ['Desktop cursor status did not mount']
            const within = (child: Element, parent: DOMRect, name: string) => {
              const box = child.getBoundingClientRect()
              if (
                box.width <= 0 ||
                box.height <= 0 ||
                box.left < parent.left - 1 ||
                box.right > parent.right + 1 ||
                box.top < parent.top - 1 ||
                box.bottom > parent.bottom + 1
              )
                failures.push(name)
            }
            const viewport = new DOMRect(0, 0, innerWidth, innerHeight)
            within(surface, viewport, 'Shell surface exceeds viewport')
            within(root, surface.getBoundingClientRect(), 'Active editor exceeds shell')
            within(main, root.getBoundingClientRect(), 'Panes exceed editor')
            within(status, root.getBoundingClientRect(), 'Status bar exceeds editor')
            if (position) within(position, status.getBoundingClientRect(), 'Cursor position is clipped')
            if (main.getBoundingClientRect().bottom > status.getBoundingClientRect().top + 1) failures.push('Panes cover status bar')
            const notices = surface.querySelector('.editor-notices')
            if (notices && notices.getBoundingClientRect().bottom > root.getBoundingClientRect().top + 1) failures.push('Notices cover editor')
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 1
            const context = canvas.getContext('2d')
            if (!context) return ['Canvas color comparison is unavailable']
            // Composite mounted background colors front-to-back using the browser's
            // color parser and source-over math, not their serialized CSS spelling.
            // Exposed images and nontrivial compositing need pixel sampling instead;
            // fail closed rather than silently treating those paints as flat colors.
            const canvasBackground = (element: Element): number[] | null => {
              context.clearRect(0, 0, 1, 1)
              context.globalCompositeOperation = 'destination-over'
              let pixel = context.getImageData(0, 0, 1, 1).data
              for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor)
                if (Number(style.opacity) !== 1 || style.mixBlendMode !== 'normal' || style.filter !== 'none' || style.backdropFilter !== 'none') {
                  return null
                }
                // An opaque foreground hides ancestor images, but ancestor group
                // opacity/filters still affect it, so keep checking those above.
                if (pixel[3] === 255) continue
                if (style.backgroundImage !== 'none' || style.backgroundBlendMode !== 'normal') return null
                context.fillStyle = style.backgroundColor
                context.fillRect(0, 0, 1, 1)
                pixel = context.getImageData(0, 0, 1, 1).data
              }
              return pixel[3] === 255 ? Array.from(pixel) : null
            }
            const background = canvasBackground(application)
            if (!background) failures.push('Application canvas needs supported opaque background paint')
            for (const selector of ['.editor-markdown-editor', '.cm-editor', '.editor-markdown-preview', '.editor-markdown-preview-content']) {
              const pane = root.querySelector(selector)
              if (!pane) continue
              const box = pane.getBoundingClientRect()
              if (!box.width || !box.height) continue // Narrow screens show one pane at a time.
              within(pane, main.getBoundingClientRect(), `${selector} exceeds pane area`)
              const paintedBackground = canvasBackground(pane)
              if (!background || !paintedBackground || paintedBackground.some((channel, index) => channel !== background[index])) {
                failures.push(`${selector} loses the application canvas theme`)
              }
            }
            const previewContent = root.querySelector('.editor-markdown-preview-content')
            if (!previewContent || previewContent.scrollHeight <= previewContent.clientHeight) failures.push('Preview has no local scroll range')
            if (previewContent) {
              const overflow = getComputedStyle(previewContent).overflowY
              if (overflow !== 'auto' && overflow !== 'scroll') failures.push('Preview has no user-scrollable vertical overflow')
            }
            if (document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1) {
              failures.push('Editor content escapes into document scrolling')
            }
            return failures
          }),
        'Visible editor panes and cursor status remain bounded and use the active canvas theme'
      )
      .toEqual([])
  }
  await assertBoundedCanvas()
  const toggle = page.getByRole('button', { name: 'Synchronize source and preview scrolling', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await selectLine(page, 80)
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(500)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await preview.evaluate(element => {
    element.scrollTop = 300
  })
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBe(300)
  const previewReopened = await selectLine(page, 140)
  // Mobile switches panes: its old preview node is destroyed, not retained.
  // A fresh disabled preview must stay at zero rather than align to line 140.
  const disabledScrollTop = previewReopened ? 0 : 300
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.waitForTimeout(400)
  expect(await preview.evaluate(element => element.scrollTop)).toBe(disabledScrollTop)
  await withVisibleSource(page, async source => {
    await page.keyboard.insertText('Edited while following is disabled. ')
    await expect(source).toContainText('Edited while following is disabled.')
  })
  await page.waitForTimeout(900)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await preview.evaluate(element => element.scrollTop)).toBe(disabledScrollTop)
  const otherScrollPositions = await page.locator('.editor-markdown').evaluate(root => ({
    source: root.querySelector('.cm-scroller')?.scrollTop ?? 0,
    document: window.scrollY
  }))
  // Mobile WebKit has no wheel injection; the real scroll API still dispatches browser scroll events.
  await preview.evaluate(element => element.scrollBy(0, 200))
  await expect.poll(() => preview.evaluate(element => element.scrollTop), 'Browser scrolling moves the preview locally').toBeGreaterThan(disabledScrollTop)
  expect(
    await page.locator('.editor-markdown').evaluate(root => ({
      source: root.querySelector('.cm-scroller')?.scrollTop ?? 0,
      document: window.scrollY
    })),
    'Preview scrolling does not move the source pane or document'
  ).toEqual(otherScrollPositions)
  const paneToggle = page.locator('.editor-markdown-toolbar').getByRole('button', { name: /toggle preview|show editor|show preview/i })
  await paneToggle.click()
  await expect(preview).not.toBeVisible()
  await selectLine(page, 160)
  await paneToggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(preview).toBeVisible()
  const reopenedScrollTop = await preview.evaluate(element => element.scrollTop)
  await selectLine(page, 140)
  await page.waitForTimeout(400)
  expect(await preview.evaluate(element => element.scrollTop)).toBe(reopenedScrollTop)
  await toggle.focus()
  await expect(toggle).toBeFocused()
  await page.keyboard.press('Space')
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
  // A real offline event shows the supported save notice without replacing the editor or its DOM.
  await page.context().setOffline(true)
  try {
    await expect(page.locator('.editor-notices')).toBeVisible()
    await assertBoundedCanvas()
  } finally {
    await page.context().setOffline(false)
  }
  // Keep the mounted canvas bounded through a real breakpoint and media changes.
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('The preview canvas test requires a configured viewport.')
  await page.setViewportSize({ ...viewport, width: viewport.width >= 960 ? 750 : 1024 })
  await assertBoundedCanvas()
  const application = page.locator('.v-application')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(application).toHaveClass(/v-theme--dark/u)
  await assertBoundedCanvas()
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await expect(application).toHaveClass(/v-theme--light/u)
  await paneToggle.click()
  await expect(preview).not.toBeVisible()
  await paneToggle.click()
  await expect(preview).toBeVisible()
  await assertBoundedCanvas()
  await page.setViewportSize(viewport)
  await assertBoundedCanvas()
})

routedEditorTest('applies formatting from the toolbar or its mobile overflow', async ({ page }) => {
  await openEditor(page)
  const editorRoot = page.locator('.editor-markdown')
  await selectText(page, 2, 0, 11)
  const selectionBackground = editorRoot.locator('.cm-selectionLayer .cm-selectionBackground').first()
  await editorRoot.evaluate(root => {
    const editor = (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor
    editor.requestMeasure()
  })
  await page.evaluate(
    () =>
      new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await expect(selectionBackground).toBeVisible()
  await expect
    .poll(() => selectionBackground.evaluate(element => element.getBoundingClientRect().width), 'The selected Markdown range must have visible width')
    .toBeGreaterThan(0)
  await expect
    .poll(() => selectionBackground.evaluate(element => element.getBoundingClientRect().height), 'The selected Markdown range must have visible height')
    .toBeGreaterThan(0)
  // Geometry and a background color alone pass even when opaque editor content
  // covers CodeMirror's selection layer. Compare the actual painted region.
  const selectionClip = await selectionBackground.boundingBox()
  expect(selectionClip).not.toBeNull()
  const selectedPixels = await page.screenshot({ clip: selectionClip!, caret: 'hide', animations: 'disabled' })
  const hiddenSelectionStyle = await page.addStyleTag({ content: '.cm-selectionBackground { visibility: hidden !important; }' })
  const unselectedPixels = await page.screenshot({ clip: selectionClip!, caret: 'hide', animations: 'disabled' })
  await hiddenSelectionStyle.evaluate(element => element.parentNode?.removeChild(element))
  expect(selectedPixels.equals(unselectedPixels), 'Selection must visibly paint over the editor background').toBe(false)

  const bold = page.getByRole('button', { name: 'Bold', exact: true })
  if (await bold.isVisible()) {
    await bold.click()
    await expect
      .poll(() => editorRoot.evaluate(root => (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor.getLine(2)))
      .toMatch(/^\*\*A paragraph\*\*/)
    return
  }

  const more = page.getByRole('button', { name: 'More formatting tools', exact: true })
  await expect(more).toBeVisible()
  await more.click()
  const strike = page.locator('.v-overlay--active .v-list-item').filter({ hasText: 'Strikethrough' }).first()
  await expect(strike).toBeVisible()
  await strike.click()
  await expect
    .poll(() => editorRoot.evaluate(root => (root as HTMLElement & { __wikiSourceEditor: TextEditorHandle }).__wikiSourceEditor.getLine(2)))
    .toMatch(/^~~A paragraph~~/)
})
routedEditorTest('page properties keeps tag drafts honest across suggestion, failure, removal, and cancel', async ({ page }) => {
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

  await reopened.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(reopened).not.toBeVisible()
  expect(taxonomyRequests).toEqual([])
})

routedEditorTest('page properties applies a new tag without reviving a canceled draft', async ({ page }) => {
  const taxonomyRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname.includes('/taxonomy')) taxonomyRequests.push(request.url())
  })
  await openEditor(page, { onTagSearch: route => route.fulfill({ json: [] }) })
  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const properties = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(properties).toBeVisible()
  const tags = properties.getByRole('combobox', { name: /tags/i }).first()
  await tags.fill('  Cancelled-Transient  ')
  await tags.press('Enter')
  await expect(properties.getByRole('button', { name: 'Remove tag cancelled-transient', exact: true })).toBeVisible()
  await tags.press('Tab')
  await properties.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(properties).not.toBeVisible()

  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const reopened = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(reopened.getByRole('button', { name: 'Remove tag cancelled-transient', exact: true })).toHaveCount(0)
  await reopened.getByRole('combobox', { name: /tags/i }).fill('  Draft-Tag  ')
  await reopened.getByRole('combobox', { name: /tags/i }).press('Enter')
  await expect(reopened.getByRole('button', { name: /remove.*draft-tag/i })).toBeVisible()
  await reopened.getByRole('combobox', { name: /tags/i }).press('Tab')
  await reopened.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(reopened).not.toBeVisible()
  await page.getByRole('button', { name: 'Page', exact: true }).click()
  const committed = page.getByRole('dialog', { name: 'Page Properties', exact: true })
  await expect(committed.getByRole('button', { name: /remove.*draft-tag/i })).toBeVisible()
  await expect(committed.getByRole('button', { name: 'Remove tag cancelled-transient', exact: true })).toHaveCount(0)
  await committed.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(committed).not.toBeVisible()

  const createRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/_api/pages')
  const createResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/_api/pages')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  expect((await createRequest).postDataJSON().tags).toEqual(['draft-tag'])
  await createResponse
  expect(taxonomyRequests).toEqual([])
})

routedEditorTest('page properties ignores a late suggestion response for an older query', async ({ page }) => {
  let releaseSlow: (() => void) | undefined
  let slowStarted = false
  const slowResponse = new Promise<void>(resolve => {
    releaseSlow = resolve
  })
  await openEditor(page, {
    onTagSearch: async route => {
      const query = new URL(route.request().url()).searchParams.get('query') ?? ''
      if (query === 'slow') {
        slowStarted = true
        await slowResponse
        await route.fulfill({ json: ['slow-tag'] })
        return
      }
      await route.fulfill({ json: query === 'fast' ? ['fast-tag'] : [] })
    }
  })

  try {
    await page.getByRole('button', { name: 'Page', exact: true }).click()
    const properties = page.getByRole('dialog', { name: 'Page Properties', exact: true })
    const tags = properties.getByRole('combobox', { name: /tags/i }).first()
    await tags.click()
    await tags.fill('slow')
    await expect.poll(() => slowStarted).toBe(true)
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
  } finally {
    releaseSlow?.()
  }
})

routedEditorTest('Draw.io parent modal isolates the editor and restores its native toolbar opener across iframe focus', async ({ page }) => {
  // Use the persistent desktop toolbar opener, not a transient mobile overflow item.
  await page.setViewportSize({ width: 1440, height: 900 })
  await openEditor(page)
  const parentOrigin = new URL(page.url()).origin
  // Replace only the external document. Native cross-origin frame traversal is real;
  // this fixture does not implement the diagrams.net SDK or forward Escape/exit.
  await page.route('https://embed.diagrams.net/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Frame focus fixture</title></head><body>
        <button type="button">Frame start</button>
        <label>Diagram label <input type="text"></label>
        <script>parent.postMessage(JSON.stringify({ event: 'init' }), ${JSON.stringify(parentOrigin)});</script>
      </body></html>`
    })
  )
  const editor = page.locator('.editor-markdown')
  const readBackground = (root: Element) => {
    const states: Array<{ inert: boolean; inertAttribute: string | null; ariaHidden: string | null }> = []
    for (let element: HTMLElement | null = root as HTMLElement; element; element = element.parentElement) {
      states.push({
        inert: element.inert,
        inertAttribute: element.getAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden')
      })
    }
    return states
  }
  const originalBackground = await editor.evaluate(readBackground)
  const opener = page.getByRole('button', { name: 'Insert Diagram', exact: true })
  await expect(opener).toBeVisible()
  await opener.focus()
  await expect(opener).toBeFocused()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog', { name: 'Draw.io', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  const back = dialog.getByRole('button', { name: 'Back to editor', exact: true })
  await expect(back).toBeFocused()
  await expect
    .poll(() =>
      editor.evaluate(root => {
        const isolated = root.closest<HTMLElement>('[inert][aria-hidden="true"]')
        return isolated?.inert === true
      })
    )
    .toBe(true)

  const iframe = dialog.locator('iframe[title="Diagram editor"]')
  const frame = page.frameLocator('.editor-modal-drawio iframe[title="Diagram editor"]')
  const frameStart = frame.getByRole('button', { name: 'Frame start', exact: true })
  const frameEnd = frame.getByRole('textbox', { name: 'Diagram label', exact: true })
  const frameBody = frame.locator('body')
  const leaveFrame = async (key: 'Tab' | 'Shift+Tab') => {
    await page.keyboard.press(key)
    const frameElementStop = await iframe.evaluate(element => document.hasFocus() && document.activeElement === element)
    if (frameElementStop && !(await frameStart.evaluate(() => document.hasFocus()))) {
      // Gecko can stop on the parent iframe element after leaving its document.
      // One further native key must reach the modal, never an arbitrary Tab loop.
      await expect(iframe).toBeFocused()
      await page.keyboard.press(key)
    }
    await expect(back).toBeFocused()
    expect(await page.evaluate(() => document.hasFocus())).toBe(true)
  }
  const enterFrameForward = async (allowRetainedEnd = false) => {
    await page.keyboard.press('Tab')
    await expect(iframe).toBeFocused()
    await expect
      .poll(() =>
        frameStart.evaluate(element => ({
          hasFocus: document.hasFocus(),
          target:
            document.activeElement === element
              ? 'start'
              : document.activeElement === document.body
                ? 'body'
                : document.activeElement?.matches('input')
                  ? 'end'
                  : 'other'
        }))
      )
      .toEqual({ hasFocus: true, target: expect.stringMatching(allowRetainedEnd ? /^(body|start|end)$/ : /^(body|start)$/) })
    // Some native browsers enter the frame document before its first control.
    // Accept only that real focused-body stop, then require one Tab to the button.
    if (await frameBody.evaluate(element => document.activeElement === element)) {
      await expect(frameBody).toBeFocused()
      await page.keyboard.press('Tab')
    }
    if (allowRetainedEnd && (await frameEnd.evaluate(element => document.activeElement === element))) {
      await expect(frameEnd).toBeFocused()
      expect(await page.evaluate(() => document.hasFocus())).toBe(true)
      return 'end'
    }
    await expect(frameStart).toBeFocused()
    expect(await page.evaluate(() => document.hasFocus())).toBe(true)
    return 'start'
  }
  await expect(frameStart).toBeVisible()
  await expect(dialog.getByText('Loading diagram editor', { exact: true })).not.toBeVisible()
  const frameOrigin = await frameStart.evaluate(() => location.origin)
  expect(frameOrigin).toBe('https://embed.diagrams.net')
  expect(frameOrigin).not.toBe(parentOrigin)

  // Browser keyboard events, not DOM-dispatched events or scripted focus in the frame.
  await enterFrameForward()
  await page.keyboard.press('Tab')
  await expect(frameEnd).toBeFocused()
  await leaveFrame('Tab')
  // Native iframe re-entry may retain the last focused control.
  const retainedEntry = await enterFrameForward(true)
  if (retainedEntry === 'start') await page.keyboard.press('Tab')
  await expect(frameEnd).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(frameStart).toBeFocused()
  await leaveFrame('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(iframe).toBeFocused()
  await expect(back).not.toBeFocused()
  expect(await page.evaluate(() => document.hasFocus())).toBe(true)
  // Reverse entry can land on the frame document or one of its native controls.
  // Each accepted state has a specific remaining sequence; never retry Tab
  // until focus happens to escape an opaque frame.
  await expect
    .poll(() =>
      frameStart.evaluate(element => ({
        hasFocus: document.hasFocus(),
        target:
          document.activeElement === document.body
            ? 'body'
            : document.activeElement === element
              ? 'start'
              : document.activeElement?.matches('input')
                ? 'end'
                : 'other'
      }))
    )
    .toEqual({ hasFocus: true, target: expect.stringMatching(/^(body|start|end)$/) })
  if (await frameBody.evaluate(element => document.activeElement === element)) {
    await expect(frameBody).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(frameEnd).toBeFocused()
  }
  if (await frameEnd.evaluate(element => document.activeElement === element)) {
    await expect(frameEnd).toBeFocused()
    await page.keyboard.press('Shift+Tab')
  }
  await expect(frameStart).toBeFocused()
  await leaveFrame('Shift+Tab')

  // Escape originates at the genuine parent modal control after leaving the iframe.
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect.poll(() => editor.evaluate(readBackground)).toEqual(originalBackground)
  await expect(opener).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeEditable()

  // Reopening must not retain the prior scope or break native pointer activation.
  await opener.click()
  await expect(dialog).toBeVisible()
  await expect(back).toBeFocused()
  await back.click()
  await expect(dialog).not.toBeVisible()
  await expect.poll(() => editor.evaluate(readBackground)).toEqual(originalBackground)
  await expect(opener).toBeFocused()
})
