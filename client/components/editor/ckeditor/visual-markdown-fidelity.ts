import MarkdownIt, { type Token } from 'markdown-it'
import mdDeflist from 'markdown-it-deflist'
import mdMark from 'markdown-it-mark'
import mdSub from 'markdown-it-sub'
import mdSup from 'markdown-it-sup'
import {
  AttributeCommand,
  ButtonView,
  IconCode,
  IconMarker,
  IconSubscript,
  IconSuperscript,
  Plugin,
  type DecoupledEditor
} from 'ckeditor5'

const markdown = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: false,
  typographer: false
}).use(mdMark).use(mdSub).use(mdSup).use(mdDeflist)

const keptHtmlElements = ['mark', 'kbd', 'dl', 'dt', 'dd'] as const

type MarkdownProcessor = {
  keepHtml: (element: typeof keptHtmlElements[number]) => void
}


type SourceSpan = {
  start: number
  end: number
  html: string
}

export class VisualMarkdownFidelity extends Plugin {
  static get pluginName (): 'VisualMarkdownFidelity' {
    return 'VisualMarkdownFidelity'
  }

  init (): void {
    const definitions = [
      {
        attribute: 'wikiHighlight',
        component: 'wikiHighlight',
        element: {
          name: 'kbd',
          attributes: { 'data-wiki-highlight': 'true' }
        },
        icon: IconMarker,
        label: 'Highlight'
      },
      {
        attribute: 'wikiSubscript',
        component: 'wikiSubscript',
        element: {
          name: 'kbd',
          attributes: { 'data-wiki-subscript': 'true' }
        },
        icon: IconSubscript,
        label: 'Subscript'
      },
      {
        attribute: 'wikiSuperscript',
        component: 'wikiSuperscript',
        element: {
          name: 'kbd',
          attributes: { 'data-wiki-superscript': 'true' }
        },
        icon: IconSuperscript,
        label: 'Superscript'
      },
      {
        attribute: 'wikiKeyboard',
        component: 'wikiKeyboard',
        element: {
          name: 'kbd',
          attributes: { 'data-wiki-keyboard': 'true' }
        },
        icon: IconCode,
        label: 'Keyboard key'
      }
    ] as const

    for (const definition of definitions) {
      this.editor.model.schema.extend('$text', { allowAttributes: definition.attribute })
      this.editor.conversion.attributeToElement({
        model: definition.attribute,
        view: definition.element
      })
      const command = new AttributeCommand(this.editor, definition.attribute)
      this.editor.commands.add(definition.component, command)
      this.editor.ui.componentFactory.add(definition.component, locale => {
        const button = new ButtonView(locale)
        button.set({
          icon: definition.icon,
          isToggleable: true,
          label: definition.label,
          tooltip: true
        })
        button.bind('isEnabled').to(command, 'isEnabled')
        button.bind('isOn').to(command, 'value', value => Boolean(value))
        this.listenTo(button, 'execute', () => {
          this.editor.execute(definition.component)
          this.editor.editing.view.focus()
        })
        return button
      })
    }
  }

  afterInit (): void {
    const processor = this.editor.data.processor as unknown as Partial<MarkdownProcessor>
    if (typeof processor.keepHtml !== 'function') {
      throw new TypeError('Visual Markdown requires the Markdown data processor.')
    }
    for (const element of keptHtmlElements) processor.keepHtml(element)
  }
}

function findBlockEnd (tokens: Token[], start: number): number {
  const opening = tokens[start]
  if (!opening || opening.nesting !== 1) return start

  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    depth += tokens[index]?.nesting ?? 0
    if (depth === 0) return index
  }
  return start
}

