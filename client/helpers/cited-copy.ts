import { wikiSourceHref, wikiSourceSelectorFromHref, type WikiSource } from '../../shared/wiki-source.ts'
import { copyTextToClipboard } from './clipboard.ts'

/** Use window.location.origin, never a page href, query, or user-provided URL. */
export type CitedCopyContext = Readonly<{ origin: string }>

export type CitedCopyInput = Readonly<{
  /** Current authorized visible plain text, not HTML, Markdown source, or DOM textContent. */
  text: string
  source: WikiSource
  context: CitedCopyContext
  /** An existing source block's literal id (not an encoded fragment or scraped href). */
  blockAnchor?: string
}>

export type CitedCopyPayload = Readonly<{ text: string; citationHref: string }>
export type CitedCopyErrorCode = 'invalid-text' | 'invalid-source' | 'clipboard-failed'

export class CitedCopyError extends Error {
  constructor (readonly code: CitedCopyErrorCode) {
    super(code)
    this.name = 'CitedCopyError'
  }
}

// Keep paragraphs, list indentation, tabs/table columns and CRLF exactly as supplied.
// Reject invisible control artifacts rather than silently changing selected text.
const unsafeText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/u
const unsafeLocator = /[\u0000-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/u

/** No DOM extraction or rich flavor: the required text/plain is the only clipboard format. */
export const createCitedCopyPayload = (input: CitedCopyInput): CitedCopyPayload => {
  if (typeof input.text !== 'string' || !input.text.trim() || unsafeText.test(input.text)) {
    throw new CitedCopyError('invalid-text')
  }

  try {
    const origin = new URL(input.context.origin)
    if (
      typeof window === 'undefined' || origin.origin !== window.location.origin ||
      origin.href !== `${origin.origin}/` || input.context.origin !== origin.origin ||
      !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    ) throw new Error('Untrusted origin')

    const source = input.source
    if (
      !source || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(source.locale) ||
      !['public', 'private'].includes(source.visibility) ||
      !source.path || source.path.length > 1024 || unsafeLocator.test(source.path) ||
      source.path.split('/').some(segment => !segment || segment === '.' || segment === '..')
    ) throw new Error('Invalid source')

    const href = wikiSourceHref(source)
    const url = new URL(href, origin.origin)
    const selector = wikiSourceSelectorFromHref(href, origin.origin)
    if (
      !selector || !('locale' in selector) || selector.locale !== source.locale ||
      selector.path !== source.path || selector.visibility !== source.visibility ||
      url.origin !== origin.origin || url.pathname !== href || url.search || url.hash ||
      url.username || url.password
    ) throw new Error('Source did not round-trip')

    if (input.blockAnchor !== undefined) {
      if (!input.blockAnchor || unsafeLocator.test(input.blockAnchor)) throw new Error('Invalid block id')
      url.hash = encodeURIComponent(input.blockAnchor)
    }
    const citationHref = url.href
    return { text: `${input.text}\n\n${citationHref}`, citationHref }
  } catch {
    throw new CitedCopyError('invalid-source')
  }
}

/** Resolves only when the native clipboard or repository legacy fallback reports success. */
export const copyCitedSnippet = async (input: CitedCopyInput): Promise<CitedCopyPayload> => {
  const payload = createCitedCopyPayload(input)
  try {
    await copyTextToClipboard(payload.text)
  } catch {
    throw new CitedCopyError('clipboard-failed')
  }
  return payload
}
