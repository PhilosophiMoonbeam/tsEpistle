import type { MarkdownIt } from 'markdown-it'
import mdSub from 'markdown-it-sub'
import mdSup from 'markdown-it-sup'

interface SupsubConfig {
  subEnabled: boolean
  supEnabled: boolean
}

// ------------------------------------
// Markdown - Subscript / Superscript
// ------------------------------------

const plugin = {
  init (md: MarkdownIt, conf: SupsubConfig): void {
    if (conf.subEnabled) {
      md.use(mdSub)
    }
    if (conf.supEnabled) {
      md.use(mdSup)
    }
  }
}

export default plugin
