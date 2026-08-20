import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true, typographer: false })
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]?.attrSet('rel', 'noopener noreferrer')
  tokens[index]?.attrSet('target', '_blank')
  return renderer.renderToken(tokens, index, options)
}

export const renderSafeMarkdown = (content: string): string => DOMPurify.sanitize(markdown.render(content), {
  ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
  ALLOWED_ATTR: ['href', 'rel', 'target']
})
