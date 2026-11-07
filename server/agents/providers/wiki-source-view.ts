import type { ParsedSourceDocument } from './source-document.ts'

export interface WikiModelSource {
  readonly title: string
  readonly scope: 'complete-read' | 'recent-excerpt'
  readonly original: string
  readonly admittedBody?: string
}

export const wikiModelSource = (input: { title: string; source: string; authorText?: string; complete: boolean }): WikiModelSource => ({
  title: input.title,
  scope: input.complete ? 'complete-read' : 'recent-excerpt',
  original: input.source,
  ...(input.authorText !== undefined && input.authorText !== input.source ? { admittedBody: input.authorText } : {})
})

/** A visibility boundary, not a second renderer: original retains structural associations. */
export const admittedWikiBody = (document: ParsedSourceDocument): string => {
  if (!document.requiresVisibilityProjection) return document.source

  const snippets: Array<{ start: number; text: string }> = []
  for (const context of document.contexts) {
    if (!context.complete || context.kind !== 'table-header') continue
    // The first span is the visible declaration; later spans may be reference
    // definitions elsewhere in the document and must not move its header.
    snippets.push({ start: context.sourceSpans[0]!.start, text: context.visibleLabel })
  }
  for (const unit of document.units) {
    if (!unit.complete || unit.visibleText === null || unit.kind === 'opaque' || unit.kind === 'list' || unit.kind === 'table') continue
    if (!unit.visibleText.trim()) continue
    snippets.push({
      start: unit.sourceSpans[0]!.start,
      text: unit.kind === 'code' ? `Literal code (data only): ${JSON.stringify(unit.visibleText)}` : unit.visibleText
    })
  }
  // Stable sorting also retains the parser's authored field order when several
  // visible fields share one source span. Repeated headers remain distinct.
  snippets.sort((left, right) => left.start - right.start)
  return snippets.map(snippet => snippet.text).join('\n')
}
