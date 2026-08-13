import type { MarkdownIt } from 'markdown-it'
import pivotTable from './pivot-table.ts'

const plugin = {
  init (md: MarkdownIt): void {
    md.use(pivotTable)
  }
}

export default plugin
