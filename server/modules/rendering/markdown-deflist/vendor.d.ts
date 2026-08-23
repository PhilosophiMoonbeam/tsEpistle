declare module 'markdown-it-deflist' {
  import type { MarkdownIt } from 'markdown-it'

  const deflist: (markdown: MarkdownIt) => void
  export default deflist
}
