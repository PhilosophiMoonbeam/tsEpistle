const detailsBlockStart = /^(\s*<details)(?=[\s>])/i

/**
 * Gives a raw details block a stable source anchor without changing the saved Markdown.
 */
export function stampDetailsSourceLine(html: string, sourceLine: number): string | null {
  if (!detailsBlockStart.test(html)) return null
  return html.replace(detailsBlockStart, `$1 data-source-line="${sourceLine}"`)
}

/**
 * Hidden descendants retain layout offsets in some browsers. Align a source line inside
 * a collapsed disclosure to its outermost visible summary instead.
 */
export function resolveVisiblePreviewTarget(target: HTMLElement): HTMLElement {
  let disclosure = target.closest<HTMLDetailsElement>('details')
  let collapsedDisclosure: HTMLDetailsElement | null = null

  while (disclosure) {
    if (!disclosure.open) collapsedDisclosure = disclosure
    disclosure = disclosure.parentElement?.closest<HTMLDetailsElement>('details') ?? null
  }

  if (!collapsedDisclosure) return target
  for (const child of collapsedDisclosure.children) {
    if (child.localName === 'summary') return child as HTMLElement
  }
  return collapsedDisclosure
}
