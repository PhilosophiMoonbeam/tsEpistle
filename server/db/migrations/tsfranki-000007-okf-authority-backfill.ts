import type { Knex } from 'knex'

const BATCH_SIZE = 100
const LEGACY_PRODUCER = 'import:legacy-database'

type JsonObject = Record<string, unknown>

type PageRow = {
  id: number
  extra: unknown
  sourceRevision: unknown
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

type TimestampSnapshot = {
  readonly dbValue: string | number | Date
  readonly iso: string
}

const normalizeTimestamp = (value: unknown): TimestampSnapshot | null => {
  if (!(value instanceof Date || typeof value === 'string' || typeof value === 'number')) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.valueOf())
    ? { dbValue: value, iso: date.toISOString() }
    : null
}

const authorityFor = (row: PageRow, timestamp: string): string | JsonObject | null => {
  const parsed = parseExtra(row.extra)
  if (parsed === null) return null

  // Existing OKF claims, including malformed or future extensions, belong to
  // the page author and must not be rewritten by this legacy repair.
  if (Object.hasOwn(parsed.extra, 'okf')) return null

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
      .select('id', 'extra', 'sourceRevision', timestampColumn)
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(BATCH_SIZE)

    if (rows.length === 0) return

    for (const row of rows) {
      cursor = row.id
      const timestamp = normalizeTimestamp(row[timestampColumn])
      if (timestamp === null) continue
      const authority = authorityFor(row, timestamp.iso)
      if (authority === null) continue
      await knex(tableName)
        .where({ id: row.id, sourceRevision: row.sourceRevision })
        .where(timestampColumn, timestamp.dbValue)
        .update({ extra: authority })
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
