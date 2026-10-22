import type { Token } from 'markdown-it'
import type { AbstractBlock } from '@asciidoctor/core'

export type SourceHeading = { line: number; level: number; title: string }

function plainTitle(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content.textContent?.trim() ?? ''
}

export function markdownHeadings(tokens: readonly Token[]): SourceHeading[] {
  const headings: SourceHeading[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token.type !== 'heading_open' || !token.map) continue
    const inline = tokens[index + 1]
    const title = (inline?.children ?? [])
      .map(child => {
        if (child.type === 'softbreak' || child.type === 'hardbreak') return ' '
        return child.type === 'html_inline' ? '' : child.content
      })
      .join('')
      .trim()
    headings.push({ line: token.map[0], level: Number(token.tag.slice(1)), title })
  }
  return headings
}

/** Add view-only roles to a loaded document, never to authored or persisted source. */
export function mapAsciiDocDocument(document: AbstractBlock): SourceHeading[] {
  const headings: SourceHeading[] = []
  const visit = (block: AbstractBlock) => {
    const number = block.getLineNumber()
    if (number !== undefined && number > 0) {
      block.addRole(`editor-source-line-${number - 1}`)
      if (block.getContext() === 'section' || (block.getContext() === 'document' && block.getTitle())) {
        headings.push({ line: number - 1, level: Math.max(1, (block.getLevel() ?? 0) + 1), title: plainTitle(block.getTitle() ?? '') })
      }
    }
    for (const child of block.getBlocks()) visit(child)
  }
  visit(document)
  return headings
}

const CONTENTS_PREFERENCE = 'wiki.editor.contents'
export function readContentsPreference(): boolean {
  try {
    return localStorage.getItem(CONTENTS_PREFERENCE) === 'open'
  } catch {
    return false
  }
}
export function writeContentsPreference(open: boolean): void {
  try {
    localStorage.setItem(CONTENTS_PREFERENCE, open ? 'open' : 'closed')
  } catch {
    /* Storage is optional for view preferences. */
  }
}
