import { h, render, type AppContext } from 'vue'
import type { WikiSource } from '../../shared/wiki-source.ts'
import CitedCopyAction from '../components/common/cited-copy-action.vue'

/** Metadata belongs to the admitted rendered revision, never a search/preview fallback. */
export type ReaderCitedCopySource = Omit<WikiSource, 'excerpt' | 'excerptTruncated'>
export type ReaderCitedCopyOptions = Readonly<{
  appContext: AppContext
  identity: string
  /** Nonsecret useId() from the owning page component, not its source/authority identity. */
  hintIdPrefix: string
  source: () => ReaderCitedCopySource | null
  isCurrent: () => boolean
  unavailable: string
}>

const ownedUi = 'script,style,template,noscript,button,input,select,textarea,form,svg,canvas,iframe,object,embed,audio,video,[role="button"],[role="tablist"],[data-reader-cited-copy],[data-annotation-ui],.toolbar,.toc-anchor,.header-anchor,.wiki-cited-copy-sweep,.content-extension-diagram__source,.content-extension-diagram__error,.content-extension-index__status,.glossary-hover-card'
const blockTags: Record<string, true> = { P: true, DIV: true, SECTION: true, ARTICLE: true, BLOCKQUOTE: true, DETAILS: true, SUMMARY: true, PRE: true, UL: true, OL: true, DL: true, DT: true, DD: true, LI: true, TR: true, CAPTION: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true }

/** Inspect the live tree without cloning it or extracting closed disclosure bodies. */
const readable = (element: Element, root: HTMLElement): boolean => {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.matches('[hidden],[inert],[aria-hidden="true"]')) return false
    const style = root.ownerDocument.defaultView?.getComputedStyle(node)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.contentVisibility === 'hidden') return false
    if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = [...node.children].find(child => child.tagName === 'SUMMARY')
      if (!summary || (summary !== element && !summary.contains(element))) return false
    }
    if (node === root) return true
  }
  return false
}

/** Keep visible signs/currency, paragraph/list/table boundaries and preformatted spacing. */
export const readerCitedCopyText = (element: HTMLElement, root: HTMLElement): string => {
  if (!readable(element, root)) return ''
  const walk = (node: Node, preformatted = false): string => {
    if (node.nodeType === Node.TEXT_NODE) return preformatted ? node.nodeValue ?? '' : (node.nodeValue ?? '').replace(/[\t\n\r\f ]+/gu, ' ')
    if (!(node instanceof HTMLElement) || node.matches(ownedUi) || !readable(node, root)) return ''
    if (node.tagName === 'BR') return '\n'
    if (node.tagName === 'HR') return '\n—\n'
    const pre = preformatted || node.tagName === 'PRE' || /^(?:pre|break-spaces)/u.test(root.ownerDocument.defaultView?.getComputedStyle(node).whiteSpace ?? '')
    let text = [...node.childNodes].map(child => walk(child, pre)).join('')
    if (!text.trim()) return ''
    if (node.tagName === 'SUP') text = `^(${text})`
    if (node.tagName === 'SUB') text = `_(${text})`
    if (node.matches('del,s,strike')) text = `~~${text}~~`
    if (node.tagName === 'LI') {
      const list = node.parentElement
      let marker = '•'
      if (list instanceof HTMLOListElement) {
        const items = [...list.children].filter(child => child.tagName === 'LI')
        let ordinal = list.hasAttribute('start') ? list.start : list.reversed ? items.length : 1
        for (const item of items) {
          if (item instanceof HTMLLIElement && item.hasAttribute('value')) ordinal = item.value
          if (item === node) break
          ordinal += list.reversed ? -1 : 1
        }
        marker = `${ordinal}.`
      }
      text = `${marker} ${text.trim()}`
    }
    if (node.matches('td,th')) return `${text.trim()}\t`
    return blockTags[node.tagName] ? `\n${text}\n` : text
  }
  return walk(element).trim()
}

