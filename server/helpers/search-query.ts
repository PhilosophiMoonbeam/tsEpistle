const STANDALONE_OR = /(?:^|[^\p{L}\p{N}_-])or(?=$|[^\p{L}\p{N}_-])/iu
const TOKEN_NEGATION = /(?:^|[^\p{L}\p{N}_-])-\s*(?=[\p{L}\p{N}"])/u

/**
 * Whether a query uses web-search syntax whose boolean meaning must not be
 * widened by literal, fuzzy, or generated-hint fallback matching.
 */
export const isStructuredSearchQuery = (query: string): boolean => query.includes('"') || STANDALONE_OR.test(query) || TOKEN_NEGATION.test(query)
