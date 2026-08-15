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
    if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 1 || typeof title !== 'string' || title.length > 255) {
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
    return { id, title, description, path, href, updatedAt }
  })
}

export const hydratePageIndex = async (
  element: HTMLElement,
  fetchImpl: FetchLike,
  signal: AbortSignal
): Promise<void> => {
  try {
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
  } catch {
    if (signal.aborted) return
    element.setAttribute('aria-busy', 'false')
    const status = element.querySelector<HTMLElement>('.content-extension-index__status')
    if (status) status.textContent = 'Page index is temporarily unavailable.'
  }
}
