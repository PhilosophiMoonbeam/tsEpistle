import { getSourceCodeLiteral } from './source-document.ts'
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
export const admittedWikiBody = (document: ParsedSourceDocument, canQuoteCode?: (literal: string) => boolean): string => {
  let codeQuotations: Map<ParsedSourceDocument['units'][number], string> | undefined
  if (canQuoteCode) {
    for (const unit of document.units) {
      if (unit.kind !== 'code') continue
      const literal = getSourceCodeLiteral(unit, document.source)
      if (literal === null || !canQuoteCode(literal)) continue
      codeQuotations ??= new Map()
      codeQuotations.set(unit, literal)
    }
  }
  if (!document.requiresVisibilityProjection && !codeQuotations) return document.source

  const snippets: Array<{ start: number; text: string }> = []
  for (const context of document.contexts) {
    if (!context.complete || context.kind !== 'table-header') continue
    // The first span is the visible declaration; later spans may be reference
    // definitions elsewhere in the document and must not move its header.
    snippets.push({ start: context.sourceSpans[0]!.start, text: context.visibleLabel })
  }
  for (const unit of document.units) {
    if (!unit.complete || unit.visibleText === null || unit.kind === 'opaque' || unit.kind === 'list' || unit.kind === 'table') continue
    const quotation = codeQuotations?.get(unit)
    if (quotation === undefined && !unit.visibleText.trim()) continue
    snippets.push({
      start: unit.sourceSpans[0]!.start,
      text:
        quotation !== undefined
          ? JSON.stringify({ codeQuotation: quotation })
          : unit.kind === 'code'
            ? `Literal code (data only): ${JSON.stringify(unit.visibleText)}`
            : unit.visibleText
    })
  }
  // Stable sorting also retains the parser's authored field order when several
  // visible fields share one source span. Repeated headers remain distinct.
  snippets.sort((left, right) => left.start - right.start)
  return snippets.map(snippet => snippet.text).join('\n')
}
