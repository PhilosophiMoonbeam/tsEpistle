import type { Knex } from 'knex'

const BATCH_SIZE = 100
const LEGACY_PRODUCER = 'import:legacy-database'

type JsonObject = Record<string, unknown>

type PageRow = {
  id: number
  extra: unknown
  updatedAt?: unknown
  createdAt?: unknown
}

const isJsonObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

const parseExtra = (value: unknown): { readonly extra: JsonObject; readonly wasString: boolean } | null => {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isJsonObject(parsed) ? { extra: parsed, wasString: true } : null
    } catch {
      return null
    }
  }
  return isJsonObject(value) ? { extra: value, wasString: false } : null
}

const normalizeTimestamp = (value: unknown): string | null => {
  const date = value instanceof Date
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : null
  return date !== null && Number.isFinite(date.valueOf()) ? date.toISOString() : null
}

const authorityFor = (row: PageRow, tableName: 'pages' | 'pageHistory'): string | JsonObject | null => {
  const parsed = parseExtra(row.extra)
  if (parsed === null) return null

  // Existing OKF claims, including malformed or future extensions, belong to
  // the page author and must not be rewritten by this legacy repair.
  if (Object.hasOwn(parsed.extra, 'okf')) return null

  const timestamp = normalizeTimestamp(tableName === 'pages' ? row.updatedAt : row.createdAt)
  if (timestamp === null) return null

  const nextExtra: JsonObject = {
    ...parsed.extra,
    okf: {
      type: 'Reference',
      status: 'stable',
      generated: { by: LEGACY_PRODUCER, at: timestamp }
    }
  }
  return parsed.wasString ? JSON.stringify(nextExtra) : nextExtra
}

const backfillTable = async (knex: Knex, tableName: 'pages' | 'pageHistory', timestampColumn: 'updatedAt' | 'createdAt'): Promise<void> => {
  let cursor = 0
  while (true) {
    const rows = await knex<PageRow>(tableName)
      .select('id', 'extra', timestampColumn)
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(BATCH_SIZE)

    if (rows.length === 0) return

    for (const row of rows) {
      cursor = row.id
      const authority = authorityFor(row, tableName)
      if (authority === null) continue
      await knex(tableName).where({ id: row.id }).update({ extra: authority })
    }
  }
}

export const up = async (knex: Knex): Promise<void> => {
  await backfillTable(knex, 'pages', 'updatedAt')
  await backfillTable(knex, 'pageHistory', 'createdAt')
}

export const down = async (): Promise<void> => {
  // Legacy authority metadata cannot be removed without risking user-authored data.
}
