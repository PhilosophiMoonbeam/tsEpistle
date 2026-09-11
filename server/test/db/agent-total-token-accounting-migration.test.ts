import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/tsepistle-000031-agent-total-token-accounting.ts'

const RUN_ID = '00000000-0000-4000-8000-000000000301'
const EVENT_ID = '00000000-0000-4000-8000-000000000302'
const EVENT_DATA = JSON.stringify({ kind: 'historical', value: 'unchanged' })
const EVENT_HASH = createHash('sha256').update(EVENT_DATA).digest('hex')

const createDatabase = async (databases: Knex[]): Promise<Knex> => {
  const database = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { max: 1, min: 1 }, useNullAsDefault: true })
  databases.push(database)
  await database.schema.createTable('agentRuns', table => {
    table.uuid('id').primary()
    table.bigInteger('inputTokens').notNullable().defaultTo(0)
    table.bigInteger('outputTokens').notNullable().defaultTo(0)
  })
  await database.schema.createTable('agentQuotaReservations', table => {
    table.uuid('runId').primary()
    table.bigInteger('consumedTokens').notNullable().defaultTo(0)
  })
  await database.schema.createTable('agentQuotaDaily', table => {
    table.integer('ownerId').primary()
    table.bigInteger('consumedTokens').notNullable().defaultTo(0)
  })
  await database.schema.createTable('agentEvents', table => {
    table.uuid('id').primary()
    table.uuid('runId').notNullable()
    table.string('dataSha256').notNullable()
    table.text('data').notNullable()
  })
  return database
}

describe('agent total token accounting migration', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  it('backfills a validated directional lower bound without reading charged ledgers or rewriting events', async () => {
    const database = await createDatabase(databases)
    await database('agentRuns').insert({ id: RUN_ID, inputTokens: 3, outputTokens: 309 })
    await database('agentQuotaReservations').insert({ runId: RUN_ID, consumedTokens: 4_580 })
    await database('agentQuotaDaily').insert({ ownerId: 7, consumedTokens: 4_580 })
    await database('agentEvents').insert({ id: EVENT_ID, runId: RUN_ID, dataSha256: EVENT_HASH, data: EVENT_DATA })
    const eventBefore = await database('agentEvents').first()

    await up(database)

    expect(await database.schema.hasColumn('agentRuns', 'totalTokens')).toBe(true)
    expect(await database('agentRuns').where({ id: RUN_ID }).first('inputTokens', 'outputTokens', 'totalTokens')).toEqual({
      inputTokens: 3,
      outputTokens: 309,
      totalTokens: 312
    })
    expect(await database('agentQuotaReservations').where({ runId: RUN_ID }).first('consumedTokens')).toEqual({ consumedTokens: 4_580 })
    expect(await database('agentQuotaDaily').where({ ownerId: 7 }).first('consumedTokens')).toEqual({ consumedTokens: 4_580 })
    const eventAfter = await database('agentEvents').first()
    expect(eventAfter).toEqual(eventBefore)
    expect(createHash('sha256').update(String(eventAfter?.data)).digest('hex')).toBe(eventAfter?.dataSha256)
    expect(await database('agentRuns').columnInfo('totalTokens')).toMatchObject({ nullable: false })

    await up(database)
    expect(await database('agentRuns').where({ id: RUN_ID }).first('totalTokens')).toEqual({ totalTokens: 312 })

    await down(database)
    expect(await database.schema.hasColumn('agentRuns', 'totalTokens')).toBe(false)
    expect(await database('agentEvents').first()).toEqual(eventBefore)
  })

  it('aborts before schema commit when legacy directional usage is invalid or its safe sum overflows', async () => {
    for (const [inputTokens, outputTokens] of [
      [-1, 2],
      [Number.MAX_SAFE_INTEGER, 1]
    ] as const) {
      const database = await createDatabase(databases)
      await database('agentRuns').insert({ id: RUN_ID, inputTokens, outputTokens })

      await expect(Promise.resolve(up(database))).rejects.toThrow('Cannot backfill agent run token totals: legacy directional token usage is invalid')
      expect(await database.schema.hasColumn('agentRuns', 'totalTokens')).toBe(false)
      expect(await database('agentRuns').where({ id: RUN_ID }).first('inputTokens', 'outputTokens')).toEqual({ inputTokens, outputTokens })
    }
  })
})
