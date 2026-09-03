import type { Knex } from 'knex'

export const MIN_POSTGRES_MAJOR = 15
export const MAX_POSTGRES_MAJOR = 18
export const SUPPORTED_POSTGRES_MAJORS = [15, 16, 17, 18] as const

interface PostgresVersionRow {
  serverVersion: string
  serverVersionNum: string
}

export interface PostgresVersion {
  major: number
  number: number
  version: string
}

export class UnsupportedPostgresVersionError extends Error {
  readonly code = 'UNSUPPORTED_POSTGRES_VERSION'
}

export const parsePostgresVersion = (row: PostgresVersionRow): PostgresVersion => {
  const number = Number.parseInt(row.serverVersionNum, 10)
  if (!Number.isSafeInteger(number) || number <= 0 || typeof row.serverVersion !== 'string' || row.serverVersion.length === 0) {
    throw new UnsupportedPostgresVersionError('PostgreSQL returned an invalid server version.')
  }
  return {
    major: Math.floor(number / 10000),
    number,
    version: row.serverVersion
  }
}

export const assertSupportedPostgresVersion = async (knex: Knex): Promise<PostgresVersion> => {
  const result = await knex.raw<{ rows: PostgresVersionRow[] }>(`
    SELECT
      current_setting('server_version') AS "serverVersion",
      current_setting('server_version_num') AS "serverVersionNum"
  `)
  const row = result.rows[0]
  if (!row) throw new UnsupportedPostgresVersionError('PostgreSQL did not return its server version.')
  const version = parsePostgresVersion(row)
  if (version.major < MIN_POSTGRES_MAJOR || version.major > MAX_POSTGRES_MAJOR) {
    throw new UnsupportedPostgresVersionError(
      `PostgreSQL ${version.version} is unsupported. tsEpistle requires a current minor release of PostgreSQL ${MIN_POSTGRES_MAJOR} through ${MAX_POSTGRES_MAJOR}.`
    )
  }
  return version
}
