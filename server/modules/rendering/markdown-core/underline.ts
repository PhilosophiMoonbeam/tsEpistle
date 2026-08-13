import type { MarkdownIt, RendererRule } from 'markdown-it'

const renderEm: RendererRule = (tokens, idx, options, _env, renderer) => {
  const token = tokens[idx]
  if (token?.markup === '_') {
    token.tag = 'u'
  }
  return renderer.renderToken(tokens, idx, options)
}

const underline = (md: MarkdownIt): void => {
  md.renderer.rules.em_open = renderEm
  md.renderer.rules.em_close = renderEm
}

export default underline
