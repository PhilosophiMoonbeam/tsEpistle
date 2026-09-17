import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import {
  ensureAgentRunQuota,
  reconcileAgentRunQuota,
  reserveAgentRunQuota,
  resetAgentDailyTokenQuota
} from '../../agents/coordinator.ts'
import { down, up } from '../../db/migrations/tsepistle-000043-agent-daily-token-reset.ts'
import { parseQuotaResetOwnerId } from '../../scripts/agent-reset-daily-tokens.ts'

const now = new Date('2026-09-17T23:59:00.000Z')
const nextDay = new Date('2026-09-18T00:00:00.000Z')
const expiresAt = new Date('2026-09-18T00:05:00.000Z')
const limits = { dailyTokens: 1_000, dailyCostMicros: 10_000 }
let db: Knex

const reserve = (runId: string, tokens: number, ownerId = 7, time = now, costMicros = 10) =>
  reserveAgentRunQuota(db, runId, ownerId, { tokens, costMicros }, limits, expiresAt, time)

const settle = (runId: string, tokens: number, ownerId = 7) =>
  reconcileAgentRunQuota(db, { runId, ownerId, consumedTokens: tokens, consumedCostMicros: 10, status: 'consumed', now })

describe('owner daily token allowance reset', () => {
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { min: 1, max: 1 }, useNullAsDefault: true })
    await db.schema.createTable('users', table => { table.integer('id').primary() })
    await db('users').insert([{ id: 7 }, { id: 8 }])
    await db.schema.createTable('agentQuotaDaily', table => {
      table.integer('ownerId').notNullable()
      table.date('day').notNullable()
      table.bigInteger('reservedTokens').notNullable()
      table.bigInteger('consumedTokens').notNullable()
      table.bigInteger('reservedCostMicros').notNullable()
      table.bigInteger('consumedCostMicros').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.primary(['ownerId', 'day'])
    })
    await db.schema.createTable('agentQuotaReservations', table => {
      table.string('runId').primary()
      table.integer('ownerId').notNullable()
      table.date('day').notNullable()
      table.bigInteger('reservedTokens').notNullable()
      table.bigInteger('reservedCostMicros').notNullable()
      table.bigInteger('consumedTokens').notNullable().defaultTo(0)
      table.bigInteger('consumedCostMicros').notNullable().defaultTo(0)
      table.string('status').notNullable()
      table.dateTime('expiresAt').notNullable()
      table.dateTime('heartbeatAt').notNullable().defaultTo(db.fn.now())
      table.dateTime('reconciledAt').nullable()
    })
    await up(db)
  })
  afterEach(async () => { await db.destroy() })

  it('restores admission and dispatch headroom while charging existing holds and preserving settlement history', async () => {
    await reserve('historical', 900)
    await settle('historical', 900)
    await reserve('active', 100)
    const ledgerBefore = await db('agentQuotaReservations').orderBy('runId')
    const dailyBefore = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    await expect(reserve('denied', 1)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })

    expect(await resetAgentDailyTokenQuota(db, 7, now)).toEqual({
      ownerId: 7, day: '2026-09-17', previousCredit: 0, tokenResetCredit: 900,
      consumedTokens: 900, reservedTokens: 100, consumedCostMicros: 10, reservedCostMicros: 10
    })
    expect(await db('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual({ ...dailyBefore, tokenResetCredit: 900 })
    expect(await db('agentQuotaReservations').orderBy('runId')).toEqual(ledgerBefore)
    const afterReset = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    expect(await resetAgentDailyTokenQuota(db, 7, new Date(now.valueOf() + 1_000))).toMatchObject({ previousCredit: 900, tokenResetCredit: 900 })
    expect(await db('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(afterReset)

    await reserve('fresh', 900)
    await expect(reserve('denied', 1)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    await expect(ensureAgentRunQuota(db, 'active', 7, { tokens: 101, costMicros: 10 }, limits, expiresAt, now)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    await reconcileAgentRunQuota(db, { runId: 'fresh', ownerId: 7, consumedTokens: 0, consumedCostMicros: 0, status: 'released', now })
    await ensureAgentRunQuota(db, 'active', 7, { tokens: 1_000, costMicros: 10 }, limits, expiresAt, now)
    await expect(ensureAgentRunQuota(db, 'active', 7, { tokens: 1_001, costMicros: 10 }, limits, expiresAt, now)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    await settle('active', 800)
    expect(await db('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({ consumedTokens: 1_700, reservedTokens: 0, tokenResetCredit: 900, consumedCostMicros: 20 })
    expect(await db('agentQuotaReservations').where({ runId: 'historical' }).first()).toEqual(ledgerBefore.find(row => row.runId === 'historical'))
    await reserve('remaining', 200)
    await expect(reserve('denied', 1)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
  })

  it('isolates the owner and UTC day and does not reset the cost quota', async () => {
    for (const ownerId of [7, 8]) { await reserve(`history-${ownerId}`, 900, ownerId); await settle(`history-${ownerId}`, 900, ownerId) }
    const otherBefore = await db('agentQuotaDaily').where({ ownerId: 8 }).first()
    await resetAgentDailyTokenQuota(db, 7, now)
    expect(await db('agentQuotaDaily').where({ ownerId: 8 }).first()).toEqual(otherBefore)
    await expect(reserve('other-denied', 101, 8)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    await reserve('tomorrow', 1_000, 7, nextDay)
    await expect(reserve('tomorrow-denied', 1, 7, nextDay)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    expect(await db('agentQuotaDaily').where({ ownerId: 7, day: '2026-09-18' }).first()).toMatchObject({ tokenResetCredit: 0, consumedTokens: 0 })
    await expect(reserveAgentRunQuota(db, 'cost-denied', 7, { tokens: 1, costMicros: 1 }, { dailyTokens: 1_000, dailyCostMicros: 10 }, expiresAt, now)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
  })

  it('never clears positive pending settlement or its full active hold', async () => {
    await reserve('historical', 800)
    await settle('historical', 800)
    await reserve('pending', 200)
    await db('agentQuotaReservations').where({ runId: 'pending' }).update({ consumedTokens: 60, consumedCostMicros: 5 })
    const pendingBefore = await db('agentQuotaReservations').where({ runId: 'pending' }).first()
    expect(await resetAgentDailyTokenQuota(db, 7, now)).toMatchObject({ tokenResetCredit: 800, reservedTokens: 200 })
    expect(await db('agentQuotaReservations').where({ runId: 'pending' }).first()).toEqual(pendingBefore)
    await expect(ensureAgentRunQuota(db, 'pending', 7, { tokens: 201, costMicros: 10 }, limits, expiresAt, now)).rejects.toMatchObject({ code: 'AGENT_QUOTA_SETTLEMENT_REQUIRED' })
    await settle('pending', 100)
    expect(await db('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({ consumedTokens: 900, reservedTokens: 0, tokenResetCredit: 800, consumedCostMicros: 20 })
  })

  it.each([-1, Number.MAX_SAFE_INTEGER])('fails closed on invalid or overflowing reset credit %s in both quota paths', async credit => {
    await reserve('active', 1)
    await db('agentQuotaDaily').where({ ownerId: 7 }).update({ tokenResetCredit: credit })
    const before = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    await expect(reserve('denied', 1)).rejects.toMatchObject({ code: 'AGENT_QUOTA_CORRUPT' })
    await expect(ensureAgentRunQuota(db, 'active', 7, { tokens: 2, costMicros: 10 }, limits, expiresAt, now)).rejects.toMatchObject({ code: 'AGENT_QUOTA_CORRUPT' })
    expect(await db('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(before)
  })

  it('rejects invalid or missing owners and treats an existing owner with no usage as a no-op', async () => {
    for (const owner of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(resetAgentDailyTokenQuota(db, owner, now)).rejects.toMatchObject({ code: 'INVALID_AGENT_QUOTA' })
    await expect(resetAgentDailyTokenQuota(db, 9, now)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })
    expect(await resetAgentDailyTokenQuota(db, 7, now)).toMatchObject({ ownerId: 7, day: '2026-09-17', tokenResetCredit: 0, consumedTokens: 0 })
    expect(await db('agentQuotaDaily')).toEqual([])
  })

  it('adds default-zero credit without changing existing usage and refuses destructive rollback after a reset', async () => {
    await down(db)
    await db('agentQuotaDaily').insert({ ownerId: 7, day: '2026-09-17', consumedTokens: 900, reservedTokens: 0, consumedCostMicros: 10, reservedCostMicros: 0, updatedAt: now })
    const before = await db('agentQuotaDaily').first()
    await up(db)
    await up(db)
    expect(await db('agentQuotaDaily').first()).toEqual({ ...before, tokenResetCredit: 0 })
    await resetAgentDailyTokenQuota(db, 7, now)
    await expect(down(db)).rejects.toThrow('Daily token reset credits exist')
    expect(await db('agentQuotaDaily').first()).toEqual({ ...before, tokenResetCredit: 900 })
  })

  it('requires exactly one positive CLI owner and offers no domain-wide or arbitrary-day mode', () => {
    expect(parseQuotaResetOwnerId(['--owner-id', '7'])).toBe(7)
    for (const args of [[], ['--all'], ['--owner-id', '0'], ['--owner-id', '-1'], ['--owner-id', '1.2'], ['--owner-id', '9007199254740992'], ['--owner-id', '7', '--day', '2026-09-16']]) expect(() => parseQuotaResetOwnerId(args)).toThrow()
  })
})
