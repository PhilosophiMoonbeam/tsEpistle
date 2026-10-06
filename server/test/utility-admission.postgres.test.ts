import { randomUUID } from 'node:crypto'

import knexModule from 'knex'
import type { Knex } from 'knex'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { claimPageMutationEffects, enqueuePageMutationEffects, executePageMutationEffect } from '../core/page-mutation-outbox.ts'
import type { ClaimedPageProjectionEffect, PageProjectionEffectKind } from '../core/page-mutation-outbox.ts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import { up as createKnowledgeProjectionStore } from '../db/migrations/2.5.152.ts'
import { up as createKnowledgeSearchStore } from '../db/migrations/tsepistle-000027-knowledge-search.ts'
import { up as createKnowledgeMaintenanceStore } from '../db/migrations/tsfranki-000006-knowledge-maintenance.ts'
import { lockSearchIndex, lockSearchPage, publicationTimestampSql } from '../helpers/search-contract.ts'
import { PageKnowledgeLifecycle, PageKnowledgeRepository } from '../knowledge/lifecycle.ts'
import type { AgentKnowledgeEnrichmentRequest } from '../agents/providers/utility.ts'

const connection = getPostgresTestConnection('_utility_admission_test', import.meta.path)
const suite = connection ? describe : describe.skip
const schema = `utility_admission_${randomUUID().replaceAll('-', '')}`

