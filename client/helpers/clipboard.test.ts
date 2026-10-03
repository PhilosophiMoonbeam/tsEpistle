import { afterEach, describe, expect, it } from '../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../test/browser-dom.mts'
import { copyTextToClipboard } from './clipboard.ts'

const previousClipboard = Object.getOwnPropertyDescriptor(browserWindow.navigator, 'clipboard')
const previousExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
const restoreProperty = (target: object, key: string, descriptor?: PropertyDescriptor): void => {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}
const setClipboard = (writeText?: (text: string) => Promise<void>): void => {
  Object.defineProperty(browserWindow.navigator, 'clipboard', { configurable: true, value: writeText ? { writeText } : undefined })
}
const setLegacyCopy = (copy: () => boolean): void => {
  Object.defineProperty(document, 'execCommand', { configurable: true, value: copy })
}
const selectAnswer = (): { answer: HTMLElement; selection: Selection } => {
  const answer = document.createElement('p')
  answer.tabIndex = 0
  answer.textContent = 'Selected answer text'
  document.body.append(answer)
  answer.focus()
  const selection = document.getSelection()
  if (!selection || !answer.firstChild) throw new Error('Browser selection is unavailable')
  selection.setBaseAndExtent(answer.firstChild, 15, answer.firstChild, 9)
  return { answer, selection }
}

afterEach(() => {
  restoreProperty(browserWindow.navigator, 'clipboard', previousClipboard)
  restoreProperty(document, 'execCommand', previousExecCommand)
  document.getSelection()?.removeAllRanges()
  resetBody()
})

describe('Clipboard copy boundary', () => {
  it('uses secure copying without disturbing focus or a backward text selection', async () => {
    const { answer, selection } = selectAnswer()
    let copiedText = ''
    setClipboard(async text => {
      copiedText = text
    })
    setLegacyCopy(() => {
      throw new Error('Legacy copying must not run after secure success')
    })

    await copyTextToClipboard('Answer with source links')

    expect(copiedText).toBe('Answer with source links')
    expect(document.activeElement).toBe(answer)
    expect(selection.toString()).toBe('answer')
    expect(selection.anchorOffset).toBe(15)
    expect(selection.focusOffset).toBe(9)
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back after clipboard denial and restores the selected DOM range on success', async () => {
    const { answer, selection } = selectAnswer()
    setClipboard(async () => {
      throw new Error('Permission denied')
    })
    let copiedText = ''
    setLegacyCopy(() => {
      const helper = document.querySelector('textarea')
      if (!helper) throw new Error('No text available for legacy copying')
      copiedText = helper.value.slice(helper.selectionStart, helper.selectionEnd)
      helper.focus()
      selection.removeAllRanges()
      return true
    })

    await copyTextToClipboard('Legacy answer')

    expect(copiedText).toBe('Legacy answer')
    expect(document.activeElement).toBe(answer)
    expect(selection.toString()).toBe('answer')
    expect(selection.getRangeAt(0).startContainer).toBe(answer.firstChild)
    expect(selection.anchorOffset).toBe(15)
    expect(selection.focusOffset).toBe(9)
    expect(document.querySelector('textarea')).toBeNull()
  })

  for (const outcome of ['success', 'false', 'throw'] as const) {
    it(`preserves textarea focus and selection and removes the fallback textarea after ${outcome}`, async () => {
      const editor = document.createElement('textarea')
      editor.value = 'Review this draft before saving'
      document.body.append(editor)
      editor.focus()
      editor.setSelectionRange(7, 17, 'backward')
      setClipboard()
      let copiedText = ''
      setLegacyCopy(() => {
        const helper = [...document.querySelectorAll('textarea')].find(candidate => candidate !== editor)
        if (!helper) throw new Error('No fallback text to copy')
        copiedText = helper.value.slice(helper.selectionStart, helper.selectionEnd)
        helper.focus()
        editor.setSelectionRange(0, 0)
        if (outcome === 'throw') throw new Error('Legacy clipboard denied')
        return outcome === 'success'
      })

      if (outcome === 'success') await copyTextToClipboard('Copied code')
      else await expect(copyTextToClipboard('Copied code')).rejects.toThrow()

      expect(copiedText).toBe('Copied code')
      expect(document.activeElement).toBe(editor)
      expect(editor.selectionStart).toBe(7)
      expect(editor.selectionEnd).toBe(17)
      expect(editor.selectionDirection).toBe('backward')
      expect([...document.querySelectorAll('textarea')]).toEqual([editor])
    })
  }

  it('reports failure when neither clipboard path succeeds and still restores the text selection', async () => {
    const { answer, selection } = selectAnswer()
    setClipboard(async () => {
      throw new Error('Permission denied')
    })
    setLegacyCopy(() => {
      document.querySelector('textarea')?.focus()
      selection.removeAllRanges()
      return false
    })

    await expect(copyTextToClipboard('Denied answer')).rejects.toThrow()

    expect(document.activeElement).toBe(answer)
    expect(selection.toString()).toBe('answer')
    expect(selection.anchorOffset).toBe(15)
    expect(selection.focusOffset).toBe(9)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
