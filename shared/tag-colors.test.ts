import { describe, expect, it } from '../server/test/bun-test.mts'
import { tagColorBucket } from './tag-colors.ts'

describe('tag color buckets', () => {
  it('normalizes case and compatibility forms before skipping punctuation and selecting Unicode letters or numbers', () => {
    expect(tagColorBucket('  !!!Ｆoo')).toBe('primary')
    expect(tagColorBucket('foo')).toBe('primary')
    expect(tagColorBucket('  !!!１２')).toBe('info')
    expect(tagColorBucket('Éclair')).toBe('error')
    expect(tagColorBucket('—…   ')).toBe('neutral')
  })
})
