import type { MarkdownIt } from 'markdown-it'
import mdTaskLists from 'markdown-it-task-lists'

// ------------------------------------
// Markdown - Task Lists
// ------------------------------------

const plugin = {
  init (md: MarkdownIt): void {
    md.use(mdTaskLists, { label: false, labelAfter: false })
  }
}

export default plugin
