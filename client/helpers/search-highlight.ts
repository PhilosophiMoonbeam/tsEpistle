import { visibleQueryTerms } from '../../shared/search-query.ts'

export type SearchTextSegment = {
  text: string
  matched: boolean
}

/** Return original text slices; consumers render them as Vue text nodes, including markup. */
export const createSearchHighlighter = (query: string, structured = true): ((text: string) => SearchTextSegment[]) => {
  const terms = [...new Set(visibleQueryTerms(query, structured))].sort((left, right) => right.length - left.length)
  const pattern = terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'giu') : null

  return (text: string): SearchTextSegment[] => {
    if (!pattern || !text) return [{ text, matched: false }]
    const segments: SearchTextSegment[] = []
    let offset = 0
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > offset) segments.push({ text: text.slice(offset, match.index), matched: false })
      segments.push({ text: match[0], matched: true })
      offset = match.index + match[0].length
    }
    if (offset < text.length) segments.push({ text: text.slice(offset), matched: false })
    return segments
  }
}
