import { getExtensionField, mergeAttributes, type Node, type MarkdownToken } from '@tiptap/core'
import { DOMParser, DOMSerializer } from '@tiptap/pm/model'
import {
  normalizeQuoteAuthor,
  parseQuoteAttribution,
  QUOTE_AUTHOR_ATTRIBUTE,
  QUOTE_BYLINE_CLASS,
  serializeQuoteAttribution
} from '../../../../shared/markdown-it-quote-attribution.ts'

function findByline(element: HTMLElement): Element | undefined {
  return [...element.children].find(child => child.matches(`p.${QUOTE_BYLINE_CLASS}`))
}

function createByline(author: string): HTMLParagraphElement {
  const byline = document.createElement('p')
  byline.className = QUOTE_BYLINE_CLASS
  const name = document.createElement('span')
  name.textContent = author
  byline.append(name)
  return byline
}

function createQuote(attributes: Record<string, unknown>): HTMLQuoteElement {
  const quote = document.createElement('blockquote')
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) quote.setAttribute(name, String(value))
  }
  return quote
}

/** Extend the native StarterKit node, keeping its commands, keys and input rules. */
export function extendAttributedBlockquote(blockquote: Node): Node {
  return blockquote.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        author: {
          default: null,
          parseHTML: element => normalizeQuoteAuthor(element.getAttribute(QUOTE_AUTHOR_ATTRIBUTE)) ?? normalizeQuoteAuthor(findByline(element)?.textContent),
          renderHTML: attributes => {
            const author = normalizeQuoteAuthor(attributes.author)
            return author ? { [QUOTE_AUTHOR_ATTRIBUTE]: author } : {}
          }
        }
      }
    },
    parseHTML() {
      return [
        {
          tag: 'blockquote',
          getContent: (element, schema) => {
            const body = document.createElement('div')
            const clone = element.cloneNode(true) as HTMLElement
            // The byline is metadata, never a second editable body paragraph.
            if (normalizeQuoteAuthor(clone.getAttribute(QUOTE_AUTHOR_ATTRIBUTE)) || normalizeQuoteAuthor(findByline(clone)?.textContent)) {
              findByline(clone)?.remove()
            }
            body.append(...clone.childNodes)
            return DOMParser.fromSchema(schema).parse(body).content
          }
        }
      ]
    },
    renderHTML({ node, HTMLAttributes }) {
      const quote = createQuote(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes))
      quote.append(DOMSerializer.fromSchema(node.type.schema).serializeFragment(node.content))
      const author = normalizeQuoteAuthor(node.attrs.author)
      if (author) quote.append(createByline(author))
      return quote
    },
    addNodeView() {
      return ({ node, HTMLAttributes }) => {
        const dom = createQuote(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes))
        const author = normalizeQuoteAuthor(node.attrs.author)
        // A private view-only content container leaves the byline outside ProseMirror's
        // editable content. HTML serialization above emits only standard quote/p/span.
        const contentDOM = author ? document.createElement('div') : dom
        const byline = author ? createByline(author) : null
        if (byline) {
          contentDOM.className = 'quote-attribution__content'
          byline.contentEditable = 'false'
          dom.append(contentDOM, byline)
        }
        let currentNode = node
        return {
          dom,
          contentDOM,
          update(nextNode) {
            if (nextNode.type !== currentNode.type) return false
            if (Object.keys(currentNode.attrs).some(key => key !== 'author' && currentNode.attrs[key] !== nextNode.attrs[key])) return false
            const nextAuthor = normalizeQuoteAuthor(nextNode.attrs.author)
            if (Boolean(nextAuthor) !== Boolean(byline)) return false
            if (nextAuthor && byline) {
              byline.firstChild!.textContent = nextAuthor
              dom.setAttribute(QUOTE_AUTHOR_ATTRIBUTE, nextAuthor)
            }
            currentNode = nextNode
            return true
          },
          ignoreMutation: mutation => Boolean(byline && mutation.type !== 'selection' && byline.contains(mutation.target))
        }
      }
    },
    parseMarkdown(token, helpers) {
      const tokens = [...(token.tokens ?? [])]
      const index = tokens.findIndex(child => child.type === 'paragraph')
      const firstParagraph = tokens[index]
      const attribution = firstParagraph ? parseQuoteAttribution(firstParagraph.text ?? '') : null
      if (!attribution) return getExtensionField<NonNullable<Node['config']['parseMarkdown']>>(blockquote, 'parseMarkdown', this)(token, helpers)
      if (attribution.body) {
        if (!helpers.tokenizeInline) throw new TypeError('Markdown inline tokenizer is unavailable.')
        tokens[index] = { ...firstParagraph, text: attribution.body, tokens: helpers.tokenizeInline(attribution.body) }
      } else {
        tokens.splice(index, 1)
        const separator: MarkdownToken | undefined = tokens[index]
        if (separator?.type === 'space') tokens[index] = { ...separator, raw: (separator.raw ?? '').replace(/\n\n/u, '') }
      }
      const parseChildren = helpers.parseBlockChildren ?? helpers.parseChildren
      const content = parseChildren(tokens)
      return helpers.createNode('blockquote', { author: attribution.author }, content.length ? content : [helpers.createNode('paragraph')])
    },
    renderMarkdown(node, helpers, context) {
      const body = getExtensionField<NonNullable<Node['config']['renderMarkdown']>>(blockquote, 'renderMarkdown', this)(node, helpers, context)
      const author = normalizeQuoteAuthor(node.attrs?.author)
      return author ? `> ${serializeQuoteAttribution(author)}\n${body}` : body
    }
  })
}
