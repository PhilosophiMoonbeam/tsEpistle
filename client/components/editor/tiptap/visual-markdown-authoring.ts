import type { Editor } from '@tiptap/core'

export const ADMONITION_KINDS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const
export type AdmonitionKind = typeof ADMONITION_KINDS[number]

export interface AdmonitionInput {
  kind: AdmonitionKind
  title: string
  body: string
}

export type VisualMarkdownGlyphCategory = 'icon' | 'emoji'
export type VisualMarkdownGlyphFilter = 'all' | VisualMarkdownGlyphCategory

export interface VisualMarkdownGlyph {
  label: string
  value: string
  category: VisualMarkdownGlyphCategory
  keywords: readonly string[]
}

const icon = (label: string, value: string, ...keywords: string[]): VisualMarkdownGlyph => ({
  label,
  value,
  category: 'icon',
  keywords
})

const emoji = (label: string, value: string, ...keywords: string[]): VisualMarkdownGlyph => ({
  label,
  value,
  category: 'emoji',
  keywords
})

export const VISUAL_MARKDOWN_GLYPHS: readonly VisualMarkdownGlyph[] = Object.freeze([
  icon('Information', 'ℹ️', 'info', 'help', 'notice'),
  icon('Warning', '⚠️', 'alert', 'caution', 'danger'),
  icon('Success', '✅', 'check', 'complete', 'done', 'passed'),
  icon('Failure', '❌', 'cross', 'error', 'failed', 'remove'),
  icon('Star', '★', 'favorite', 'featured', 'rating'),
  icon('Heart', '♥', 'favorite', 'like', 'love'),
  icon('Check mark', '✓', 'accept', 'complete', 'done', 'yes'),
  icon('Cross mark', '✕', 'cancel', 'close', 'delete', 'no'),
  icon('Question', '❓', 'help', 'unknown'),
  icon('Exclamation', '❗', 'alert', 'important'),
  icon('Right arrow', '→', 'forward', 'next'),
  icon('Left arrow', '←', 'back', 'previous'),
  icon('Up arrow', '↑', 'increase', 'top'),
  icon('Down arrow', '↓', 'decrease', 'bottom'),
  icon('Bullet', '•', 'dot', 'list'),
  icon('Diamond', '◆', 'shape'),
  icon('Circle', '●', 'dot', 'shape'),
  icon('Square', '■', 'box', 'shape'),
  icon('Copyright', '©', 'license'),
  icon('Registered', '®', 'trademark'),
  icon('Trademark', '™', 'brand'),
  emoji('Smile', '🙂', 'happy', 'face'),
  emoji('Grin', '😄', 'happy', 'joy', 'face'),
  emoji('Laugh', '😂', 'funny', 'joy', 'tears', 'face'),
  emoji('Wink', '😉', 'playful', 'face'),
  emoji('Love eyes', '😍', 'heart', 'like', 'face'),
  emoji('Cool', '😎', 'sunglasses', 'confident', 'face'),
  emoji('Think', '🤔', 'consider', 'hmm', 'question', 'face'),
  emoji('Surprised', '😮', 'wow', 'face'),
  emoji('Sad', '😢', 'cry', 'tear', 'face'),
  emoji('Angry', '😠', 'mad', 'face'),
  emoji('Celebrate', '🎉', 'confetti', 'party', 'success'),
  emoji('Party', '🥳', 'celebrate', 'birthday', 'face'),
  emoji('Idea', '💡', 'bulb', 'insight', 'tip'),
  emoji('Rocket', '🚀', 'deploy', 'launch', 'ship'),
  emoji('Fire', '🔥', 'hot', 'popular'),
  emoji('Sparkles', '✨', 'magic', 'new', 'shine'),
  emoji('Lightning', '⚡', 'fast', 'power', 'zap'),
  emoji('Search', '🔎', 'find', 'magnify', 'lookup'),
  emoji('Lock', '🔒', 'private', 'secure'),
  emoji('Unlock', '🔓', 'open', 'public'),
  emoji('Key', '🔑', 'access', 'password'),
  emoji('Pin', '📌', 'location', 'pushpin'),
  emoji('Link', '🔗', 'chain', 'url'),
  emoji('Bell', '🔔', 'alert', 'notification'),
  emoji('Calendar', '📅', 'date', 'event', 'schedule'),
  emoji('Clock', '🕒', 'history', 'time'),
  emoji('Clipboard', '📋', 'copy', 'paste', 'task'),
  emoji('Note', '📝', 'edit', 'pencil', 'write'),
  emoji('Book', '📘', 'docs', 'documentation', 'read'),
  emoji('Folder', '📁', 'directory', 'files'),
  emoji('File', '📄', 'document', 'page'),
  emoji('Chart', '📊', 'analytics', 'data', 'report'),
  emoji('Trend up', '📈', 'growth', 'increase', 'metrics'),
  emoji('Trend down', '📉', 'decline', 'decrease', 'metrics'),
  emoji('Target', '🎯', 'goal', 'objective'),
  emoji('Trophy', '🏆', 'achievement', 'award', 'winner'),
  emoji('Medal', '🏅', 'achievement', 'award'),
  emoji('Gift', '🎁', 'present', 'reward'),
  emoji('Handshake', '🤝', 'agreement', 'deal', 'partner'),
  emoji('Wave', '👋', 'goodbye', 'hello', 'welcome'),
  emoji('Thumbs up', '👍', 'approve', 'good', 'like', 'yes'),
  emoji('Thumbs down', '👎', 'bad', 'disapprove', 'no'),
  emoji('Clap', '👏', 'applause', 'congratulations'),
  emoji('Strong', '💪', 'muscle', 'power'),
  emoji('Eyes', '👀', 'look', 'review', 'watch'),
  emoji('Point right', '👉', 'direction', 'next'),
  emoji('Brain', '🧠', 'ai', 'knowledge', 'smart'),
  emoji('Gear', '⚙️', 'config', 'settings'),
  emoji('Tools', '🛠️', 'build', 'maintenance', 'repair'),
  emoji('Computer', '💻', 'code', 'developer', 'laptop'),
  emoji('Phone', '📱', 'mobile', 'smartphone'),
  emoji('Email', '✉️', 'mail', 'message'),
  emoji('Globe', '🌐', 'internet', 'network', 'web', 'world'),
  emoji('Home', '🏠', 'house', 'start'),
  emoji('Team', '👥', 'group', 'people', 'users'),
  emoji('Person', '👤', 'account', 'profile', 'user'),
  emoji('Robot', '🤖', 'ai', 'automation', 'bot'),
  emoji('Bug', '🐛', 'debug', 'defect', 'issue'),
  emoji('Shield', '🛡️', 'protect', 'security'),
  emoji('Test tube', '🧪', 'experiment', 'lab', 'test'),
  emoji('Construction', '🚧', 'blocked', 'building', 'work'),
  emoji('Database', '🗄️', 'data', 'server', 'storage'),
  emoji('Package', '📦', 'box', 'delivery', 'release'),
  emoji('Cloud', '☁️', 'hosting', 'weather'),
  emoji('Download', '⬇️', 'receive', 'save'),
  emoji('Upload', '⬆️', 'publish', 'send')
])