/** One owned, removable sibling action per authored disclosure/callout. No observers or source writes. */
export const hydrateReaderCitedCopy = (root: HTMLElement, options: ReaderCitedCopyOptions): (() => void) => {
  let disposed = false
  let epoch = 0
  const controller = new AbortController()
  const idCounts = new Map<string, number>()
  for (const element of root.ownerDocument.querySelectorAll('[id]')) {
    idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1)
  }
  const surfaces = [...root.querySelectorAll<HTMLElement>('details > summary, blockquote, .admonitionblock')]
    .filter(element => !element.closest('[data-reader-cited-copy],.content-extension-diagram__source'))
    .filter(element => element.tagName !== 'SUMMARY' ||
      [...element.parentElement!.children].find(child => child.tagName === 'SUMMARY') === element)
    .map((element, index) => {
      const disclosure = element.tagName === 'SUMMARY' ? element.parentElement as HTMLDetailsElement : null
      const content = disclosure ?? element
      const owner = root.ownerDocument.createElement('div')
      owner.className = `reader-cited-copy-surface wiki-cited-copy-owner${disclosure ? ' reader-cited-copy-surface--disclosure' : ''}`
      owner.dataset.citedCopyOwner = `${options.hintIdPrefix}-${index}`
      const mount = root.ownerDocument.createElement('div')
      mount.className = 'reader-cited-copy-mount'
      mount.dataset.readerCitedCopy = 'true'
      mount.setAttribute('role', 'group')
      const action = root.ownerDocument.createElement('span')
      const unavailable = root.ownerDocument.createElement('span')
      unavailable.className = 'reader-cited-copy-unavailable'
      unavailable.textContent = options.unavailable
      mount.append(action, unavailable)
      content.before(owner)
      owner.append(content, mount)
      // Only authored, existing unique IDs may become citation fragments.
      const anchor = [element, content].find(candidate => candidate.id && idCounts.get(candidate.id) === 1)?.id
      return { element, disclosure, content, owner, mount, action, unavailable, anchor, hintId: `${options.hintIdPrefix}-${index}` }
    })

  const retire = (): void => {
    epoch++
    for (const surface of surfaces) render(null, surface.action)
  }
  const refresh = (): void => {
    if (disposed) return
    const admitted = options.isCurrent()
    const source = admitted ? options.source() : null
    for (const surface of surfaces) {
      const visible = admitted && root.isConnected && root.contains(surface.content) && readable(surface.element, root)
      surface.mount.hidden = !visible
      if (!visible) { render(null, surface.action); continue }
      // A closed disclosure admits only its visible summary; opening it admits
      // its current visible body as well, still excluding nested closed bodies.
      const target = surface.disclosure?.open ? surface.disclosure : surface.element
      const text = source ? readerCitedCopyText(target, root) : ''
      const canonical: WikiSource | null = source ? {
        ...source, excerpt: text.slice(0, 2400), excerptTruncated: text.length > 2400
      } : null
      surface.unavailable.hidden = canonical !== null
      surface.mount.tabIndex = canonical ? -1 : 0
      surface.mount.title = canonical ? '' : options.unavailable
      if (canonical) surface.mount.removeAttribute('aria-label')
      else surface.mount.setAttribute('aria-label', options.unavailable)
      const vnode = h(CitedCopyAction, {
        key: epoch,
        text,
        source: canonical,
        context: { origin: window.location.origin },
        identity: `${options.identity}:${epoch}:${surface.disclosure?.open ?? ''}`,
        hintId: surface.hintId,
        blockAnchor: surface.anchor
      })
      vnode.appContext = options.appContext
      render(vnode, surface.action)
    }
  }
  // Refresh synchronously before the core component handles activation, so a
  // just-closed disclosure can never contribute its former body to clipboard.
  for (const surface of surfaces) {
    surface.mount.addEventListener('click', event => {
      event.preventDefault()
      refresh()
    }, { capture: true, signal: controller.signal })
  }
  const visibilityAction = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('[data-reader-cited-copy]')) return
    if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key) &&
      !(event.target instanceof Element && event.target.closest('.content-extension-tabs__list') &&
        ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))) return
    retire()
    queueMicrotask(refresh)
  }
  root.addEventListener('click', visibilityAction, { capture: true, signal: controller.signal })
  root.addEventListener('keydown', visibilityAction, { capture: true, signal: controller.signal })
  root.addEventListener('keyup', visibilityAction, { capture: true, signal: controller.signal })
  root.addEventListener('toggle', () => { retire(); refresh() }, { capture: true, signal: controller.signal })
  refresh()
  return () => {
    disposed = true
    controller.abort()
    retire()
    // Inner wrappers first, so nested callouts/disclosures restore in place.
    for (const surface of [...surfaces].reverse()) {
      surface.mount.remove()
      if (surface.content.parentElement === surface.owner) surface.owner.replaceWith(surface.content)
      else surface.owner.remove()
    }
  }
}
