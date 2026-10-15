import { GLOSSARY_LIMITS, glossaryNameKey, type GlossaryTerm, type GlossaryTermInput } from '../../shared/glossary.ts'
import { hasAsciiControlCharacters } from '../../shared/text-safety.ts'
import type { GlossaryWrite } from './glossary-api.ts'
export type GlossaryDraft = GlossaryTermInput & { aliasesText: string }
export function glossaryDraft(locale: string, term?: GlossaryTerm): GlossaryDraft {
  return {
    locale,
    term: term?.term ?? '',
    expansion: term?.expansion ?? '',
    definition: term?.definition ?? '',
    aliases: [...(term?.aliases ?? [])],
    aliasesText: term?.aliases.join('\n') ?? '',
    relatedIds: [...(term?.relatedIds ?? [])],
    documentationPageId: term?.documentationPageId ?? null,
    documentationLabel: term?.documentationLabel ?? '',
    references: (term?.references ?? []).map(item => ({ ...item })),
    caseSensitive: term?.caseSensitive ?? false,
    autoLink: term?.autoLink ?? true,
    category: term?.category ?? ''
  }
}
export function glossaryWrite(draft: GlossaryDraft, documentationDirty: { page: boolean; label: boolean }): GlossaryWrite {
  const { aliasesText, documentationPageId, documentationLabel, ...fields } = draft
  const aliases = aliasesText
    .split(/\r?\n/u)
    .map(name => name.trim())
    .filter(Boolean)
  if (!draft.term.trim() || draft.term.length > GLOSSARY_LIMITS.name) throw new Error('Enter a term of at most 255 characters.')
  if ([draft.expansion, draft.category, draft.documentationLabel, ...aliases].some(name => name.length > GLOSSARY_LIMITS.name))
    throw new Error('Names, aliases, categories and labels must be at most 255 characters.')
  if (draft.definition.length > GLOSSARY_LIMITS.definition) throw new Error('The definition must be at most 10,000 characters.')
  if (aliases.length > GLOSSARY_LIMITS.aliases || draft.relatedIds.length > GLOSSARY_LIMITS.relatedIds || draft.references.length > GLOSSARY_LIMITS.references)
    throw new Error('Use at most 50 aliases, 50 related terms, and 20 references.')
  const names = [draft.term, ...aliases].map(glossaryNameKey)
  if (new Set(names).size !== names.length) throw new Error('The term and aliases must have distinct names.')
  for (const reference of draft.references) {
    let url: URL
    try {
      url = new URL(reference.url)
    } catch {
      throw new Error('Every reference needs an absolute HTTP or HTTPS URL.')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      hasAsciiControlCharacters(reference.url) ||
      reference.url.length > 2048 ||
      reference.label.length > 255
    )
      throw new Error('References need safe HTTP(S) URLs (at most 2,048 characters) and labels (at most 255 characters).')
  }
  return { ...fields, aliases, ...(documentationDirty.page ? { documentationPageId } : {}), ...(documentationDirty.label ? { documentationLabel } : {}) }
}
