import type { MarkdownIt, Token } from 'markdown-it'

export const QUOTE_BYLINE_CLASS = 'quote-attribution'
export const QUOTE_AUTHOR_ATTRIBUTE = 'data-quote-author'

export function normalizeQuoteAuthor(value: unknown): string | null {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) return null
  return value.trim() || null
}

/** Only marker delimiters are escaped; the author is otherwise literal text. */
export function parseQuoteAttribution(source: string): { author: string; body: string } | null {
  if (!source.startsWith('[name=')) return null
  let name = ''
  for (let index = 6; index < source.length; index += 1) {
    const character = source[index]!
    if (character === '\r' || character === '\n') return null
    if (character === '\\' && (source[index + 1] === '\\' || source[index + 1] === ']')) {
      name += source[index + 1]
      index += 1
    } else if (character === ']') {
      const author = normalizeQuoteAuthor(name)
      return author ? { author, body: source.slice(index + 1).replace(/^[ \t]*(?:\n)?/u, '') } : null
    } else {
      name += character
    }
  }
  return null
}

export function serializeQuoteAttribution(author: string): string {
  return `[name=${author.replace(/([\\\]])/gu, '\\$1')}]`
}

/** Extract before inline parsing so HTML, Markdown, links and typography never touch the name. */
export default function markdownItQuoteAttribution(markdown: MarkdownIt): void {
  markdown.core.ruler.before('inline', 'quote_attribution', state => {
    const quotes: Array<{ token: Token; seenParagraph: boolean; author: string | null }> = []
    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index]!
      if (token.type === 'blockquote_open') {
        quotes.push({ token, seenParagraph: false, author: null })
        continue
      }
      const quote = quotes.at(-1)
      if (!quote) continue
      if (token.type === 'blockquote_close') {
        if (quote.author) token.meta = { ...token.meta, quoteAuthor: quote.author }
        quotes.pop()
        continue
      }
      if (token.type !== 'paragraph_open' || token.level !== quote.token.level + 1 || quote.seenParagraph) continue
      quote.seenParagraph = true
      const inline = state.tokens[index + 1]
      if (inline?.type !== 'inline') continue
      const attribution = parseQuoteAttribution(inline.content)
      if (!attribution) continue
      quote.author = attribution.author
      quote.token.attrSet(QUOTE_AUTHOR_ATTRIBUTE, attribution.author)
      quote.token.meta = { ...quote.token.meta, quoteAttributionLine: inline.map?.[0] }
      inline.content = attribution.body
      if (!inline.content) {
        // A marker-only paragraph is metadata, not an empty quoted paragraph.
        state.tokens.splice(index, 3)
        index -= 1
      }
    }
  })

  const renderClose = markdown.renderer.rules.blockquote_close
  markdown.renderer.rules.blockquote_close = (tokens, index, options, env, renderer) => {
    const author = tokens[index]?.meta?.quoteAuthor
    const byline = typeof author === 'string' ? `<p class="${QUOTE_BYLINE_CLASS}"><span>${markdown.utils.escapeHtml(author)}</span></p>\n` : ''
    return byline + (renderClose ? renderClose(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options))
  }
}
