import type { MarkdownIt, Token } from 'markdown-it'

const ADMONITION_MARKER = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):[ \t]+(.+)$/
const ADMONITION_CLASS: Record<string, string> = {
  NOTE: 'is-info',
  TIP: 'is-success',
  IMPORTANT: 'is-info',
  WARNING: 'is-warning',
  CAUTION: 'is-danger'
}

const meaningfulChildren = (token: Token): Token[] =>
  token.children?.filter(child => child.type !== 'text' || child.content.length > 0) ?? []
const firstTextChild = (token: Token): Token | undefined =>
  meaningfulChildren(token).find(child => child.type === 'text')
const isStrongTitle = (token: Token): boolean => {
  const children = meaningfulChildren(token)
  return children[0]?.type === 'strong_open' && children.at(-1)?.type === 'strong_close'
}

export function installAdmonitionRule (markdown: MarkdownIt): void {
  markdown.core.ruler.after('inline', 'wiki_admonitions', state => {
    for (let index = 0; index < state.tokens.length - 2; index += 1) {
      const quote = state.tokens[index]
      const paragraph = state.tokens[index + 1]
      const inline = state.tokens[index + 2]
      if (quote?.type !== 'blockquote_open' || paragraph?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
      if (!isStrongTitle(inline)) continue

      const markerText = firstTextChild(inline)
      const match = markerText?.content.match(ADMONITION_MARKER)
      if (!match || !markerText) continue
      const kind = match[1]!
      const title = match[2]!.trim()
      quote.attrJoin('class', `admonition ${ADMONITION_CLASS[kind]}`)
      paragraph.attrJoin('class', 'admonition__title')
      inline.content = title
      markerText.content = title
    }
  })
}
