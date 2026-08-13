import type { MarkdownIt } from 'markdown-it'
import multiTableModule from 'markdown-it-multimd-table'

interface MultiTableConfig {
  multilineEnabled: boolean
  rowspanEnabled: boolean
  headerlessEnabled: boolean
}
interface MultiTableOptions {
  multiline: boolean
  rowspan: boolean
  headerless: boolean
}

type MultiTablePlugin = (markdown: MarkdownIt, options: MultiTableOptions) => void

const isMultiTablePlugin = (value: unknown): value is MultiTablePlugin => typeof value === 'function'
const multiTable: unknown = multiTableModule

if (!isMultiTablePlugin(multiTable)) {
  throw new TypeError('markdown-it-multimd-table does not export a plugin function')
}


const plugin = {
  init (md: MarkdownIt, conf: MultiTableConfig): void {
    md.use(multiTable, {
      multiline: conf.multilineEnabled,
      rowspan: conf.rowspanEnabled,
      headerless: conf.headerlessEnabled
    })
  }
}

export default plugin
