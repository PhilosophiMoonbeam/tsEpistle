import type { Knex } from 'knex'

const TABLE = 'contentExtensions'
const CONTENT_EXTENSIONS = [
  { key: 'qr', version: 1 },
  { key: 'gallery', version: 1 },
  { key: 'index', version: 1 },
  { key: 'tabs', version: 1 },
  { key: 'spoiler', version: 1 },
  { key: 'infobox', version: 1 },
  { key: 'pdf', version: 1 },
  { key: 'media', version: 1 },
  { key: 'youtube', version: 1 },
  { key: 'diagram', version: 1 },
  { key: 'kroki', version: 1 },
  { key: 'plantuml', version: 1 },
  { key: 'map', version: 1 }
] as const

export const up = async (knex: Knex): Promise<void> => {
  await knex(TABLE)
    .insert(
      CONTENT_EXTENSIONS.map(extension => ({
        ...extension,
        isEnabled: false,
        updatedAt: knex.fn.now(),
        updatedBy: null
      }))
    )
    .onConflict('key')
    .ignore()
}

export const down = async (): Promise<void> => {
  // Registry rows can contain administrator state and cannot be safely removed.
}
