import type { AgentCitation } from '../../../shared/agents/contracts.ts'

const citationMarker = /\[\[cite:([^\]\s]{1,128})\]\]/g
const trailingIncompleteCitationMarker = /\[\[cite:[^\]\s]{0,128}\]?$/

const markdownHref = (href: string): string | null => {
  try {
    return encodeURI(href).replaceAll('(', '%28').replaceAll(')', '%29')
  } catch {
    return null
  }
}

const markdownTitle = (value: string): string => value
  .replaceAll('\\', '\\\\')
  .replaceAll('"', '\\"')
  .replaceAll(/\s+/g, ' ')
  .trim()

export const formatAgentCitationMarkers = (
  content: string,
  citations: readonly AgentCitation[],
  streaming = false
): string => {
  const citationNumbers = new Map(citations.map((citation, index) => [citation.evidenceId, index + 1]))
  const citationsById = new Map(citations.map(citation => [citation.evidenceId, citation]))
  const visibleContent = streaming ? content.replace(trailingIncompleteCitationMarker, '') : content
  return visibleContent.replace(citationMarker, (_marker, evidenceId: string) => {
    const citation = citationsById.get(evidenceId)
    const number = citationNumbers.get(evidenceId)
    if (!citation || number === undefined) return ''
    if (!citation.href) return `**[${number}]**`
    const href = markdownHref(citation.href)
    if (!href) return `**[${number}]**`
    return `[${number}](${href} "Citation ${number}: ${markdownTitle(citation.label)}")`
  })
}