interface GlyphSearchEntry {
  glyph: VisualMarkdownGlyph
  terms: readonly string[]
}

const normalizeSearchValue = (value: string): string => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const GLYPH_SEARCH_INDEX: readonly GlyphSearchEntry[] = VISUAL_MARKDOWN_GLYPHS.map(glyph => ({
  glyph,
  terms: [glyph.label, ...glyph.keywords]
    .map(normalizeSearchValue)
    .filter(Boolean)
}))

const boundedEditDistance = (left: string, right: string, limit: number): number => {
  if (Math.abs(left.length - right.length) > limit) return limit + 1

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex]
    let rowMinimum = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution = previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      const distance = Math.min(previous[rightIndex]! + 1, current[rightIndex - 1]! + 1, substitution)
      current.push(distance)
      rowMinimum = Math.min(rowMinimum, distance)
    }
    if (rowMinimum > limit) return limit + 1
    previous = current
  }
  return previous[right.length]!
}

const searchTokenScore = (query: string, term: string): number => {
  if (term === query) return 0
  if (term.startsWith(query)) return 10 + (term.length - query.length) / 100
  const substringIndex = term.indexOf(query)
  if (substringIndex >= 0) return 20 + substringIndex / 100

  let queryIndex = 0
  let gapCount = 0
  for (const character of term) {
    if (character === query[queryIndex]) queryIndex++
    else if (queryIndex > 0) gapCount++
    if (queryIndex === query.length) return 30 + gapCount / 100
  }

  const editLimit = Math.max(1, Math.ceil(query.length * .3))
  const editDistance = boundedEditDistance(query, term, editLimit)
  return editDistance <= editLimit ? 40 + editDistance : Number.POSITIVE_INFINITY
}