function visualBlockSpans (source: string): SourceSpan[] {
  const environment = {}
  const tokens = markdown.parse(source, environment)
  const spans: SourceSpan[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.level !== 0 || token.nesting !== 1 || !token.map) continue

    const endIndex = findBlockEnd(tokens, index)
    const blockTokens = tokens.slice(index, endIndex + 1)
    const needsVisualConversion = token.type === 'dl_open' ||
      blockTokens.some(candidate => [candidate, ...(candidate.children ?? [])]
        .some(nested => ['mark_open', 'sub_open', 'sup_open'].includes(nested.type)))
    if (!needsVisualConversion) continue

    spans.push({
      start: token.map[0],
      end: token.map[1],
      html: markdown.renderer.render(blockTokens, markdown.options, environment)
        .replaceAll('<mark>', '<kbd data-wiki-highlight="true">')
        .replaceAll('</mark>', '</kbd>')
        .replaceAll('<sub>', '<kbd data-wiki-subscript="true">')
        .replaceAll('</sub>', '</kbd>')
        .replaceAll('<sup>', '<kbd data-wiki-superscript="true">')
        .replaceAll('</sup>', '</kbd>')
        .replace(/<kbd>([\s\S]*?)<\/kbd>/gi, '<kbd data-wiki-keyboard="true">$1</kbd>')
        .trimEnd()
    })
    index = endIndex
  }

  return spans
}

/**
 * Converts extended Markdown into semantic HTML understood by CKEditor while
 * keeping the page's persisted representation as Markdown.
 */
export function prepareVisualMarkdownData (source: string): string {
  const spans = visualBlockSpans(source)
  if (spans.length === 0) return source

  const lines = source.split('\n')
  for (const span of spans.reverse()) {
    lines.splice(span.start, span.end - span.start, span.html)
  }
  return lines.join('\n')
}

function inlineNodeToMarkdown (node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''

  const content = Array.from(node.childNodes).map(inlineNodeToMarkdown).join('')
  switch (node.tagName) {
    case 'A': return `[${content}](${node.getAttribute('href') ?? ''})`
    case 'BR': return '\n'
    case 'CODE': return `\`${content}\``
    case 'EM': return `_${content}_`
    case 'KBD': return `<kbd>${content}</kbd>`
    case 'MARK': return `==${content}==`
    case 'S': return `~~${content}~~`
    case 'STRONG': return `**${content}**`
    case 'SUB': return `~${content}~`
    case 'SUP': return `^${content}^`
    default: return content
  }
}

function definitionBodyToMarkdown (element: HTMLElement): string {
  const blocks = Array.from(element.children)
  if (blocks.length === 0) return inlineNodeToMarkdown(element).trim()

  return blocks
    .map(block => inlineNodeToMarkdown(block).trim())
    .filter(Boolean)
    .join('\n\n')
}

function definitionListToMarkdown (element: HTMLElement): string {
  const lines: string[] = []
  let pendingTerms: string[] = []

  for (const child of Array.from(element.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.tagName === 'DT') {
      pendingTerms.push(inlineNodeToMarkdown(child).trim())
      continue
    }
    if (child.tagName !== 'DD') continue

    lines.push(...pendingTerms)
    pendingTerms = []
    const body = definitionBodyToMarkdown(child)
    const [first = '', ...remaining] = body.split('\n')
    lines.push(`: ${first}`)
    lines.push(...remaining.map(line => line.length > 0 ? `  ${line}` : ''))
    lines.push('')
  }

  lines.push(...pendingTerms)
  return lines.join('\n').trimEnd()
}

function restoreDefinitionLists (source: string): string {
  return source.replace(/<dl(?:\s[^>]*)?>[\s\S]*?<\/dl>/gi, html => {
    const template = document.createElement('template')
    template.innerHTML = html
    const definitionList = template.content.querySelector('dl')
    return definitionList instanceof HTMLElement ? definitionListToMarkdown(definitionList) : html
  })
}

/** Converts CKEditor's semantic HTML extensions back to canonical Markdown. */
export function serializeVisualMarkdownData (source: string): string {
  return restoreDefinitionLists(source)
    .replace(/<kbd data-wiki-highlight="true">([\s\S]*?)<\/kbd>/gi, '==$1==')
    .replace(/<kbd data-wiki-subscript="true">([\s\S]*?)<\/kbd>/gi, '~$1~')
    .replace(/<kbd data-wiki-superscript="true">([\s\S]*?)<\/kbd>/gi, '^$1^')
    .replace(/<kbd data-wiki-keyboard="true">([\s\S]*?)<\/kbd>/gi, '<kbd>$1</kbd>')
}

export function insertVisualMarkdownDefinitionList (editor: DecoupledEditor): void {
  const source = prepareVisualMarkdownData('Term\n: Definition\n\nTerm\n: Definition')
  const view = editor.data.processor.toView(source)
  const model = editor.data.toModel(view)
  editor.model.insertContent(model, editor.model.document.selection)
}