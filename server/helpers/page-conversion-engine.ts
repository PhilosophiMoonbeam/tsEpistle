import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'
import { PAGE_CONVERSION_LIMITS as limits, type ConversionResult, type ConversionWorkerInput } from './page-conversion-protocol.ts'
import markdownCore from '../modules/rendering/markdown-core/renderer.ts'

const safeChildren: Record<string, true> = {
  markdownAbbr: true, markdownDeflist: true, markdownEmoji: true, markdownExpandtabs: true,
  markdownFootnotes: true, markdownImsize: true, markdownMark: true, markdownMultiTable: true,
  markdownSupsub: true, markdownTasklists: true
}

/** Runs only in the killable child; never call with authored HTML on the request thread. */
export async function convertHtmlCandidate(input: ConversionWorkerInput): Promise<ConversionResult> {
  if (Buffer.byteLength(input.source, 'utf8') > limits.inputBytes) throw new Error('input budget')
  const $ = cheerio.load(input.source, {}, false)
  const stack: Array<{ node: AnyNode; depth: number }> = $.root().contents().toArray().map(node => ({ node, depth: 1 }))
  let count = 0
  while (stack.length > 0) {
    const item = stack.pop()!
    if (++count > limits.nodes || item.depth > limits.depth) throw new Error('structure budget')
    if ('children' in item.node) {
      for (const node of item.node.children) stack.push({ node, depth: item.depth + 1 })
    }
  }
  if ($('td,th').length > limits.tableCells || $('tr').length > limits.tableRows) throw new Error('table budget')
  $('tr').each((_index, row) => {
    const width = $(row).children('td,th').toArray().reduce((sum, cell) => sum + Number($(cell).attr('colspan') ?? 1), 0)
    if (!Number.isFinite(width) || width > limits.tableColumns) throw new Error('table column budget')
  })
  $('td,th').each((_index, cell) => {
    for (const attribute of ['colspan', 'rowspan']) {
      const raw = $(cell).attr(attribute)
      if (raw !== undefined && (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > (attribute === 'colspan' ? limits.tableColumns : limits.tableRows))) throw new Error('table span budget')
    }
  })
  const warnings: string[] = [
    'Conversion is not certified lossless. Compare the exact original HTML, candidate and native Markdown-core preview before confirming.',
    'Preview uses the configured native Markdown core and supported local child renderers; downstream HTML transforms, browser/editor normalization and network extensions are not simulated.',
    'Original authored HTML is retained exactly in canonical page history on confirmation; cancelling keeps the current HTML editor and source unchanged.',
    'Reviews expire after five minutes and remain only in this server process. A restart or confirmation on another instance requires a fresh review.',
    `Isolated work is limited to ${limits.inputBytes / 1024} KiB input and ${limits.deadlineMs / 1000} seconds, with at most ${limits.concurrency} concurrent conversions. Resident memory is monitored at ${limits.monitorMs} ms intervals against ${limits.rssBytes / 1024 / 1024} MiB; transient overshoot is possible. This is not a hard heap cap.`
  ]
  if ($('[style],[class], [id]').length) warnings.push('HTML styling, classes and element identifiers may not survive Markdown conversion.')
  if ($('script,style,iframe,object,embed,video,audio,form,svg,math,tabset,template').length) warnings.push('Unsupported active, embedded or custom HTML is present; its behavior cannot be represented faithfully in Markdown.')
  if ($('table table,td[colspan],th[colspan],td[rowspan],th[rowspan],td pre,td ul,td ol,td blockquote').length) warnings.push('Merged, nested or block-rich tables may remain raw HTML or lose table structure; inspect the table differences.')
  if ($('table').filter((_index, table) => $(table).find('th').length === 0).length) warnings.push('Headerless tables may acquire a synthetic empty header.')
  const td = new TurndownService({
    bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', fence: '```',
    headingStyle: 'atx', hr: '---', linkStyle: 'inlined', preformattedCode: true, strongDelimiter: '**'
  })
  td.use(gfm)
  td.keep(['kbd'])
  td.addRule('subscript', { filter: ['sub'], replacement: content => `~${content}~` })
  td.addRule('superscript', { filter: ['sup'], replacement: content => `^${content}^` })
  td.addRule('underline', { filter: ['u'], replacement: content => `_${content}_` })
  td.addRule('taskList', {
    filter: node => node.nodeName === 'INPUT' && node.getAttribute('type') === 'checkbox',
    replacement: (_content, node) => node.hasAttribute('checked') ? '[x] ' : '[ ] '
  })
  td.addRule('removeTocAnchors', { filter: node => node.nodeName === 'A' && node.classList.contains('toc-anchor'), replacement: () => '' })
  // Turndown's recursive converted child content can add emphasis delimiters inside code.
  // Use decoded DOM text, and choose delimiters that cannot close within that text.
  td.addRule('literalPre', {
    filter: ['pre'],
    replacement: (_content, node) => {
      const text = node.textContent ?? ''
      const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length))
      const fence = '`'.repeat(longest + 1)
      return `\n\n${fence}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`
    }
  })
  td.addRule('literalCode', {
    filter: ['code'],
    replacement: (_content, node) => {
      const text = (node.textContent ?? '').replaceAll('\n', ' ')
      const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length))
      const delimiter = '`'.repeat(longest + 1)
      const pad = text.startsWith('`') || text.endsWith('`') || (/^ .+ $/.test(text) && text.trim() !== '') ? ' ' : ''
      return `${delimiter}${pad}${text}${pad}${delimiter}`
    }
  })
  const candidate = td.turndown(input.source)
  if (Buffer.byteLength(candidate, 'utf8') > limits.outputBytes) throw new Error('output budget')
  if (candidate.trim() === '' && input.source.trim() !== '') warnings.push('The candidate is empty. Confirming explicitly replaces the HTML source with an empty Markdown document.')
  const children = input.children.filter(child => safeChildren[child.key] === true)
  if (children.length !== input.children.length) warnings.push('Some configured child renderers are excluded from isolated preview because they require external services or unsupported capabilities.')
  const previewHtml = await markdownCore.render.call({
    input: candidate,
    config: {
      ...input.config,
      allowHTML: input.config.allowHTML !== false,
      linebreaks: input.config.linebreaks === true,
      linkify: input.config.linkify === true,
      typographer: input.config.typographer === true,
      quotes: typeof input.config.quotes === 'string' ? input.config.quotes : 'English',
      underline: input.config.underline === true
    },
    children: children.map((child, order) => ({ ...child, order, step: 'markdown' })),
    page: input.page
  })
  if (Buffer.byteLength(previewHtml, 'utf8') > limits.outputBytes) throw new Error('preview budget')
  const after = cheerio.load(previewHtml, {}, false)
  const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim()
  const beforeCode = $('pre,code').map((_i, node) => $(node).text()).toArray()
  const afterCode = after('pre,code').map((_i, node) => after(node).text()).toArray()
  const beforeLinks = $('a').map((_i, node) => JSON.stringify([$(node).attr('href'), $(node).text()])).toArray()
  const afterLinks = after('a').map((_i, node) => JSON.stringify([after(node).attr('href'), after(node).text()])).toArray()
  const beforeTables = $('table').map((_i, node) => $(node).html() ?? '').toArray()
  const afterTables = after('table').map((_i, node) => after(node).html() ?? '').toArray()
  const differences = {
    text: normalizeText($.root().text()) !== normalizeText(after.root().text()),
    code: JSON.stringify(beforeCode) !== JSON.stringify(afterCode),
    links: JSON.stringify(beforeLinks) !== JSON.stringify(afterLinks),
    tables: JSON.stringify(beforeTables) !== JSON.stringify(afterTables)
  }
  if (Object.values(differences).some(Boolean)) warnings.push('Native preview differs from the source in the flagged categories. These comparisons are diagnostics, not a complete semantic or visual equivalence proof.')
  const roundtripSource = td.turndown(previewHtml)
  if (Buffer.byteLength(roundtripSource, 'utf8') > limits.outputBytes) throw new Error('roundtrip budget')
  if (candidate !== roundtripSource) warnings.push('Markdown → native preview → Markdown is not stable; compare the roundtrip source below.')
  return { candidate, report: { warnings, differences, previewHtml, roundtripSource, renderer: 'native markdownCore + admitted local children (not the complete publication/editor pipeline)' } }
}
