import type { MarkdownIt } from 'markdown-it'
import pivotTable from 'markdown-it-pivot-table'

const plugin = {
  init (md: MarkdownIt): void {
    md.use(pivotTable)
  }
}

export default plugin
