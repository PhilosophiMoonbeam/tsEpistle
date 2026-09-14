import { describe, expect, it } from '../server/test/bun-test.mts'
import { tagColorBucket } from './tag-colors.ts'

describe('tag color buckets', () => {
  it('normalizes case and compatibility forms before selecting a letter group', () => {
    expect(tagColorBucket('Ｆoo')).toBe(tagColorBucket('foo'))
    expect(tagColorBucket('ＦＯＯ')).toBe(tagColorBucket('fOo'))
    expect(tagColorBucket('Éclair')).toBe(tagColorBucket('éCLAIR'))
    expect(tagColorBucket('—…   ')).toBe('neutral')
  })

  it('keeps the non-letter browse group neutral across numeric and punctuated tags', () => {
    const nonLetterTags = ['123 roadmap', '１２３ roadmap', '--alpha', '—東京', '!!!', '???']
    const firstPass = nonLetterTags.map(tagColorBucket)
    const secondPass = nonLetterTags.map(tagColorBucket)

    expect(firstPass).toEqual(secondPass)
    expect(firstPass.every(bucket => bucket === 'neutral')).toBe(true)
  })

  it('keeps every member of a letter group on one stable bucket', () => {
    expect(tagColorBucket('alpha')).toBe(tagColorBucket('apple'))
    expect(tagColorBucket('beta')).toBe(tagColorBucket('boat'))
    expect(tagColorBucket('alpha-one')).toBe(tagColorBucket('alpha-two'))
  })

  it('distributes representative A-Z groups across the expanded palette', () => {
    const representativeTags = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index))
    const firstPass = representativeTags.map(tagColorBucket)
    const secondPass = representativeTags.map(tagColorBucket)

    expect(firstPass).toEqual(secondPass)
    expect(new Set(firstPass).size).toBeGreaterThanOrEqual(10)
    expect(firstPass.every(bucket => bucket !== 'neutral')).toBe(true)
  })
})
