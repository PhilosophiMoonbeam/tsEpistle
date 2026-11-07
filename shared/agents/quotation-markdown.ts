import type { MarkdownIt } from 'markdown-it'

/** Only this complete numeric-only wrapper is an inert code quotation, not general HTML. */
const decodeCodeQuotation = (content: string): string | null => {
  const match = /^<pre><code>((?:&#[0-9]+;)*)<\/code><\/pre>$/u.exec(content)
  if (match === null) return null
  let decoded = ''
  for (const entity of match[1]!.matchAll(/&#([0-9]+);/gu)) {
    const code = Number(entity[1])
    if (!Number.isSafeInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
    decoded += String.fromCodePoint(code)
  }
  return decoded
}

/** Decode after block normalization into an ordinary escaped code token, never executable HTML. */
export const installAgentCodeQuotationRule = (markdown: MarkdownIt): void => {
  markdown.core.ruler.before('inline', 'agent_code_quotation', state => {
    const tokens = state.tokens
    for (let index = 1; index + 3 < tokens.length; index++) {
      const open = tokens[index]!
      const inline = tokens[index + 1]!
      if (
        tokens[index - 1]!.type !== 'blockquote_open' ||
        open.type !== 'paragraph_open' ||
        inline.type !== 'inline' ||
        inline.map === null ||
        inline.map[1] !== inline.map[0] + 1 ||
        tokens[index + 2]!.type !== 'paragraph_close' ||
        tokens[index + 3]!.type !== 'blockquote_close'
      )
        continue
      const text = decodeCodeQuotation(inline.content)
      if (text === null) continue
      open.type = 'fence'
      open.tag = 'code'
      open.nesting = 0
      open.content = text
      open.info = 'text'
      open.markup = '```'
      open.hidden = false
      tokens.splice(index + 1, 2)
    }
  })
}

/** Decode only complete encoded quote paragraphs, never literal code or mixed Markdown. */
export const mapEncodedAgentQuotationParagraphs = (
  content: string,
  markdown: MarkdownIt,
  render: (text: string) => string,
  renderCode?: (text: string) => string
): string => {
  if (!content.includes('> &#') && (renderCode === undefined || !content.includes('> <pre><code>'))) return content
  const lines = content.split('\n')
  let changed = false
  for (const token of markdown.parse(content, {})) {
    if (token.type !== 'inline' || token.map === null || token.map[1] !== token.map[0] + 1) continue
    const index = token.map[0]
    const line = lines[index]
    if (line !== `> ${token.content}` && line !== `> ${token.content}\r`) continue
    const code = renderCode === undefined ? null : decodeCodeQuotation(token.content)
    if (code !== null) {
      lines[index] = `${renderCode!(code)}${line.endsWith('\r') ? '\r' : ''}`
    } else {
      if (!/^(?:&#[0-9]+;)+$/u.test(token.content) || token.children?.length !== 1 || token.children[0]?.type !== 'text') continue
      lines[index] = `${render(token.children[0].content)}${line.endsWith('\r') ? '\r' : ''}`
    }
    changed = true
  }
  return changed ? lines.join('\n') : content
}
