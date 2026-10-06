import { hasSearchQueryNegation } from '../../shared/search-query.ts'

const STANDALONE_OR = /(?:^|[\s()])or(?=$|[\s()])/iu

/**
 * Whether a query uses web-search syntax whose boolean meaning must not be
 * widened by literal, fuzzy, or generated-hint fallback matching.
 */
export const isStructuredSearchQuery = (query: string): boolean => query.includes('"') || STANDALONE_OR.test(query) || hasSearchQueryNegation(query)