export function searchVisualMarkdownGlyphs (
  query: string,
  category: VisualMarkdownGlyphFilter = 'all'
): readonly VisualMarkdownGlyph[] {
  const queryTokens = normalizeSearchValue(query).split(' ').filter(Boolean)
  const matches = GLYPH_SEARCH_INDEX
    .map((entry, index) => {
      if (category !== 'all' && entry.glyph.category !== category) return null
      const score = queryTokens.reduce((total, queryToken) => {
        const tokenScore = Math.min(...entry.terms.map(term => searchTokenScore(queryToken, term)))
        return total + tokenScore
      }, 0)
      return Number.isFinite(score) ? { glyph: entry.glyph, index, score } : null
    })
    .filter((match): match is { glyph: VisualMarkdownGlyph, index: number, score: number } => match !== null)

  matches.sort((left, right) => left.score - right.score || left.index - right.index)
  return matches.map(match => match.glyph)
}

const normalizedLine = (value: string): string => value.replace(/\r?\n/g, ' ').trim()
const escapeMarkdownInline = (value: string): string => value.replace(/[\\`*_[\]<>]/g, '\\$&')

export function serializeVisualMarkdownAdmonition (input: AdmonitionInput): string {
  if (!ADMONITION_KINDS.includes(input.kind)) throw new TypeError('Unsupported admonition kind.')
  const title = normalizedLine(input.title)
  const body = input.body.replace(/\r\n/g, '\n').trim()
  if (title.length < 1 || title.length > 120) throw new TypeError('Admonition title must contain 1–120 characters.')
  if (body.length < 1 || body.length > 5000) throw new TypeError('Admonition body must contain 1–5000 characters.')

  return `> **${input.kind}: ${escapeMarkdownInline(title)}**\n>\n${body.split('\n').map(line => `> ${line}`).join('\n')}\n`
}

export function insertVisualMarkdownAdmonition (editor: Editor, input: AdmonitionInput): void {
  editor.commands.insertContent(serializeVisualMarkdownAdmonition(input), { contentType: 'markdown' })
}

export function insertVisualMarkdownGlyph (editor: Editor, glyph: VisualMarkdownGlyph): void {
  if (!VISUAL_MARKDOWN_GLYPHS.some(candidate => candidate.value === glyph.value && candidate.label === glyph.label)) {
    throw new TypeError('Unsupported Visual Markdown glyph.')
  }
  editor.commands.insertContent(glyph.value)
}

export function insertVisualMarkdownDefinitionList (editor: Editor): void {
  editor.commands.insertContent({
    type: 'definitionList',
    content: [
      {
        type: 'definitionTerm',
        content: [{ type: 'text', text: 'Term' }]
      },
      {
        type: 'definitionDescription',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Definition' }] }]
      },
      {
        type: 'definitionTerm',
        content: [{ type: 'text', text: 'Term' }]
      },
      {
        type: 'definitionDescription',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Definition' }] }]
      }
    ]
  })
}
