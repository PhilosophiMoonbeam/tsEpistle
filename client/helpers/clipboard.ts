export const copyTextToClipboard = async (text: string): Promise<void> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    /* Fall through to the legacy copy path. */
  }

  const activeElement = document.activeElement
  const selection = document.getSelection()
  const ranges: Range[] = []
  for (let index = 0; selection && index < selection.rangeCount; index += 1) {
    ranges.push(selection.getRangeAt(index).cloneRange())
  }
  const anchorNode = selection?.anchorNode
  const anchorOffset = selection?.anchorOffset ?? 0
  const focusNode = selection?.focusNode
  const focusOffset = selection?.focusOffset ?? 0
  const activeInput = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement ? activeElement : null
  const inputSelection =
    activeInput && activeInput.selectionStart !== null && activeInput.selectionEnd !== null
      ? { start: activeInput.selectionStart, end: activeInput.selectionEnd, direction: activeInput.selectionDirection }
      : null

  const helper = document.createElement('textarea')
  helper.value = text
  helper.readOnly = true
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  helper.style.pointerEvents = 'none'
  try {
    document.body.append(helper)
    helper.select()
    if (!document.execCommand('copy')) throw new Error('Clipboard copy unavailable')
  } finally {
    helper.remove()
    if (activeElement instanceof HTMLElement && activeElement.isConnected) activeElement.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
      if (ranges.length === 1 && anchorNode && focusNode && selection.setBaseAndExtent) {
        selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
      }
    }
    if (activeInput && inputSelection) activeInput.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined)
  }
}
