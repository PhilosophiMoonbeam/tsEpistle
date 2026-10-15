import * as cheerio from 'cheerio'
import katex from 'katex'
import MarkdownIt, { type Token } from 'markdown-it'
import attrs from 'markdown-it-attrs'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'
import previewMath from '../../../client/components/editor/common/katex.ts'

// Static imports cannot work here: native modules capture WIKI before this fixture can install it.
const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
Object.defineProperty(globalThis, 'WIKI', {
  configurable: true,
  writable: true,
  value: { logger: console }
})
afterAll(() => {
  if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
  else Reflect.deleteProperty(globalThis, 'WIKI')
})

async function inServerEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  // MathJax chooses its global at load time; JSDOM's separate window is not
  // present in the actual server process.
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'window')
  try {
    return await operation()
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

const { katexRenderer, mathjaxRenderer } = await inServerEnvironment(async () => {
  const { default: katexRenderer } = await import('../../modules/rendering/markdown-katex/renderer.ts')
  const { default: mathjaxRenderer } = await import('../../modules/rendering/markdown-mathjax/renderer.ts')
  return { katexRenderer, mathjaxRenderer }
})

type Markdown = InstanceType<typeof MarkdownIt>
type MathConfig = { useInline: boolean; useBlocks: boolean }

const engines = [
  { name: 'KaTeX', plugin: katexRenderer, inline: 'katex_inline', block: 'katex_block' },
  { name: 'MathJax', plugin: mathjaxRenderer, inline: 'mathjax_inline', block: 'mathjax_block' }
]

function inlineTokens(markdown: Markdown, source: string): Token[] {
  return markdown.parse(source, {}).flatMap(token => token.children ?? [])
}

function markdownWithAttrs(): Markdown {
  return new MarkdownIt().use(attrs, { allowedAttributes: ['id', 'class', 'target'] })
}

for (const engine of engines) {
  describe(`${engine.name} native math delimiters`, () => {
    const modes: Partial<Record<string, Markdown>> = {}
    let preview: Markdown

    beforeAll(async () => {
      for (const config of [
        { useInline: true, useBlocks: true },
        { useInline: false, useBlocks: true },
        { useInline: true, useBlocks: false },
        { useInline: false, useBlocks: false }
      ]) {
        const markdown = markdownWithAttrs()
        await inServerEnvironment(async () => engine.plugin.init(markdown, config))
        modes[`${config.useInline}/${config.useBlocks}`] = markdown
      }
      preview = markdownWithAttrs()
      preview.inline.ruler.after('escape', 'katex_inline', previewMath.katexInline)
      preview.block.ruler.after('blockquote', 'katex_block', previewMath.katexBlock)
      preview.renderer.rules.katex_inline = (tokens, index) => {
        const token = tokens[index]
        if (!token) throw new Error('Missing preview math token')
        return katex.renderToString(token.content)
      }
    })

    function renderer(config: MathConfig = { useInline: true, useBlocks: true }): Markdown {
      const markdown = modes[`${config.useInline}/${config.useBlocks}`]
      if (!markdown) throw new Error('Math renderer has not initialized')
      return markdown
    }

    it('renders explicit framing as math without changing TeX or ordinary dollar syntax', () => {
      const tex = String.raw`\frac{a_1}{b^2} + \text{cost \$5}`
      const explicit = '$`' + tex + '`$'
      const markdown = renderer()
      const rendered = markdown.render(explicit)
      expect(rendered).toBe(markdown.render('$' + tex + '$'))
      const document = cheerio.load(rendered)
      if (engine.name === 'KaTeX') expect(document('math')).toHaveLength(1)
      expect(document('mfrac, svg g[data-mml-node="mfrac"]')).toHaveLength(1)
      expect(document('merror, [data-mml-node="merror"]')).toHaveLength(0)
      // Preview uses the same framing and keeps braces opaque to attrs.
      const previewDocument = cheerio.load(preview.render(explicit))
      expect(previewDocument('annotation[encoding="application/x-tex"]').text()).toBe(tex)
      expect(previewDocument('mfrac')).toHaveLength(1)
    })

    it('renders inline and block font variants and chemistry after engine initialization', () => {
      for (const tex of [String.raw`\mathcal{ABCDEFGHIJKLMNOPQRSTUVWXYZ} + \mathfrak{abc}`, String.raw`\ce{H2 + O2 -> H2O}`]) {
        for (const source of ['$`' + tex + '`$', '$$' + tex + '$$']) {
          const document = cheerio.load(renderer().render(source))
          if (engine.name === 'KaTeX') expect(document('math')).toHaveLength(1)
          expect(document('merror, [data-mml-node="merror"]')).toHaveLength(0)
          if (engine.name === 'MathJax') {
            expect(document('svg g[data-mml-node="mi"], svg g[data-mml-node="mtext"]').length).toBeGreaterThan(0)
            expect(document('svg path[d]').length).toBeGreaterThan(0)
          } else {
            expect(document('math mi, math mtext').length).toBeGreaterThan(0)
          }
          expect(document('svg [href^="http"], svg [xlink\\:href^="http"]')).toHaveLength(0)
        }
      }
    })

    it('keeps explicit TeX opaque until an unescaped backtick-dollar closer', () => {
      const cases = [
        { source: '$`a $ b`$', tex: 'a $ b' },
        { source: '$` x + y `$2', tex: ' x + y ' },
        { source: '$`a\\`$b`$', tex: 'a\\`$b' },
        { source: '$`a\\\\`$', tex: 'a\\\\' }
      ]
      for (const { source, tex } of cases) {
        const native = inlineTokens(renderer(), source).filter(token => token.type === engine.inline)
        const editor = inlineTokens(preview, source).filter(token => token.type === 'katex_inline')
        expect(native.map(token => token.content)).toEqual([tex])
        expect(editor.map(token => token.content)).toEqual([tex])
      }
    })

    it('leaves currency, code, escapes and unmatched explicit delimiters to Markdown', () => {
      for (const source of ['Prices are $5 and $10.', '`$x$` and ``$`x`$``', '\\$x$', '\\$`x`$', '$`x$', '$`x`', '$``$', '$x $', '$x$2']) {
        const markdown = renderer()
        expect(inlineTokens(markdown, source).filter(token => token.type === engine.inline)).toHaveLength(0)
        expect(inlineTokens(preview, source).filter(token => token.type === 'katex_inline')).toHaveLength(0)
        const ordinary = markdownWithAttrs().render(source)
        expect(markdown.render(source)).toBe(ordinary)
        expect(preview.render(source)).toBe(ordinary)
      }
      const source = '```tex\n$`x^2`$\n$$y$$\n```'
      expect(renderer().render(source)).toBe(markdownWithAttrs().render(source))
    })

    it('preserves escaped legacy dollars and independent inline/block configuration gates', () => {
      const escaped = String.raw`$x + \$5$`
      expect(
        inlineTokens(renderer(), escaped)
          .filter(token => token.type === engine.inline)
          .map(token => token.content)
      ).toEqual([String.raw`x + \$5`])
      for (const config of [
        { useInline: true, useBlocks: true },
        { useInline: false, useBlocks: true },
        { useInline: true, useBlocks: false },
        { useInline: false, useBlocks: false }
      ]) {
        const markdown = renderer(config)
        for (const source of ['$x^2$', '$`x^2`$']) {
          const math = inlineTokens(markdown, source).filter(token => token.type === engine.inline)
          expect(math).toHaveLength(config.useInline ? 1 : 0)
          if (!config.useInline) expect(markdown.render(source)).toBe(markdownWithAttrs().render(source))
        }
        const block = markdown.parse('$$x^2$$', {}).filter(token => token.type === engine.block)
        expect(block).toHaveLength(config.useBlocks ? 1 : 0)
        if (!config.useBlocks) {
          expect(markdown.render('$$x^2$$')).toBe(markdownWithAttrs().render('$$x^2$$'))
        }
      }
    })
  })
}
