declare module 'markdown-it-mark' {
  import type { MarkdownIt } from 'markdown-it'

  const mark: (markdown: MarkdownIt) => void
  export default mark
}
