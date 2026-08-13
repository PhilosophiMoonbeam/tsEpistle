declare module 'markdown-it-attrs' {
  import type { MarkdownIt } from 'markdown-it'

  interface AttributesOptions {
    leftDelimiter?: string
    rightDelimiter?: string
    allowedAttributes?: Array<string | RegExp>
  }

  export default function attributes (markdown: MarkdownIt, options?: AttributesOptions): void
}
