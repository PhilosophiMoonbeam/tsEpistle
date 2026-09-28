import { Extension, mergeAttributes, Node, type Editor, type Extensions } from '@tiptap/core'
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
  DefinitionListKeyboard,
  DefinitionTerm,
  Keyboard,
  restoreTiptapHtmlSources,
  WikiSourceBlock,
  WikiSourceInline,
  WikiSubscript,
  WikiSuperscript
} from './dialect.ts'
import {
  parseWikiLinkAt,
  resolveWikiLinkHref,
  serializeWikiLink,
  WIKI_LINKS_DISABLED,
  type WikiLinkOptions
} from '../../../../shared/wikilinks.ts'

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

function parseCitationLinkAt (source: string) {
  const match = /^\[\[(\d+)\]\]\((https?:\/\/[^)\s<>]+)\)/iu.exec(source)
  if (!match?.[0] || !match[1] || !match[2]) return null

  try {
    const protocol = new URL(match[2]).protocol
    if (protocol !== 'http:' && protocol !== 'https:') return null
  } catch {
    return null
  }

  return { raw: match[0], text: `[[${match[1]}]]`, href: match[2] }
}

function parseWikiLinkSourceAt (source: string) {
  const parsed = parseWikiLinkAt(source)
  if (parsed) return { raw: parsed.raw, parsed }

  const raw = /^\[\[[^[\]\r\n]+\]\]/u.exec(source)?.[0]
  if (!raw) return null
  const continuation = source[raw.length]
  if (continuation === '(' || (continuation === '[' && source[raw.length + 1] !== '[')) return null
  return { raw, parsed: null }
}

const WikiLinkNode = Node.create({
  name: 'wikiLink',
  inline: true,
  group: 'inline',
  content: 'text*',
  selectable: false,
  addAttributes () {
    return {
      href: {
        default: null,
        renderHTML: attributes => attributes.href ? { href: attributes.href } : {}
      },
      wikiLinkSource: { default: null, rendered: false },
      wikiLinkHref: { default: null, rendered: false }
    }
  },
  renderHTML ({ node, HTMLAttributes }) {
    let containsLinkMark = false
    node.descendants(child => {
      if (child.marks.some(mark => mark.type.name === 'link')) containsLinkMark = true
    })
    return !node.attrs.href || containsLinkMark
      ? ['span', {}, 0]
      : ['a', mergeAttributes(HTMLAttributes, { href: node.attrs.href }), 0]
  },
  renderMarkdown (node, helpers) {
    const attrs = node.attrs ?? {}
    const content = node.content ?? []
    const source = typeof attrs.wikiLinkSource === 'string' ? attrs.wikiLinkSource : null
    const parsed = source ? parseWikiLinkAt(source) : null
    const citation = source ? parseCitationLinkAt(source) : null
    const unchangedText = source !== null &&
      attrs.href === attrs.wikiLinkHref &&
      content.length === 1 &&
      content[0]?.type === 'text' &&
      content[0]?.text === (citation?.text ?? (parsed && attrs.href ? parsed.text : source)) &&
      !content[0]?.marks?.length

    if (unchangedText && source !== null) {
      return parsed ? serializeWikiLink(parsed) ?? source : source
    }

    const renderedContent = helpers.renderChildren(node)
    const containsLinkMark = content.some(child => child.marks?.some(mark => mark.type === 'link'))
    if (containsLinkMark || !attrs.href) return renderedContent
    const href = typeof attrs.href === 'string' ? attrs.href : ''
    return `[${renderedContent}](${href})`
  }
})

const createWikiLinkSourceParser = (wikiLinks: WikiLinkOptions) => Extension.create({
  name: 'wikiLinkSourceParser',
  markdownTokenName: 'wikiLinkSource',
  markdownTokenizer: {
    name: 'wikiLinkSource',
    level: 'inline',
    start: source => source.indexOf('[['),
    tokenize: source => {
      const citation = parseCitationLinkAt(source)
      if (citation) {
        return {
          type: 'wikiLinkSource',
          raw: citation.raw,
          text: citation.text,
          tokens: [{ type: 'text', raw: citation.text, text: citation.text }]
        }
      }

      const candidate = parseWikiLinkSourceAt(source)
      if (!candidate) return undefined
      const text = candidate.parsed?.text ?? candidate.raw
      return {
        type: 'wikiLinkSource',
        raw: candidate.raw,
        text,
        tokens: [{ type: 'text', raw: text, text }]
      }
    }
  },
  parseMarkdown (token, helpers) {
    const raw = token.raw
    const citation = typeof raw === 'string' ? parseCitationLinkAt(raw) : null
    if (citation) {
      return helpers.createNode('wikiLink', {
        href: citation.href,
        wikiLinkSource: citation.raw,
        wikiLinkHref: citation.href
      }, helpers.parseInline([{ type: 'text', raw: citation.text, text: citation.text }]))
    }

    const candidate = typeof raw === 'string' ? parseWikiLinkSourceAt(raw) : null
    if (!candidate) throw new TypeError('The wikilink tokenizer returned an invalid token.')
    const parsed = candidate.parsed
    if (!parsed || !wikiLinks.enabled) {
      return helpers.createNode('wikiLink', {
        href: null,
        wikiLinkSource: candidate.raw,
        wikiLinkHref: null
      }, helpers.parseInline([{ type: 'text', raw: candidate.raw, text: candidate.raw }]))
    }

    const href = resolveWikiLinkHref(parsed, wikiLinks.context)
    if (!href) {
      return helpers.createNode('wikiLink', {
        href: null,
        wikiLinkSource: candidate.raw,
        wikiLinkHref: null
      }, helpers.parseInline([{ type: 'text', raw: candidate.raw, text: candidate.raw }]))
    }
    return helpers.createNode('wikiLink', {
      href,
      wikiLinkSource: candidate.raw,
      wikiLinkHref: href
    }, helpers.parseInline(token.tokens ?? []))
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

export function createTiptapExtensions (format: VisualEditorFormat, wikiLinks: WikiLinkOptions = WIKI_LINKS_DISABLED): Extensions {
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
    DefinitionListKeyboard,
    DefinitionTerm,
    DefinitionDescription,
    WikiSourceBlock,
    WikiSourceInline,
    GlobalHtmlAttributes,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    CharacterCount,
    Placeholder.configure({ placeholder: 'Type the page content here' }),
    ...(isMarkdown
      ? [
          WikiLinkNode,
          createWikiLinkSourceParser(wikiLinks),
          Markdown.configure({
            indentation: { style: 'space', size: 2 },
            markedOptions: { gfm: true }
          })
        ]
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
