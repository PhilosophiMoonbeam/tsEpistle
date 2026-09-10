import DOMPurify from 'dompurify'
import MarkdownIt, { type Env, type Token } from 'markdown-it'

export interface SafeMarkdownCitation {
  readonly evidenceId?: string
  readonly number: number
  readonly label: string
  readonly href: string | null
}

export interface SafeMarkdownFenceMetadata {
  readonly language: string
  readonly info: string
  readonly source: string
  readonly kind: 'fence' | 'code-block'
}

export type SafeMarkdownCitationResolver = (evidenceId: string) => SafeMarkdownCitation | null
export type SafeMarkdownFenceAttributes = Readonly<Record<string, string | number | boolean | null | undefined>>

export interface SafeMarkdownOptions {
  readonly resolveCitation?: SafeMarkdownCitationResolver
  readonly streaming?: boolean
  readonly fenceMetadata?: (metadata: SafeMarkdownFenceMetadata) => SafeMarkdownFenceAttributes | null | undefined
}

interface MarkdownEnvironment extends Env {
  readonly safeMarkdown?: SafeMarkdownOptions
}

const citationMarker = /^\[\[cite:([^\]\s]{1,128})\]\]/
const incompleteCitationMarker = /\[\[cite:[^\]\s]{0,128}\]?$/
const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true, typographer: false })

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

const safeCitationHref = (href: string | null | undefined): string | null => {
  if (!href || containsControlCharacter(href) || href.startsWith('//')) return null
  try {
    const url = new URL(href, 'https://wiki.invalid')
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return href
  } catch {
    return null
  }
}

const safeLanguage = (info: string): string => {
  const language = info.trim().split(/\s+/, 1)[0] ?? ''
  return /^[a-z0-9][a-z0-9_+.-]{0,31}$/i.test(language) ? language.toLowerCase() : 'text'
}

const safeFenceAttributes = (attributes: SafeMarkdownFenceAttributes | null | undefined): string => {
  if (!attributes) return ''
  const allowlist = new Set(['data-language', 'data-fence-id', 'data-diagram'])
  return Object.entries(attributes)
    .flatMap(([name, value]) => {
      if (!allowlist.has(name) || value === null || value === undefined || value === false) return []
      const normalized = value === true ? 'true' : String(value)
      if (name === 'data-language' && !/^[a-z0-9][a-z0-9_+.-]{0,31}$/i.test(normalized)) return []
      if (name !== 'data-language' && (containsControlCharacter(normalized) || normalized.includes('"'))) return []
      return [` ${name}="${escapeHtml(normalized)}"`]
    })
    .join('')
}

const renderCitationAttributes = (citation: SafeMarkdownCitation): string => {
  const attributes = [`data-agent-citation="true"`, `data-citation-number="${escapeHtml(String(citation.number))}"`]
  if (citation.evidenceId) attributes.push(`data-citation-id="${escapeHtml(citation.evidenceId)}"`)
  return attributes.join(' ')
}

const isSafeMarkdownCitation = (value: unknown): value is SafeMarkdownCitation => {
  if (typeof value !== 'object' || value === null) return false
  if (!('number' in value) || typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number < 1) return false
  if (!('label' in value) || typeof value.label !== 'string') return false
  if (!('href' in value) || (value.href !== null && typeof value.href !== 'string')) return false
  return !('evidenceId' in value) || value.evidenceId === undefined || typeof value.evidenceId === 'string'
}

markdown.inline.ruler.before('text', 'agent_citation', (state, silent) => {
  const match = state.src.slice(state.pos).match(citationMarker)
  if (!match) return false
  const resolver = (state.env as MarkdownEnvironment | undefined)?.safeMarkdown?.resolveCitation
  if (!resolver) return false
  const citation = resolver(match[1])
  if (!citation || !Number.isSafeInteger(citation.number) || citation.number < 1) return false
  if (silent) return true
  const token = state.push('agent_citation', 'a', 0)
  token.meta = {
    ...citation,
    href: safeCitationHref(citation.href)
  }
  state.pos += match[0].length
  return true
})

markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]?.attrSet('rel', 'noopener noreferrer')
  tokens[index]?.attrSet('target', '_blank')
  return renderer.renderToken(tokens, index, options)
}
markdown.renderer.rules.agent_citation = (tokens, index) => {
  const citation = tokens[index]?.meta
  if (!isSafeMarkdownCitation(citation)) return ''
  const attrs = renderCitationAttributes(citation)
  const label = `Citation ${citation.number}: ${citation.label}`
  if (!citation.href) return `<strong ${attrs} aria-label="${escapeHtml(label)}">[${escapeHtml(String(citation.number))}]</strong>`
  return `<a ${attrs} href="${escapeHtml(citation.href)}" rel="noopener noreferrer" target="_blank" aria-label="${escapeHtml(`${label} (opens in a new tab)`)}">${escapeHtml(String(citation.number))}</a>`
}

const addFenceMetadata = (rendered: string, options: SafeMarkdownOptions | undefined, metadata: SafeMarkdownFenceMetadata): string => {
  const attrs = safeFenceAttributes(options?.fenceMetadata?.(metadata))
  return attrs ? rendered.replace(/^<pre(?=[\s>])/, `<pre${attrs}`) : rendered
}

const defaultFenceRenderer = markdown.renderer.rules.fence
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  const metadata: SafeMarkdownFenceMetadata = {
    language: safeLanguage(token?.info ?? ''),
    info: token?.info ?? '',
    source: token?.content ?? '',
    kind: 'fence'
  }
  const rendered = defaultFenceRenderer ? defaultFenceRenderer(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options)
  return addFenceMetadata(rendered, (env as MarkdownEnvironment | undefined)?.safeMarkdown, metadata)
}

const defaultCodeBlockRenderer = markdown.renderer.rules.code_block
markdown.renderer.rules.code_block = (tokens, index, options, env, renderer) => {
  const token = tokens[index]
  const metadata: SafeMarkdownFenceMetadata = {
    language: 'text',
    info: '',
    source: token?.content ?? '',
    kind: 'code-block'
  }
  const rendered = defaultCodeBlockRenderer ? defaultCodeBlockRenderer(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options)
  return addFenceMetadata(rendered, (env as MarkdownEnvironment | undefined)?.safeMarkdown, metadata)
}

const trimTrailingStreamingMarker = (tokens: readonly Token[]): void => {
  let inlineIndex = -1
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type === 'inline') {
      inlineIndex = index
      break
    }
  }
  if (inlineIndex < 0 || tokens.slice(inlineIndex + 1).some(token => token.type === 'inline' || token.type === 'fence' || token.type === 'code_block')) return
  const children = tokens[inlineIndex]?.children
  if (!children) return
  const last = children.at(-1)
  if (last?.type !== 'text' || !incompleteCitationMarker.test(last.content ?? '')) return
  last.content = (last.content ?? '').replace(incompleteCitationMarker, '')
}

export const renderSafeMarkdown = (content: string, options?: SafeMarkdownOptions): string => {
  const environment: MarkdownEnvironment = { safeMarkdown: options }
  const tokens = markdown.parse(content, environment)
  if (options?.streaming) trimTrailingStreamingMarker(tokens)
  const rendered = markdown.renderer.render(tokens, markdown.options, environment)
  return DOMPurify.sanitize(rendered, {
    ALLOW_DATA_ATTR: false,
    ALLOWED_TAGS: [
      'a',
      'blockquote',
      'br',
      'code',
      'del',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'li',
      'ol',
      'p',
      'pre',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul'
    ],
    ALLOWED_ATTR: [
      'aria-label',
      'data-agent-citation',
      'data-citation-id',
      'data-citation-number',
      'data-diagram',
      'data-fence-id',
      'data-language',
      'href',
      'rel',
      'target',
      'title'
    ]
  })
}
