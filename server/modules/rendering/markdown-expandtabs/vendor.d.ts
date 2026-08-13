declare module 'markdown-it-expand-tabs' {
  import type { MarkdownIt } from 'markdown-it'

  interface ExpandTabsOptions {
    tabWidth?: number
  }

  export default function expandTabs (markdown: MarkdownIt, options?: ExpandTabsOptions): void
}
