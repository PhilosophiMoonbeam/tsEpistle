import { describe, expect, it } from '../bun-test.mts'
import { load } from 'cheerio'
import { matchingSearchExcerpt, searchExcerpt, structuredSearchExcerpt } from '../../helpers/search-excerpt.ts'
describe('source preview excerpts', () => {
  it('returns bounded plain text around a query and excludes invisible executable content', () => {
    const render = `<script>credential</script><style>private</style><p hidden>hidden</p><p>${'Opening words. '.repeat(300)}</p><p>Orbital calibration &amp; testing.</p><p>${'Later words. '.repeat(300)}</p>`
    const result = searchExcerpt(render, 'orbital calibration')
    expect(result.excerpt).toContain('Orbital calibration & testing.')
    expect(result.excerpt).not.toMatch(/credential|private|hidden|<p>/)
    expect(result.excerpt.length).toBeLessThanOrEqual(2400)
    expect(result.excerptTruncated).toBe(true)
  })
  it('keeps paragraphs readable and reports complete short content', () => {
    expect(searchExcerpt('<h1><a class="toc-anchor" href="#title">¶</a>Title</h1><p>First</p><p>Second</p>', '')).toEqual({
      excerpt: 'Title\n\nFirst\n\nSecond',
      excerptTruncated: false
    })
  })

  for (const query of [
    'desiredmarker -excludedmarker',
    'desiredmarker -excluded-marker',
    'desiredmarker OR alternative',
    'desiredmarker -"excludedmarker phrase"',
    'desiredmarker - "excludedmarker phrase"',
    'desiredmarker - (excludedmarker)',
    'desiredmarker -!excludedmarker',
    'desiredmarker ---excludedmarker'
  ]) {
    it(`anchors on positive terms rather than excluded terms or OR for ${query}`, () => {
      const render = `<p>Ordinary excludedmarker phrase excluded-marker ${'filler '.repeat(500)}</p><p>desiredmarker</p>`
      const result = searchExcerpt(render, query, 180)
      expect(result.excerpt).toContain('desiredmarker')
      expect(result.excerpt).not.toMatch(/Ordinary|excludedmarker|excluded-marker/)
      expect(result.excerpt.length).toBeLessThanOrEqual(180)
      expect(result.excerpt.startsWith('…')).toBe(true)
      expect(result.excerptTruncated).toBe(true)
    })
  }

  it('preserves a positive in-word hyphen instead of anchoring on its components', () => {
    const render = `<p>desired marker ${'filler '.repeat(500)}</p><p>desired-marker</p>`
    const result = searchExcerpt(render, 'desired-marker', 180)
    expect(result.excerpt).toContain('desired-marker')
    expect(result.excerpt).not.toContain('desired marker')
  })

  it('does not anchor exclusion-only queries on an excluded phrase', () => {
    const render = `<p>Opening ${'filler '.repeat(500)}</p><p>excludedmarker phrase</p>`
    const result = searchExcerpt(render, '- "excludedmarker phrase"', 180)
    expect(result.excerpt.startsWith('Opening')).toBe(true)
    expect(result.excerpt).not.toContain('excludedmarker')
  })

  it('matches literal query punctuation rather than interpreting regex operators', () => {
    const render = `<p>desiredm ${'filler '.repeat(500)}</p><p>desired[marker]</p>`
    const result = searchExcerpt(render, '"desired[marker]"', 180)
    expect(result.excerpt).toContain('desired[marker]')
    expect(result.excerpt).not.toContain('desiredm')
  })

  it('keeps original-text match offsets after Unicode characters with expanding lowercase mappings', () => {
    const render = `<p>${'İ '.repeat(1500)}</p><p>Desiredmarker</p>`
    const result = searchExcerpt(render, 'desiredmarker', 180)
    expect(result.excerpt).toContain('Desiredmarker')
    expect(result.excerpt.length).toBeLessThanOrEqual(180)
    expect(result.excerpt.startsWith('…')).toBe(true)
    expect(result.excerptTruncated).toBe(true)
  })
})

