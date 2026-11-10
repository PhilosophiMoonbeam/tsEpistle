import { EventEmitter } from 'node:events'
import knexModule, { type Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as reviewSchema } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as accuracySchema } from '../../db/migrations/tsepistle-000070-page-accuracy-attestations.ts'
import { up as durableSchema } from '../../db/migrations/2.5.130.ts'
import { up as leaseSchema } from '../../db/migrations/2.5.158.ts'
import { up as createEditLocks } from '../../db/migrations/tsepistle-000080-page-edit-locks.ts'
import { DurableJobStore, runDurableJobBatch, type DurableJob } from '../../core/durable-jobs.ts'
import { NOTIFICATION_SETTINGS_KEY, readNotificationCeilings } from '../../jobs/notification-ceilings.ts'
import type * as Routing from '../../operations/page-review-routing.ts'
import type * as Reminders from '../../jobs/page-review-reminders.ts'

const connection = getPostgresTestConnection('_review_reminders_test', import.meta.path)
const suite = connection ? describe : describe.skip
const requester = { id: 7, authVersion: 0, permissions: ['read:pages', 'write:pages'] } as Express.User
suite('native PostgreSQL review routing and durable effect fences', () => {
  let db: Knex
  let routing: typeof Routing
  let reminders: typeof Reminders
  let mailCalls = 0
  let ambiguousMail = false
  let preHandoffFailure = false
  const context = () => ({ knex: db, requester, sessionId: 'review-browser-session', delegated: false, pageId: 42 })
  const adapter: Reminders.PageReviewNotificationAdapter = {
    async deliverInApp(transaction, effect) {
      await transaction('testReviewInbox').insert({ cycleId: effect.cycleId, userId: effect.userId }).onConflict(['cycleId', 'userId']).ignore()
      return true
    },
    async sendEmail() { if (preHandoffFailure) return 'retry-before-handoff'; mailCalls++; if (ambiguousMail) throw new Error('Connection lost after external handoff'); return 'sent' }
  }
  const claim = async () => {
    const jobs = await new DurableJobStore(db).claim({ workerId: 'native-review-worker', supportedIdentities: ['page-review-reminder@1'], limit: 10 })
    const job = jobs.find(value => value.payload.cycleId !== undefined)
    if (!job) throw new Error('Expected actual review delivery work')
    return job
  }
  const invoke = (job: DurableJob) => reminders.createPageReviewReminderHandler(adapter)(job, { knex: db, signal: new AbortController().signal })
  const enable = () => routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', expectedSourceRevision: '8', expectedRoutingRevision: '0', enabled: true } })
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection!, pool: { min: 0, max: 5 }, acquireConnectionTimeout: 4000 })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text, email text, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text, permissions jsonb, "pageRules" jsonb);
      CREATE TABLE "userGroups" ("userId" integer REFERENCES users(id) ON DELETE CASCADE, "groupId" integer REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY("userId","groupId"));
      CREATE TABLE pages (id integer PRIMARY KEY, "sourceRevision" bigint NOT NULL, "creatorId" integer, "authorId" integer, "ownerId" integer, visibility text, path text, "localeCode" text, title text, content text, "updatedAt" timestamptz, "isPublished" boolean DEFAULT true, "publishStartDate" text DEFAULT '', "publishEndDate" text DEFAULT '');
      CREATE TABLE tags (id integer PRIMARY KEY, tag text, "redirectToId" integer, "isArchived" boolean DEFAULT false);
      CREATE TABLE "pageTags" ("pageId" integer, "tagId" integer);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, "passwordHash" text, version integer);
      CREATE TABLE "pageUnlockGrants" (id text PRIMARY KEY, "pageId" integer, "sessionId" text, "userId" integer, "passwordVersion" integer, "expiresAt" timestamptz);
      CREATE TABLE "userNotificationPreferences" ("userId" integer REFERENCES users(id) ON DELETE CASCADE, category text, "emailEnabled" boolean DEFAULT false, "inAppEnabled" boolean DEFAULT false, "updatedAt" timestamptz DEFAULT clock_timestamp(), PRIMARY KEY("userId",category));
      CREATE TABLE "testReviewInbox" ("cycleId" uuid, "userId" integer, PRIMARY KEY("cycleId","userId"));
      CREATE TABLE settings (key text PRIMARY KEY, value text, "updatedAt" timestamptz);
    `)
    await durableSchema(db); await leaseSchema(db); await accuracySchema(db); await reviewSchema(db)
    await createEditLocks(db)
    vi.stubGlobal('WIKI', {
      config: { db: { type: 'postgres' }, lang: { code: 'en', namespacing: false } },
      configSvc: {}, lang: {}, startedAt: {},
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      models: { knex: db }, logger: console
    })
    // These modules capture native WIKI dependencies; fixture binding is part of this module-loading boundary.
    const auth = (await import('../../core/auth.ts')).default
    Reflect.get(globalThis, 'WIKI').auth = auth
    routing = await import('../../operations/page-review-routing.ts')
    reminders = await import('../../jobs/page-review-reminders.ts')
  })
  beforeEach(async () => {
    await db('pageEditLockAudit').delete()
    await db('pageEditLocks').delete()
    mailCalls = 0; ambiguousMail = false; preHandoffFailure = false
    await db.raw('TRUNCATE pages,users,groups,tags,settings,"durableJobs","testReviewInbox" CASCADE')
    await db('users').insert([{ id: 7, name: 'Writer', email: 'writer@example.test' }, { id: 8, name: 'Other writer', email: 'other@example.test' }, { id: 9, name: 'Reader', email: 'reader@example.test' }])
    await db('groups').insert([{ id: 3, name: 'Writers', permissions: JSON.stringify(['read:pages', 'write:pages']), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages'], locales: [] }]) }, { id: 4, name: 'Readers', permissions: JSON.stringify(['read:pages']), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages'], locales: [] }]) }])
    await db('userGroups').insert([{ userId: 7, groupId: 3 }, { userId: 8, groupId: 3 }, { userId: 9, groupId: 4 }])
    await db('pages').insert({ id: 42, sourceRevision: '8', creatorId: 7, authorId: 7, ownerId: null, visibility: 'public', path: 'reviewable', localeCode: 'en', title: 'Reviewable', content: 'Untouched canonical source', updatedAt: new Date('2000-01-01T00:00:00Z') })
    await db('userNotificationPreferences').insert([7, 8, 9].map(userId => ({ userId, category: 'reviewReminder', emailEnabled: false, inAppEnabled: true })))
  })
  afterAll(async () => { try { await db?.destroy() } finally { vi.unstubAllGlobals() } })

  it('continues current authorized routing and durable reminder delivery while the source is edit-locked', async () => {
    await db('pageEditLocks').insert({ pageId: 42, isEditLocked: true, lockVersion: '1', updatedBy: 7, reason: 'Review routing is operational, not an authored rewrite' })
    const before = await db('pages').first()
    const route = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [8] } } })
    await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', expectedSourceRevision: '8', expectedRoutingRevision: route.routingRevision, enabled: true } })
    const job = await claim()
    await invoke(job)
    expect(await db('testReviewInbox')).toEqual([{ cycleId: job.payload.cycleId, userId: 8 }])
    expect(await db('pages').first()).toEqual(before)
    expect(await db('pageEditLocks').first()).toMatchObject({ isEditLocked: true, lockVersion: '1' })
  })

  it('defaults off, previews without mutation, refuses readers/delegates, and reset preserves source/schedule/accuracy', async () => {
    expect(await routing.readPageReviewRouting(context())).toMatchObject({ enabled: false, mode: 'contacts', routingRevision: '0', diagnostic: 'disabled' })
    await routing.previewPageReviewRouting({ ...context(), preview: { expectedSourceRevision: '8', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [8] } } })
    expect(await db('pageReviewRouting')).toHaveLength(0)
    await expect(Promise.resolve(routing.readPageReviewRouting({ ...context(), requester: { id: 9, authVersion: 0 } as Express.User }))).rejects.toMatchObject({ status: 403 })
    await expect(Promise.resolve(routing.readPageReviewRouting({ ...context(), delegated: true }))).rejects.toMatchObject({ status: 401 })
    const before = await db('pages').first()
    const saved = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [8] } } })
    const reset = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'reset', mode: 'contacts', expectedSourceRevision: '8', expectedRoutingRevision: saved.routingRevision } })
    expect(reset).toMatchObject({ mode: 'contacts', enabled: false, scheduleGeneration: saved.scheduleGeneration })
    expect(await db('pageReviewRoutingUsers')).toHaveLength(0)
    expect(await db('pages').first()).toEqual(before)
    expect(await db('pageAccuracyAttestations')).toHaveLength(0)
  })
  it('serializes concurrent producers and survives crash-before-complete without duplicate inbox effects', async () => {
    await enable()
    await Promise.all([db.transaction(transaction => reminders.producePageReviewReminder({ transaction, pageId: 42 })), db.transaction(transaction => reminders.producePageReviewReminder({ transaction, pageId: 42 }))])
    expect(await db('pageReviewCycles')).toHaveLength(1)
    const job = await claim()
    await invoke(job)
    await reminders.createPageReviewReminderHandler(adapter)(job, { knex: db, signal: new AbortController().signal })
    expect(await db('testReviewInbox')).toHaveLength(1)
    expect(await db('pageReviewChannelReceipts').first()).toMatchObject({ status: 'delivered', userId: 7 })
  })
  it('suppresses current membership/account/consent loss behind native authority locks', async () => {
    await enable()
    const job = await claim()
    const revocation = await db.transaction()
    await revocation('groups').where('id', 3).forUpdate().first()
    await revocation('userGroups').where({ userId: 7, groupId: 3 }).delete()
    const pending = invoke(job)
    await revocation.commit()
    await pending
    expect(await db('testReviewInbox')).toHaveLength(0)
    expect(await db('pageReviewChannelReceipts').first()).toMatchObject({ status: 'suppressed' })
  })
  it('rejects expired and replaced leases, stale routing/source and a superseding same-source human epoch', async () => {
    await enable()
    const job = await claim()
    await db('durableJobs').where('id', job.id).update({ leaseExpiresAt: db.raw("clock_timestamp() - interval '1 millisecond'") })
    await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(0)
    await db('durableJobs').where('id', job.id).update({ leaseExpiresAt: db.raw("clock_timestamp() + interval '30 seconds'"), leaseToken: randomUUID() })
    await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(0)
    await db('durableJobs').where('id', job.id).update({ leaseToken: job.leaseToken })
    await db('pageAccuracyAttestations').insert({ id: randomUUID(), pageId: 42, sourceRevision: '8', verifiedBy: 7, verifiedAt: db.raw('clock_timestamp()') })
    await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(0)
    await db('pageAccuracyAttestations').delete()
    await db('pages').where('id', 42).update({ sourceRevision: '9' })
    await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(0)
    await db('pages').where('id', 42).update({ sourceRevision: '8' })
    await db('pageReviewRouting').where('pageId', 42).increment('revision', 1)
    await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(0)
  })
  it('lets an authoritative attestation race invalidate an already claimed epoch before delivery', async () => {
    await enable(); const job = await claim()
    const attesting = await db.transaction()
    await attesting('pages').where('id', 42).forUpdate().first()
    await attesting('pageAccuracyAttestations').insert({ id: randomUUID(), pageId: 42, sourceRevision: '8', verifiedBy: 7, verifiedAt: attesting.raw('clock_timestamp()') })
    const pending = invoke(job)
    await attesting.commit(); await pending
    expect(await db('testReviewInbox')).toHaveLength(0)
    expect((await routing.readPageReviewRouting(context())).currentCycleId).toBeNull()
  })
  it('recovers orphan handoffs per tick without timing out a live matching lease or replaying SMTP', async () => {
    await db('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ emailEnabled: true })
    await enable(); const job = await claim()
    const receipt = await db('pageReviewChannelReceipts').where('channel', 'email').first()
    const messageId = `<orphan-${receipt.id}@wiki.local>`
    const old = new Date(Date.now() - 60_000)
    await db('pageReviewChannelReceipts').where('id', receipt.id).update({ status: 'sending', messageId, handoffJobId: job.id, handoffLeaseOwner: job.leaseOwner, handoffLeaseToken: job.leaseToken, updatedAt: old })
    await db('pageReviewEmailAttempts').insert({ receiptId: receipt.id, attempt: 0, messageId, status: 'sending', createdAt: old, updatedAt: old })
    await reminders.recoverPageReviewHandoffs(db)
    expect(await db('pageReviewChannelReceipts').where('id', receipt.id).first()).toMatchObject({ status: 'sending' })
    const enabled = await routing.readPageReviewRouting(context())
    const disabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: false, expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision } })
    expect(await db('pageReviewChannelReceipts').where('id', receipt.id).first()).toMatchObject({ status: 'sending', messageId })
    const reenabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: disabled.routingRevision } })
    await db('durableJobs').where('id', job.id).update({ leaseExpiresAt: db.raw(`clock_timestamp() - interval '1 millisecond'`) })
    await reminders.recoverPageReviewHandoffs(db)
    expect(await db('pageReviewChannelReceipts').where('id', receipt.id).first()).toMatchObject({ status: 'unknown' })
    expect(await db('pageReviewEmailAttempts').where('receiptId', receipt.id).first()).toMatchObject({ status: 'unknown' })
    await invoke(job)
    expect(mailCalls).toBe(0)
    await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'resend', expectedSourceRevision: '8', expectedRoutingRevision: reenabled.routingRevision, cycleId: job.payload.cycleId, userId: 7, acknowledgePossibleDuplicate: true } })
    // The expired original job is reclaimable too; dispatch every claimed job
    // instead of leasing the resend and silently discarding it in claim().
    await runDurableJobBatch(db, { workerId: 'native-review-resend-worker', limit: 10, handlers: { 'page-review-reminder@1': reminders.createPageReviewReminderHandler(adapter) } })
    expect(mailCalls).toBe(1)
    expect(await db('pageReviewChannelReceipts').where('id', receipt.id).first()).toMatchObject({ status: 'sent', attempt: 1 })
    expect(await db('pageReviewChannelReceipts').where({ cycleId: job.payload.cycleId, channel: 'in-app' }).first()).toMatchObject({ status: 'suppressed' })
    expect((await db('pageReviewEmailAttempts').where('receiptId', receipt.id).orderBy('attempt')).map(attempt => attempt.status)).toEqual(['unknown', 'sent'])
  })
  it('commits the sending marker before handoff and refuses replay after the handoff transaction aborts', async () => {
    await db('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ emailEnabled: true })
    await enable(); const job = await claim()
    const failingHandoff: Reminders.PageReviewNotificationAdapter = {
      deliverInApp: adapter.deliverInApp,
      async sendEmail(transaction, effect) {
        // This independent connection can see only committed preparation, not
        // the handoff transaction's writes.
        const marker = await db('pageReviewChannelReceipts').where({ cycleId: effect.cycleId, userId: effect.userId, channel: 'email' }).first()
        expect(marker).toMatchObject({ status: 'sending', messageId: effect.messageId })
        expect(await db('pageReviewEmailAttempts').where({ receiptId: marker.id, attempt: marker.attempt }).first()).toMatchObject({ status: 'sending' })
        mailCalls++
        await transaction.raw('SELECT 1 / 0')
        return 'sent'
      }
    }
    await reminders.createPageReviewReminderHandler(failingHandoff)(job, { knex: db, signal: new AbortController().signal })
    await invoke(job)
    expect(mailCalls).toBe(1)
    expect(await db('pageReviewChannelReceipts').where('channel', 'email').first()).toMatchObject({ status: 'unknown' })
  })
  it('retries only a known pre-handoff failure with the stable attempt message identity', async () => {
    await db('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ emailEnabled: true })
    await enable(); const job = await claim(); preHandoffFailure = true
    await expect(invoke(job)).rejects.toThrow()
    const pending = await db('pageReviewChannelReceipts').where('channel', 'email').first()
    expect(pending.status).toBe('pending')
    expect(mailCalls).toBe(0)
    preHandoffFailure = false; await invoke(job)
    expect(await db('pageReviewChannelReceipts').where('channel', 'email').first()).toMatchObject({ status: 'sent', messageId: pending.messageId })
    expect(mailCalls).toBe(1)
  })
  it('never replays ambiguous SMTP and erases recipient receipts on account deletion', async () => {
    await db('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ emailEnabled: true })
    await enable(); const job = await claim(); ambiguousMail = true
    await invoke(job); await invoke(job)
    expect(mailCalls).toBe(1)
    expect(await db('pageReviewChannelReceipts').where('channel', 'email').first()).toMatchObject({ status: 'unknown' })
    const current = await routing.readPageReviewRouting(context())
    await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'resend', expectedSourceRevision: '8', expectedRoutingRevision: current.routingRevision, cycleId: current.currentCycleId, userId: 7, acknowledgePossibleDuplicate: true } })
    ambiguousMail = false
    await invoke(await claim())
    const attempts = await db('pageReviewEmailAttempts').orderBy('attempt')
    expect(attempts.map(attempt => attempt.status)).toEqual(['unknown', 'sent'])
    expect(attempts).toHaveLength(2)
    expect(attempts[0].messageId).not.toBe(attempts[1].messageId)
    expect(mailCalls).toBe(2)
    const proofId = randomUUID()
    await db('pageAccuracyAttestations').insert({ id: proofId, pageId: 42, sourceRevision: '8', verifiedBy: 7, verifiedAt: db.raw('clock_timestamp()') })
    await db('users').where('id', 7).delete()
    expect(await db('pageReviewChannelReceipts')).toHaveLength(0)
    expect(await db('pageReviewEmailAttempts')).toHaveLength(0)
    expect(await db('pageAccuracyAttestations').where('id', proofId).first()).toMatchObject({ id: proofId, verifiedBy: null, sourceRevision: '8' })
  })
  for (const [loss, outcome] of [
    ['consent', 'unknown'], ['authority', 'unknown'], ['route', 'unknown'], ['account', 'unknown'],
    ['stop-all-email cutoff', 'unknown'], ['administrator ceiling', 'unknown'], ['administrator cutoff', 'unknown'],
    ['consent', 'failed']
  ] as const) {
    it(`refuses ${outcome} email resend after ${loss} loss without changing delivery facts or queuing work`, async () => {
      await db('userNotificationPreferences').where({ userId: 8, category: 'reviewReminder' }).update({ emailEnabled: true })
      const selected = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [8] } } })
      const enabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: selected.routingRevision } })
      if (outcome === 'failed') await db('durableJobs').where('type', 'page-review-reminder').update({ attempts: db.raw('?? - 1', ['maxAttempts']) })
      const job = await claim()
      ambiguousMail = outcome === 'unknown'
      preHandoffFailure = outcome === 'failed'
      await invoke(job)
      const receipts = await db('pageReviewChannelReceipts').where('cycleId', job.payload.cycleId).orderBy('channel')
      const attempts = await db('pageReviewEmailAttempts').orderBy('receiptId').orderBy('attempt')
      expect(receipts).toHaveLength(2)
      expect(receipts[0]).toMatchObject({ channel: 'email', status: outcome, attempt: 0, userId: 8 })
      expect(receipts[1]).toMatchObject({ channel: 'in-app', status: 'delivered', userId: 8 })
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ status: outcome, attempt: 0 })
      const cycle = await db('pageReviewCycles').where('id', job.payload.cycleId).first()
      let currentRevision = enabled.routingRevision
      if (loss === 'consent') await db('userNotificationPreferences').where({ userId: 8, category: 'reviewReminder' }).update({ emailEnabled: false })
      else if (loss === 'authority') await db('userGroups').where({ userId: 8, groupId: 3 }).delete()
      else if (loss === 'route') {
        const changed = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: currentRevision, route: { mode: 'users', userIds: [7] } } })
        currentRevision = changed.routingRevision
      } else if (loss === 'account') await db('users').where('id', 8).update({ isActive: false })
      else if (loss === 'stop-all-email cutoff') {
        const stoppedAt = new Date(new Date(cycle.createdAt).valueOf() + 1)
        await db('userNotificationPreferences').insert({ userId: 8, category: 'allEmailStopped', updatedAt: stoppedAt })
        // Even renewed current consent cannot replay work admitted before stop-all.
        await db('userNotificationPreferences').where({ userId: 8, category: 'reviewReminder' }).update({ updatedAt: new Date(stoppedAt.valueOf() + 1) })
      } else {
        const state = await readNotificationCeilings(db)
        if (loss === 'administrator ceiling') state.ceilings.reviewReminder = 'in-app-only'
        else state.suppressedBefore.reviewReminder = { email: new Date(cycle.createdAt).toISOString() }
        await db('settings').insert({ key: NOTIFICATION_SETTINGS_KEY, value: JSON.stringify(state), updatedAt: db.fn.now() })
      }
      const jobs = await db('durableJobs').orderBy('id')
      const audit = await db('pageReviewRoutingAudit').orderBy('id')
      await expect(Promise.resolve(routing.updatePageReviewRouting({ ...context(), mutation: { command: 'resend', expectedSourceRevision: '8', expectedRoutingRevision: currentRevision, cycleId: job.payload.cycleId, userId: 8, acknowledgePossibleDuplicate: true } }))).rejects.toMatchObject({ status: 409, name: 'PAGE_REVIEW_RESEND_UNAVAILABLE' })
      await invoke(job)
      expect(await db('pageReviewChannelReceipts').where('cycleId', job.payload.cycleId).orderBy('channel')).toEqual(receipts)
      expect(await db('pageReviewEmailAttempts').orderBy('receiptId').orderBy('attempt')).toEqual(attempts)
      expect(await db('durableJobs').orderBy('id')).toEqual(jobs)
      expect(await db('pageReviewRoutingAudit').orderBy('id')).toEqual(audit)
      expect(await db('pageReviewRouting').where('pageId', 42).first('revision')).toEqual({ revision: currentRevision })
      expect(await db('testReviewInbox')).toEqual([{ cycleId: job.payload.cycleId, userId: 8 }])
      expect(mailCalls).toBe(outcome === 'unknown' ? 1 : 0)
    })
  }
  it('bounds each minute scan and fairly advances pages whose next milestone is not due', async () => {
    await enable()
    const originalPage = await db('pages').where('id', 42).first()
    const originalRouting = await db('pageReviewRouting').where('pageId', 42).first()
    const ids = Array.from({ length: 100 }, (_, index) => 100 + index)
    await db('pages').insert(ids.map(id => ({ ...originalPage, id, path: `bounded-review-${id}` })))
    await db('pageReviewRouting').insert(ids.map(pageId => ({ ...originalRouting, pageId })))
    const now = await db.transaction(transaction => routing.reviewDatabaseNow(transaction))
    await db('pageAccuracyAttestations').insert([42, ...ids].map(pageId => ({ id: randomUUID(), pageId, sourceRevision: '8', verifiedBy: 7, verifiedAt: now })))
    await reminders.scanPageReviewReminders(db)
    const unscanned = await db('pageReviewRouting').where('lastScannedAt', new Date(0)).select('pageId')
    expect(unscanned).toEqual([{ pageId: 199 }])
    await reminders.scanPageReviewReminders(db)
    expect(await db('pageReviewRouting').where('lastScannedAt', new Date(0))).toHaveLength(0)
    const aborted = new AbortController()
    aborted.abort()
    await expect(reminders.scanPageReviewReminders(db, aborted.signal)).rejects.toThrow()
  })
  it('retains consumed cycle identity after detailed receipts expire or are removed', async () => {
    await enable(); const job = await claim(); await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(1)
    await db('pageReviewCycles').where('id', job.payload.cycleId).delete()
    await db.transaction(transaction => reminders.producePageReviewReminder({ transaction, pageId: 42 }))
    expect(await db('pageReviewCycles')).toHaveLength(0)
    expect(await db('pageReviewConsumed')).toHaveLength(1)
    expect(await db('testReviewInbox')).toHaveLength(1)
  })
  it('re-resolves current group members and delivers a cycle once across reset and re-enable', async () => {
    const selected = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: '0', route: { mode: 'groups', groupIds: [3] } } })
    const enabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: selected.routingRevision } })
    const oldJob = await claim()
    await db('users').where('id', 8).update({ isActive: false })
    await invoke(oldJob)
    expect(await db('testReviewInbox').orderBy('userId')).toEqual([{ cycleId: oldJob.payload.cycleId, userId: 7 }])
    const reset = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'reset', mode: 'contacts', expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision } })
    const disabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: false, expectedSourceRevision: '8', expectedRoutingRevision: reset.routingRevision } })
    await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: disabled.routingRevision } })
    const jobs = await new DurableJobStore(db).claim({ workerId: 'replacement-audience-worker', supportedIdentities: ['page-review-reminder@1'], limit: 10 })
    for (const job of jobs) await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(1)
    expect(await db('pageReviewCycles')).toHaveLength(1)
  })
  for (const command of ['route', 'reset'] as const) {
    it(`cancels pending ${command} audience work before routing ABA can resurrect the consumed cycle`, async () => {
      await db('userNotificationPreferences').whereIn('userId', [7, 8]).where('category', 'reviewReminder').update({ emailEnabled: true })
      const initialUser = command === 'route' ? 7 : 8
      const selected = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [initialUser] } } })
      const enabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: selected.routingRevision } })
      const oldJob = await claim()
      const receipts = await db('pageReviewChannelReceipts').where('cycleId', oldJob.payload.cycleId).orderBy('channel')
      const consumed = await db('pageReviewConsumed')
      expect(receipts.map(receipt => receipt.status)).toEqual(['pending', 'pending'])
      const expected = { expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision }
      const changed = await routing.updatePageReviewRouting({ ...context(), mutation: command === 'route' ? { ...expected, command, route: { mode: 'users', userIds: [8] } } : { ...expected, command, mode: 'contacts' } })
      expect(await db('pageReviewCycles').where('id', oldJob.payload.cycleId).first()).toMatchObject({ status: 'superseded' })
      expect(await db('pageReviewChannelReceipts').where('cycleId', oldJob.payload.cycleId).orderBy('channel').select('id', 'status')).toEqual(receipts.map(receipt => ({ id: receipt.id, status: 'suppressed' })))
      const restored = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: changed.routingRevision, route: { mode: 'users', userIds: [initialUser] } } })
      expect(restored).toMatchObject({ currentCycleId: oldJob.payload.cycleId, scheduleGeneration: enabled.scheduleGeneration, diagnostic: 'suppressed' })
      await reminders.scanPageReviewReminders(db)
      await invoke(oldJob)
      await runDurableJobBatch(db, { workerId: 'routing-aba-review-worker', limit: 10, handlers: { 'page-review-reminder@1': reminders.createPageReviewReminderHandler(adapter) } })
      expect(await db('durableJobs')).toHaveLength(1)
      expect(await db('pageReviewCycles')).toHaveLength(1)
      expect(await db('pageReviewChannelReceipts').where('cycleId', oldJob.payload.cycleId).orderBy('channel').select('id', 'status')).toEqual(receipts.map(receipt => ({ id: receipt.id, status: 'suppressed' })))
      expect(await db('pageReviewConsumed')).toEqual(consumed)
      expect(await db('pageReviewEmailAttempts')).toHaveLength(0)
      expect(await db('testReviewInbox')).toHaveLength(0)
      expect(mailCalls).toBe(0)
    })
    it(`serializes ${command} cancellation with a late known pre-handoff result without clearing sending facts`, async () => {
      await db('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ emailEnabled: true })
      const enabled = await enable()
      const job = await claim()
      const cancelBeforeHandoff: Reminders.PageReviewNotificationAdapter = {
        deliverInApp: adapter.deliverInApp,
        async sendEmail(transaction, effect) {
          const expected = { expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision }
          await routing.updatePageReviewRouting({ ...context(), knex: transaction, mutation: command === 'route' ? { ...expected, command, route: { mode: 'users', userIds: [8] } } : { ...expected, command, mode: 'contacts' } })
          const receipt = await transaction('pageReviewChannelReceipts').where({ cycleId: effect.cycleId, userId: effect.userId, channel: 'email' }).first()
          expect(receipt).toMatchObject({ status: 'sending', messageId: effect.messageId, attempt: 0, handoffJobId: job.id, handoffLeaseOwner: job.leaseOwner, handoffLeaseToken: job.leaseToken })
          expect(await transaction('pageReviewEmailAttempts').where({ receiptId: receipt.id, attempt: 0 }).first()).toMatchObject({ status: 'sending', messageId: effect.messageId })
          return 'retry-before-handoff'
        }
      }
      await reminders.createPageReviewReminderHandler(cancelBeforeHandoff)(job, { knex: db, signal: new AbortController().signal })
      expect(await db('pageReviewChannelReceipts').where('channel', 'email').first()).toMatchObject({ status: 'suppressed', attempt: 0 })
      expect(await db('pageReviewEmailAttempts').first()).toMatchObject({ status: 'suppressed', attempt: 0 })
      await reminders.scanPageReviewReminders(db)
      await invoke(job)
      expect(mailCalls).toBe(0)
      expect(await db('testReviewInbox')).toHaveLength(0)
      expect(await db('durableJobs')).toHaveLength(1)
    })
  }
  it('durably cancels pending channels before re-enable and audience replacement without blocking a later accuracy epoch', async () => {
    await db('userNotificationPreferences').whereIn('userId', [7, 8]).where('category', 'reviewReminder').update({ emailEnabled: true })
    const enabled = await enable()
    const oldJob = await claim()
    const oldReceipts = await db('pageReviewChannelReceipts').where('cycleId', oldJob.payload.cycleId).orderBy('channel')
    expect(oldReceipts.map(receipt => receipt.status)).toEqual(['pending', 'pending'])
    const consumed = await db('pageReviewConsumed')
    const disabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: false, expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision } })
    expect(await db('pageReviewChannelReceipts').where('cycleId', oldJob.payload.cycleId).orderBy('channel').select('id', 'status')).toEqual(oldReceipts.map(receipt => ({ id: receipt.id, status: 'suppressed' })))
    const reenabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: disabled.routingRevision } })
    expect(reenabled).toMatchObject({ scheduleGeneration: enabled.scheduleGeneration, currentCycleId: oldJob.payload.cycleId, diagnostic: 'suppressed' })
    await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: reenabled.routingRevision, route: { mode: 'users', userIds: [7, 8] } } })
    await reminders.scanPageReviewReminders(db)
    await invoke(oldJob)
    const replacements = await new DurableJobStore(db).claim({ workerId: 'canceled-review-worker', supportedIdentities: ['page-review-reminder@1'], limit: 10 })
    expect(replacements).toHaveLength(0)
    expect(await db('testReviewInbox')).toHaveLength(0)
    expect(mailCalls).toBe(0)
    expect(await db('pageReviewChannelReceipts').where('cycleId', oldJob.payload.cycleId)).toHaveLength(2)
    expect(await db('pageReviewConsumed')).toEqual(consumed)

    const now = await db.transaction(transaction => routing.reviewDatabaseNow(transaction))
    await db('pageAccuracyAttestations').insert({ id: randomUUID(), pageId: 42, sourceRevision: '8', verifiedBy: 7, verifiedAt: new Date(now.valueOf() - 31 * 86_400_000) })
    await db.transaction(transaction => reminders.producePageReviewReminder({ transaction, pageId: 42 }))
    const laterJob = await claim()
    expect(laterJob.payload.scheduleGeneration).toBe(enabled.scheduleGeneration)
    expect(laterJob.payload.cycleId).not.toBe(oldJob.payload.cycleId)
    await invoke(laterJob); await invoke(laterJob)
    expect(await db('testReviewInbox').orderBy('userId')).toEqual([7, 8].map(userId => ({ cycleId: laterJob.payload.cycleId, userId })))
    expect(mailCalls).toBe(2)
    expect((await db('pageReviewChannelReceipts').where('cycleId', oldJob.payload.cycleId)).every(receipt => receipt.status === 'suppressed')).toBe(true)
  })
  it('preserves canceled independent high water after retention and admits only a deliberate fresh schedule generation', async () => {
    const now = await db.transaction(transaction => routing.reviewDatabaseNow(transaction))
    const schedule = { mode: 'independent', anchorAt: new Date(now.valueOf() - 10 * 86_400_000 - 1000).toISOString(), intervalDays: 1, acknowledgeIndependentAccuracy: true }
    const scheduled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'reschedule', expectedSourceRevision: '8', expectedRoutingRevision: '0', schedule } })
    const enabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: scheduled.routingRevision } })
    const oldJob = await claim()
    const consumed = await db('pageReviewConsumed')
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toMatchObject({ highWater: '10', scheduleGeneration: enabled.scheduleGeneration })
    const disabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: false, expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision } })
    const reenabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: disabled.routingRevision } })
    await db('pageReviewCycles').where('id', oldJob.payload.cycleId).delete()
    await db.transaction(transaction => reminders.producePageReviewReminder({ transaction, pageId: 42 }))
    await invoke(oldJob)
    expect(await db('pageReviewCycles')).toHaveLength(0)
    expect(await db('pageReviewConsumed')).toEqual(consumed)
    expect(await db('testReviewInbox')).toHaveLength(0)

    const fresh = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'reschedule', expectedSourceRevision: '8', expectedRoutingRevision: reenabled.routingRevision, schedule } })
    expect(fresh).toMatchObject({ scheduleGeneration: (BigInt(enabled.scheduleGeneration) + 1n).toString(), currentMilestone: 'cycle:10' })
    const freshJob = await claim()
    await invoke(freshJob); await invoke(freshJob)
    expect(await db('testReviewInbox')).toEqual([{ cycleId: freshJob.payload.cycleId, userId: 7 }])
  })
  it('does not reopen canceled work when a known pre-handoff result is finalized afterward', async () => {
    await db('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ emailEnabled: true })
    const enabled = await enable()
    const job = await claim()
    const cancelBeforeHandoff: Reminders.PageReviewNotificationAdapter = {
      deliverInApp: adapter.deliverInApp,
      async sendEmail(transaction) {
        await routing.updatePageReviewRouting({ ...context(), knex: transaction, mutation: { command: 'enable', enabled: false, expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision } })
        return 'retry-before-handoff'
      }
    }
    await reminders.createPageReviewReminderHandler(cancelBeforeHandoff)(job, { knex: db, signal: new AbortController().signal })
    expect(await db('pageReviewChannelReceipts').where('channel', 'email').first()).toMatchObject({ status: 'suppressed', attempt: 0 })
    expect(await db('pageReviewEmailAttempts').first()).toMatchObject({ status: 'suppressed', attempt: 0 })
    const disabled = await routing.readPageReviewRouting(context())
    await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: disabled.routingRevision } })
    await invoke(job)
    expect(mailCalls).toBe(0)
    expect(await db('testReviewInbox')).toHaveLength(0)
  })
  it('fences channel opt-out before effect and catches up an independent anchor without attestation drift', async () => {
    const now = await db.transaction(transaction => routing.reviewDatabaseNow(transaction))
    const anchorAt = new Date(now.valueOf() - 10 * 86_400_000 - 1000).toISOString()
    const scheduled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'reschedule', expectedSourceRevision: '8', expectedRoutingRevision: '0', schedule: { mode: 'independent', anchorAt, intervalDays: 1, acknowledgeIndependentAccuracy: true } } })
    const enabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: scheduled.routingRevision } })
    expect(enabled).toMatchObject({ currentMilestone: 'cycle:10', currentDueAt: new Date(Date.parse(anchorAt) + 10 * 86_400_000).toISOString(), nextDueAt: new Date(Date.parse(anchorAt) + 11 * 86_400_000).toISOString() })
    const job = await claim()
    const optout = await db.transaction()
    await optout('users').where('id', 7).forUpdate().first()
    await optout('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ inAppEnabled: false })
    const pending = invoke(job)
    await optout.commit(); await pending
    expect(await db('testReviewInbox')).toHaveLength(0)
    expect(await db('pageReviewChannelReceipts').first()).toMatchObject({ status: 'suppressed' })
    await db('pageAccuracyAttestations').insert({ id: randomUUID(), pageId: 42, sourceRevision: '8', verifiedBy: 7, verifiedAt: db.raw('clock_timestamp()') })
    expect(await routing.readPageReviewRouting(context())).toMatchObject({ currentMilestone: 'cycle:10', nextDueAt: enabled.nextDueAt })
    expect(await db('pageReviewCycles').first()).toMatchObject({ coalescedThrough: '9' })
  })
  it('does not deliver protected pages, and disable/re-enable preserves suppressed cycle receipts', async () => {
    const enabled = await enable(); const job = await claim()
    await db('pageAccessPasswords').insert({ pageId: 42, passwordHash: 'not-used-for-background', version: 1 })
    await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(0)
    expect(await db.transaction(transaction => routing.resolvePageReviewRecipients({ transaction, pageId: 42, sourceRevision: '8' }))).toMatchObject({ status: 'protected' })
    await db('pageAccessPasswords').delete()
    const disabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: false, expectedSourceRevision: '8', expectedRoutingRevision: enabled.routingRevision } })
    await invoke(job)
    expect(await db('testReviewInbox')).toHaveLength(0)
    const reenabled = await routing.updatePageReviewRouting({ ...context(), mutation: { command: 'enable', enabled: true, expectedSourceRevision: '8', expectedRoutingRevision: disabled.routingRevision } })
    expect(reenabled.diagnostic).toBe('suppressed')
    const replacements = await new DurableJobStore(db).claim({ workerId: 'protected-review-replacement-worker', supportedIdentities: ['page-review-reminder@1'], limit: 10 })
    for (const replacement of replacements) await invoke(replacement)
    expect(await db('pageReviewCycles')).toHaveLength(1)
    expect(await db('testReviewInbox')).toHaveLength(0)
  })
})
