type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type PageIndexItem = {
  id: number
  title: string
  description: string | null
  path: string
  href: string
  updatedAt: string
}

const readPageIndexItems = (payload: unknown): PageIndexItem[] => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Page index response must be an object.')
  const items = Reflect.get(payload, 'items')
  if (!Array.isArray(items) || items.length > 200) throw new TypeError('Page index response has an invalid items list.')
  return items.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`Page index item ${index} must be an object.`)
    const id = Reflect.get(input, 'id')
    const title = Reflect.get(input, 'title')
    const description = Reflect.get(input, 'description')
    const path = Reflect.get(input, 'path')
    const href = Reflect.get(input, 'href')
    const updatedAt = Reflect.get(input, 'updatedAt')
    if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof title !== 'string' || title.length > 255) {
      throw new TypeError(`Page index item ${index} has invalid identity fields.`)
    }
    if (description !== null && (typeof description !== 'string' || description.length > 1000)) {
      throw new TypeError(`Page index item ${index} has an invalid description.`)
    }
    if (typeof path !== 'string' || path.length > 512 || typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) {
      throw new TypeError(`Page index item ${index} has an invalid route.`)
    }
    if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
      throw new TypeError(`Page index item ${index} has an invalid update timestamp.`)
    }
    return { id: id as number, title, description, path, href, updatedAt }
  })
}

const hydratePageIndex = async (
  element: HTMLElement,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<void> => {
  const query = new URLSearchParams({
    path: element.dataset.indexPath ?? '',
    locale: element.dataset.indexLocale ?? '',
    depth: element.dataset.indexDepth ?? '0',
    order: element.dataset.indexOrder ?? 'path',
    limit: element.dataset.indexLimit ?? '50'
  })
  const response = await fetchImpl(`/_api/content-extensions/index?${query}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal
  })
  if (!response.ok) throw new Error(`Page index request failed (${response.status}).`)
  const items = readPageIndexItems(await response.json())
  if (signal.aborted) return
  element.replaceChildren()
  element.setAttribute('aria-busy', 'false')
  if (items.length === 0) {
    const status = element.ownerDocument.createElement('p')
    status.className = 'content-extension-index__status'
    status.textContent = element.dataset.indexEmptyLabel ?? 'No pages are available in this section.'
    element.append(status)
    return
  }

  const list = element.ownerDocument.createElement('ul')
  list.className = 'content-extension-index__list'
  list.setAttribute('role', 'list')
  const showIcons = element.dataset.indexShowIcons === 'true'
  for (const item of items) {
    const listItem = element.ownerDocument.createElement('li')
    listItem.className = 'content-extension-index__item'
    const link = element.ownerDocument.createElement('a')
    link.className = 'content-extension-index__link'
    link.href = item.href
    if (showIcons) {
      const icon = element.ownerDocument.createElement('span')
      icon.className = 'content-extension-index__icon'
      icon.setAttribute('aria-hidden', 'true')
      link.append(icon)
    }
    const copy = element.ownerDocument.createElement('span')
    copy.className = 'content-extension-index__copy'
    const title = element.ownerDocument.createElement('span')
    title.className = 'content-extension-index__title'
    title.textContent = item.title
    copy.append(title)
    if (item.description) {
      const description = element.ownerDocument.createElement('span')
      description.className = 'content-extension-index__description'
      description.textContent = item.description
      copy.append(description)
    }
    link.append(copy)
    listItem.append(link)
    list.append(listItem)
  }
  element.append(list)
}

const galleryCleanup = (gallery: HTMLElement): (() => void) => {
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
  const onDialogClick = (event: MouseEvent): void => {
    if (event.target === dialog) dialog.close()
  }
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

export const hydrateContentExtensions = (
  root: ParentNode,
  fetchImpl: FetchLike = fetch
): (() => void) => {
  const controller = new AbortController()
  const cleanups = [...root.querySelectorAll<HTMLElement>('.content-extension--gallery')].map(galleryCleanup)
  for (const index of root.querySelectorAll<HTMLElement>('.content-extension--index')) {
    void hydratePageIndex(index, fetchImpl, controller.signal).catch(() => {
      if (controller.signal.aborted) return
      index.setAttribute('aria-busy', 'false')
      const status = index.querySelector<HTMLElement>('.content-extension-index__status')
      if (status) status.textContent = 'Page index is temporarily unavailable.'
    })
  }
  return () => {
    controller.abort()
    for (const cleanup of cleanups) cleanup()
  }
}
