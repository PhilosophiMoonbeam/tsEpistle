import type { MarkdownIt } from 'markdown-it'
import type { UnknownRecord } from '../../types.ts'
import mdDeflist from 'markdown-it-deflist'

const plugin = {
  init (md: MarkdownIt, _conf: UnknownRecord): void {
    void _conf
    md.use(mdDeflist)
  }
}

export default plugin
