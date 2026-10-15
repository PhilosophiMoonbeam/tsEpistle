import type { GlossaryAutolinkTerm } from '../../shared/glossary.ts'

const excluded =
  'a,form,fieldset,button,input,textarea,select,option,label,summary,details,[contenteditable],h1,h2,h3,h4,h5,h6,pre,code,kbd,samp,script,style,template,svg,math,canvas,video,audio,iframe,object,embed,picture,figure,.mermaid,.plantuml,.katex,.MathJax,[class*="content-extension--"],[data-content-extension],[data-wiki-extension],[data-glossary-owned],[data-annotation-ui]'
const word = /[\p{L}\p{N}\p{M}_]/u
const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function glossaryHref(href: string, name: string | null): string {
  const url = new URL(href)
  if (name === null) url.searchParams.delete('glossary')
  else url.searchParams.set('glossary', name)
  return `${url.pathname}${url.search}${url.hash}`
}
function allowed(node: Text, root: HTMLElement): boolean {
  let parent = node.parentElement
  while (parent) {
    if (parent.matches(excluded) || parent.localName.includes('-')) return false
    if (parent === root) return true
    parent = parent.parentElement
  }
  return false
}
const blocks = 'p,li,td,th,div,section,article,blockquote,dd,dt,br,hr,h1,h2,h3,h4,h5,h6,pre,figure,ul,ol,table'
function adjacentCharacter(node: Text, root: HTMLElement, previous: boolean): string {
  let current: Node = node
  while (current !== root) {
    let sibling = previous ? current.previousSibling : current.nextSibling
    while (sibling) {
      if (sibling instanceof Element && (sibling.matches(blocks) || sibling.localName.includes('-'))) return ''
      const text = sibling.textContent ?? ''
      if (text) return previous ? Array.from(text).at(-1)! : Array.from(text)[0]!
      sibling = previous ? sibling.previousSibling : sibling.nextSibling
    }
    const parent = current.parentElement
    if (!parent || parent === root || parent.matches(blocks)) return ''
    current = parent
  }
  return ''
}
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** Keep offsets in original UTF-16 even when a composed character has a different NFC length. */
function normalized(source: string): { text: string; starts: number[]; ends: number[] } {
  let text = ''
  const starts: number[] = [],
    ends: number[] = []
  for (const match of graphemes.segment(source)) {
    const value = match.segment.normalize('NFC')
    text += value
    for (let index = 0; index < value.length; index++) {
      starts.push(match.index)
      ends.push(match.index + match.segment.length)
    }
  }
  return { text, starts, ends }
}
type Match = { start: number; end: number; id: number; term: string; label?: string; explicit?: boolean }
/** DOM-only decoration. Cleanup restores the very same original Text nodes, never canonical HTML/source. */
export function linkGlossaryContent(root: HTMLElement, terms: readonly GlossaryAutolinkTerm[], href = window.location.href): () => void {
  const nodes: Text[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) if (walker.currentNode instanceof Text && allowed(walker.currentNode, root)) nodes.push(walker.currentNode)
  const matches: Array<{ node: Text; matches: Match[] }> = []
  const automatic: Array<Match & { node: Text; order: number; length: number }> = []
  for (const [order, node] of nodes.entries()) {
    const local: Match[] = []
    for (const match of node.data.matchAll(/\[\[Glossary:([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/giu)) {
      local.push({ start: match.index, end: match.index + match[0].length, id: 0, term: match[1]!.trim(), label: match[2] ?? match[1], explicit: true })
    }
    matches.push({ node, matches: local })
    const source = normalized(node.data)
    for (const term of terms) {
      for (const name of [term.term, ...term.aliases]) {
        if (!name.trim()) continue
        const expression = new RegExp(escapePattern(name.normalize('NFC').trim()).replace(/\s+/gu, '\\s+'), term.caseSensitive ? 'gu' : 'giu')
        for (const match of source.text.matchAll(expression)) {
          const before = Array.from(source.text.slice(Math.max(0, match.index - 2), match.index)).at(-1) ?? adjacentCharacter(node, root, true)
          const after =
            Array.from(source.text.slice(match.index + match[0].length, match.index + match[0].length + 2))[0] ?? adjacentCharacter(node, root, false)
          if ((word.test(Array.from(match[0])[0] ?? '') && word.test(before)) || (word.test(Array.from(match[0]).at(-1) ?? '') && word.test(after))) continue
          const start = source.starts[match.index]!,
            end = source.ends[match.index + match[0].length - 1]!
          if (local.some(item => start < item.end && end > item.start)) continue
          automatic.push({
            node,
            order,
            start,
            end,
            id: term.id,
            term: term.term,
            length: Array.from(name.normalize('NFC').trim().replace(/\s+/gu, ' ')).length
          })
        }
      }
    }
  }
  automatic.sort((a, b) => b.length - a.length || a.order - b.order || a.start - b.start || a.id - b.id)
  const used = new Set<number>()
  const byNode = new Map(matches.map(item => [item.node, item.matches]))
  for (const match of automatic) {
    const local = byNode.get(match.node)!
    if (used.has(match.id) || local.some(item => match.start < item.end && match.end > item.start)) continue
    used.add(match.id)
    local.push(match)
  }
  const decorated: Array<{ wrapper: HTMLElement; node: Text }> = []
  for (const { node, matches: local } of matches) {
    if (!local.length || !node.parentNode) continue
    local.sort((a, b) => a.start - b.start)
    const wrapper = root.ownerDocument.createElement('span')
    wrapper.dataset.glossaryOwned = 'true'
    let position = 0
    for (const match of local) {
      wrapper.append(node.data.slice(position, match.start))
      const anchor = root.ownerDocument.createElement('a')
      anchor.href = glossaryHref(href, match.term)
      anchor.textContent = match.label ?? node.data.slice(match.start, match.end)
      anchor.setAttribute('aria-label', `Glossary: ${match.term}`)
      wrapper.append(anchor)
      position = match.end
    }
    wrapper.append(node.data.slice(position))
    node.replaceWith(wrapper)
    decorated.push({ wrapper, node })
  }
  return () => {
    for (const { wrapper, node } of decorated) if (wrapper.parentNode) wrapper.replaceWith(node)
  }
}

export function glossaryQueryLink(anchor: HTMLAnchorElement, currentHref: string): string | null | undefined {
  const current = new URL(currentHref),
    target = new URL(anchor.href, current)
  if (target.origin !== current.origin || target.pathname !== current.pathname || !target.searchParams.has('glossary')) return undefined
  return target.searchParams.get('glossary')
}
