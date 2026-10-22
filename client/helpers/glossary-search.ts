import type { GlossaryAccess } from '../../shared/glossary.ts'

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
