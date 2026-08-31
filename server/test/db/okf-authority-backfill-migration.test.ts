import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import { up } from '../../db/migrations/tsfranki-000007-okf-authority-backfill.ts'

type StoredExtra = string | Record<string, unknown>
type PageRow = { id: number; extra: StoredExtra; updatedAt: string }
type HistoryRow = { id: number; extra: StoredExtra; createdAt: string }

const parseExtra = (value: StoredExtra): Record<string, unknown> => typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value

const createTables = async (db: Knex): Promise<void> => {
  await db.schema.createTable('pages', table => {
    table.increments('id').primary()
    table.json('extra').notNullable()
    table.text('content').notNullable().defaultTo('legacy content')
    table.string('updatedAt').notNullable()
  })
  await db.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.json('extra').notNullable()
    table.text('content').notNullable().defaultTo('legacy history')
    table.string('createdAt').notNullable()
  })
}

describe('OKF authority backfill migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createTables(db)
  })

  afterEach(async () => await db.destroy())

  it('backfills current and history rows while preserving valid claims, extensions, and malformed values', async () => {
    const validOkf = {
      type: 'Guide',
      status: 'stable',
      generated: { by: 'human:7', at: '2026-08-20T12:00:00.000Z' },
      verified: { by: 'human:7', at: '2026-08-21T12:00:00.000Z' },
      extension_family: { score: 7 }
    }
    const claimedMalformedOkf = { type: 'FutureType', status: 'future-status' }
    await db<PageRow>('pages').insert([
      { id: 1, extra: JSON.stringify({ source: 'legacy', nested: { keep: true } }), updatedAt: '2026-08-31T12:00:00+02:00' },
      { id: 2, extra: JSON.stringify({ source: 'legacy-string' }), updatedAt: '2026-08-30 01:02:03+00:00' },
      { id: 3, extra: JSON.stringify({ okf: validOkf, source: 'authored' }), updatedAt: '2026-08-29T00:00:00Z' },
      { id: 4, extra: 'not-json', updatedAt: '2026-08-28T00:00:00Z' },
      { id: 5, extra: JSON.stringify({ okf: claimedMalformedOkf, source: 'claimed' }), updatedAt: '2026-08-27T00:00:00Z' }
    ])
    await db<HistoryRow>('pageHistory').insert([
      { id: 10, extra: JSON.stringify({ revision: 1 }), createdAt: '2026-08-26T04:05:06-04:00' },
      { id: 11, extra: JSON.stringify({ revision: 2 }), createdAt: '2026-08-25T00:00:00Z' },
      { id: 12, extra: JSON.stringify({ okf: validOkf, revision: 3 }), createdAt: '2026-08-24T00:00:00Z' },
      { id: 13, extra: 'bad-history-json', createdAt: '2026-08-23T00:00:00Z' }
    ])

    const beforeValid = await db<PageRow>('pages').where({ id: 3 }).first()
    const beforeMalformedClaim = await db<PageRow>('pages').where({ id: 5 }).first()
    const beforeHistoryValid = await db<HistoryRow>('pageHistory').where({ id: 12 }).first()
    const beforeMalformed = await db<PageRow>('pages').where({ id: 4 }).first()
    const beforeHistoryMalformed = await db<HistoryRow>('pageHistory').where({ id: 13 }).first()

    await up(db)

    expect(parseExtra((await db<PageRow>('pages').where({ id: 1 }).first())!.extra)).toEqual({
      source: 'legacy',
      nested: { keep: true },
      okf: { type: 'Reference', status: 'stable', generated: { by: 'import:legacy-database', at: '2026-08-31T10:00:00.000Z' } }
    })
    expect(parseExtra((await db<PageRow>('pages').where({ id: 2 }).first())!.extra)).toEqual({
      source: 'legacy-string',
      okf: { type: 'Reference', status: 'stable', generated: { by: 'import:legacy-database', at: '2026-08-30T01:02:03.000Z' } }
    })
    expect((await db<PageRow>('pages').where({ id: 2 }).first())!.extra).toBeTypeOf('string')
    expect((await db<PageRow>('pages').where({ id: 3 }).first())!.extra).toEqual(beforeValid!.extra)
    expect((await db<PageRow>('pages').where({ id: 5 }).first())!.extra).toEqual(beforeMalformedClaim!.extra)
    expect((await db<PageRow>('pages').where({ id: 4 }).first())!.extra).toBe(beforeMalformed!.extra)

    expect(parseExtra((await db<HistoryRow>('pageHistory').where({ id: 10 }).first())!.extra).okf).toEqual({
      type: 'Reference', status: 'stable', generated: { by: 'import:legacy-database', at: '2026-08-26T08:05:06.000Z' }
    })
    expect(parseExtra((await db<HistoryRow>('pageHistory').where({ id: 11 }).first())!.extra).okf).toEqual({
      type: 'Reference', status: 'stable', generated: { by: 'import:legacy-database', at: '2026-08-25T00:00:00.000Z' }
    })
    expect((await db<HistoryRow>('pageHistory').where({ id: 11 }).first())!.extra).toBeTypeOf('string')
    expect((await db<HistoryRow>('pageHistory').where({ id: 12 }).first())!.extra).toEqual(beforeHistoryValid!.extra)
    expect((await db<HistoryRow>('pageHistory').where({ id: 13 }).first())!.extra).toBe(beforeHistoryMalformed!.extra)
  })

  it('is a no-op on a second run', async () => {
    await db<PageRow>('pages').insert({ id: 1, extra: JSON.stringify({ source: 'legacy' }), updatedAt: '2026-08-31T00:00:00Z' })
    await db<HistoryRow>('pageHistory').insert({ id: 1, extra: JSON.stringify({ source: 'legacy' }), createdAt: '2026-08-31T00:00:00Z' })

    await up(db)
    const pagesAfterFirstRun = await db<PageRow>('pages').orderBy('id')
    const historyAfterFirstRun = await db<HistoryRow>('pageHistory').orderBy('id')
    await up(db)

    expect(await db<PageRow>('pages').orderBy('id')).toEqual(pagesAfterFirstRun)
    expect(await db<HistoryRow>('pageHistory').orderBy('id')).toEqual(historyAfterFirstRun)
  })
})
