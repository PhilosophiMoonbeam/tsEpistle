import * as cheerio from 'cheerio'
import renderer from '../../modules/rendering/markdown-core/renderer.ts'

const baseConfig = {
  allowHTML: false,
  linebreaks: false,
  linkify: false,
  typographer: false,
  quotes: 'English',
  underline: false
}

const renderMarkdown = (input, { config = {}, children = [], page = { localeCode: 'en', path: 'docs/setup' } } = {}) => {
  return renderer.render.call({
    input,
    config: {
      ...baseConfig,
      ...config
    },
    children,
    page
  })
}

describe('markdown core renderer plugin behavior', () => {
  it('leaves wiki-link source literal and escaped when the optional prop is unset', async () => {
    const html = await renderMarkdown('[[next-page|<img src=x onerror=alert(1)>]]')
    expect(html).toContain('[[next-page|&lt;img src=x onerror=alert(1)&gt;]]')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a ')
  })

  it('renders enabled wiki links as safe context-resolved anchors with escaped labels', async () => {
    const originalWiki = global.WIKI
    global.WIKI = { config: { lang: { namespacing: true } } }
    try {
      const html = await renderMarkdown('[[next-page|<img src=x onerror=alert(1)> & notes]]', {
        config: { wikilinks: true },
        page: { localeCode: 'en-US', path: 'docs/setup' }
      })
      const $ = cheerio.load(html)
      const anchor = $('p > a')
      expect($('p')).toHaveLength(1)
      expect($('a')).toHaveLength(1)
      expect(anchor).toHaveLength(1)
      expect(anchor.attr('href')).toBe('/en-US/docs/setup/next-page')
      expect(anchor.text()).toBe('<img src=x onerror=alert(1)> & notes')
      expect($('p').text()).toBe('<img src=x onerror=alert(1)> & notes')
      expect($('img, [onerror]')).toHaveLength(0)
      expect(anchor.html()).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; notes')
    } finally {
      if (originalWiki === undefined) delete global.WIKI
      else global.WIKI = originalWiki
    }
  })

  it('does not link unsafe wiki targets and preserves code and reference links', async () => {
    const originalWiki = global.WIKI
    global.WIKI = { config: { lang: { namespacing: false } } }
    try {
      const unsafe = await renderMarkdown('[[javascript:alert(1)|<img src=x onerror=alert(1)>]]', {
        config: { wikilinks: true }
      })
      expect(unsafe).not.toContain('href="javascript:')
      expect(unsafe).not.toContain('<img')
      const unsafeDocument = cheerio.load(unsafe)
      expect(unsafeDocument('p').text()).toBe('[[javascript:alert(1)|<img src=x onerror=alert(1)>]]')
      expect(unsafeDocument('a, img, [onerror]')).toHaveLength(0)

      const ordinary = await renderMarkdown(
        '`[[inline]]`\n\n```txt\n[[fenced]]\n```\n\n[ordinary][destination]\n\n[destination]: /ordinary',
        { config: { wikilinks: true } }
      )
      expect(ordinary).toContain('<code>[[inline]]</code>')
      const $ = cheerio.load(ordinary)
      expect($('pre > code.language-txt')).toHaveLength(1)
      expect($('pre > code.language-txt').text()).toBe('[[fenced]]\n')
      expect($('a[href="/docs/setup/fenced"]')).toHaveLength(0)
      expect(ordinary).toContain('<a href="/ordinary">ordinary</a>')
      expect(ordinary).not.toContain('href="/docs/setup/inline"')
    } finally {
      if (originalWiki === undefined) delete global.WIKI
      else global.WIKI = originalWiki
    }
  })
  it('pins core attrs allowlist and escapes raw HTML by default', async () => {
    const $ = cheerio.load(await renderMarkdown('# Title {#hero .lead target=_blank onclick=alert(1)}\n\n<strong>ok</strong>'))
    expect($('h1')).toHaveLength(1)
    expect($('h1').text()).toBe('Title')
    expect($('h1').attr('id')).toBe('hero')
    expect($('h1').hasClass('lead')).toBe(true)
    expect($('h1').attr('target')).toBe('_blank')
    expect($('p')).toHaveLength(1)
    expect($('p').text()).toBe('<strong>ok</strong>')
    expect($('strong, [onclick]')).toHaveLength(0)
  })

  it('honors selected markdown-it core config toggles', async () => {
    const $ = cheerio.load(await renderMarkdown('hello\nworld\n\nhttps://example.com\n\n"hi"', {
      config: {
        linebreaks: true,
        linkify: true,
        typographer: true,
        quotes: 'French'
      }
    }))
    const paragraphs = $('p')
    expect(paragraphs).toHaveLength(3)
    const first = paragraphs.eq(0).contents()
    expect(first).toHaveLength(3)
    expect(first.eq(0).text()).toBe('hello')
    expect(first.eq(1).is('br')).toBe(true)
    expect(first.eq(2).text().trimStart()).toBe('world')
    expect(paragraphs.eq(1).children('a')).toHaveLength(1)
    expect(paragraphs.eq(1).children('a').attr('href')).toBe('https://example.com')
    expect(paragraphs.eq(1).text()).toBe('https://example.com')
    expect(paragraphs.eq(2).text()).toBe('« hi »')
  })

  it('pins attrs allowlist behavior on links and images', async () => {
    const $ = cheerio.load(await renderMarkdown('[x](/url){#lnk .primary target=_blank rel=noopener onclick=alert(1)}\n\n![alt](img.png){#img .thumb target=_blank onload=alert(1) style="color:red"}'))
    const paragraphs = $('p')
    expect(paragraphs).toHaveLength(2)
    const link = paragraphs.eq(0).children('a')
    const image = paragraphs.eq(1).children('img')
    expect(link).toHaveLength(1)
    expect(link.attr('href')).toBe('/url')
    expect(link.text()).toBe('x')
    expect(link.attr('id')).toBe('lnk')
    expect(link.hasClass('primary')).toBe(true)
    expect(link.attr('target')).toBe('_blank')
    expect(link.attr('rel')).toBeUndefined()
    expect(image).toHaveLength(1)
    expect(image.attr('src')).toBe('img.png')
    expect(image.attr('alt')).toBe('alt')
    expect(image.attr('id')).toBe('img')
    expect(image.hasClass('thumb')).toBe(true)
    expect(image.attr('target')).toBe('_blank')
    expect($('[onclick], [onload], [style]')).toHaveLength(0)
  })

  it('pins attrs behavior on lists, code, and malformed declarations', async () => {
    const $ = cheerio.load(await renderMarkdown('- item {#li .entry target=_blank onclick=evil}\n- second\n{#lst .list onclick=evil}\n\n`code`{#c .kbd target=_blank onclick=evil}\n\nbad {.}\n\nx {.a .b #one target=_blank onclick=evil}'))
    expect($('ul')).toHaveLength(1)
    expect($('ul').attr('id')).toBe('lst')
    expect($('ul').hasClass('list')).toBe(true)
    const items = $('ul > li')
    expect(items).toHaveLength(2)
    expect(items.eq(0).attr('id')).toBe('li')
    expect(items.eq(0).hasClass('entry')).toBe(true)
    expect(items.eq(0).attr('target')).toBe('_blank')
    expect(items.eq(0).text()).toBe('item')
    expect(items.eq(1).text()).toBe('second')
    const paragraphs = $('p')
    expect(paragraphs).toHaveLength(3)
    const code = paragraphs.eq(0).children('code')
    expect(code).toHaveLength(1)
    expect(code.attr('id')).toBe('c')
    expect(code.hasClass('kbd')).toBe(true)
    expect(code.attr('target')).toBe('_blank')
    expect(code.text()).toBe('code')
    expect(paragraphs.eq(1).text()).toBe('bad {.}')
    expect(paragraphs.eq(2).text()).toBe('x')
    expect(paragraphs.eq(2).attr('id')).toBe('one')
    expect(paragraphs.eq(2).hasClass('a')).toBe(true)
    expect(paragraphs.eq(2).hasClass('b')).toBe(true)
    expect(paragraphs.eq(2).attr('target')).toBe('_blank')
    expect($('[onclick]')).toHaveLength(0)
  })

  it('pins attrs behavior on tables, blockquotes, and horizontal rules', async () => {
    const $ = cheerio.load(await renderMarkdown('A | B\n--|--\n1 {#cell .hot target=_blank onclick=evil colspan=2} | 2\n\n{#tbl .striped target=_blank onclick=evil border=1}\n\n> quote {#q .quote onclick=evil}\n\n--- {#hr .rule onclick=evil}'))
    const table = $('table')
    expect(table).toHaveLength(1)
    expect(table.attr('id')).toBe('tbl')
    expect(table.hasClass('striped')).toBe(true)
    expect(table.attr('target')).toBe('_blank')
    expect(table.attr('border')).toBeUndefined()
    expect(table.find('thead > tr')).toHaveLength(1)
    expect(table.find('thead > tr > th').map((_index, cell) => $(cell).text()).get()).toEqual(['A', 'B'])
    expect(table.find('tbody > tr')).toHaveLength(1)
    const cells = table.find('tbody > tr > td')
    expect(cells.map((_index, cell) => $(cell).text()).get()).toEqual(['1', '2'])
    expect(cells.eq(0).attr('id')).toBe('cell')
    expect(cells.eq(0).hasClass('hot')).toBe(true)
    expect(cells.eq(0).attr('target')).toBe('_blank')
    expect(cells.eq(0).attr('colspan')).toBeUndefined()
    expect($('blockquote')).toHaveLength(1)
    expect($('blockquote > p')).toHaveLength(1)
    expect($('blockquote > p').attr('id')).toBe('q')
    expect($('blockquote > p').hasClass('quote')).toBe(true)
    expect($('blockquote > p').text()).toBe('quote')
    expect($('blockquote').attr('id')).toBeUndefined()
    expect($('blockquote').hasClass('quote')).toBe(false)
    expect($('hr')).toHaveLength(1)
    expect($('hr').attr('id')).toBe('hr')
    expect($('hr').hasClass('rule')).toBe(true)
    expect($('[onclick]')).toHaveLength(0)
  })

  it('pins attrs behavior around rejected javascript links and footnotes', async () => {
    const $ = cheerio.load(await renderMarkdown('[x](javascript:alert(1)){target=_blank onclick=alert(1)}\n\n[x](https://example.test){target=_blank rel=noopener onclick=evil}\n\nRef[^1]{.ref onclick=evil}\n\n[^1]: foot **body** {.fnbody onclick=evil}', {
      children: [
        { key: 'markdownFootnotes', config: {} }
      ]
    }))
    const paragraphs = $('body > p')
    expect(paragraphs).toHaveLength(3)
    expect(paragraphs.eq(0).attr('target')).toBe('_blank')
    expect(paragraphs.eq(0).text()).toBe('[x](javascript:alert(1))')
    expect(paragraphs.eq(0).children()).toHaveLength(0)
    const link = paragraphs.eq(1).children('a')
    expect(link).toHaveLength(1)
    expect(link.attr('href')).toBe('https://example.test')
    expect(link.attr('target')).toBe('_blank')
    expect(link.attr('rel')).toBeUndefined()
    expect(link.text()).toBe('x')
    const reference = paragraphs.eq(2)
    expect(reference.hasClass('ref')).toBe(true)
    expect(reference.text()).toBe('Ref[1]')
    expect(reference.children('sup.footnote-ref')).toHaveLength(1)
    const referenceLink = reference.find('sup.footnote-ref > a')
    expect(referenceLink).toHaveLength(1)
    expect(referenceLink.attr('id')).toBe('fnref1')
    expect(referenceLink.attr('href')).toBe('#fn1')
    expect(referenceLink.text()).toBe('[1]')
    expect($('body > hr.footnotes-sep')).toHaveLength(1)
    expect($('body > section.footnotes')).toHaveLength(1)
    expect($('section.footnotes > ol.footnotes-list')).toHaveLength(1)
    const footnote = $('section.footnotes > ol.footnotes-list > li.footnote-item')
    expect(footnote).toHaveLength(1)
    expect(footnote.attr('id')).toBe('fn1')
    const body = footnote.children('p.fnbody')
    expect(body).toHaveLength(1)
    expect(body.children('strong')).toHaveLength(1)
    expect(body.children('strong').text()).toBe('body')
    expect(body.text()).toBe('foot body ↩︎')
    const backref = body.children('a.footnote-backref')
    expect(backref).toHaveLength(1)
    expect(backref.attr('href')).toBe('#fnref1')
    expect(backref.text()).toBe('↩︎')
    expect($('a[href^="javascript:"], [onclick]')).toHaveLength(0)
  })

  it('allows raw HTML only when allowHTML is enabled', async () => {
    expect(await renderMarkdown('<strong>ok</strong>', {
      config: {
        allowHTML: true
      }
    })).toBe('<p><strong>ok</strong></p>\n')
  })

  it('pins code fence rendering and diagram decoding', async () => {
    const html = await renderMarkdown('```js\nif (a < b) return "x"\n```\n\n```diagram\nPGI+aGk8L2I+\n```')
    const $ = cheerio.load(html)
    const blocks = $('pre')
    expect(blocks).toHaveLength(2)
    expect(blocks.eq(0).hasClass('prismjs')).toBe(true)
    expect(blocks.eq(0).hasClass('language-js')).toBe(true)
    expect(blocks.eq(0).hasClass('line-numbers')).toBe(false)
    const code = blocks.eq(0).children('code.language-js')
    expect(code).toHaveLength(1)
    expect(code.text()).toBe('if (a < b) return "x"\n')
    expect(code.children()).toHaveLength(0)
    expect(html).toContain('if (a &lt; b) return &quot;x&quot;\n')
    expect(blocks.eq(1).hasClass('diagram')).toBe(true)
    expect(blocks.eq(1).children('b')).toHaveLength(1)
    expect(blocks.eq(1).children('b').text()).toBe('hi')
    expect(blocks.eq(1).text()).toBe('hi')
  })

  it('renders titled, renumbered and highlighted code fences with canonical metadata', async () => {
    const $ = cheerio.load(await renderMarkdown(
      '```ts title="src/main.ts" linesStart=30 linesHighlight="31, 30"\nconst first = 1\nconst second = 2\n```'
    ))
    expect($('figure.codeblock-framed')).toHaveLength(1)
    const title = $('figure.codeblock-framed > figcaption.codeblock-title')
    expect(title).toHaveLength(1)
    expect(title.text()).toBe('src/main.ts')
    const block = title.next('pre')
    expect(block).toHaveLength(1)
    expect(block.hasClass('prismjs')).toBe(true)
    expect(block.hasClass('language-ts')).toBe(true)
    expect(block.hasClass('line-numbers')).toBe(true)
    expect(block.attr('data-start')).toBe('30')
    expect(block.attr('data-line-offset')).toBe('29')
    expect(block.attr('data-line')).toBe('30-31')
    expect(block.children('code.language-ts')).toHaveLength(1)
    expect(block.children('code.language-ts').text()).toBe('const first = 1\nconst second = 2\n')
  })

  it('pins abbreviation rendering', async () => {
    expect(await renderMarkdown('*[HTML]: Hyper Text Markup Language\n\nHTML rocks', {
      children: [
        { key: 'markdownAbbr', config: {} }
      ]
    })).toBe('<p><abbr title="Hyper Text Markup Language">HTML</abbr> rocks</p>\n')
  })

  it('pins subscript and superscript rendering, including config gating', async () => {
    expect(await renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: true, supEnabled: true } }
      ]
    })).toBe('<p>H<sub>2</sub>O and x<sup>2</sup></p>\n')

    expect(await renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: true, supEnabled: false } }
      ]
    })).toBe('<p>H<sub>2</sub>O and x^2^</p>\n')

    expect(await renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: false, supEnabled: true } }
      ]
    })).toBe('<p>H~2~O and x<sup>2</sup></p>\n')

    expect(await renderMarkdown('H~2~O and x^2^', {
      children: [
        { key: 'markdownSupsub', config: { subEnabled: false, supEnabled: false } }
      ]
    })).toBe('<p>H~2~O and x^2^</p>\n')
  })

  it('pins task list and image size plugin output', async () => {
    const $ = cheerio.load(await renderMarkdown('- [x] done\n- [ ] todo\n\n![alt](img.png =120x80)', {
      children: [
        { key: 'markdownTasklists', config: {} },
        { key: 'markdownImsize', config: {} }
      ]
    }))
    expect($('ul.contains-task-list')).toHaveLength(1)
    const items = $('ul.contains-task-list > li.task-list-item')
    expect(items).toHaveLength(2)
    for (const [index, text] of [' done', ' todo'].entries()) {
      const checkbox = items.eq(index).children('input.task-list-item-checkbox')
      expect(checkbox).toHaveLength(1)
      expect(checkbox.attr('type')).toBe('checkbox')
      expect(checkbox.prop('disabled')).toBe(true)
      expect(checkbox.prop('checked')).toBe(index === 0)
      expect(items.eq(index).text()).toBe(text)
    }
    const image = $('p > img')
    expect(image).toHaveLength(1)
    expect(image.attr('src')).toBe('img.png')
    expect(image.attr('alt')).toBe('alt')
    expect(image.attr('width')).toBe('120')
    expect(image.attr('height')).toBe('80')
  })
})
