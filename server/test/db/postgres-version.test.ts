import { describe, expect, it, vi } from 'vitest'
import type { Knex } from 'knex'

import {
  assertSupportedPostgresVersion,
  MAX_POSTGRES_MAJOR,
  MIN_POSTGRES_MAJOR,
  parsePostgresVersion
} from '../../db/postgres-version.ts'

const knexWithVersion = (serverVersion: string, serverVersionNum: string): Knex => ({
  raw: vi.fn().mockResolvedValue({ rows: [{ serverVersion, serverVersionNum }] })
}) as unknown as Knex

describe('PostgreSQL server version policy', () => {
  it('parses PostgreSQL version numbers without treating the minor as a major', () => {
    expect(parsePostgresVersion({ serverVersion: '17.11', serverVersionNum: '170011' })).toEqual({
      major: 17,
      number: 170011,
      version: '17.11'
    })
  })

  it.each([15, 16, 17, 18])('accepts supported PostgreSQL %s servers', async major => {
    await expect(assertSupportedPostgresVersion(knexWithVersion(`${major}.1`, `${major}0001`))).resolves.toMatchObject({ major })
  })

  it.each([
    [MIN_POSTGRES_MAJOR - 1, 'below the support floor'],
    [MAX_POSTGRES_MAJOR + 1, 'newer than the validated ceiling']
  ])('rejects PostgreSQL %s servers %s', async major => {
    await expect(assertSupportedPostgresVersion(knexWithVersion(`${major}.1`, `${major}0001`))).rejects.toMatchObject({
      code: 'UNSUPPORTED_POSTGRES_VERSION',
      message: expect.stringContaining(`PostgreSQL ${MIN_POSTGRES_MAJOR} through ${MAX_POSTGRES_MAJOR}`)
    })
  })

  it('rejects malformed server responses', async () => {
    await expect(assertSupportedPostgresVersion(knexWithVersion('', 'unknown'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_POSTGRES_VERSION'
    })
  })
})