describe('inline matching passages', () => {
  it('returns the actual matching passage rather than the opening paragraph', () => {
    const render = `<p>Opening boilerplate ${'before '.repeat(100)}</p><p>Orbital calibration &amp; testing.</p><p>${'after '.repeat(100)}</p>`
    const result = matchingSearchExcerpt(render, '"orbital calibration"')!
    expect(result.excerpt).toContain('Orbital calibration & testing.')
    expect(result.excerpt).not.toContain('Opening boilerplate')
    expect(result.excerpt.length).toBeLessThanOrEqual(320)
    expect(result.excerpt.startsWith('…')).toBe(true)
    expect(result.excerpt.endsWith('…')).toBe(true)
    expect(result.excerptTruncated).toBe(true)
  })

  it('does not fabricate a body passage for metadata-only, excluded or hidden matches', () => {
    const render = '<h1>Visible title</h1><p>Visible paragraph.</p><script>needle</script><p hidden>needle</p><span aria-hidden="true">needle</span>'
    expect(matchingSearchExcerpt(render, 'needle')).toBeNull()
    expect(matchingSearchExcerpt(render, '-visible')).toBeNull()
    expect(matchingSearchExcerpt(render, 'metadata')).toBeNull()
  })

  it('reports complete Unicode passages without mistaking authored ellipses for truncation', () => {
    expect(matchingSearchExcerpt('<p>…İ🙂 desired[marker] …</p>', '"desired[marker]"')).toEqual({
      excerpt: '…İ🙂 desired[marker] …',
      excerptTruncated: false
    })
  })

  it('preserves literal punctuation and Unicode offsets without splitting surrogate pairs', () => {
    const render = `<p>${'İ🙂 '.repeat(200)}desired[marker] ${'🙂 '.repeat(200)}</p>`
    const result = matchingSearchExcerpt(render, '"desired[marker]"')!
    expect(result.excerpt).toContain('desired[marker]')
    expect(result.excerpt.length).toBeLessThanOrEqual(320)
    expect(result.excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    expect(result.excerptTruncated).toBe(true)
  })
})

describe('structured current-render passages', () => {
  it('retains zero-to-end row spans and explicit group-header associations', () => {
    const result = structuredSearchExcerpt(
      '<table><tbody><tr><th id="group" rowspan="0" scope="rowgroup">Group A</th><td headers="group">First</td></tr><tr><td headers="group">Second</td></tr></tbody></table>',
      '',
      '/en/table'
    )
    const $ = load(result.html)
    expect($('tbody > tr').length).toBe(2)
    expect($('th').attr('rowspan')).toBe('2')
    expect($('th').attr('scope')).toBe('rowgroup')
    expect(
      $('tbody > tr')
        .last()
        .children()
        .map((_index, cell) => $(cell).text())
        .get()
    ).toEqual(['Second'])
    for (const cell of $('td').toArray()) {
      const header = $(cell).attr('headers')!
      expect(
        $('th')
          .filter((_index, node) => $(node).attr('id') === header)
          .text()
      ).toBe('Group A')
    }
    expect(result.truncated).toBe(false)
  })

  it('omits an oversized connected row group instead of changing its table grid', () => {
    const rows = Array.from({ length: 121 }, (_, index) => `<tr>${index === 0 ? '<th rowspan="121">Group A</th>' : ''}<td>Row ${index + 1}</td></tr>`).join('')
    const result = structuredSearchExcerpt(`<table><tbody>${rows}</tbody></table>`, 'Row 60', '/en/table')
    expect(result.html).toBe('')
    expect(result.truncated).toBe(true)
  })

  it('preserves native automatic association for column headers without an explicit thead', () => {
    const result = structuredSearchExcerpt('<table><tr><th>Name</th><th>Amount</th></tr><tr><td>Example</td><td>42</td></tr></table>', '', '/en/table')
    const $ = load(result.html)
    expect(
      $('th')
        .map((_index, cell) => $(cell).text())
        .get()
    ).toEqual(['Name', 'Amount'])
    expect($('th[scope]').length).toBe(0)
    expect(
      $('tr')
        .last()
        .children()
        .map((_index, cell) => $(cell).text())
        .get()
    ).toEqual(['Example', '42'])
  })

  for (const reversed of [false, true]) {
    it(`keeps effective ordered-list numbers after truncation (${reversed ? 'implicit reverse' : 'preceding reset'})`, () => {
      const count = 35,
        target = reversed ? 1 : 20
      const items = Array.from(
        { length: count },
        (_, index) =>
          `<li${!reversed && index === 0 ? ' value="100"' : ''}>Step ${index + 1}: ${'context '.repeat(70)}${index + 1 === target ? 'needlemarker' : ''}</li>`
      ).join('')
      const result = structuredSearchExcerpt(`<ol${reversed ? ' reversed' : ''}>${items}</ol>`, 'needlemarker', '/en/steps')
      const $ = load(result.html)
      const first = Number(
        $('ol > li')
          .first()
          .text()
          .match(/^Step (\d+):/u)![1]
      )
      expect(Number($('ol').attr('start'))).toBe(reversed ? count - first + 1 : 99 + first)
      expect($('ol').is('[reversed]')).toBe(reversed)
      expect($('ol').text()).toContain('needlemarker')
      expect(result.truncated).toBe(true)
    })
  }

  it('retains passive structure and authored pilcrows while removing generated anchors and unsafe payloads', () => {
    const render =
      '<h2><a class="toc-anchor" href="#evidence">¶</a>Evidence</h2><p onclick="attack()">Visible <strong>evidence</strong>; authored ¶ and <code>¶</code>, <a href="#authored">¶</a>, <span class="toc-anchor">authored ¶ span</span></p><ul><li>One</li></ul><p hidden>hidden-secret</p><p aria-hidden="true">aria-secret</p><img src="https://egress.invalid/image"><svg><image href="https://egress.invalid/svg"></image></svg><iframe src="https://egress.invalid/frame"></iframe><style>body{background:url(https://egress.invalid/css)}</style><script>script-secret</script><form><input autofocus></form><a href="javascript:attack()">Unsafe</a>'
    const result = structuredSearchExcerpt(render, 'evidence', '/_private/en/source')
    const $ = load(result.html)
    expect($('strong').text()).toBe('evidence')
    expect($('h2').text()).toBe('Evidence')
    expect($('h2 a').length).toBe(0)
    expect($('p').first().text()).toContain('authored ¶')
    expect($('code').text()).toBe('¶')
    expect($('a[href]').text()).toBe('¶')
    expect($('a[href]').attr('href')).toBe('/_private/en/source#authored')
    expect($.root().text()).toContain('authored ¶ span')
    expect($('ul > li').text()).toBe('One')
    expect($('img,svg,iframe,style,script,form,input,[onclick],[style],[src],[srcset]').length).toBe(0)
    expect($('a').last().attr('href')).toBeUndefined()
    expect($.root().text()).not.toMatch(/hidden-secret|aria-secret|script-secret|egress\.invalid/u)
  })
})
