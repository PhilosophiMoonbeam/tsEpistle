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
import twemoji from 'twemoji'
import 'katex/dist/contrib/mhchem.mjs'

import { renderMarkdownCodeFence } from '../../../../shared/markdown-code-fence.ts'
import mdImsize from '../../../../shared/markdown-it-image-size.ts'
import { decodeBase64Text } from '../../../helpers/base64.ts'
import {
  MERMAID_MAX_DIAGRAMS_PER_ROOT,
  MERMAID_MAX_TEXT_SIZE,
  renderMermaidSvg,
  selectMermaidRenderHosts
} from '../../../helpers/content-extension-runtimes/mermaid.ts'
import underline from '../../../libs/markdown-it-underline/index.ts'
import Prism from '../../../libs/prism/setup.ts'
import katexHelper from '../common/katex.ts'
import plantuml from './plantuml.ts'
import tabsetHelper from './tabset.ts'

DOMPurify.addHook('uponSanitizeElement', node => {
  if (!(node instanceof Element)) return
  const breaks = node.querySelectorAll('foreignObject br, foreignObject p')
  breaks.forEach(breakElement => {
    breakElement.parentNode?.replaceChild(document.createElement('div'), breakElement)
  })
})

export function createWikiMarkdownRenderer(): InstanceType<typeof MarkdownIt> {
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

  markdown.renderer.rules.emoji = (tokens, index) =>
    twemoji.parse(tokens[index]!.content, {
      callback: icon => `/_assets/svg/twemoji/${icon}.svg`
    })

  return markdown
}

export function sanitizeWikiMarkdownHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['foreignObject'],
    HTML_INTEGRATION_POINTS: { foreignobject: true }
  })
}
const MERMAID_ERROR_CLASS = 'content-extension-diagram__error'
const MERMAID_ERROR_MESSAGE = 'Diagram could not be rendered locally. Its source remains available below.'
const MERMAID_LIMIT_NOTICE_CLASS = 'content-extension-diagram__limit-notice'
const MERMAID_LIMIT_NOTICE_MESSAGE = `Additional diagrams remain available as source because only ${MERMAID_MAX_DIAGRAMS_PER_ROOT} diagrams are rendered automatically per preview.`
const editorMermaidControllers = new WeakMap<HTMLElement, AbortController>()

const showMermaidLimitNotice = (root: HTMLElement): void => {
  if (root.querySelector(`.${MERMAID_LIMIT_NOTICE_CLASS}`)) return
  const notice = root.ownerDocument.createElement('p')
  notice.className = MERMAID_LIMIT_NOTICE_CLASS
  notice.textContent = MERMAID_LIMIT_NOTICE_MESSAGE
  root.append(notice)
}

export function enhanceWikiMarkdownPreview(root: HTMLElement, dark = false): void {
  editorMermaidControllers.get(root)?.abort()
  const controller = new AbortController()
  editorMermaidControllers.set(root, controller)
  for (const codeBlock of root.querySelectorAll<HTMLElement>('pre.codeblock-mermaid')) {
    if (codeBlock.dataset.editorMermaidState === 'pending') delete codeBlock.dataset.editorMermaidState
  }
  const allHosts = [...root.querySelectorAll<HTMLElement>('pre.codeblock-mermaid, .editor-mermaid-rendered[data-editor-mermaid-host]')]
  const candidates = allHosts.filter(host => {
    if (!host.isConnected || !root.contains(host)) return false
    if (host.matches('.editor-mermaid-rendered')) return true
    const source = host.querySelector<HTMLElement>('code')?.textContent ?? ''
    return source.length <= MERMAID_MAX_TEXT_SIZE
  })
  const mermaidHosts = selectMermaidRenderHosts(candidates)
  const excess = allHosts.filter(host => {
    const source = host.matches('.editor-mermaid-rendered') ? null : (host.querySelector<HTMLElement>('code')?.textContent ?? '')
    return source !== null && !mermaidHosts.has(host)
  })
  for (const codeBlock of excess) codeBlock.setAttribute('aria-busy', 'false')
  if (excess.length > 0) showMermaidLimitNotice(root)
  tabsetHelper.format()
  void renderMermaidDiagrams(root, dark ? 'dark' : 'default', controller.signal, () => editorMermaidControllers.get(root) === controller, mermaidHosts)
  Prism.highlightAllUnder(root)
  root.querySelectorAll('pre.line-numbers').forEach(pre => {
    pre.classList.add('prismjs')
  })
}

async function renderMermaidDiagrams(
  root: HTMLElement,
  theme: 'default' | 'dark',
  signal: AbortSignal,
  isCurrent: () => boolean,
  mermaidHosts: ReadonlySet<HTMLElement>
): Promise<void> {
  const elements = [...root.querySelectorAll<HTMLElement>('pre.codeblock-mermaid > code')]
  const jobs = elements.flatMap(element => {
    const codeBlock = element.parentElement
    if (!codeBlock) return []
    const source = element.innerText
    const state = codeBlock.dataset.editorMermaidState
    if (
      !mermaidHosts.has(codeBlock) ||
      state === 'rendered' ||
      state === 'source-only' ||
      state === 'failed' ||
      state === 'pending' ||
      source.length > MERMAID_MAX_TEXT_SIZE
    ) {
      codeBlock.setAttribute('aria-busy', 'false')
      if (source.length > MERMAID_MAX_TEXT_SIZE) codeBlock.dataset.editorMermaidState = 'source-only'
      return []
    }
    codeBlock.dataset.editorMermaidState = 'pending'
    return [
      async (): Promise<void> => {
        const current = (): boolean => isCurrent() && root.isConnected && codeBlock.isConnected && root.contains(codeBlock)
        codeBlock.setAttribute('aria-busy', 'true')
        try {
          const safeSvg = await renderMermaidSvg(source, {
            ownerDocument: root.ownerDocument,
            theme,
            signal,
            isCurrent: current
          })
          if (!safeSvg || !current()) return
          const mermaidElement = root.ownerDocument.createElement('div')
          mermaidElement.className = 'editor-mermaid-rendered'
          mermaidElement.dataset.editorMermaidHost = 'true'
          mermaidElement.append(safeSvg)
          codeBlock.replaceWith(mermaidElement)
          codeBlock.dataset.editorMermaidState = 'rendered'
        } catch {
          if (!current()) return
          if (!codeBlock.previousElementSibling?.classList.contains(MERMAID_ERROR_CLASS)) {
            const status = root.ownerDocument.createElement('p')
            status.className = MERMAID_ERROR_CLASS
            status.setAttribute('role', 'alert')
            status.textContent = MERMAID_ERROR_MESSAGE
            codeBlock.before(status)
          }
          codeBlock.dataset.editorMermaidState = 'failed'
        } finally {
          if (current()) codeBlock.setAttribute('aria-busy', 'false')
        }
      }
    ]
  })
  await Promise.all(jobs.map(job => job()))
}
