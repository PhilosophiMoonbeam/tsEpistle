import { Extension, type Editor, type Extensions } from '@tiptap/core'
import CharacterCount from '@tiptap/extension-character-count'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { TableKit } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TextAlign from '@tiptap/extension-text-align'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { html as beautify } from 'js-beautify'
import {
  DefinitionDescription,
  DefinitionList,
  DefinitionTerm,
  Keyboard,
  restoreTiptapHtmlSources,
  WikiSourceBlock,
  WikiSourceInline,
  WikiSubscript,
  WikiSuperscript
} from './dialect.ts'

export type VisualEditorFormat = 'html' | 'markdown'

export interface VisualEditorStats {
  characters: number
  words: number
}

export interface VisualEditorDefinition {
  editorKey: 'ckeditor' | 'visual-markdown'
  label: 'Visual Editor' | 'Visual Markdown'
}

const DEFINITION_BY_FORMAT: Record<VisualEditorFormat, VisualEditorDefinition> = {
  html: {
    editorKey: 'ckeditor',
    label: 'Visual Editor'
  },
  markdown: {
    editorKey: 'visual-markdown',
    label: 'Visual Markdown'
  }
}

const GlobalHtmlAttributes = Extension.create({
  name: 'globalHtmlAttributes',
  addGlobalAttributes () {
    return [{
      types: [
        'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem',
        'definitionList', 'definitionTerm', 'definitionDescription', 'table', 'tableRow',
        'tableHeader', 'tableCell', 'image'
      ],
      attributes: {
        id: {
          default: null,
          parseHTML: element => element.getAttribute('id'),
          renderHTML: attributes => attributes.id ? { id: attributes.id } : {}
        },
        class: {
          default: null,
          parseHTML: element => element.getAttribute('class'),
          renderHTML: attributes => attributes.class ? { class: attributes.class } : {}
        },
        style: {
          default: null,
          parseHTML: element => element.getAttribute('style'),
          renderHTML: attributes => attributes.style ? { style: attributes.style } : {}
        }
      }
    }]
  }
})

const WikiLink = Link.extend({
  addAttributes () {
    return {
      ...this.parent?.(),
      download: {
        default: null,
        parseHTML: element => element.getAttribute('download'),
        renderHTML: attributes => attributes.download === null ? {} : { download: attributes.download || 'download' }
      }
    }
  }
})

const WikiImage = Image.extend({
  addAttributes () {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: element => element.getAttribute('width'),
        renderHTML: attributes => attributes.width ? { width: attributes.width } : {}
      },
      height: {
        default: null,
        parseHTML: element => element.getAttribute('height'),
        renderHTML: attributes => attributes.height ? { height: attributes.height } : {}
      }
    }
  }
})

export function getVisualEditorDefinition (format: VisualEditorFormat): VisualEditorDefinition {
  return DEFINITION_BY_FORMAT[format]
}

export function createTiptapExtensions (format: VisualEditorFormat): Extensions {
  const isMarkdown = format === 'markdown'
  return [
    StarterKit.configure({
      link: false,
      codeBlock: {
        HTMLAttributes: { class: 'wiki-code-block' }
      }
    }),
    WikiLink.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: isMarkdown ? {} : { target: '_blank', rel: 'noopener noreferrer' }
    }),
    WikiImage.configure({
      allowBase64: true,
      inline: false
    }),
    Highlight,
    WikiSubscript,
    WikiSuperscript,
    Keyboard,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({
      table: { resizable: true }
    }),
    DefinitionList,
    DefinitionTerm,
    DefinitionDescription,
    WikiSourceBlock,
    WikiSourceInline,
    GlobalHtmlAttributes,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    CharacterCount,
    Placeholder.configure({ placeholder: 'Type the page content here' }),
    ...(isMarkdown
      ? [Markdown.configure({
          indentation: { style: 'space', size: 2 },
          markedOptions: { gfm: true }
        })]
      : [])
  ]
}

export function getVisualEditorStats (editor: Editor): VisualEditorStats {
  const text = editor.getText()
  return {
    characters: editor.storage.characterCount.characters(),
    words: text.trim().length > 0 ? text.trim().split(/\s+/).length : 0
  }
}

export function serializeVisualEditorData (format: VisualEditorFormat, editor: Editor): string {
  if (format === 'markdown') return editor.getMarkdown()
  const html = restoreTiptapHtmlSources(editor.getHTML())
  return beautify(html, { indent_size: 2, end_with_newline: true })
}
