/// <reference types="bun" />

import knexModule from 'knex'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from './bun-test.mts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import { publicationTimestampSql } from '../helpers/search-contract.ts'
import { publicationBoundaryTimestamp, publicationWindowOpen } from '../../shared/publication-window.ts'

const connection = getPostgresTestConnection('_publication_calendar_test', import.meta.path)
const suite = connection ? describe : describe.skip
const reference = '2026-10-06T00:00:00Z'
const now = Date.parse(reference)

const boundaries = [
  { value: null, startOpen: true, endOpen: true },
  { value: '', startOpen: true, endOpen: true },
  { value: '2024-02-29T00:00:00+05:30', startOpen: true, endOpen: false },
  { value: '2000-02-29T00:00:00+14:00', startOpen: true, endOpen: false },
  { value: '2024-02-29', startOpen: true, endOpen: false },
  { value: '2020-01-01T00:00Z', startOpen: true, endOpen: false },
  { value: '2020-01-01 00:00:00', startOpen: true, endOpen: false },
  { value: '2030-01-01T00:00:00-14:00', startOpen: false, endOpen: true },
  { value: reference, startOpen: true, endOpen: true },
  { value: 'not-a-date', startOpen: false, endOpen: false },
  { value: '2020-02-30T00:00:00Z', startOpen: false, endOpen: false },
  { value: '2025-02-29T00:00:00Z', startOpen: false, endOpen: false },
  { value: '1900-02-29T00:00:00Z', startOpen: false, endOpen: false },
  { value: '0000-01-01T00:00:00Z', startOpen: false, endOpen: false },
  { value: '2020-01-01T24:00:00Z', startOpen: false, endOpen: false },
  { value: '2020-01-01T00:60:00Z', startOpen: false, endOpen: false },
  { value: '2020-01-01T00:00:60Z', startOpen: false, endOpen: false },
  { value: '2020-01-01T00:00:00+14:01', startOpen: false, endOpen: false },
  { value: '2020-01-01T00:00:00+15:00', startOpen: false, endOpen: false },
  { value: '2020-01-01T00:00:00Z trailing', startOpen: false, endOpen: false }
] as const

suite('Publication windows agree across requester/provider policy and PostgreSQL', () => {
  let db: Knex
  beforeAll(() => {
    db = knexModule({ client: 'pg', connection: connection!, pool: { min: 0, max: 1 } })
  })
  afterAll(async () => {
    await db?.destroy()
  })

  for (const boundary of boundaries) {
    it(`preserves inclusive open/closed admission for ${JSON.stringify(boundary.value)}`, async () => {
      const result = await db.raw(
        `SELECT (value IS NULL OR value = '' OR stamp <= ?::timestamptz) AS start_open,
                (value IS NULL OR value = '' OR stamp >= ?::timestamptz) AS end_open
         FROM (SELECT value, ${publicationTimestampSql('value')} AS stamp
               FROM (SELECT ?::text AS value) input) boundaries`,
        [reference, reference, boundary.value]
      )
      expect(result.rows[0].start_open === true).toBe(boundary.startOpen)
      expect(result.rows[0].end_open === true).toBe(boundary.endOpen)
      expect(publicationWindowOpen({ publishStartDate: boundary.value, publishEndDate: '' }, now)).toBe(boundary.startOpen)
      expect(publicationWindowOpen({ publishStartDate: '', publishEndDate: boundary.value }, now)).toBe(boundary.endOpen)
    })
  }

  it('keeps adapter dates/epochs inclusive and malformed disclosed bounds closed', () => {
    expect(publicationWindowOpen({ publishStartDate: new Date(now), publishEndDate: now }, now)).toBe(true)
    expect(publicationWindowOpen({ publishStartDate: new Date(Number.NaN) }, now)).toBe(false)
    expect(publicationWindowOpen({ publishEndDate: Number.POSITIVE_INFINITY }, now)).toBe(false)
    expect(publicationWindowOpen({ publishStartDate: { year: 2026 } }, now)).toBe(false)
    expect(publicationBoundaryTimestamp(new Date('0000-01-01T00:00:00Z'))).toBeNaN()
    expect(publicationWindowOpen({}, now)).toBe(true)
  })
})
