import type { WikiReadTextReference } from '../../agents/providers/wiki-read-transport.ts'
import { packWikiReadTexts, unpackWikiReadTexts } from '../../agents/providers/wiki-read-transport.ts'
import { describe, expect, it } from '../bun-test.mts'

describe('lossless registered Wiki read text transport', () => {
  it('retains every complete scope exactly rather than replacing a section read with its containing root', () => {
    const section = '## Scoped entries\n\nName: Ada\n\n'
    const root = `# Catalog\n\nNot in section scope.\n\n${section}## Other scope\n\nName: Atlas\n`
    const originals = [section, root, section]
    const packed = packWikiReadTexts(originals)

    expect(packed.texts).toEqual([root])
    expect(unpackWikiReadTexts(packed)).toEqual(originals)
  })

  it('finds complete containing originals even when shorter reads arrive first', () => {
    const orders = [
      ['entry', 'prefix entry suffix', 'prefix entry'],
      ['prefix entry suffix', 'entry', 'prefix entry'],
      ['prefix entry', 'prefix entry suffix', 'entry']
    ]
    for (const originals of orders) {
      const packed = packWikiReadTexts(originals)
      expect(packed.texts).toEqual(['prefix entry suffix'])
      expect(unpackWikiReadTexts(packed)).toEqual(originals)
    }
  })

  it('keeps identical content as two independent original input positions', () => {
    const originals = ['# Identical source\n\nName: Ada\n', '# Identical source\n\nName: Ada\n']
    const packed = packWikiReadTexts(originals)

    expect(packed.texts).toEqual([originals[0]])
    expect(packed.sources).toHaveLength(2)
    expect(unpackWikiReadTexts(packed)).toEqual(originals)
  })

  it('does not synthesize a combined source from overlapping non-contained originals', () => {
    const originals = ['left shared', 'shared right', 'shared']
    const packed = packWikiReadTexts(originals)

    expect(packed.texts).toEqual(['shared right', 'left shared'])
    expect(unpackWikiReadTexts(packed)).toEqual(originals)
  })

  it('preserves Unicode code units, mixed newlines, whitespace and empty reads without normalization', () => {
    const section = '  e\u0301\t\r\n😀 scope\n\n'
    const root = `\uFEFF# 🧭\r\n${section}\u0000tail\r`
    const originals = [section, root, '😀 scope', 'e\u0301', '\ude00 scope', '', '\u0000tail\r']
    const packed = packWikiReadTexts(originals)

    expect(packed.texts).toEqual([root])
    expect(unpackWikiReadTexts(packed)).toEqual(originals)
    expect(unpackWikiReadTexts(packWikiReadTexts(['', '']))).toEqual(['', ''])
    expect(unpackWikiReadTexts(packWikiReadTexts([]))).toEqual([])
  })

  it('rejects invalid indexes and offsets instead of coercing or clamping a reference', () => {
    const valid: WikiReadTextReference = { textIndex: 0, start: 0, end: 3 }
    const invalid: readonly WikiReadTextReference[] = [
      { ...valid, textIndex: -1 },
      { ...valid, textIndex: 1 },
      { ...valid, textIndex: 0.5 },
      { ...valid, textIndex: Number.NaN },
      { ...valid, textIndex: Number.POSITIVE_INFINITY },
      { ...valid, textIndex: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, start: -1 },
      { ...valid, start: 0.5 },
      { ...valid, start: Number.NaN },
      { ...valid, start: Number.POSITIVE_INFINITY },
      { ...valid, start: 4, end: 4 },
      { ...valid, start: 2, end: 1 },
      { ...valid, end: -1 },
      { ...valid, end: 4 },
      { ...valid, end: 2.5 },
      { ...valid, end: Number.NaN },
      { ...valid, end: Number.POSITIVE_INFINITY },
      { ...valid, end: Number.MAX_SAFE_INTEGER + 1 }
    ]
    expect(unpackWikiReadTexts({ texts: ['abc'], sources: [valid] })).toEqual(['abc'])
    for (const reference of invalid)
      expect(() => unpackWikiReadTexts({ texts: ['abc'], sources: [valid, reference] })).toThrow('Invalid Wiki read text reference')
  })
})
