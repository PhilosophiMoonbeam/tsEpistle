import type { MarkdownIt } from 'markdown-it'
import type { UnknownRecord } from '../../types.ts'
import mdFootnote from 'markdown-it-footnote'

// ------------------------------------
// Markdown - Footnotes
// ------------------------------------

const plugin = {
  init (md: MarkdownIt, _conf: UnknownRecord): void {
    void _conf
    md.use(mdFootnote)
  }
}

export default plugin
