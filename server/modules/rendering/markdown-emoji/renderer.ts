import type { MarkdownIt, Token } from 'markdown-it'
import type { UnknownRecord } from '../../types.ts'
import { full as mdEmoji } from 'markdown-it-emoji'
import twemoji from 'twemoji'

// ------------------------------------
// Markdown - Emoji
// ------------------------------------

const plugin = {
  init (md: MarkdownIt, _conf: UnknownRecord): void {
    void _conf
    md.use(mdEmoji)

    md.renderer.rules.emoji = (tokens: Token[], idx: number) => {
      const emoji = tokens[idx]
      return emoji
        ? twemoji.parse(emoji.content, {
            callback (icon: string): string {
              return `/_assets/svg/twemoji/${icon}.svg`
            }
          })
        : ''
    }
  }
}

export default plugin
