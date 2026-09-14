export type TagColorBucket =
  | 'primary'
  | 'info'
  | 'success'
  | 'warning'
  | 'secondary'
  | 'error'
  | 'violet'
  | 'teal'
  | 'cyan'
  | 'orange'
  | 'rose'
  | 'indigo'
  | 'neutral'

const TAG_COLOR_BUCKETS: readonly Exclude<TagColorBucket, 'neutral'>[] = [
  'primary',
  'info',
  'success',
  'warning',
  'secondary',
  'error',
  'violet',
  'teal',
  'cyan',
  'orange',
  'rose',
  'indigo'
]

const LETTER = /^\p{L}$/u
const LATIN_UPPERCASE = /^[A-Z]$/
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

const hashGroupKey = (groupKey: string): number => {
  let hash = FNV_OFFSET_BASIS
  for (const codePoint of groupKey) {
    hash ^= codePoint.codePointAt(0)!
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** Selects a stable semantic color bucket for the tag's browse group. */
export const tagColorBucket = (canonicalTag: string): TagColorBucket => {
  const normalizedTag = canonicalTag.normalize('NFKC').toLowerCase()
  let groupKey = ''
  for (const codePoint of normalizedTag) {
    groupKey = codePoint
    break
  }

  if (!LETTER.test(groupKey)) return 'neutral'

  const uppercaseGroup = groupKey.toUpperCase()
  if (LATIN_UPPERCASE.test(uppercaseGroup)) {
    const latinIndex = uppercaseGroup.codePointAt(0)! - 'A'.codePointAt(0)!
    return TAG_COLOR_BUCKETS[latinIndex % TAG_COLOR_BUCKETS.length]!
  }

  return TAG_COLOR_BUCKETS[hashGroupKey(uppercaseGroup) % TAG_COLOR_BUCKETS.length]!
}
