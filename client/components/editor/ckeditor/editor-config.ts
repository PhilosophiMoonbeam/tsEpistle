import {
  Autoformat,
  BlockQuote,
  Bold,
  Code,
  CodeBlock,
  Essentials,
  GeneralHtmlSupport,
  Heading,
  HorizontalLine,
  Image,
  ImageCaption,
  ImageInsert,
  ImageResize,
  ImageStyle,
  ImageToolbar,
  Indent,
  IndentBlock,
  Italic,
  Link,
  List,
  ListProperties,
  Markdown,
  Paragraph,
  PasteFromOffice,
  Strikethrough,
  Table,
  TableToolbar,
  TodoList,
  Underline,
  WordCount,
  type EditorConfig,
  type HeadingOption
} from 'ckeditor5'
import { html as beautify } from 'js-beautify'
import { serializeVisualMarkdownData, VisualMarkdownFidelity } from './visual-markdown-fidelity.ts'

export type VisualEditorFormat = 'html' | 'markdown'

export interface VisualEditorStats {
  characters: number
  words: number
}

export interface VisualEditorDefinition {
  editorKey: 'ckeditor' | 'visual-markdown'
  label: 'Visual Editor' | 'Visual Markdown'
}

const definitionByFormat: Record<VisualEditorFormat, VisualEditorDefinition> = {
  html: {
    editorKey: 'ckeditor',
    label: 'Visual Editor'
  },
  markdown: {
    editorKey: 'visual-markdown',
    label: 'Visual Markdown'
  }
}

const htmlPlugins = [
  Essentials,
  Paragraph,
  Heading,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Link,
  List,
  ListProperties,
  BlockQuote,
  CodeBlock,
  Image,
  ImageInsert,
  ImageCaption,
  ImageResize,
  ImageStyle,
  ImageToolbar,
  Table,
  TableToolbar,
  WordCount,
  Autoformat,
  Indent,
  IndentBlock,
  PasteFromOffice
]

const markdownPlugins = [
  Markdown,
  Essentials,
  GeneralHtmlSupport,
  VisualMarkdownFidelity,
  Paragraph,
  Heading,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
  List,
  TodoList,
  BlockQuote,
  CodeBlock,
  HorizontalLine,
  Image,
  ImageInsert,
  ImageToolbar,
  Table,
  TableToolbar,
  WordCount,
  Autoformat,
  PasteFromOffice
]

const htmlToolbar = [
  'undo',
  'redo',
  '|',
  'heading',
  '|',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'link',
  '|',
  'bulletedList',
  'numberedList',
  'outdent',
  'indent',
  '|',
  'blockQuote',
  'codeBlock',
  'insertTable'
]

const markdownToolbar = [
  'undo',
  'redo',
  '|',
  'heading',
  '|',
  'bold',
  'italic',
  'strikethrough',
  'wikiHighlight',
  'wikiSubscript',
  'wikiSuperscript',
  'wikiKeyboard',
  'code',
  'link',
  '|',
  'bulletedList',
  'numberedList',
  'todoList',
  '|',
  'blockQuote',
  'codeBlock',
  'horizontalLine',
  'insertTable'
]
const markdownCodeBlockLanguages = [
  { language: 'plaintext', label: 'Plain text' },
  { language: 'javascript', label: 'JavaScript' },
  { language: 'typescript', label: 'TypeScript' },
  { language: 'html', label: 'HTML' },
  { language: 'css', label: 'CSS' },
  { language: 'json', label: 'JSON' },
  { language: 'diagram', label: 'Draw.io diagram' },
  { language: 'mermaid', label: 'Mermaid diagram' },
  { language: 'plantuml', label: 'PlantUML diagram' },
  { language: 'kroki', label: 'Kroki diagram' },
  { language: 'wiki-extension', label: 'Wiki content extension' }
]
const markdownHeadingOptions: HeadingOption[] = [
  { model: 'paragraph', title: 'Paragraph', class: 'ck-heading_paragraph' },
  { model: 'heading1', view: 'h1', title: 'Heading 1', class: 'ck-heading_heading1' },
  { model: 'heading2', view: 'h2', title: 'Heading 2', class: 'ck-heading_heading2' },
  { model: 'heading3', view: 'h3', title: 'Heading 3', class: 'ck-heading_heading3' },
  { model: 'heading4', view: 'h4', title: 'Heading 4', class: 'ck-heading_heading4' },
  { model: 'heading5', view: 'h5', title: 'Heading 5', class: 'ck-heading_heading5' },
  { model: 'heading6', view: 'h6', title: 'Heading 6', class: 'ck-heading_heading6' }
]


export function getVisualEditorDefinition (format: VisualEditorFormat): VisualEditorDefinition {
  return definitionByFormat[format]
}

export function serializeVisualEditorData (format: VisualEditorFormat, data: string): string {
  return format === 'html'
    ? beautify(data, { indent_size: 2, end_with_newline: true })
    : serializeVisualMarkdownData(data)
}

export function createVisualEditorConfig (
  format: VisualEditorFormat,
  locale: string,
  onStats: (stats: VisualEditorStats) => void
): EditorConfig {
  const isMarkdown = format === 'markdown'

  return {
    licenseKey: 'GPL',
    plugins: isMarkdown ? markdownPlugins : htmlPlugins,
    toolbar: {
      items: isMarkdown ? markdownToolbar : htmlToolbar
    },
    ...(isMarkdown ? { heading: { options: markdownHeadingOptions } } : {}),
    ...(isMarkdown ? { codeBlock: { languages: markdownCodeBlockLanguages } } : {}),
    ...(isMarkdown
      ? {
          htmlSupport: {
            allow: [{
              name: /^(?:dl|dt|dd)$/,
              attributes: true,
              classes: true
            }]
          }
        }
      : {}),
    image: {
      toolbar: isMarkdown
        ? ['imageTextAlternative']
        : ['imageTextAlternative', 'toggleImageCaption', 'imageStyle:inline', 'imageStyle:block', 'imageStyle:side']
    },
    table: {
      contentToolbar: isMarkdown
        ? ['tableColumn', 'tableRow']
        : ['tableColumn', 'tableRow', 'mergeTableCells']
    },
    link: isMarkdown
      ? {}
      : {
          addTargetToExternalLinks: true,
          decorators: {
            isDownloadable: {
              mode: 'manual' as const,
              label: 'Downloadable',
              attributes: {
                download: 'download'
              }
            }
          }
        },
    language: locale,
    placeholder: 'Type the page content here',
    wordCount: {
      onUpdate: onStats
    }
  }
}
