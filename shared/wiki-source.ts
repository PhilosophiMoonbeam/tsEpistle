import { z } from 'zod'

export const WikiSourceSchema = z.object({
  id: z.number().int().positive(),
  locale: z.string().min(1).max(35),
  path: z.string().min(1).max(1024),
  title: z.string(),
  description: z.string(),
  visibility: z.enum(['public', 'private']),
  updatedAt: z.string(),
  sourceRevision: z.string(),
  excerpt: z.string().max(2400),
  excerptTruncated: z.boolean()
})
export type WikiSource = z.infer<typeof WikiSourceSchema>

/** Preview-only transport; never persist rendered markup in a citation or agent source. */
export const WikiSourcePreviewSchema = WikiSourceSchema.extend({
  structuredExcerpt: z.object({
    html: z.string().max(24000),
    truncated: z.boolean()
  })
})
export type WikiSourcePreview = z.infer<typeof WikiSourcePreviewSchema>

/** The reader uses the repository's DOMPurify HTML policy, narrowed to passive prose. */
export const wikiSourcePreviewSanitizerPolicy = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'div',
    'span',
    'section',
    'article',
    'main',
    'figure',
    'figcaption',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'del',
    'mark',
    'small',
    'sub',
    'sup',
    'abbr',
    'blockquote',
    'pre',
    'code',
    'ul',
    'ol',
    'li',
    'dl',
    'dt',
    'dd',
    'hr',
    'a',
    'table',
    'caption',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td'
  ],
  ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'scope', 'id', 'headers', 'start', 'value', 'reversed', 'hidden', 'aria-hidden'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_NAMESPACES: ['http://www.w3.org/1999/xhtml'],
  ADD_FORBID_CONTENTS: [
    'svg',
    'math',
    'iframe',
    'object',
    'embed',
    'template',
    'script',
    'style',
    'audio',
    'video',
    'picture',
    'form',
    'button',
    'textarea',
    'select'
  ]
}

/** Relative links resolve against the canonical locale/private page, not the overlay URL. */
export const wikiSourcePreviewLink = (href: string, pageHref: string): string | null => {
  if (!href || href.length > 2048) return null
  for (let index = 0; index < href.length; index++) {
    const code = href.charCodeAt(index)
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null
  }
  try {
    const base = 'https://wiki-preview.invalid'
    const url = new URL(href, `${base}${pageHref}`)
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) return null
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : url.href
  } catch {
    return null
  }
}
export type WikiSourceSelector = { id: number } | { locale: string; path: string; visibility: 'public' | 'private' }

export const wikiSourceHref = (source: Pick<WikiSource, 'locale' | 'path' | 'visibility'>): string =>
  `${source.visibility === 'private' ? '/_private' : ''}/${encodeURIComponent(source.locale)}/${source.path.split('/').map(encodeURIComponent).join('/')}`

export const wikiSourceSelectorFromHref = (href: string, origin: string): WikiSourceSelector | null => {
  try {
    const url = new URL(href, origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const visibility = segments[0] === '_private' ? 'private' : 'public'
    if (visibility === 'private') segments.shift()
    const locale = segments.shift()
    const path = segments.join('/')
    if (!locale || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale) || !path || path.length > 1024) return null
    return { locale, path, visibility }
  } catch {
    return null
  }
}
