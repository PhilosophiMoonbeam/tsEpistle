const TOKEN_NEGATION = /(?:^|[^\p{L}\p{N}_-])-[^\p{L}\p{N}"]*(?=[\p{L}\p{N}"])/u

/** PostgreSQL ignores punctuation between a leading NOT dash and its operand. */
export const hasSearchQueryNegation = (query: string): boolean => TOKEN_NEGATION.test(query)

/** Presentation terms only: omit boolean operators and exclusions, without stemming. */
export const visibleQueryTerms = (query: string, structured = true): string[] => {
  if (!structured) return query.split(/\s+/u).filter(Boolean)

  const terms: string[] = []
  const tokens = /(-[^\p{L}\p{N}"]*)?("[^"]*(?:"|$)|[^\s"(),;]+)/gu
  for (const token of query.matchAll(tokens)) {
    if (token[1]) continue
    const value = token[2]!
    if (value.startsWith('"')) {
      const phrase = value.slice(1, value.endsWith('"') ? -1 : undefined).trim()
      if (phrase) terms.push(phrase)
    } else if (!/^or$/iu.test(value) && value !== '-') {
      terms.push(value)
    }
  }
  return terms
}
