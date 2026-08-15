type Cleanup = () => void

export const hydrateGallery = (gallery: HTMLElement): Cleanup => {
  const links = [...gallery.querySelectorAll<HTMLAnchorElement>('.content-extension-gallery__link')]
  const view = gallery.ownerDocument.defaultView
  if (links.length === 0 || !view || typeof view.HTMLDialogElement === 'undefined') return () => {}

  const dialog = gallery.ownerDocument.createElement('dialog')
  if (typeof dialog.showModal !== 'function') return () => {}
  dialog.className = 'content-extension-gallery-dialog'
  dialog.setAttribute('aria-label', 'Image viewer')
  const close = gallery.ownerDocument.createElement('button')
  close.className = 'content-extension-gallery-dialog__close'
  close.type = 'button'
  close.setAttribute('aria-label', 'Close image viewer')
  close.textContent = '×'
  const previous = gallery.ownerDocument.createElement('button')
  previous.className = 'content-extension-gallery-dialog__previous'
  previous.type = 'button'
  previous.setAttribute('aria-label', 'Previous image')
  previous.textContent = '‹'
  const next = gallery.ownerDocument.createElement('button')
  next.className = 'content-extension-gallery-dialog__next'
  next.type = 'button'
  next.setAttribute('aria-label', 'Next image')
  next.textContent = '›'
  const figure = gallery.ownerDocument.createElement('figure')
  figure.className = 'content-extension-gallery-dialog__figure'
  const image = gallery.ownerDocument.createElement('img')
  image.className = 'content-extension-gallery-dialog__image'
  const caption = gallery.ownerDocument.createElement('figcaption')
  caption.className = 'content-extension-gallery-dialog__caption'
  figure.append(image, caption)
  dialog.append(close, previous, figure, next)
  gallery.ownerDocument.body.append(dialog)

  let activeIndex = 0
  let returnFocus: HTMLAnchorElement | null = null
  const show = (index: number): void => {
    activeIndex = (index + links.length) % links.length
    const link = links[activeIndex]!
    const thumbnail = link.querySelector<HTMLImageElement>('img')
    image.src = link.href
    image.alt = thumbnail?.alt ?? ''
    const itemCaption = link.closest('figure')?.querySelector<HTMLElement>('.content-extension-gallery__caption')?.textContent?.trim()
    caption.textContent = itemCaption || `${activeIndex + 1} of ${links.length}`
    previous.disabled = links.length < 2
    next.disabled = links.length < 2
  }
  const handlers = links.map((link, index) => {
    const handler = (event: MouseEvent): void => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      returnFocus = link
      show(index)
      dialog.showModal()
      close.focus()
    }
    link.addEventListener('click', handler)
    return { link, handler }
  })
  const closeDialog = (): void => dialog.close()
  const showPrevious = (): void => show(activeIndex - 1)
  const showNext = (): void => show(activeIndex + 1)
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      showPrevious()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      showNext()
    }
  }
  const onDialogClick = (event: MouseEvent): void => { if (event.target === dialog) dialog.close() }
  const restoreFocus = (): void => returnFocus?.focus()
  close.addEventListener('click', closeDialog)
  previous.addEventListener('click', showPrevious)
  next.addEventListener('click', showNext)
  dialog.addEventListener('keydown', onKeydown)
  dialog.addEventListener('click', onDialogClick)
  dialog.addEventListener('close', restoreFocus)

  return () => {
    for (const { link, handler } of handlers) link.removeEventListener('click', handler)
    close.removeEventListener('click', closeDialog)
    previous.removeEventListener('click', showPrevious)
    next.removeEventListener('click', showNext)
    dialog.removeEventListener('keydown', onKeydown)
    dialog.removeEventListener('click', onDialogClick)
    dialog.removeEventListener('close', restoreFocus)
    if (dialog.open) dialog.close()
    dialog.remove()
  }
}
