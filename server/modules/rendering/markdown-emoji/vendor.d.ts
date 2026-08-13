declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it'

  export const bare: (markdown: MarkdownIt) => void
  export const light: (markdown: MarkdownIt) => void
  export const full: (markdown: MarkdownIt) => void
}
