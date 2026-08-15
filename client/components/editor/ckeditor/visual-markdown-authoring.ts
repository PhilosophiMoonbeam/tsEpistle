import type { DecoupledEditor } from 'ckeditor5'

export const ADMONITION_KINDS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const
export type AdmonitionKind = typeof ADMONITION_KINDS[number]

export interface AdmonitionInput {
  kind: AdmonitionKind
  title: string
  body: string
}

export interface VisualMarkdownGlyph {
  label: string
  value: string
  category: 'icon' | 'emoji'
}

export const VISUAL_MARKDOWN_GLYPHS: readonly VisualMarkdownGlyph[] = Object.freeze([
  { label: 'Information', value: 'ℹ️', category: 'icon' },
  { label: 'Warning', value: '⚠️', category: 'icon' },
  { label: 'Success', value: '✅', category: 'icon' },
  { label: 'Failure', value: '❌', category: 'icon' },
  { label: 'Star', value: '★', category: 'icon' },
  { label: 'Heart', value: '♥', category: 'icon' },
  { label: 'Smile', value: '🙂', category: 'emoji' },
  { label: 'Celebrate', value: '🎉', category: 'emoji' },
  { label: 'Idea', value: '💡', category: 'emoji' },
  { label: 'Rocket', value: '🚀', category: 'emoji' },
  { label: 'Search', value: '🔎', category: 'emoji' },
  { label: 'Lock', value: '🔒', category: 'emoji' }
])

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

export function insertVisualMarkdownAdmonition (editor: DecoupledEditor, input: AdmonitionInput): void {
  const source = serializeVisualMarkdownAdmonition(input)
  const view = editor.data.processor.toView(source)
  const model = editor.data.toModel(view)
  editor.model.insertContent(model, editor.model.document.selection)
}

export function insertVisualMarkdownGlyph (editor: DecoupledEditor, glyph: VisualMarkdownGlyph): void {
  if (!VISUAL_MARKDOWN_GLYPHS.some(candidate => candidate.value === glyph.value && candidate.label === glyph.label)) {
    throw new TypeError('Unsupported Visual Markdown glyph.')
  }
  editor.model.change(writer => {
    editor.model.insertContent(writer.createText(glyph.value), editor.model.document.selection)
  })
}
