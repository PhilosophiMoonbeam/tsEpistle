declare module 'markdown-it-pivot-table' {
  import type { MarkdownIt } from 'markdown-it'

  function pivotTable (md: MarkdownIt): void

  export default pivotTable
}
