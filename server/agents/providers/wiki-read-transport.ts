export interface WikiReadTextReference {
  readonly textIndex: number
  /** Inclusive JavaScript UTF-16 string offset. */
  readonly start: number
  /** Exclusive JavaScript UTF-16 string offset. */
  readonly end: number
}

export interface WikiReadTextTransport {
  readonly texts: readonly string[]
  /** One reference per input read, in its original order, including duplicates. */
  readonly sources: readonly WikiReadTextReference[]
}

/** Content-only interning; references confer no evidence identity or ownership. */
export const packWikiReadTexts = (input: readonly string[]): WikiReadTextTransport => {
  const originals = [...new Set(input)].sort((left, right) => right.length - left.length)
  const texts: string[] = []
  const references = new Map<string, WikiReadTextReference>()
  for (const original of originals) {
    let reference: WikiReadTextReference | undefined
    for (let textIndex = 0; textIndex < texts.length; textIndex++) {
      const start = texts[textIndex]!.indexOf(original)
      if (start < 0) continue
      reference = { textIndex, start, end: start + original.length }
      break
    }
    if (!reference) {
      reference = { textIndex: texts.length, start: 0, end: original.length }
      texts.push(original)
    }
    references.set(original, reference)
  }
  return { texts, sources: input.map(original => references.get(original)!) }
}

/** Decode exact original strings; invalid references never use slice's clamping. */
export const unpackWikiReadTexts = (input: WikiReadTextTransport): readonly string[] => {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.texts) || !Array.isArray(input.sources))
    throw new Error('Invalid Wiki read text transport')
  for (const text of input.texts) {
    if (typeof text !== 'string') throw new Error('Invalid Wiki read text transport')
  }
  const sources: string[] = []
  for (const reference of input.sources) {
    if (reference === null || typeof reference !== 'object' ||
      !Number.isSafeInteger(reference.textIndex) || !Number.isSafeInteger(reference.start) || !Number.isSafeInteger(reference.end) ||
      reference.textIndex < 0 || reference.textIndex >= input.texts.length || reference.start < 0 || reference.end < reference.start)
      throw new Error('Invalid Wiki read text reference')
    const text = input.texts[reference.textIndex]!
    if (reference.end > text.length) throw new Error('Invalid Wiki read text reference')
    sources.push(reference.start === 0 && reference.end === text.length ? text : text.slice(reference.start, reference.end))
  }
  return sources
}
