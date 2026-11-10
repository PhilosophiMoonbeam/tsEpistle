import { expect, type Locator, type Page } from '@playwright/test'
import { openAuthenticatedPage, responsiveTest as test } from './helpers'

async function clearDraft(page: Page, editor: Locator) {
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await expect(editor).toHaveText('')
}

async function discardDraft(page: Page, readerPath: string) {
  if (!(await page.locator('.editor-tiptap').count())) return
  const close = page.getByRole('button', { name: 'Close', exact: true })
  if (await close.isVisible()) await close.click()
  else {
    await page.getByRole('button', { name: 'More editor actions', exact: true }).click()
    await page.getByRole('listitem').filter({ hasText: /^Close$/u }).click()
  }
  const discard = page.getByRole('button', { name: 'Discard Changes', exact: true })
  await expect(discard).toBeVisible()
  await discard.click()
  await page.waitForURL(readerPath, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.editor-tiptap')).toHaveCount(0)
}

for (const format of ['visual-markdown', 'visual-html'] as const) {
  test(`${format} native discovery supports contextual Ctrl+Space, literal cancel, pointer selection and undo`, async ({ page }) => {
    test.setTimeout(90_000)
    const readerPath = `/en/${format}-browser`
    const targetPath = format === 'visual-markdown' ? 'visual-html-browser' : 'visual-markdown-browser'
    const targetTitle = format === 'visual-markdown' ? 'Visual HTML Browser' : 'Visual Markdown Browser'
    await openAuthenticatedPage(page, `/e${readerPath}`, '.editor-tiptap')
    const editor = page.locator('.editor-tiptap .ProseMirror')
    const menu = page.locator('.editor-tiptap-slash-menu')
    try {
      // A real edit retires first-focus reconciliation before replacing this unsaved draft.
      await editor.getByRole('heading').first().click()
      await page.keyboard.insertText('x')
      await expect(page.getByRole('button', { name: 'Save and close', exact: true })).toHaveAttribute('data-commitment', 'active')
      await clearDraft(page, editor)

      // Exercise the browser shortcut itself, not an invocation of an editor command.
      await page.keyboard.press('Control+Space')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: 'Heading 2', exact: true })).toBeVisible()
      await editor.pressSequentially('heading 2')
      await page.keyboard.press('Enter')
      await expect(editor.locator('h2')).toHaveCount(1)
      await page.keyboard.press('ControlOrMeta+z')
      await expect(editor).toHaveText('heading 2')
      await expect(editor.locator('h2')).toHaveCount(0)

      await clearDraft(page, editor)
      await editor.pressSequentially('Before after')
      await page.keyboard.press('Home')
      for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Control+Space')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem')).toHaveCount(4)
      await expect(menu.getByRole('menuitem', { name: 'Heading 2', exact: true })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(menu).not.toBeVisible()
      await expect(editor).toHaveText('Before after')

      await editor.pressSequentially('[[')
      await expect(menu).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(editor).toHaveText('Before [[after')
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
      await editor.pressSequentially(`[[/${targetPath}`)
      await expect(menu.getByRole('menuitem', { name: targetTitle, exact: true })).toBeVisible()
      await menu.getByRole('menuitem', { name: targetTitle, exact: true }).click()
      await expect(editor.getByRole('link', { name: targetTitle, exact: true })).toHaveAttribute('href', `/${targetPath}`)
      await expect(editor).toHaveText(`Before ${targetTitle}after`)
      await page.keyboard.press('ControlOrMeta+z')
      await expect(editor).toHaveText(`Before [[/${targetPath}after`)
      await expect(editor.getByRole('link')).toHaveCount(0)

      await clearDraft(page, editor)
      await editor.pressSequentially('[[')
      await expect(menu).toBeVisible()
      // Browser composition events fence the picker. Physical OS/IME interception
      // remains a separate manual check; synthetic composition is not that proof.
      await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
      await expect(menu).not.toBeVisible()
      const composingShortcutHandled = await editor.evaluate(element => {
        const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })
        element.dispatchEvent(event)
        return event.defaultPrevented
      })
      expect(composingShortcutHandled).toBe(false)
      await expect(editor).toHaveText('[[')
      await editor.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    } finally {
      if (!page.isClosed()) await discardDraft(page, readerPath)
    }
  })
}
