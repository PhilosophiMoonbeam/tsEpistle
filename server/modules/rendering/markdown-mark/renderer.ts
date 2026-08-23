import type { MarkdownIt } from 'markdown-it'
import type { UnknownRecord } from '../../types.ts'
import mdMark from 'markdown-it-mark'

const plugin = {
  init (md: MarkdownIt, _conf: UnknownRecord): void {
    void _conf
    md.use(mdMark)
  }
}

export default plugin
