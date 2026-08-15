type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Cleanup = () => void

type PageIndexItem = {
  id: number
  title: string
  description: string | null
  path: string
  href: string
  updatedAt: string
}

let tabsInstance = 0
let diagramInstance = 0
let mermaidQueue = Promise.resolve()

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

const galleryCleanup = (gallery: HTMLElement): Cleanup => {
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

const tabsCleanup = (tabs: HTMLElement): Cleanup => {
  const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('.content-extension-tabs__tab')]
  const panels = [...tabs.querySelectorAll<HTMLElement>('.content-extension-tabs__panel')]
  if (buttons.length < 2 || buttons.length !== panels.length) return () => {}
  const instance = ++tabsInstance
  let active = Number(tabs.dataset.tabsActive)
  if (!Number.isInteger(active) || active < 0 || active >= buttons.length) active = 0

  const select = (index: number, focus: boolean): void => {
    active = index
    buttons.forEach((button, buttonIndex) => {
      const selected = buttonIndex === index
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    })
    panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== index })
    if (focus) buttons[index]?.focus()
  }
  const clickHandlers = buttons.map((button, index) => {
    const buttonId = `content-extension-tabs-${instance}-tab-${index}`
    const panelId = `content-extension-tabs-${instance}-panel-${index}`
    button.id = buttonId
    button.hidden = false
    button.setAttribute('aria-controls', panelId)
    panels[index]!.id = panelId
    panels[index]!.setAttribute('aria-labelledby', buttonId)
    panels[index]!.querySelector<HTMLElement>('.content-extension-tabs__fallback-label')?.setAttribute('hidden', '')
    const handler = (): void => select(index, false)
    button.addEventListener('click', handler)
    return { button, handler }
  })
  const onKeydown = (event: KeyboardEvent): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight') next = (active + 1) % buttons.length
    if (event.key === 'ArrowLeft') next = (active - 1 + buttons.length) % buttons.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = buttons.length - 1
    if (next === null) return
    event.preventDefault()
    select(next, true)
  }
  const tablist = tabs.querySelector<HTMLElement>('.content-extension-tabs__list')
  tablist?.addEventListener('keydown', onKeydown)
  select(active, false)

  return () => {
    for (const { button, handler } of clickHandlers) button.removeEventListener('click', handler)
    tablist?.removeEventListener('keydown', onKeydown)
  }
}

const spoilerCleanup = (spoiler: HTMLElement): Cleanup => {
  const button = spoiler.querySelector<HTMLButtonElement>('.content-extension-spoiler__toggle')
  const content = spoiler.querySelector<HTMLElement>('.content-extension-spoiler__content')
  if (!button || !content) return () => {}
  let expanded = false
  const update = (): void => {
    button.setAttribute('aria-expanded', String(expanded))
    content.hidden = !expanded
  }
  const toggle = (): void => {
    expanded = !expanded
    update()
  }
  button.hidden = false
  button.addEventListener('click', toggle)
  update()
  return () => button.removeEventListener('click', toggle)
}

const safeSameOriginPath = (value: string): boolean => {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  try {
    const url = new URL(value, window.location.origin)
    return url.origin === window.location.origin && url.pathname === value
  } catch {
    return false
  }
}

const pdfCleanup = (figure: HTMLElement): Cleanup => {
  const src = figure.dataset.pdfSrc ?? ''
  const viewer = figure.querySelector<HTMLElement>('.content-extension-pdf__viewer')
  if (!viewer || !safeSameOriginPath(src)) return () => {}
  const page = Number(figure.dataset.pdfPage)
  const height = Number(figure.dataset.pdfHeight)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(height) || height < 320 || height > 1600) return () => {}
  const frame = figure.ownerDocument.createElement('iframe')
  frame.className = 'content-extension-pdf__frame'
  frame.src = `${src}#page=${page}`
  frame.title = figure.dataset.pdfTitle ?? 'PDF document'
  frame.loading = 'lazy'
  frame.style.height = `${height}px`
  viewer.append(frame)
  return () => {
    frame.src = 'about:blank'
    frame.remove()
  }
}

const remoteError = (element: HTMLElement, message: string): void => {
  const consent = element.querySelector<HTMLElement>('.content-extension-remote__consent')
  if (!consent) return
  const status = element.ownerDocument.createElement('p')
  status.className = 'content-extension-remote__error'
  status.setAttribute('role', 'alert')
  status.textContent = message
  consent.replaceChildren(status)
}

