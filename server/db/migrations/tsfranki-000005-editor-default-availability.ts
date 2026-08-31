import type { Knex } from 'knex'

const EDITORS_SETTINGS_KEY = 'editors'
const LEGACY_DEFAULT_EDITORS = ['markdown', 'visual-markdown', 'ckeditor', 'asciidoc', 'code'] as const
const DEFAULT_EDITORS = ['markdown', 'visual-markdown'] as const

type EditorsSettings = Record<string, unknown> & { available?: unknown }

const parseEditorsSettings = (value: unknown): EditorsSettings | undefined => {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return undefined
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as EditorsSettings
}

const hasLegacyDefaultEditors = (available: unknown): boolean => {
  if (!Array.isArray(available) || available.length !== LEGACY_DEFAULT_EDITORS.length) return false

  const selected = new Set<unknown>(available)
  return selected.size === LEGACY_DEFAULT_EDITORS.length && LEGACY_DEFAULT_EDITORS.every(editor => selected.has(editor))
}

export const up = async (knex: Knex): Promise<void> => {
  const row = await knex<{ key: string; value: unknown }>('settings')
    .where({ key: EDITORS_SETTINGS_KEY })
    .first('value')
  if (!row) return

  const settings = parseEditorsSettings(row.value)
  if (!settings || !hasLegacyDefaultEditors(settings.available)) return

  await knex('settings')
    .where({ key: EDITORS_SETTINGS_KEY })
    .update({ value: JSON.stringify({ ...settings, available: [...DEFAULT_EDITORS] }) })
}

export const down = async (): Promise<void> => {
  // Administrator editor selections cannot be reconstructed.
}
