import { describe, expect, it } from '../../server/test/bun-test.mts'
import { createSearchHighlighter } from './search-highlight.ts'

describe('visible search highlighting', () => {
  it('marks positive phrases and terms, not exclusions or boolean operators', () => {
    const highlight = createSearchHighlighter('"pasta sauce" OR noodles -garlic - "olive oil"')
    const segments = highlight('PASTA SAUCE, pasta, Noodles, garlic, olive oil, OR')
    expect(segments.filter(segment => segment.matched).map(segment => segment.text)).toEqual(['PASTA SAUCE', 'Noodles'])
    expect(createSearchHighlighter('-pasta OR -"sauce"')('pasta OR sauce')).toEqual([{ text: 'pasta OR sauce', matched: false }])
    expect(createSearchHighlighter('"pasta sauce')('Pasta sauce')).toEqual([{ text: 'Pasta sauce', matched: true }])
  })

  it('treats regex metacharacters literally and prefers a complete phrase over an overlapping term', () => {
    const highlight = createSearchHighlighter('"C++ [pasta]" pasta')
    expect(highlight('C++ [pasta] and pasta; CCCC')).toEqual([
      { text: 'C++ [pasta]', matched: true },
      { text: ' and ', matched: false },
      { text: 'pasta', matched: true },
      { text: '; CCCC', matched: false }
    ])
  })

  it('preserves malicious markup and Unicode offsets as original text slices', () => {
    const highlight = createSearchHighlighter('pasta')
    expect(highlight('<img src=x onerror=alert(1)>İ 🍝 Pasta & <b>PASTA</b>')).toEqual([
      { text: '<img src=x onerror=alert(1)>İ 🍝 ', matched: false },
      { text: 'Pasta', matched: true },
      { text: ' & <b>', matched: false },
      { text: 'PASTA', matched: true },
      { text: '</b>', matched: false }
    ])
    expect(highlight('No match')).toEqual([{ text: 'No match', matched: false }])
    expect(highlight('PASTA')).toEqual([{ text: 'PASTA', matched: true }])
  })

  it('keeps minus prefixes and OR literal for downloaded plain-text search', () => {
    const highlight = createSearchHighlighter('-pasta OR', false)
    expect(highlight('-PASTA or pasta')).toEqual([
      { text: '-PASTA', matched: true },
      { text: ' ', matched: false },
      { text: 'or', matched: true },
      { text: ' pasta', matched: false }
    ])
  })
})
