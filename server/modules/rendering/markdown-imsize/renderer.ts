import type { MarkdownIt } from 'markdown-it'
import type { UnknownRecord } from '../../types.ts'
import markdownItImageSize from '../../../../shared/markdown-it-image-size.ts'

// ------------------------------------
// Markdown - Image Size
// ------------------------------------

const plugin = {
  init (md: MarkdownIt, _conf: UnknownRecord): void {
    void _conf
    md.use(markdownItImageSize)
  }
}

export default plugin
