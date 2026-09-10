import type { AgentCitation } from '../../../shared/agents/contracts.ts'
import type { SafeMarkdownCitation, SafeMarkdownCitationResolver } from '../../helpers/safe-markdown.ts'

export interface AgentCitationResolution extends SafeMarkdownCitation {
  readonly evidenceId: string
  readonly kind: AgentCitation['kind']
  readonly previewable: boolean
}

const citationMarker = /^\[\[cite:([^\]\s]{1,128})\]\]/
const incompleteCitationMarker = /^\[\[cite:[^\]\s]{0,128}\]?$/

const containsUnsafeCitationHrefCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f || code === 0x22 || code === 0x27) return true
  }
  return false
}

const safeCitationHref = (href: string | null): string | null => {
  if (!href || containsUnsafeCitationHrefCharacter(href) || href.startsWith('//')) return null
  try {
    const url = new URL(href, 'https://wiki.invalid')
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return href
  } catch {
    return null
  }
}

const markdownHref = (href: string): string | null => {
  const safeHref = safeCitationHref(href)
  if (!safeHref) return null
  try {
    return encodeURI(safeHref).replaceAll('(', '%28').replaceAll(')', '%29')
  } catch {
    return null
  }
}

const markdownTitle = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\s+/g, ' ').trim()

const citationFenceAt = (content: string, index: number): { marker: '`' | '~'; length: number } | null => {
  if (index > 0 && content[index - 1] !== '\n') return null
  const match = content.slice(index).match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return null
  return { marker: match[1][0] as '`' | '~', length: match[1].length }
}

const skipFence = (content: string, index: number, fence: { marker: '`' | '~'; length: number }): number => {
  let lineStart = content.indexOf('\n', index)
  if (lineStart < 0) return content.length
  lineStart += 1
  while (lineStart < content.length) {
    const lineEnd = content.indexOf('\n', lineStart)
    const end = lineEnd < 0 ? content.length : lineEnd
    const line = content.slice(lineStart, end)
    const closing = new RegExp(`^[ \t]{0,3}${fence.marker}{${fence.length},}[ \t]*$`).test(line)
    if (closing) return lineEnd < 0 ? content.length : lineEnd + 1
    if (lineEnd < 0) return content.length
    lineStart = lineEnd + 1
  }
  return content.length
}

const skipInlineCode = (content: string, index: number): number => {
  let length = 1
  while (content[index + length] === '`') length += 1
  const marker = '`'.repeat(length)
  const closing = content.indexOf(marker, index + length)
  return closing < 0 ? content.length : closing + length
}

const replaceProseCitationMarkers = (content: string, resolver: SafeMarkdownCitationResolver, streaming: boolean): string => {
  let output = ''
  let index = 0
  while (index < content.length) {
    const fence = citationFenceAt(content, index)
    if (fence) {
      const end = skipFence(content, index, fence)
      output += content.slice(index, end)
      index = end
      continue
    }
    if (content[index] === '`') {
      const end = skipInlineCode(content, index)
      output += content.slice(index, end)
      index = end
      continue
    }
    const remaining = content.slice(index)
    if (streaming && incompleteCitationMarker.test(remaining) && !citationMarker.test(remaining)) break
    const match = remaining.match(citationMarker)
    if (!match || (index > 0 && content[index - 1] === '\\')) {
      output += content[index]
      index += 1
      continue
    }
    const citation = resolver(match[1])
    if (citation) {
      if (!citation.href) {
        output += `**[${citation.number}]**`
      } else {
        const href = markdownHref(citation.href)
        output += href ? `[${citation.number}](${href} "Citation ${citation.number}: ${markdownTitle(citation.label)}")` : `**[${citation.number}]**`
      }
    }
    index += match[0].length
  }
  return output
}

export const createAgentCitationResolver = (citations: readonly AgentCitation[]): SafeMarkdownCitationResolver => {
  const citationById = new Map<string, AgentCitationResolution>()
  const numbersById = new Map<string, number>()
  for (const [index, citation] of citations.entries()) {
    if (citationById.has(citation.evidenceId)) continue
    const href = safeCitationHref(citation.href)
    let previewable = false
    if (href) {
      try {
        previewable = citation.kind === 'page' && !new URL(href, 'https://wiki.invalid').hash
      } catch {
        previewable = false
      }
    }
    numbersById.set(citation.evidenceId, index + 1)
    citationById.set(citation.evidenceId, {
      evidenceId: citation.evidenceId,
      number: index + 1,
      kind: citation.kind,
      label: citation.label,
      href,
      previewable
    })
  }
  return (evidenceId: string): AgentCitationResolution | null => {
    const citation = citationById.get(evidenceId)
    const number = numbersById.get(evidenceId)
    if (!citation || number === undefined) return null
    return citation
  }
}

export const formatAgentCitationMarkers = (content: string, citations: readonly AgentCitation[] | SafeMarkdownCitationResolver, streaming = false): string => {
  const resolver = typeof citations === 'function' ? citations : createAgentCitationResolver(citations)
  return replaceProseCitationMarkers(content, resolver, streaming)
}
