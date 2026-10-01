import { describe, expect, it, vi } from '../bun-test.mts'
import type { Knex } from 'knex'

import { assertSupportedPostgresVersion, parsePostgresVersion } from '../../db/postgres-version.ts'

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
    expect(await assertSupportedPostgresVersion(knexWithVersion(`${major}.1`, `${major}0001`))).toMatchObject({ major })
  })

  it.each([
    [14, 'below the support floor'],
    [19, 'newer than the validated ceiling']
  ])('rejects PostgreSQL %s servers %s', async major => {
    await expect(Promise.resolve(assertSupportedPostgresVersion(knexWithVersion(`${major}.1`, `${major}0001`)))).rejects.toMatchObject({
      code: 'UNSUPPORTED_POSTGRES_VERSION'
    })
  })

  it.each([
    ['', 'unknown'],
    ['17.1', 'unknown'],
    ['', '170001']
  ])('rejects malformed server responses (%s, %s)', async (serverVersion, serverVersionNum) => {
    await expect(Promise.resolve(assertSupportedPostgresVersion(knexWithVersion(serverVersion, serverVersionNum)))).rejects.toMatchObject({
      code: 'UNSUPPORTED_POSTGRES_VERSION'
    })
  })
})
