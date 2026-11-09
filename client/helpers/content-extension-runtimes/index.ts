import { watchEffect } from 'vue'
import moment from 'moment-timezone'
import { helpers } from '../index.ts'
import { sameOriginJsonFetch } from '../json-transport.ts'
import { tagColorBucket } from '../../../shared/tag-colors.ts'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type PageIndexItem = {
  id: number
  title: string
  description: string | null
  path: string
  href: string
  updatedAt: string
  tags: string[]
  pageAccent: string | null
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
    const tags = Reflect.get(input, 'tags') ?? []
    const rawAccent = Reflect.get(input, 'pageAccent')
    const pageAccent = typeof rawAccent === 'string' && /^#[0-9a-f]{6}$/i.test(rawAccent) ? rawAccent : null
    if (!Array.isArray(tags) || tags.length > 100 || tags.some(tag => typeof tag !== 'string' || tag.length === 0 || tag.length > 255)) {
      throw new TypeError(`Page index item ${index} has invalid tags.`)
    }
    if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 1 || typeof title !== 'string' || title.length > 255) {
      throw new TypeError(`Page index item ${index} has invalid identity fields.`)
    }
    if (description !== null && (typeof description !== 'string' || description.length > 1000)) {
      throw new TypeError(`Page index item ${index} has an invalid description.`)
    }
    if (typeof path !== 'string' || path.length > 512 || typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) {
      throw new TypeError(`Page index item ${index} has an invalid route.`)
    }
    if (typeof updatedAt !== 'string' || updatedAt.length > 100) {
      throw new TypeError(`Page index item ${index} has an invalid update timestamp field.`)
    }
    return { id, title, description, path, href, updatedAt, tags, pageAccent }
  })
}

export const hydratePageIndex = async (element: HTMLElement, fetchImpl: FetchLike, signal: AbortSignal): Promise<void> => {
  try {
    const query = new URLSearchParams({
      path: element.dataset.indexPath ?? '',
      locale: element.dataset.indexLocale ?? '',
      depth: element.dataset.indexDepth ?? '0',
      order: element.dataset.indexOrder ?? 'path',
      limit: element.dataset.indexLimit ?? '50'
    })
    const response = await sameOriginJsonFetch(fetchImpl, `/_api/content-extensions/index?${query}`, {
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
    const showTags = element.dataset.indexShowTags === 'true'
    const showPageAccent = element.dataset.indexShowPageAccent === 'true'
    const showUpdatedAt = element.dataset.indexShowUpdatedAt === 'true'
    const dates: Array<{ element: HTMLTimeElement; value: string }> = []
    for (const item of items) {
      const listItem = element.ownerDocument.createElement('li')
      listItem.className = 'content-extension-index__item'
      const link = element.ownerDocument.createElement('a')
      link.className = 'content-extension-index__link'
      link.href = item.href
      if (showPageAccent) {
        link.classList.add('content-extension-index__link--page-accent')
        if (item.pageAccent) link.style.setProperty('--index-page-accent', item.pageAccent)
      }
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
      if (showUpdatedAt) {
        // A date without an explicit offset is not an instant. Never invent UTC
        // or the reader's zone for incomplete server metadata.
        const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.updatedAt)
          ? moment.parseZone(item.updatedAt, moment.ISO_8601, true)
          : null
        if (instant?.isValid()) {
          const time = element.ownerDocument.createElement('time')
          time.className = 'content-extension-index__updated-at'
          time.dateTime = instant.toISOString()
          copy.append(time)
          dates.push({ element: time, value: item.updatedAt })
        } else {
          const unavailable = element.ownerDocument.createElement('span')
          unavailable.className = 'content-extension-index__updated-at'
          unavailable.textContent = 'Update time unavailable'
          copy.append(unavailable)
        }
      }
      if (showTags && item.tags.length > 0) {
        const tags = element.ownerDocument.createElement('span')
        tags.className = 'content-extension-index__tags'
        for (const tag of item.tags) {
          const chip = element.ownerDocument.createElement('bdi')
          chip.className = 'content-extension-index__tag wiki-tag-color'
          chip.dataset.tagColor = tagColorBucket(tag)
          chip.textContent = tag
          tags.append(chip)
        }
        copy.append(tags)
      }
      link.append(copy)
      listItem.append(link)
      list.append(listItem)
    }
    element.append(list)
    if (dates.length > 0) {
      const stop = watchEffect(() => {
        for (const date of dates) {
          const label = helpers.formatMoment(date.value, 'L LT')
          date.element.textContent = typeof label === 'string' && label ? label : 'Update time unavailable'
        }
      })
      signal.addEventListener('abort', () => stop(), { once: true })
    }
  } catch {
    if (signal.aborted) return
    element.setAttribute('aria-busy', 'false')
    const status = element.querySelector<HTMLElement>('.content-extension-index__status')
    if (status) status.textContent = 'Page index is temporarily unavailable.'
  }
}
