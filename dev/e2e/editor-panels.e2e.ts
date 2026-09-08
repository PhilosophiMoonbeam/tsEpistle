import { expect, test, type Page } from '@playwright/test'
import type { TextEditorHandle } from '../../client/components/editor/common/text-editor'

// Mount the shipped editor with a new-page fixture: no account, saved page, or collaboration session.
const content = Array.from(
  { length: 45 },
  (_, index) => `## Section ${index + 1}\n\nA paragraph for checking cursor alignment and independent preview scrolling.\n\n`
).join('')

async function openEditor(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
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
  await page.route('**/u', route => route.fulfill({ status: 405 }))
  await page.route('**/editor-panel-fixture', async route => {
    const response = await page.request.get('/login')
    const html = (await response.text()).replace(
      /<login\b[^>]*><\/login>/,
      `<editor init-editor="markdown" init-mode="create" title="Editor review" init-content="${Buffer.from(content).toString('base64')}"></editor>`
    )
    await route.fulfill({ response, body: html })
  })
  await page.goto('/editor-panel-fixture')
  await expect(page.locator('.cm-content')).toBeAttached()
  await page.locator('.v-dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  return errors
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
  const errors = await openEditor(page)
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
  expect(errors).toEqual([])
})

test('preview follows the cursor by default and stops when toggled off', async ({ page }) => {
  const errors = await openEditor(page)
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
  expect(errors).toEqual([])
})
