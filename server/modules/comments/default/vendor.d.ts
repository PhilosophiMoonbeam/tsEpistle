declare module 'markdown-it-emoji' {
  import type MarkdownIt from 'markdown-it'

  interface EmojiOptions {
    defs?: Record<string, string>
    shortcuts?: Record<string, string | readonly string[]>
    enabled?: readonly string[]
  }

  type EmojiPlugin = (md: MarkdownIt, options?: EmojiOptions) => void

  export const bare: EmojiPlugin
  export const full: EmojiPlugin
  export const light: EmojiPlugin
}
