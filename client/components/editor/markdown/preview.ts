import DOMPurify from 'dompurify'
import katex from 'katex'
import MarkdownIt from 'markdown-it'
import mdAbbr from 'markdown-it-abbr'
import mdAttrs from 'markdown-it-attrs'
import mdDeflist from 'markdown-it-deflist'
import { full as mdEmoji } from 'markdown-it-emoji'
import mdExpandTabs from 'markdown-it-expand-tabs'
import mdFootnote from 'markdown-it-footnote'
import mdMark from 'markdown-it-mark'
import mdMultiTable from 'markdown-it-multimd-table'
import mdSub from 'markdown-it-sub'
import mdSup from 'markdown-it-sup'
import mdTaskLists from 'markdown-it-task-lists'
import mermaid from 'mermaid'
import twemoji from 'twemoji'
import 'katex/dist/contrib/mhchem.mjs'

import { renderMarkdownCodeFence } from '../../../../shared/markdown-code-fence.ts'
import mdImsize from '../../../../shared/markdown-it-image-size.ts'
import { decodeBase64Text } from '../../../helpers/base64.ts'
import underline from '../../../libs/markdown-it-underline/index.ts'
import Prism from '../../../libs/prism/setup.ts'
import katexHelper from '../common/katex.ts'
import plantuml from './plantuml.ts'
import tabsetHelper from './tabset.ts'

let mermaidId = 0

DOMPurify.addHook('uponSanitizeElement', node => {
  if (!(node instanceof Element)) return
  const breaks = node.querySelectorAll('foreignObject br, foreignObject p')
  breaks.forEach(breakElement => {
    breakElement.parentNode?.replaceChild(document.createElement('div'), breakElement)
  })
})

export function createWikiMarkdownRenderer (): InstanceType<typeof MarkdownIt> {
  const markdown = new MarkdownIt({
    html: true,
    breaks: true,
    linkify: true,
    typographer: true
  })
    .use(mdAttrs, {
      allowedAttributes: ['id', 'class', 'target']
    })
    .use(underline)
    .use(mdEmoji)
    .use(mdTaskLists, { label: false, labelAfter: false })
    .use(mdExpandTabs)
    .use(mdAbbr)
    .use(mdSup)
    .use(mdSub)
    .use(mdMultiTable, { multiline: true, rowspan: true, headerless: true })
    .use(mdMark)
    .use(mdDeflist)
    .use(mdFootnote)
    .use(mdImsize)

  plantuml.init(markdown, {})
  markdown.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    if (!token) throw new TypeError('Markdown fence token is unavailable.')
    return renderMarkdownCodeFence({
      source: token.content,
      info: token.info,
      decodeDiagram: decodeBase64Text,
      unescape: value => markdown.utils.unescapeAll(value)
    })
  }

  const macros: Record<string, string> = {}
  markdown.inline.ruler.after('escape', 'katex_inline', katexHelper.katexInline)
  markdown.renderer.rules.katex_inline = (tokens, index) => {
    try {
      return katex.renderToString(tokens[index]!.content, {
        displayMode: false,
        macros
      })
    } catch (error) {
      console.warn(error)
      return tokens[index]!.content
    }
  }
  markdown.block.ruler.after('blockquote', 'katex_block', katexHelper.katexBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })
  markdown.renderer.rules.katex_block = (tokens, index) => {
    try {
      return `<p>${katex.renderToString(tokens[index]!.content, {
        displayMode: true,
        macros
      })}</p>`
    } catch (error) {
      console.warn(error)
      return tokens[index]!.content
    }
  }

  markdown.renderer.rules.emoji = (tokens, index) => twemoji.parse(tokens[index]!.content, {
    callback: icon => `/_assets/svg/twemoji/${icon}.svg`
  })

  return markdown
}

export function sanitizeWikiMarkdownHtml (html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true }
  })
}

export function enhanceWikiMarkdownPreview (root: HTMLElement, dark = false): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default'
  })
  tabsetHelper.format()
  void renderMermaidDiagrams(root)
  Prism.highlightAllUnder(root)
  root.querySelectorAll('pre.line-numbers').forEach(pre => {
    pre.classList.add('prismjs')
  })
}

async function renderMermaidDiagrams (root: HTMLElement): Promise<void> {
  const elements = root.querySelectorAll<HTMLElement>('pre.codeblock-mermaid > code')
  for (const element of elements) {
    const codeBlock = element.parentElement
    if (!codeBlock) continue
    const id = `mermaid-id-${++mermaidId}`
    try {
      const { svg, bindFunctions } = await mermaid.render(id, element.innerText)
      const mermaidElement = document.createElement('div')
      mermaidElement.innerHTML = svg
      codeBlock.replaceWith(mermaidElement)
      bindFunctions?.(mermaidElement)
    } catch {
      // Keep invalid diagram source visible.
    }
  }
}
