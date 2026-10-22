import { describe, expect, it } from '../server/test/bun-test.mts'
import MarkdownIt from 'markdown-it'
import * as cheerio from 'cheerio'
import markdownItQuoteAttribution, { parseQuoteAttribution, serializeQuoteAttribution } from './markdown-it-quote-attribution.ts'

const render = (source: string): string => new MarkdownIt({ html: true, linkify: true, typographer: true }).use(markdownItQuoteAttribution).render(source)

const expectedQuote =
  '<blockquote data-quote-author="Ada">\n<p>Quoted <strong>body</strong>.</p>\n<p class="quote-attribution"><span>Ada</span></p>\n</blockquote>\n'

describe('Markdown quote attribution', () => {
  it('gives same-line and marker-only first paragraphs the same separate byline', () => {
    for (const source of ['> [name= Ada ] Quoted **body**.', '> [name=Ada]\n> Quoted **body**.', '> [name=Ada]\n>\n> Quoted **body**.']) {
      expect(render(source)).toBe(expectedQuote)
    }
    const $ = cheerio.load(render('> [name=Ada]'))
    const quote = $('blockquote')
    expect(quote).toHaveLength(1)
    expect(quote.attr('data-quote-author')).toBe('Ada')
    expect(quote.children()).toHaveLength(1)
    expect(quote.children('p.quote-attribution')).toHaveLength(1)
    expect(quote.children('p.quote-attribution').children('span').text()).toBe('Ada')
  })

  it('leaves ordinary quotes, later paragraphs, malformed names, and code unchanged', () => {
    const ordinary = new MarkdownIt({ html: true, linkify: true, typographer: true })
    for (const source of [
      '[name=Outside] Body',
      '> Ordinary **quote**.',
      '> \\[name=Escaped] Body',
      '> First\n>\n> [name=Later] Body',
      '> [name=] Body',
      '> [name=   ] Body',
      '> [name=Two\n> lines] Body',
      '> `[name=Inline]`',
      '> ```text\n> [name=Fenced]\n> ```',
      '    > [name=Indented] Body'
    ])
      expect(render(source)).toBe(ordinary.render(source))
  })

  it('attributes nested quotes independently without stealing a parent or later paragraph marker', () => {
    const output = render('> [name=Outer] First\n>\n> [name=Later] Literal\n>\n> > [name=Inner] Nested')
    expect(output).toContain('<p>[name=Later] Literal</p>')
    expect(output).toContain('<blockquote data-quote-author="Inner">\n<p>Nested</p>\n<p class="quote-attribution"><span>Inner</span></p>\n</blockquote>')
    expect(output.endsWith('<p class="quote-attribution"><span>Outer</span></p>\n</blockquote>\n')).toBe(true)
  })

  it('keeps author punctuation literal and round-trips escaped marker delimiters', () => {
    const author = '[link](javascript:alert(1)) \\ path **bold** "quotes" & <img src=x onerror=alert(1)>'
    const marker = serializeQuoteAttribution(author)
    expect(parseQuoteAttribution(`${marker} Body`)).toEqual({ author, body: 'Body' })
    const output = render(`> ${marker} [Body](https://example.test) [Bad](javascript:alert(1))`)
    expect(output).toContain('<span>[link](javascript:alert(1)) \\ path **bold** &quot;quotes&quot; &amp; &lt;img src=x onerror=alert(1)&gt;</span>')
    expect(output).not.toContain('<img')
    expect(output).not.toContain('href="javascript:')
    expect(output).toContain('<a href="https://example.test">Body</a>')
    expect(output).not.toContain('<strong>bold</strong>')
    expect(parseQuoteAttribution('[name= \t ] Body')).toBeNull()
    expect(parseQuoteAttribution('[name=One\nTwo] Body')).toBeNull()
  })
})