const youtubeCleanup = (figure: HTMLElement): Cleanup => {
  const button = figure.querySelector<HTMLButtonElement>('.content-extension-remote__load')
  if (!button) return () => {}
  let frame: HTMLIFrameElement | null = null
  const load = (): void => {
    const id = figure.dataset.youtubeId ?? ''
    const start = Number(figure.dataset.youtubeStart)
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !Number.isInteger(start) || start < 0 || start > 86400) {
      remoteError(figure, 'This YouTube configuration is invalid.')
      return
    }
    const query = new URLSearchParams()
    if (start > 0) query.set('start', String(start))
    if (figure.dataset.youtubeControls === 'false') query.set('controls', '0')
    frame = figure.ownerDocument.createElement('iframe')
    frame.className = 'content-extension-remote__frame'
    frame.src = `https://www.youtube-nocookie.com/embed/${id}${query.size > 0 ? `?${query}` : ''}`
    frame.title = figure.dataset.youtubeTitle ?? 'YouTube video'
    frame.loading = 'lazy'
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    frame.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share'
    frame.allowFullscreen = true
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation')
    figure.querySelector<HTMLElement>('.content-extension-remote__consent')?.replaceWith(frame)
  }
  button.addEventListener('click', load, { once: true })
  return () => {
    button.removeEventListener('click', load)
    if (frame) {
      frame.src = 'about:blank'
      frame.remove()
    }
  }
}

const mapCleanup = (figure: HTMLElement): Cleanup => {
  const button = figure.querySelector<HTMLButtonElement>('.content-extension-remote__load')
  if (!button) return () => {}
  let frame: HTMLIFrameElement | null = null
  const load = (): void => {
    const latitude = Number(figure.dataset.mapLatitude)
    const longitude = Number(figure.dataset.mapLongitude)
    const zoom = Number(figure.dataset.mapZoom)
    const height = Number(figure.dataset.mapHeight)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isInteger(zoom) || zoom < 1 || zoom > 19 || !Number.isInteger(height) || height < 240 || height > 800) {
      remoteError(figure, 'This map configuration is invalid.')
      return
    }
    const longitudeSpan = 360 / (2 ** zoom)
    const latitudeSpan = Math.max(0.001, longitudeSpan * 0.6)
    const params = new URLSearchParams({
      bbox: `${longitude - longitudeSpan},${latitude - latitudeSpan},${longitude + longitudeSpan},${latitude + latitudeSpan}`,
      layer: 'mapnik',
      marker: `${latitude},${longitude}`
    })
    frame = figure.ownerDocument.createElement('iframe')
    frame.className = 'content-extension-remote__frame content-extension-map__frame'
    frame.src = `https://www.openstreetmap.org/export/embed.html?${params}`
    frame.title = figure.dataset.mapLabel ?? 'OpenStreetMap map'
    frame.loading = 'lazy'
    frame.referrerPolicy = 'no-referrer'
    frame.style.height = `${height}px`
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    figure.querySelector<HTMLElement>('.content-extension-remote__consent')?.replaceWith(frame)
  }
  button.addEventListener('click', load, { once: true })
  return () => {
    button.removeEventListener('click', load)
    if (frame) {
      frame.src = 'about:blank'
      frame.remove()
    }
  }
}

const bytesToBase64Url = (bytes: Uint8Array): string => {
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)))
  }
  return btoa(chunks.join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export const encodeKrokiSource = async (source: string): Promise<string> => {
  const { deflate } = await import('pako')
  return bytesToBase64Url(deflate(new TextEncoder().encode(source), { level: 9 }))
}

const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

export const encodePlantUmlSource = async (source: string): Promise<string> => {
  const { deflateRaw } = await import('pako')
  const bytes = deflateRaw(new TextEncoder().encode(source), { level: 9 })
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    encoded += PLANTUML_ALPHABET[first >> 2]
    encoded += PLANTUML_ALPHABET[((first & 0x3) << 4) | (second >> 4)]
    encoded += PLANTUML_ALPHABET[((second & 0xf) << 2) | (third >> 6)]
    encoded += PLANTUML_ALPHABET[third & 0x3f]
  }
  return encoded
}

const remoteDiagramCleanup = (figure: HTMLElement, provider: 'kroki' | 'plantuml', signal: AbortSignal): Cleanup => {
  const button = figure.querySelector<HTMLButtonElement>('.content-extension-remote__load')
  const sourceElement = figure.querySelector<HTMLElement>('.content-extension-diagram__source code')
  if (!button || !sourceElement) return () => {}
  let image: HTMLImageElement | null = null
  const load = async (): Promise<void> => {
    button.disabled = true
    button.textContent = 'Rendering…'
    try {
      const source = sourceElement.textContent ?? ''
      const encoded = provider === 'kroki' ? await encodeKrokiSource(source) : await encodePlantUmlSource(source)
      if (signal.aborted) return
      const format = provider === 'kroki' ? figure.dataset.krokiFormat : figure.dataset.plantumlFormat
      const type = figure.dataset.krokiType
      const url = provider === 'kroki'
        ? `https://kroki.io/${type}/${format}/${encoded}`
        : `https://www.plantuml.com/plantuml/${format}/${encoded}`
      if (url.length > 16000) throw new Error('The diagram is too large for the renderer URL.')
      image = figure.ownerDocument.createElement('img')
      image.className = 'content-extension-diagram__image'
      image.alt = figure.dataset.remoteAlt ?? `${provider} diagram`
      image.loading = 'lazy'
      image.decoding = 'async'
      image.referrerPolicy = 'no-referrer'
      image.src = url
      figure.querySelector<HTMLElement>('.content-extension-remote__consent')?.replaceWith(image)
      sourceElement.closest<HTMLElement>('.content-extension-diagram__source')?.classList.add('content-extension-diagram__source--fallback')
    } catch (error) {
      if (!signal.aborted) remoteError(figure, error instanceof Error ? error.message : 'The diagram could not be rendered.')
    }
  }
  button.addEventListener('click', load, { once: true })
  return () => {
    button.removeEventListener('click', load)
    if (image) {
      image.src = ''
      image.remove()
    }
  }
}

