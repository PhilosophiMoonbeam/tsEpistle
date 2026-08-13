import type { MarkdownIt, RendererRule } from 'markdown-it'

const renderEm: RendererRule = (tokens, idx, opts, _env, renderer) => {
  const token = tokens[idx]
  if (token?.markup === '_') token.tag = 'u'
  return renderer.renderToken(tokens, idx, opts)
}

export default function markdownItUnderline(md: MarkdownIt): void {
  md.renderer.rules.em_open = renderEm
  md.renderer.rules.em_close = renderEm
}
