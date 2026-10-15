export const GLOSSARY_RULE_PATH = 'glossary'
export const GLOSSARY_LIMITS = { name: 255, definition: 10_000, aliases: 50, references: 20, relatedIds: 50, directory: 100, autolink: 200 } as const

/** Locale-independent Unicode identity, shared by lookup, canonical names, and aliases. */
export const glossaryNameKey = (name: string): string => name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase().normalize('NFC')

export interface GlossaryReference {
  label: string
  url: string
}
export interface GlossaryTermInput {
  locale: string
  term: string
  expansion: string
  definition: string
  aliases: string[]
  relatedIds: number[]
  documentationPageId: number | null
  documentationLabel: string
  references: GlossaryReference[]
  caseSensitive: boolean
  autoLink: boolean
  category: string
}
export interface GlossaryTermSummary {
  id: number
  revision: number
  locale: string
  term: string
  expansion: string
  category: string
}
export interface GlossaryDocumentation {
  id: number
  title: string
  label: string
  href: string
  locale: string
  path: string
}
export interface GlossaryTerm extends GlossaryTermInput, GlossaryTermSummary {
  definitionHtml: string
  documentation: GlossaryDocumentation | null
  relatedTerms: GlossaryTermSummary[]
  createdAt: string
  updatedAt: string
}
export interface GlossaryAccess {
  enabled: boolean
  locale: string
  canRead: boolean
  canManage: boolean
}
export interface GlossaryPage<T> {
  items: T[]
  nextCursor: string | null
  complete: boolean
}
export interface GlossaryAutolinkTerm {
  id: number
  term: string
  aliases: string[]
  caseSensitive: boolean
}
export interface GlossaryUpdateInput extends GlossaryTermInput {
  expectedRevision: number
}
