import createDOMPurify from 'dompurify'
import jsdomModule from 'jsdom'
import md from 'markdown-it'
import { full as mdEmoji } from 'markdown-it-emoji'
import _ from 'lodash'

const { JSDOM } = jsdomModule
const DOMPurify = createDOMPurify(new JSDOM('').window)
const markdown = md({
  html: false,
  breaks: true,
  linkify: true,
  highlight(value, language) {
    return `<pre><code class="language-${_.escape(language)}">${_.escape(value)}</code></pre>`
  }
})
const MENTION_PATTERN = /(?<![\w@/])@([a-z0-9_-]{3,32})/gi

markdown.use(mdEmoji)
markdown.renderer.rules.comment_mention = (tokens, index) => `<span class="comment-mention">${_.escape(tokens[index]?.content ?? '')}</span>`
markdown.core.ruler.after('inline', 'comment_mentions', state => {
  const allowed = state.env?.commentMentions instanceof Set ? state.env.commentMentions as Set<string> : new Set<string>()
  if (allowed.size === 0) return
  for (const block of state.tokens) {
    if (!block.children) continue
    let linkDepth = 0
    const transformed = []
    for (const token of block.children) {
      if (token.type === 'link_open') linkDepth += 1
      if (token.type !== 'text' || linkDepth > 0) {
        transformed.push(token)
        if (token.type === 'link_close') linkDepth = Math.max(0, linkDepth - 1)
        continue
      }
      MENTION_PATTERN.lastIndex = 0
      let cursor = 0
      let match: RegExpExecArray | null
      while ((match = MENTION_PATTERN.exec(token.content)) !== null) {
        if (!allowed.has((match[1] ?? '').toLowerCase())) continue
        if (match.index > cursor) {
          const text = new state.Token('text', '', 0)
          text.content = token.content.slice(cursor, match.index)
          transformed.push(text)
        }
        const mention = new state.Token('comment_mention', 'span', 0)
        mention.content = match[0]
        transformed.push(mention)
        cursor = match.index + match[0].length
      }
      if (cursor === 0) transformed.push(token)
      else if (cursor < token.content.length) {
        const text = new state.Token('text', '', 0)
        text.content = token.content.slice(cursor)
        transformed.push(text)
      }
    }
    block.children = transformed
  }
})

export const commentMentionHandles = (content: string): string[] => {
  MENTION_PATTERN.lastIndex = 0
  return [...new Set([...content.matchAll(MENTION_PATTERN)].map(match => (match[1] ?? '').toLowerCase()).filter(Boolean))]
}

export const renderCommentMarkdown = (content: string, mentions: ReadonlySet<string> = new Set()): string =>
  DOMPurify.sanitize(markdown.render(content, { commentMentions: new Set(mentions) }))