const parseSafeMermaidSvg = (document: Document, source: string): SVGElement => {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const svg = parsed.documentElement
  if (svg.tagName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) throw new Error('Mermaid returned invalid SVG.')
  if (svg.querySelector('a, foreignObject, iframe, image, script, use')) throw new Error('Mermaid returned active SVG content.')
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) throw new Error('Mermaid returned an event handler.')
      if ((name === 'href' || name === 'xlink:href') && !attribute.value.startsWith('#')) {
        throw new Error('Mermaid returned an external reference.')
      }
      if (name === 'style' && (/@import/i.test(attribute.value) || /url\((?!["']?#)/i.test(attribute.value))) {
        throw new Error('Mermaid returned an external style reference.')
      }
    }
    if (element.tagName.toLowerCase() === 'style' && (/@import/i.test(element.textContent ?? '') || /url\((?!["']?#)/i.test(element.textContent ?? ''))) {
      throw new Error('Mermaid returned an external stylesheet reference.')
    }
  }
  return document.importNode(svg, true) as unknown as SVGElement
}

const hydrateMermaid = async (figure: HTMLElement, signal: AbortSignal): Promise<void> => {
  const output = figure.querySelector<HTMLElement>('.content-extension-diagram__output')
  const sourceElement = output?.querySelector<HTMLElement>('.content-extension-diagram__source code')
  if (!output || !sourceElement) return
  const source = sourceElement.textContent ?? ''
  const requestedTheme = figure.dataset.diagramTheme ?? 'auto'
  const theme = requestedTheme === 'auto' ? (figure.closest('.theme--dark') ? 'dark' : 'default') : requestedTheme
  const id = `content-extension-diagram-${++diagramInstance}`
  const drawing = mermaidQueue.then(async () => {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: theme as 'default' })
    return await mermaid.render(id, source)
  })
  mermaidQueue = drawing.then(() => {}, () => {})
  try {
    const { svg } = await drawing
    if (signal.aborted) return
    const safeSvg = parseSafeMermaidSvg(figure.ownerDocument, svg)
    safeSvg.setAttribute('role', 'img')
    safeSvg.setAttribute('aria-label', figure.querySelector('figcaption')?.textContent?.trim() || 'Mermaid diagram')
    output.replaceChildren(safeSvg)
  } catch {
    if (signal.aborted) return
    const status = figure.ownerDocument.createElement('p')
    status.className = 'content-extension-diagram__error'
    status.setAttribute('role', 'alert')
    status.textContent = 'Diagram could not be rendered locally. Its source remains available below.'
    output.prepend(status)
  }
}

export const hydrateContentExtensions = (
  root: ParentNode,
  fetchImpl: FetchLike = fetch
): Cleanup => {
  const controller = new AbortController()
  const cleanups: Cleanup[] = []
  for (const gallery of root.querySelectorAll<HTMLElement>('.content-extension--gallery')) cleanups.push(galleryCleanup(gallery))
  for (const tabs of root.querySelectorAll<HTMLElement>('.content-extension--tabs')) cleanups.push(tabsCleanup(tabs))
  for (const spoiler of root.querySelectorAll<HTMLElement>('.content-extension--spoiler')) cleanups.push(spoilerCleanup(spoiler))
  for (const pdf of root.querySelectorAll<HTMLElement>('.content-extension--pdf')) cleanups.push(pdfCleanup(pdf))
  for (const youtube of root.querySelectorAll<HTMLElement>('.content-extension--youtube')) cleanups.push(youtubeCleanup(youtube))
  for (const map of root.querySelectorAll<HTMLElement>('.content-extension--map')) cleanups.push(mapCleanup(map))
  for (const kroki of root.querySelectorAll<HTMLElement>('.content-extension--kroki')) cleanups.push(remoteDiagramCleanup(kroki, 'kroki', controller.signal))
  for (const plantuml of root.querySelectorAll<HTMLElement>('.content-extension--plantuml')) cleanups.push(remoteDiagramCleanup(plantuml, 'plantuml', controller.signal))
  for (const diagram of root.querySelectorAll<HTMLElement>('.content-extension--diagram')) void hydrateMermaid(diagram, controller.signal)
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
