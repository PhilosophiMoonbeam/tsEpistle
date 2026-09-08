import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

import knexModule, { type Knex } from 'knex'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { claimPageMutationEffects, enqueuePageMutationEffects, executePageMutationEffect } from '../core/page-mutation-outbox.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database === 'wiki_search_audit' && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        database,
        password
      }
    : null
const suite = connection ? describe : describe.skip
const schema = `utility_admission_${randomUUID().replaceAll('-', '')}`

suite('Utility admission on PostgreSQL', () => {
  let db: Knex

  const enqueueKnowledge = async (pageId: number): Promise<void> => {
    await enqueuePageMutationEffects(db, {
      pageId,
      sourceRevision: '1',
      desiredState: 'present',
      action: 'update',
      source: `# Knowledge ${pageId}\n`,
      location: { locale: 'en', path: `knowledge/${pageId}`, visibility: 'public', ownerId: null },
      effects: ['knowledge']
    })
  }

  beforeAll(async () => {
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await admin.destroy()
    }
    db = knexModule({
      client: 'pg',
      connection: connection ?? undefined,
      searchPath: [schema],
      pool: { min: 0, max: 4 }
    })
    await db.schema.createTable('pageMutationOutbox', table => {
      table.uuid('id').primary()
      table.integer('pageId').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.string('effectKind').notNullable()
      table.string('effectKey').notNullable()
      table.string('desiredState').notNullable()
      table.string('payloadSha256').notNullable()
      table.text('payload').notNullable()
      table.string('status').notNullable().defaultTo('pending')
      table.integer('attempts').notNullable().defaultTo(0)
      table.string('leaseOwner').nullable()
      table.uuid('leaseToken').nullable()
      table.timestamp('leaseExpiresAt', { useTz: true }).nullable()
      table.timestamp('availableAt', { useTz: true }).notNullable()
      table.text('result').nullable()
      table.text('postcondition').nullable()
      table.timestamp('createdAt', { useTz: true }).notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
      table.unique(['pageId', 'sourceRevision', 'effectKind'])
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.bigInteger('sourceRevision').notNullable()
    })
  })

  afterAll(async () => {
    if (db) await db.destroy()
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.destroy()
    }
  })

  beforeEach(async () => {
    await db('pageMutationOutbox').delete()
    await db('pages').delete()
  })

  it('serializes concurrent knowledge claims before checking global capacity', async () => {
    for (let pageId = 1; pageId <= 4; pageId += 1) await enqueueKnowledge(pageId)
    const functionName = `utility_admission_claim_pause_${randomUUID().replaceAll('-', '')}`
    const triggerName = `utility_admission_claim_pause_${randomUUID().replaceAll('-', '')}`
    await db.raw(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'running' AND OLD.status IN ('pending', 'retry') THEN
          PERFORM pg_sleep(0.25);
        END IF;
        RETURN NEW;
      END;
      $$`)
    await db.raw(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON "pageMutationOutbox" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`)
    try {
      const now = new Date('2100-08-18T00:00:00.000Z')
      const [first, second] = await Promise.all([
        claimPageMutationEffects(db, {
          leaseOwner: 'race-worker-a',
          limit: 2,
          maxActive: 2,
          leaseMs: 60_000,
          effects: ['knowledge'],
          now
        }),
        claimPageMutationEffects(db, {
          leaseOwner: 'race-worker-b',
          limit: 2,
          maxActive: 2,
          leaseMs: 60_000,
          effects: ['knowledge'],
          now
        })
      ])

      expect([...first, ...second]).toHaveLength(2)
      expect(await db('pageMutationOutbox').where({ effectKind: 'knowledge', status: 'running' }).where('leaseExpiresAt', '>', now.toISOString())).toHaveLength(
        2
      )
    } finally {
      await db.raw(`DROP TRIGGER IF EXISTS "${triggerName}" ON "pageMutationOutbox"`)
      await db.raw(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    }
  })

  it('admits replacement work after completion and reclaims expired utility leases', async () => {
    await enqueueKnowledge(1)
    await enqueueKnowledge(2)
    const now = new Date('2100-08-19T00:00:00.000Z')
    const [first] = await claimPageMutationEffects(db, {
      leaseOwner: 'completion-worker',
      limit: 1,
      maxActive: 1,
      leaseMs: 1_000,
      effects: ['knowledge'],
      now
    })
    if (!first) throw new Error('first knowledge claim missing')
    expect(
      await claimPageMutationEffects(db, {
        leaseOwner: 'blocked-worker',
        limit: 1,
        maxActive: 1,
        leaseMs: 1_000,
        effects: ['knowledge'],
        now
      })
    ).toEqual([])

    await executePageMutationEffect(
      db,
      first,
      {
        knowledge: {
          kind: 'knowledge',
          reconcile: async () => ({
            result: { persisted: true },
            postcondition: { satisfied: true, observedSourceRevision: '1', detail: 'synthetic knowledge projection completed' }
          })
        }
      },
      new AbortController().signal
    )
    const [replacement] = await claimPageMutationEffects(db, {
      leaseOwner: 'replacement-worker',
      limit: 1,
      maxActive: 1,
      leaseMs: 1_000,
      effects: ['knowledge'],
      now
    })
    if (!replacement) throw new Error('replacement knowledge claim missing')

    const [reclaimed] = await claimPageMutationEffects(db, {
      leaseOwner: 'recovery-worker',
      limit: 1,
      maxActive: 1,
      leaseMs: 1_000,
      effects: ['knowledge'],
      now: new Date(now.valueOf() + 1_001)
    })
    expect(reclaimed).toMatchObject({ id: replacement.id, attempts: 2 })
  })
  it('starts an implicit lease clock after waiting for the scoped admission lock', async () => {
    await enqueueKnowledge(1)
    const initial = new Date('2100-08-20T00:00:00.000Z')
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const heldLock = db.transaction(async transaction => {
      await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [0x57494b4f, 'knowledge'])
      ready.resolve()
      await release.promise
    })
    await ready.promise
    vi.useFakeTimers()
    vi.setSystemTime(initial)
    const pendingClaim = claimPageMutationEffects(db, {
      leaseOwner: 'waited-worker',
      limit: 1,
      maxActive: 1,
      leaseMs: 1_000,
      effects: ['knowledge']
    })
    try {
      // The database lock is real; fake time deterministically advances while the claimant cannot acquire it.
      vi.setSystemTime(new Date(initial.valueOf() + 1_001))
      release.resolve()
      await heldLock

      const [claim] = await pendingClaim
      if (!claim) throw new Error('knowledge claim missing after admission lock release')
      const stored = await db('pageMutationOutbox').where({ id: claim.id }).first('leaseExpiresAt')
      expect(new Date(String(stored?.leaseExpiresAt)).valueOf()).toBeGreaterThan(Date.now())
    } finally {
      release.resolve()
      await heldLock
      vi.useRealTimers()
    }
  })
})
