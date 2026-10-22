import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt()
export interface NotePublicationCapture {
  revision: number
  title: string
  content: string
}
/** Capture once, before the user reviews destination fields. Assets remain canonical. */
export function captureNotePublication(source: string, revision: number): NotePublicationCapture {
  const tokens = markdown.parse(source, {})
  const headingIndex = tokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1')
  const heading = tokens[headingIndex]
  const inline = tokens[headingIndex + 1]
  if (!heading?.map || !inline || headingIndex < 0) return { revision, title: '', content: source }
  const title = (inline.children ?? [])
    .map(token =>
      token.type === 'image' ? token.content : token.type === 'text' || token.type === 'code_inline' ? token.content : token.type === 'softbreak' ? ' ' : ''
    )
    .join('')
    .trim()
  const lines = source.split(/\r?\n/u)
  lines.splice(heading.map[0], heading.map[1] - heading.map[0])
  return { revision, title, content: lines.join('\n').replace(/^\n/u, '') }
}
