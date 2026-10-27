import type { GlossaryAccess } from '../../shared/glossary.ts'
import { GlossaryApiError } from './glossary-api.ts'

/** Only complete, well-formed catalog locale codes may reach the reader host. */
export function isGlossaryLocale (locale: string): boolean {
  if (locale.length > 35 || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu.test(locale)) return false
  try { return Intl.getCanonicalLocales(locale).length === 1 } catch { return false }
}

const validationKeys: Record<string, string> = {
  'Enter a term of at most 255 characters.': 'invalidTerm',
  'Names, aliases, categories and labels must be at most 255 characters.': 'invalidNames',
  'The definition must be at most 10,000 characters.': 'invalidDefinition',
  'Use at most 50 aliases, 50 related terms, and 20 references.': 'invalidCounts',
  'The term and aliases must have distinct names.': 'distinctNames',
  'Every reference needs an absolute HTTP or HTTPS URL.': 'invalidReferenceUrl',
  'References need safe HTTP(S) URLs (at most 2,048 characters) and labels (at most 255 characters).': 'invalidReferences',
  'The catalog continuation did not advance. Please retry.': 'invalidContinuation',
  'The glossary returned an invalid response. Please reload and try again.': 'invalidResponse'
}

/** Translate known failures rather than exposing untranslated server prose. */
export function glossaryErrorKey (failure: unknown): string {
  if (failure instanceof GlossaryApiError) {
    if (failure.code === 'GLOSSARY_DISABLED') return 'disabled'
    if (failure.status === 401) return 'signInRequired'
    if (failure.status === 403) return 'forbidden'
    if (failure.code === 'GLOSSARY_NAME_CONFLICT') return 'nameConflict'
    if (failure.status === 409) return 'revisionConflict'
    if (failure.status === 404) return 'notFound'
    if (failure.status === 400) return 'invalidInput'
  }
  return failure instanceof Error ? validationKeys[failure.message] ?? 'requestFailed' : 'requestFailed'
}

export interface GlossarySearchPanel {
  canLeave(): boolean
}

/** Reader-owned navigation and authority, rendered inside the shared Search shell. */
export interface GlossarySearchContext {
  readonly key: string
  readonly opened: boolean
  readonly locale: string
  readonly term: string
  readonly access: GlossaryAccess
  readonly error: string
  canLeave(): boolean
  navigate(term: string | null): boolean
  changeLocale(locale: string): void
  refresh(): Promise<void>
  bindPanel(instance: unknown): void
}