suite('Utility admission on PostgreSQL', () => {
  let db: Knex

  const enqueuePageEffects = async (pageId: number, effects: readonly PageProjectionEffectKind[] = ['knowledge']): Promise<void> => {
    await db('pages').insert({
      id: pageId,
      sourceRevision: '1',
      content: `# Knowledge ${pageId}\n`,
      render: `<article>Knowledge ${pageId}</article>`,
      renderedSourceRevision: '1',
      localeCode: 'en',
      path: `knowledge/${pageId}`,
      visibility: 'public',
      ownerId: null,
      isPublished: true,
      isSearchable: true,
      publishStartDate: null,
      publishEndDate: null,
      contentType: 'markdown',
      title: `Knowledge ${pageId}`,
      description: null,
      authorId: 1,
      updatedAt: '2026-09-09T00:00:00.000Z',
      extra: JSON.stringify({ okf: { type: 'Procedure', status: 'stable' } })
    })
    await enqueuePageMutationEffects(db, {
      pageId,
      sourceRevision: '1',
      desiredState: 'present',
      action: 'update',
      source: `# Knowledge ${pageId}\n`,
      location: { locale: 'en', path: `knowledge/${pageId}`, visibility: 'public', ownerId: null },
      effects
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
      table.text('content').notNullable()
      table.text('render').notNullable()
      table.text('toc').notNullable().defaultTo('[]')
      table.bigInteger('renderedSourceRevision').nullable()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.boolean('isPublished').notNullable()
      table.boolean('isSearchable').notNullable()
      table.string('publishStartDate').nullable()
      table.string('publishEndDate').nullable()
      table.string('contentType').notNullable()
      table.string('title').notNullable()
      table.text('description').nullable()
      table.integer('authorId').notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
      table.jsonb('extra').notNullable()
    })
    await db.schema.createTable('pageAccessPasswords', table => {
      table.integer('pageId').primary()
    })
    await db.schema.createTable('tags', table => {
      table.increments('id').primary()
      table.string('tag').notNullable()
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable()
      table.integer('tagId').notNullable()
    })
    await db.schema.createTable('pagesSearchMetadata', table => {
      table.specificType('contractId', 'smallint').primary()
      table.integer('schemaVersion').notNullable()
      table.text('dictionary').notNullable()
    })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.uuid('id').primary()
      table.string('status').notNullable()
      table.boolean('isGlobalDefault').notNullable()
      table.boolean('conformed').notNullable()
      table.uuid('currentVersionId').nullable()
      table.timestamp('deletedAt', { useTz: true }).nullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.boolean('conformed').notNullable()
    })
    await createKnowledgeProjectionStore(db)
    await createKnowledgeSearchStore(db)
    await createKnowledgeMaintenanceStore(db)
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
    await db('pageKnowledgeProjections').delete()
    await db('pageAccessPasswords').delete()
    await db('pageTags').delete()
    await db('tags').delete()
    await db('agentProviderProfiles').delete()
    await db('agentProviderProfileVersions').delete()
    await db('pageKnowledgeMaintenance').delete()
    await db('pageKnowledgeMaintenance').insert({ id: 1 })
    await db('pagesSearchMetadata').insert({ contractId: 1, schemaVersion: 2, dictionary: 'english' }).onConflict('contractId').merge()
    await db('pageMutationOutbox').delete()
    await db('pages').delete()
  })

  it('admits malformed publication windows for search cleanup without blocking later rendered pages', async () => {
    const now = new Date('2100-08-21T00:00:00.000Z')
    const windows = [
      { pageId: 1, publishStartDate: null, publishEndDate: 'not-a-date' },
      { pageId: 2, publishStartDate: now.toISOString(), publishEndDate: now.toISOString() },
      { pageId: 3, publishStartDate: '', publishEndDate: '' },
      { pageId: 4, publishStartDate: '2100-08-21T10:00:00+10:00', publishEndDate: '2100-08-20T14:00:00-10:00' },
      { pageId: 5, publishStartDate: null, publishEndDate: null }
    ]
    for (const window of windows) {
      await enqueuePageEffects(window.pageId, ['render', 'search'])
      await db('pages').where({ id: window.pageId }).update({
        publishStartDate: window.publishStartDate,
        publishEndDate: window.publishEndDate
      })
      await db('pageMutationOutbox')
        .where({ pageId: window.pageId, effectKind: 'search' })
        .update({
          availableAt: new Date(now.valueOf() - 60_000 + window.pageId * 1_000).toISOString()
        })
    }
    await db('pageMutationOutbox').where({ pageId: 5, sourceRevision: '1', effectKind: 'render' }).update({
      status: 'succeeded',
      result: '{"rendered":true}',
      postcondition: '{"satisfied":true,"observedSourceRevision":"1"}'
    })

    const claims = await claimPageMutationEffects(db, {
      leaseOwner: 'publication-window-worker',
      limit: 2,
      maxActive: 2,
      effects: ['search'],
      now
    })

    expect(claims.map(claim => ({ pageId: claim.payload.pageId, effectKind: claim.payload.effectKind, desiredState: claim.payload.desiredState }))).toEqual([
      { pageId: 1, effectKind: 'search', desiredState: 'present' },
      { pageId: 5, effectKind: 'search', desiredState: 'present' }
    ])
    expect(await db('pageMutationOutbox').where({ effectKind: 'search' }).select('pageId', 'status', 'attempts').orderBy('pageId')).toEqual([
      { pageId: 1, status: 'running', attempts: 1 },
      { pageId: 2, status: 'pending', attempts: 0 },
      { pageId: 3, status: 'pending', attempts: 0 },
      { pageId: 4, status: 'pending', attempts: 0 },
      { pageId: 5, status: 'running', attempts: 1 }
    ])
  })

  it('withholds invalid publication calendars from utility source dispatch while preserving empty and leap-offset windows', async () => {
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'enabled',
      isGlobalDefault: true,
      conformed: true,
      currentVersionId: profileVersionId,
      deletedAt: null
    })
    const windows = [
      { publishStartDate: '2020-02-30T00:00:00Z', publishEndDate: '' },
      { publishStartDate: '0000-01-01T00:00:00Z', publishEndDate: '' },
      { publishStartDate: '2020-01-01T24:00:00Z', publishEndDate: '' },
      { publishStartDate: '2020-01-01T00:00:00+14:01', publishEndDate: '' },
      { publishStartDate: '', publishEndDate: '' },
      { publishStartDate: '2020-02-29T12:00:00+05:30', publishEndDate: '2999-01-01T00:00:00-05:30' },
      { publishStartDate: '', publishEndDate: '2999-02-30T00:00:00Z' }
    ]
    for (const [index, window] of windows.entries()) {
      await enqueuePageEffects(index + 1)
      await db('pages')
        .where({ id: index + 1 })
        .update(window)
    }
    const eligible = await db('pages')
      .select('id')
      .whereRaw(`("publishStartDate" IS NULL OR "publishStartDate" = '' OR ${publicationTimestampSql('"publishStartDate"')} <= statement_timestamp())`)
      .whereRaw(`("publishEndDate" IS NULL OR "publishEndDate" = '' OR ${publicationTimestampSql('"publishEndDate"')} >= statement_timestamp())`)
      .orderBy('id')
    expect(eligible.map(row => row.id)).toEqual([5, 6])

    const enrichKnowledge = vi.fn(async (_request: AgentKnowledgeEnrichmentRequest) => ({
      value: { type: null, summary: null, tags: [], entities: [], relationships: [], openQuestions: [], searchTerms: ['calendaradmission'] },
      model: 'utility-small',
      inputSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64),
      inputTokens: 1,
      outputTokens: 1
    }))
    await new PageKnowledgeLifecycle(db, 'publication-calendar-worker', { enrichKnowledge }).runOnce()
    expect(enrichKnowledge.mock.calls.map(call => call[0].page.content).sort()).toEqual(['# Knowledge 5\n', '# Knowledge 6\n'])
    expect(await db('pageKnowledgeProjections').whereIn('pageId', [1, 2, 3, 4, 7]).select('pageId', 'enrichmentState').orderBy('pageId')).toEqual(
      [1, 2, 3, 4, 7].map(pageId => ({ pageId, enrichmentState: 'withheld-unpublished' }))
    )
  })

  it('serializes concurrent knowledge claims before checking global capacity', async () => {
    for (let pageId = 1; pageId <= 4; pageId += 1) await enqueuePageEffects(pageId)
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
    await enqueuePageEffects(1)
    await enqueuePageEffects(2)
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
    await enqueuePageEffects(1)
    const initial = new Date('2100-08-20T00:00:00.000Z')
    const claimant = knexModule({
      client: 'pg',
      connection: connection ?? undefined,
      searchPath: [schema],
      pool: { min: 0, max: 1 }
    })
    const ready = Promise.withResolvers<number>()
    const release = Promise.withResolvers<void>()
    const heldLock = db.transaction(async transaction => {
      await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [0x57494b4f, 'knowledge'])
      const holder = await transaction.raw<{ rows: { pid: number }[] }>('SELECT pg_backend_pid() AS pid')
      if (!holder.rows[0]) throw new Error('admission lock holder backend missing')
      ready.resolve(holder.rows[0].pid)
      await release.promise
    })
    void heldLock.catch(ready.reject)
    let pendingClaim: Promise<readonly ClaimedPageProjectionEffect[]> | undefined
    try {
      const holderPid = await ready.promise
      // A one-connection pool pins the observed backend to the actual claimant transaction.
      const backend = await claimant.raw<{ rows: { pid: number }[] }>('SELECT pg_backend_pid() AS pid')
      if (!backend.rows[0]) throw new Error('claimant backend missing')
      const claimantPid = backend.rows[0].pid
      vi.useFakeTimers()
      vi.setSystemTime(initial)
      pendingClaim = claimPageMutationEffects(claimant, {
        leaseOwner: 'waited-worker',
        limit: 1,
        maxActive: 1,
        leaseMs: 1_000,
        effects: ['knowledge']
      })
      const settledClaim = Promise.allSettled([pendingClaim])
      const deadline = process.hrtime.bigint() + 2_000_000_000n
      while (true) {
        const observation = await db.raw<{ rows: { blocked: boolean }[] }>(
          `SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE pid = ? AND locktype = 'advisory' AND NOT granted
              AND ?::integer = ANY(pg_blocking_pids(pid))
          ) AS blocked`,
          [claimantPid, holderPid]
        )
        if (observation.rows[0]?.blocked) break
        if (process.hrtime.bigint() >= deadline) throw new Error('claimant did not wait for the held admission lock')
        // Server-side sleep and monotonic time remain real while the lease clock is faked.
        await db.raw('SELECT pg_sleep(0.01)')
      }
      vi.setSystemTime(new Date(initial.valueOf() + 1_001))
      release.resolve()
      await heldLock

      const [result] = await settledClaim
      if (!result) throw new Error('knowledge claim result missing')
      if (result.status === 'rejected') throw result.reason
      const [claim] = result.value
      if (!claim) throw new Error('knowledge claim missing after admission lock release')
      const stored = await db('pageMutationOutbox').where({ id: claim.id }).first('leaseExpiresAt')
      expect(new Date(String(stored?.leaseExpiresAt)).valueOf()).toBeGreaterThan(Date.now())
    } finally {
      release.resolve()
      await Promise.allSettled([heldLock, ...(pendingClaim ? [pendingClaim] : [])])
      vi.useRealTimers()
      await claimant.destroy()
    }
  })

  it('preserves a competing lease acquired after utility requeue selects its candidate', async () => {
    await enqueuePageEffects(1)
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'enabled',
      isGlobalDefault: true,
      conformed: true,
      currentVersionId: profileVersionId,
      deletedAt: null
    })
    await new PageKnowledgeLifecycle(db, 'initial-unavailable-worker').runOnce()
    const immutableEffect = await db('pageMutationOutbox').where({ pageId: 1, effectKind: 'knowledge' }).first('id', 'payload', 'payloadSha256')
    // Keep the maintenance epoch leased elsewhere so this worker reaches utility
    // requeue before waiting on the canonical page held by the competing scheduler.
    await db('pageKnowledgeMaintenance')
      .where({ id: 1 })
      .update({
        status: 'running',
        epochId: 1,
        highWaterPageId: 1,
        cursorPageId: 0,
        leaseOwner: 'other-maintenance-worker',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    const retryDb = knexModule({
      client: 'pg',
      connection: connection ?? undefined,
      searchPath: [schema],
      pool: { min: 0, max: 1 }
    })
    const ready = Promise.withResolvers<number>()
    const acquireClaim = Promise.withResolvers<void>()
    const competingScheduler = db.transaction(async transaction => {
      await lockSearchIndex(transaction, false)
      await lockSearchPage(transaction, 1)
      await transaction('pages').where({ id: 1 }).forUpdate().first('id')
      const backend = await transaction.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')
      if (!backend.rows[0]) throw new Error('competing scheduler backend missing')
      ready.resolve(backend.rows[0].pid)
      await acquireClaim.promise
      await transaction('pageMutationOutbox').where({ id: immutableEffect.id, status: 'succeeded' }).update({ status: 'pending' })
      const [claim] = await claimPageMutationEffects(transaction, {
        leaseOwner: 'competing-worker',
        limit: 1,
        maxActive: 1,
        leaseMs: 60_000,
        effects: ['knowledge']
      })
      if (!claim) throw new Error('competing knowledge claim missing')
      return claim
    })
    void competingScheduler.catch(ready.reject)
    const enrichKnowledge = vi.fn(async () => ({
      value: { type: null, summary: null, tags: ['unaccepted'], entities: [], relationships: [], openQuestions: [], searchTerms: [] },
      model: 'utility-small',
      inputSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64),
      inputTokens: 1,
      outputTokens: 1
    }))
    let retry: Promise<{ backfilled: number; requeued: number; processed: number }> | undefined
    try {
      const holderPid = await ready.promise
      await retryDb.raw("SET statement_timeout = '5s'")
      const backend = await retryDb.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')
      if (!backend.rows[0]) throw new Error('utility retry backend missing')
      const retryPid = backend.rows[0].pid
      retry = new PageKnowledgeLifecycle(retryDb, 'retry-worker', { enrichKnowledge }).runOnce()
      const settledRetry = Promise.allSettled([retry])
      const deadline = process.hrtime.bigint() + 2_000_000_000n
      while (true) {
        const observation = await db.raw<{ rows: Array<{ blocked: boolean }> }>('SELECT ?::integer = ANY(pg_blocking_pids(?::integer)) AS blocked', [
          holderPid,
          retryPid
        ])
        if (observation.rows[0]?.blocked) break
        if (process.hrtime.bigint() >= deadline) throw new Error('utility requeue did not wait for the competing scheduler')
        await db.raw('SELECT pg_sleep(0.01)')
      }
      acquireClaim.resolve()
      const claim = await competingScheduler
      const [outcome] = await settledRetry
      if (!outcome) throw new Error('utility retry outcome missing')
      if (outcome.status === 'rejected') throw outcome.reason
      expect(outcome.value).toMatchObject({ requeued: 0, processed: 0 })
      expect(enrichKnowledge).not.toHaveBeenCalled()
      expect(await db('pageMutationOutbox').where({ id: claim.id }).first('status', 'leaseOwner', 'leaseToken')).toEqual({
        status: 'running',
        leaseOwner: 'competing-worker',
        leaseToken: claim.leaseToken
      })
      expect(await db('pageMutationOutbox').where({ id: claim.id }).first('id', 'payload', 'payloadSha256')).toEqual(immutableEffect)
      expect(await db('pageKnowledgeProjections').where({ pageId: 1 }).first('enrichmentState', 'utilityModel')).toEqual({
        enrichmentState: 'unavailable',
        utilityModel: null
      })
    } finally {
      acquireClaim.resolve()
      await Promise.allSettled([competingScheduler, ...(retry ? [retry] : [])])
      await retryDb.destroy()
    }
  }, 15_000)

  it('overlaps canonical-page maintenance and utility requeue without an effect-to-page deadlock', async () => {
    await enqueuePageEffects(1)
    const profileVersionId = '00000000-0000-4000-8000-000000000001'
    await db('agentProviderProfileVersions').insert({ id: profileVersionId, conformed: true })
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'enabled',
      isGlobalDefault: true,
      conformed: true,
      currentVersionId: profileVersionId,
      deletedAt: null
    })
    await new PageKnowledgeLifecycle(db, 'initial-unavailable-worker').runOnce()
    const healthy = await db('pageKnowledgeProjections').where({ pageId: 1 }).first('projection', 'sourceSha256', 'enrichmentState')
    expect(healthy.enrichmentState).toBe('unavailable')
    const projection = JSON.parse(String(healthy.projection))
    projection.source.sha256 = '0'.repeat(64)
    await db('pageKnowledgeProjections')
      .where({ pageId: 1 })
      .update({
        sourceSha256: projection.source.sha256,
        projection: JSON.stringify(projection)
      })
    const immutableEffect = await db('pageMutationOutbox').where({ pageId: 1, effectKind: 'knowledge' }).first('id', 'payload', 'payloadSha256')
    await db('pageKnowledgeMaintenance')
      .where({ id: 1 })
      .update({
        status: 'running',
        epochId: 1,
        highWaterPageId: 1,
        cursorPageId: 0,
        leaseOwner: 'maintenance-worker',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    const retryDb = knexModule({
      client: 'pg',
      connection: connection ?? undefined,
      searchPath: [schema],
      pool: { min: 0, max: 1 }
    })
    const ready = Promise.withResolvers<number>()
    const repair = Promise.withResolvers<void>()
    const maintenance = db.transaction(async transaction => {
      await transaction.raw("SET LOCAL lock_timeout = '3s'")
      await lockSearchIndex(transaction, false)
      await lockSearchPage(transaction, 1)
      await transaction('pages').where({ id: 1 }).forUpdate().first('id')
      const backend = await transaction.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')
      if (!backend.rows[0]) throw new Error('maintenance backend missing')
      ready.resolve(backend.rows[0].pid)
      await repair.promise
      return new PageKnowledgeLifecycle(transaction, 'maintenance-worker').runOnce()
    })
    void maintenance.catch(ready.reject)
    const enrichKnowledge = vi.fn(async () => ({
      value: { type: null, summary: null, tags: ['requeued'], entities: [], relationships: [], openQuestions: [], searchTerms: ['lockrepairtoken'] },
      model: 'utility-small',
      inputSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64),
      inputTokens: 1,
      outputTokens: 1
    }))
    let retry: Promise<{ backfilled: number; requeued: number; processed: number }> | undefined
    try {
      const maintenancePid = await ready.promise
      await retryDb.raw("SET statement_timeout = '5s'")
      const backend = await retryDb.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')
      if (!backend.rows[0]) throw new Error('utility retry backend missing')
      const retryPid = backend.rows[0].pid
      retry = new PageKnowledgeLifecycle(retryDb, 'retry-worker', { enrichKnowledge }).runOnce()
      const settledRetry = Promise.allSettled([retry])
      const deadline = process.hrtime.bigint() + 2_000_000_000n
      while (true) {
        const observation = await db.raw<{ rows: Array<{ blocked: boolean }> }>('SELECT ?::integer = ANY(pg_blocking_pids(?::integer)) AS blocked', [
          maintenancePid,
          retryPid
        ])
        if (observation.rows[0]?.blocked) break
        if (process.hrtime.bigint() >= deadline) throw new Error('utility requeue did not overlap the held canonical page')
        await db.raw('SELECT pg_sleep(0.01)')
      }
      repair.resolve()
      expect(await maintenance).toMatchObject({ backfilled: 1, processed: 1 })
      const [outcome] = await settledRetry
      if (!outcome) throw new Error('utility retry outcome missing')
      if (outcome.status === 'rejected') throw outcome.reason
      expect(outcome.value).toMatchObject({ requeued: 1, processed: 1 })
      expect(enrichKnowledge).toHaveBeenCalledOnce()
      expect(await db('pageMutationOutbox').where({ pageId: 1, effectKind: 'knowledge' }).first('id', 'payload', 'payloadSha256')).toEqual(immutableEffect)
      expect(await db('pageMutationOutbox').where({ pageId: 1, effectKind: 'knowledge' }).first('status')).toEqual({ status: 'succeeded' })
      expect(await db('pageKnowledgeProjections').where({ pageId: 1 }).first('sourceSha256', 'enrichmentState')).toEqual({
        sourceSha256: healthy.sourceSha256,
        enrichmentState: 'succeeded'
      })
      expect(await new PageKnowledgeRepository(db).getCurrent(1)).toMatchObject({ sourceRevision: '1' })
      expect(await db('pages').where({ id: 1 }).first('content', 'sourceRevision')).toEqual({
        content: '# Knowledge 1\n',
        sourceRevision: '1'
      })
    } finally {
      repair.resolve()
      await Promise.allSettled([maintenance, ...(retry ? [retry] : [])])
      await retryDb.destroy()
    }
  }, 15_000)
})
