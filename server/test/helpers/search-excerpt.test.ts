import { describe, expect, it } from '../bun-test.mts'
import { matchingSearchExcerpt, searchExcerpt } from '../../helpers/search-excerpt.ts'
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
    expect(searchExcerpt('<h1><a class="toc-anchor" href="#title">¶</a>Title</h1><p>First</p><p>Second</p>', '')).toEqual({ excerpt: 'Title\n\nFirst\n\nSecond', excerptTruncated: false })
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
    const excerpt = matchingSearchExcerpt(render, '"orbital calibration"')
    expect(excerpt).toContain('Orbital calibration & testing.')
    expect(excerpt).not.toContain('Opening boilerplate')
    expect(excerpt!.length).toBeLessThanOrEqual(320)
    expect(excerpt!.startsWith('…')).toBe(true)
    expect(excerpt!.endsWith('…')).toBe(true)
  })

  it('does not fabricate a body passage for metadata-only, excluded or hidden matches', () => {
    const render = '<h1>Visible title</h1><p>Visible paragraph.</p><script>needle</script><p hidden>needle</p><span aria-hidden="true">needle</span>'
    expect(matchingSearchExcerpt(render, 'needle')).toBeNull()
    expect(matchingSearchExcerpt(render, '-visible')).toBeNull()
    expect(matchingSearchExcerpt(render, 'metadata')).toBeNull()
  })

  it('preserves literal punctuation and Unicode offsets without splitting surrogate pairs', () => {
    const render = `<p>${'İ🙂 '.repeat(200)}desired[marker] ${'🙂 '.repeat(200)}</p>`
    const excerpt = matchingSearchExcerpt(render, '"desired[marker]"')!
    expect(excerpt).toContain('desired[marker]')
    expect(excerpt.length).toBeLessThanOrEqual(320)
    expect(excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  })
})
