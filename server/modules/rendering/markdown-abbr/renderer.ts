import type { MarkdownIt } from 'markdown-it'
import type { UnknownRecord } from '../../types.ts'
import mdAbbr from 'markdown-it-abbr'

// ------------------------------------
// Markdown - Abbreviations
// ------------------------------------

const plugin = {
  init (md: MarkdownIt, _conf: UnknownRecord): void {
    void _conf
    md.use(mdAbbr)
  }
}

export default plugin
