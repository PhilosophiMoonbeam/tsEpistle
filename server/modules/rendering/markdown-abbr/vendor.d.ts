declare module 'markdown-it-abbr' {
  import type { MarkdownIt } from 'markdown-it'

  const abbreviation: (markdown: MarkdownIt) => void
  export default abbreviation
}
