export type TagColorBucket = 'primary' | 'info' | 'success' | 'warning' | 'secondary' | 'error' | 'neutral'

const TAG_COLOR_BUCKETS: readonly Exclude<TagColorBucket, 'neutral'>[] = ['primary', 'info', 'success', 'warning', 'secondary', 'error']

const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u

/** Selects a stable semantic color bucket without changing the tag identity. */
export const tagColorBucket = (canonicalTag: string): TagColorBucket => {
  const normalizedTag = canonicalTag.normalize('NFKC').toLowerCase()

  for (const codePoint of normalizedTag) {
    if (!LETTER_OR_NUMBER.test(codePoint)) continue

    return TAG_COLOR_BUCKETS[codePoint.codePointAt(0)! % TAG_COLOR_BUCKETS.length]!
  }

  return 'neutral'
}
