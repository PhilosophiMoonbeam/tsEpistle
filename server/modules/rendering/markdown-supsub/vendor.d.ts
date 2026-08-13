declare module 'markdown-it-sub' {
  import type { MarkdownIt } from 'markdown-it'

  function subscript (md: MarkdownIt): void

  export default subscript
}

declare module 'markdown-it-sup' {
  import type { MarkdownIt } from 'markdown-it'

  function superscript (md: MarkdownIt): void

  export default superscript
}
