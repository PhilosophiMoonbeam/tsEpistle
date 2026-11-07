import type { MarkdownIt } from 'markdown-it'

/** Decode only complete encoded quote paragraphs, never literal code or mixed Markdown. */
export const mapEncodedAgentQuotationParagraphs = (content: string, markdown: MarkdownIt, render: (text: string) => string): string => {
  if (!content.includes('> &#')) return content
  const lines = content.split('\n')
  let changed = false
  for (const token of markdown.parse(content, {})) {
    if (token.type !== 'inline' || token.map === null || token.map[1] !== token.map[0] + 1 ||
      !/^(?:&#[0-9]+;)+$/u.test(token.content) || token.children?.length !== 1 || token.children[0]?.type !== 'text') continue
    const index = token.map[0]
    const line = lines[index]
    if (line !== `> ${token.content}` && line !== `> ${token.content}\r`) continue
    lines[index] = `${render(token.children[0].content)}${line.endsWith('\r') ? '\r' : ''}`
    changed = true
  }
  return changed ? lines.join('\n') : content
}
