import type { PageEditorKey } from '../../shared/page-editors.ts'

export type PageEditorDefinition = {
  key: PageEditorKey
  title: string
  format: string
  description: string
  chooserDescription: string
  icon: string
  image: string
}

export const PAGE_EDITOR_DEFINITIONS: readonly PageEditorDefinition[] = [
  {
    key: 'markdown',
    title: 'Markdown',
    format: 'Markdown',
    description: 'Write source Markdown with a live preview, diagrams, and collaboration.',
    chooserDescription: 'Source editing with live preview',
    icon: 'mdi-language-markdown',
    image: '/_assets/svg/editor-icon-markdown.svg'
  },
  {
    key: 'visual-markdown',
    title: 'Visual Markdown',
    format: 'Markdown',
    description: 'Compose rich text visually while keeping portable Markdown as the source.',
    chooserDescription: 'Rich text with Markdown output',
    icon: 'mdi-file-document-edit-outline',
    image: '/_assets/svg/editor-icon-markdown.svg'
  },
  {
    key: 'ckeditor',
    title: 'Visual HTML',
    format: 'HTML',
    description: 'Compose rich text visually and store the resulting page as HTML.',
    chooserDescription: 'Rich text with HTML output',
    icon: 'mdi-language-html5',
    image: '/_assets/svg/editor-icon-html.svg'
  },
  {
    key: 'asciidoc',
    title: 'AsciiDoc',
    format: 'AsciiDoc',
    description: 'Write structured AsciiDoc source alongside its rendered preview.',
    chooserDescription: 'Source editing with live preview',
    icon: 'mdi-file-document-outline',
    image: '/_assets/svg/editor-icon-asciidoc.svg'
  },
  {
    key: 'code',
    title: 'Code',
    format: 'HTML',
    description: 'Work directly with raw HTML for complete control over page markup.',
    chooserDescription: 'Direct HTML source editing',
    icon: 'mdi-code-tags',
    image: '/_assets/svg/editor-icon-code.svg'
  }
]
