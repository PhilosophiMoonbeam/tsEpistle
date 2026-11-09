import knexModule, { type Knex } from 'knex'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as Objection from 'objection'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import pageErrors from '../../helpers/error.ts'
import { DurableJobStore, type DurableJob } from '../../core/durable-jobs.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as createJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as installRevisionTrigger } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { up as createReviewRouting } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as createLifecycle } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as createStoragePageImportOwners } from '../../db/migrations/tsepistle-000077-storage-page-import-owners.ts'
import type { PageLifecycleEffect, PageLifecycleRuleDefinition } from '../../../shared/page-lifecycle.ts'
import type * as LifecycleOperations from '../../operations/page-lifecycle.ts'
import type * as LifecycleJobs from '../../jobs/page-lifecycle.ts'
import type PageModel from '../../models/pages.ts'

import { DISCUSSION_SETTINGS_LOCK } from '../../operations/discussion-settings.ts'
const connection = getPostgresTestConnection('_page_lifecycle_test', import.meta.path)
const suite = connection ? describe : describe.skip
const owner = { id: 7, authVersion: 0, name: 'Lifecycle human', email: 'lifecycle@example.test', permissions: ['read:pages', 'write:pages'] }
const manager = { id: 8, authVersion: 0, name: 'Scoped lifecycle manager', email: 'watcher@example.test', permissions: ['read:pages', 'write:pages', 'manage:pages'] }
const knownEpoch = '11111111-1111-4111-8111-111111111111', commentsEpoch = '22222222-2222-4222-8222-222222222222'
const source = 'Original **canonical** body\r\nwith exact bytes.'
const length = Buffer.alloc(8); length.writeBigUInt64BE(8n)
const digest = createHash('sha256').update(length).update('markdown').update(source).digest('hex')

suite('native PostgreSQL lifecycle authority, receipt and lease fences', () => {
  let db: Knex, operations: typeof LifecycleOperations, jobs: typeof LifecycleJobs, Page: typeof PageModel
  let migrationSnapshot: unknown
  const signal = () => new AbortController().signal
  const page = () => ({ id: 42, path: 'docs/start', hash: 'lifecycle-original', localeCode: 'en', title: 'Lifecycle source', content: source, render: '<p>Original</p>', sourceRevision: 1, renderedSourceRevision: 1, contentType: 'markdown', editorKey: 'markdown', visibility: 'public', ownerId: null, isPublished: true, authorId: owner.id, creatorId: owner.id })
  const current = async () => new Date((await db.raw<{ rows: Array<{ now: Date }> }>('SELECT clock_timestamp() AS now')).rows[0]!.now)
  const definition = async (effects: PageLifecycleEffect[] = [{ kind: 'set-notice', text: 'Review this page; literal <b>not HTML</b>.' }], terminalPolicy: 'keep' | 'retire-after-success' = 'keep'): Promise<PageLifecycleRuleDefinition> => ({ version: 1, selector: { kind: 'ids', pageIds: [42] }, condition: { kind: 'interval', anchorAt: new Date((await current()).valueOf() - 10 * 86_400_000).toISOString(), days: 1 }, effects, terminalPolicy })
  const save = async (value?: PageLifecycleRuleDefinition, extra: Record<string, unknown> = {}) => {
    const request = { definition: value ?? await definition(), ...extra }
    const preview = await operations.previewPageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: request })
    return operations.savePageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: { ...request, previewToken: preview.previewToken, unattendedConsent: true, enabled: true } })
  }
  const scopeManager = async () => {
    await db('groups').insert({ id: 4, name: 'Scoped lifecycle managers', permissions: JSON.stringify(manager.permissions), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages'] }, { match: 'SUBTREE', path: 'docs', deny: false, roles: ['manage:pages'] }]) }).onConflict('id').merge()
    await db('userGroups').where('userId', manager.id).delete()
    await db('userGroups').insert({ userId: manager.id, groupId: 4 })
  }
  const queued = async (): Promise<DurableJob> => {
    expect(await jobs.scanPageLifecycleRules(db)).toBe(1)
    const [job] = await new DurableJobStore(db).claim({ workerId: 'lifecycle-native-worker', leaseMs: 30_000, limit: 1, supportedIdentities: ['page-lifecycle@1'] })
    expect(job).toBeDefined()
    return job!
  }
  const run = (job: DurableJob, abortSignal = signal()) => jobs.createPageLifecycleHandler()(job, { knex: db, signal: abortSignal })

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection!, acquireConnectionTimeout: 2000, pool: { min: 0, max: 8 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL, "groupId" integer NOT NULL);
      CREATE TABLE locales (code text PRIMARY KEY);
      CREATE TABLE pages (id serial PRIMARY KEY, path text NOT NULL, hash text NOT NULL, "localeCode" text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL, render text NOT NULL DEFAULT '', toc text NOT NULL DEFAULT '[]', "sourceRevision" bigint NOT NULL DEFAULT 1, "renderedSourceRevision" bigint, "localeGroupId" text, "changeReason" text, "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL DEFAULT true, "publishStartDate" text NOT NULL DEFAULT '', "publishEndDate" text NOT NULL DEFAULT '', visibility text NOT NULL, "ownerId" integer, "authorId" integer NOT NULL, "creatorId" integer NOT NULL, "contentType" text NOT NULL, "editorKey" text NOT NULL, extra jsonb NOT NULL DEFAULT '{}', "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE tags (id serial PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageHistory" (id serial PRIMARY KEY, "pageId" integer NOT NULL, "authorId" integer NOT NULL, path text NOT NULL, hash text NOT NULL, title text NOT NULL, description text NOT NULL, visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL, "publishStartDate" text NOT NULL, "publishEndDate" text NOT NULL, content text NOT NULL, "contentType" text NOT NULL, "editorKey" text NOT NULL, extra jsonb NOT NULL, "localeCode" text NOT NULL, action text NOT NULL, "versionDate" timestamptz NOT NULL, "sourceRevision" bigint NOT NULL, "changeReason" text, "createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "pageHistoryTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageMutationOutbox" (id uuid PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL, "effectKind" text NOT NULL, "effectKey" text NOT NULL, "desiredState" text NOT NULL, "payloadSha256" text NOT NULL, payload text NOT NULL, status text NOT NULL, attempts integer NOT NULL, "availableAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL, UNIQUE ("pageId", "sourceRevision", "effectKind"));
      CREATE TABLE "outboxEvents" (id uuid PRIMARY KEY, type text NOT NULL, version integer NOT NULL, "aggregateType" text NOT NULL, "aggregateId" text NOT NULL, payload text NOT NULL, "createdAt" timestamptz NOT NULL, "publishedAt" timestamptz);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, "passwordHash" text NOT NULL, version integer NOT NULL, "updatedBy" integer NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "pageUnlockGrants" (id text PRIMARY KEY, "pageId" integer NOT NULL, "sessionId" text NOT NULL, "userId" integer NOT NULL, "passwordVersion" integer NOT NULL, "expiresAt" timestamptz NOT NULL);
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, mode text NOT NULL, "syncInterval" text NOT NULL, config jsonb NOT NULL);
      CREATE TABLE "assetFolders" (id serial PRIMARY KEY, name text, slug text, "parentId" integer);
      CREATE TABLE assets (id serial PRIMARY KEY, filename text, "folderId" integer);
      CREATE TABLE "pageTree" (id serial PRIMARY KEY, "pageId" integer, title text, "localeCode" text, path text, depth integer, "isFolder" boolean, visibility text, "ownerId" integer, parent integer, ancestors text);
      CREATE TABLE "pageLinks" ("pageId" integer, "localeCode" text, path text);
      CREATE TABLE "pageWatchers" ("userId" integer NOT NULL, "pageId" integer NOT NULL, "inAppEnabled" boolean NOT NULL, "emailEnabled" boolean NOT NULL);
      CREATE TABLE "userNotificationPreferences" ("userId" integer NOT NULL, category text NOT NULL, "inAppEnabled" boolean NOT NULL DEFAULT false, "emailEnabled" boolean NOT NULL DEFAULT false, "updatedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("userId", category));
      CREATE TABLE "commentProviders" (key text PRIMARY KEY, "isEnabled" boolean NOT NULL);
    `)
    await createJobs(db); await addLeaseToken(db); await installRevisionTrigger(db)
    await db('users').insert({ id: owner.id, name: owner.name, email: owner.email })
    await db('users').insert({ id: 8, name: 'Consenting native watcher', email: 'watcher@example.test' })
    await db('groups').insert({ id: 3, name: 'Lifecycle writers', permissions: JSON.stringify(owner.permissions), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: owner.permissions }]) })
    await db('userGroups').insert({ userId: owner.id, groupId: 3 })
    await db('userGroups').insert({ userId: 8, groupId: 3 })
    await db('locales').insert({ code: 'en' })
    await db('commentProviders').insert([{ key: 'default', isEnabled: true }, { key: 'giscus', isEnabled: false }])
    await db('tags').insert([{ id: 2, tag: 'original', title: 'Original' }, { id: 9, tag: 'review', title: 'Review' }])
    await db('pages').insert({ ...page(), visibility: 'private', ownerId: owner.id })
    const beforeMigration = await db('pages').first()
    await createReviewRouting(db)
    await createLifecycle(db)
    await createStoragePageImportOwners(db)
    migrationSnapshot = { before: beforeMigration, after: await db('pages').first(), clocks: await db('pageLifecycleClocks').first(), history: await db('pageHistory') }
    const runtime = { config: { db: { type: 'postgres' }, lang: { code: 'en', namespacing: false }, sessionSecret: 'lifecycle-owned-fixture-secret' }, configSvc: {}, lang: {}, startedAt: {}, data: { reservedPaths: [], editors: [{ key: 'markdown', contentType: 'markdown' }] }, events: { inbound: new EventEmitter(), outbound: new EventEmitter() }, logger: console, Error: pageErrors, auth: { loadPageRuleAuthority, checkPageAccess: auth.checkPageAccess, checkAccess: auth.checkAccess }, models: { knex: db, Objection, pages: {} as unknown, pageHistory: {} as unknown, renderers: { getRenderingPipeline: async () => [] } } }
    vi.stubGlobal('WIKI', runtime)
    // Native models capture WIKI at module evaluation; static imports would bind
    // the preload runtime rather than this owned disposable PostgreSQL fixture.
    Page = (await import('../../models/pages.ts')).default
    const History = (await import('../../models/pageHistory.ts')).default, Tag = (await import('../../models/tags.ts')).default, User = (await import('../../models/users.ts')).default
    for (const model of [Page, History, Tag, User]) model.knex(db)
    Object.assign(runtime.models, { pages: Page, pageHistory: History, tags: Tag })
    vi.spyOn(Page, 'deletePageFromCache').mockResolvedValue(undefined)
    operations = await import('../../operations/page-lifecycle.ts'); jobs = await import('../../jobs/page-lifecycle.ts')
  })
  beforeEach(async () => {
    await db.raw('TRUNCATE "storagePageImportOwners", "pageLifecycleRules", pages, "pageTags", "pageHistory", "pageHistoryTags", "pageMutationOutbox", "outboxEvents", "durableJobs", "pageAccessPasswords", "pageUnlockGrants", "pageWatchers", "userNotificationPreferences" RESTART IDENTITY CASCADE')
    await db('users').where('id', owner.id).update({ isActive: true, isSystem: false, authVersion: 0 })
    await db('users').where('id', manager.id).update({ isActive: true, isSystem: false, authVersion: 0 })
    await db('userGroups').where('userId', manager.id).delete()
    await db('userGroups').insert({ userId: manager.id, groupId: 3 })
    await db('groups').where('id', 4).delete()
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(owner.permissions), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: owner.permissions }]) })
    await db('tags').update({ isArchived: false, redirectToId: null })
    await db('commentProviders').where('key', 'default').update({ isEnabled: true })
    await db('commentProviders').where('key', 'giscus').update({ isEnabled: false })
    await db('pages').insert(page()); await db('pageTags').insert({ pageId: 42, tagId: 2 })
    await db('pageLifecycleClocks').insert({ pageId: 42, bodyEpoch: knownEpoch, bodyAnchorAt: new Date((await current()).valueOf() - 10 * 86_400_000), bodyAnchorKind: 'known-change', bodyDigest: digest, bodyObservedSourceRevision: '1', commentEpoch: commentsEpoch, commentAnchorAt: null, commentAnchorKind: 'unknown', lastCommentEvent: null }).onConflict('pageId').ignore()
  })
  afterAll(async () => { try { if (db) await db.destroy() } finally { vi.restoreAllMocks(); vi.unstubAllGlobals() } })

  it('adds unknown provenance without changing exact source, private owner or canonical history', () => {
    const snapshot = migrationSnapshot as { before: unknown; after: unknown; clocks: Record<string, unknown>; history: unknown[] }
    expect(snapshot.after).toEqual(snapshot.before)
    expect(snapshot.clocks).toMatchObject({ bodyAnchorAt: null, bodyAnchorKind: 'unknown', commentAnchorAt: null, commentAnchorKind: 'unknown', bodyDigest: digest })
    expect(snapshot.history).toEqual([])
  })
  it('serializes duplicate workers and survives commit-before-job-completion without another notice/event', async () => {
    await save(); const job = await queued()
    await Promise.all([run(job), run(job)])
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
    expect(await db('pageLifecycleActionReceipts')).toMatchObject([{ kind: 'set-notice', state: 'applied' }])
    const before = await db('outboxEvents').select('*')
    // Neither worker completes the durable job: this is the canonical commit / completion crash gap.
    await db('durableJobs').where('id', job.id).update({ leaseExpiresAt: db.raw("clock_timestamp() - interval '1 second'") })
    const [successor] = await new DurableJobStore(db).claim({ workerId: 'successor', supportedIdentities: ['page-lifecycle@1'], limit: 1 })
    await run(successor!)
    expect(await db('outboxEvents').select('*')).toEqual(before)
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
  })
  it('refuses expired leases, stolen tokens, aborted work and old workers after reacquisition', async () => {
    await save(); const job = await queued()
    await db('durableJobs').where('id', job.id).update({ leaseExpiresAt: db.raw("clock_timestamp() - interval '1 second'") })
    await expect(run(job)).rejects.toThrow()
    expect(await db('pageLifecycleNotices')).toEqual([])
    const [successor] = await new DurableJobStore(db).claim({ workerId: 'fresh-owner', supportedIdentities: ['page-lifecycle@1'], limit: 1 })
    await expect(run(job)).rejects.toThrow()
    expect(await db('pageLifecycleActionReceipts')).toEqual([])
    const abort = new AbortController(); abort.abort()
    await expect(run(successor!, abort.signal)).rejects.toThrow()
    expect(await db('pageLifecycleNotices')).toEqual([])
    await run(successor!)
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
  })
  it('does not borrow administrator authority after original author revocation or protection changes', async () => {
    const value = await definition(), rule = await save(value), job = await queued()
    await db('users').where('id', owner.id).update({ authVersion: 1 })
    await run(job)
    expect(await db('pageLifecycleRules').first()).toMatchObject({ status: 'suspended', reason: 'author-unavailable' })
    expect(await db('pageLifecycleNotices')).toEqual([])
    expect(await db('pageLifecycleRulePages').first()).toMatchObject({ intervalHighWater: '-1', attemptedRevision: 1, attemptedIntervalHighWater: '10' })
    const freshHuman = { ...owner, authVersion: 1 }
    const request = { definition: value, ruleId: rule.ruleId, expectedRevision: rule.revision }
    const preview = await operations.previewPageLifecycle({ requester: freshHuman, sessionId: 'fresh-native-human-session', input: request })
    await operations.savePageLifecycle({ requester: freshHuman, sessionId: 'fresh-native-human-session', input: { ...request, previewToken: preview.previewToken, unattendedConsent: true, enabled: true } })
    const admitted = await queued(); await run(admitted)
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ humanOwnerId: owner.id, authVersion: 1, revision: 2 })
  })
  it('refuses unattended protected pages even when a real browser unlock grant exists', async () => {
    await save(); const job = await queued()
    await db('pageAccessPasswords').insert({ pageId: 42, passwordHash: 'canonical-hash', version: 1, updatedBy: owner.id })
    await db('pageUnlockGrants').insert({ id: 'real-human-grant', pageId: 42, sessionId: 'native-lifecycle-human', userId: owner.id, passwordVersion: 1, expiresAt: new Date((await current()).valueOf() + 60_000) })
    await run(job)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'suspended', reason: 'needs-interactive' })
    expect(await db('pageLifecycleNotices')).toEqual([])
  })
  it('rechecks current native tag authority and blocks later effects when proposed tags revoke write access', async () => {
    await save(await definition([{ kind: 'add-tags', tagIds: [9] }, { kind: 'set-notice', text: 'Must not happen' }]))
    const job = await queued()
    await db('groups').where('id', 3).update({ pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: owner.permissions }, { match: 'TAG', path: 'review', deny: true, roles: ['write:pages'] }]) })
    await run(job)
    expect(await db('pageTags').orderBy('tagId')).toEqual([{ pageId: 42, tagId: 2 }])
    expect(await db('pageLifecycleNotices')).toEqual([])
    expect(await db('pageLifecycleActionReceipts').orderBy('effectIndex')).toMatchObject([{ state: 'suspended', reason: 'forbidden-after-tags' }, { state: 'blocked' }])
  })
  it('commits canonical tags/history/projections and receipts atomically, chains only its own result revision', async () => {
    await save(await definition([{ kind: 'add-tags', tagIds: [9] }, { kind: 'set-notice', text: 'After canonical tag revision' }]))
    const job = await queued(); await run(job)
    expect(await db('pageTags').orderBy('tagId')).toEqual([{ pageId: 42, tagId: 2 }, { pageId: 42, tagId: 9 }])
    expect(await db('pageHistory').first()).toMatchObject({ content: source, sourceRevision: '1', ownerId: null })
    expect(await db('pages').first()).toMatchObject({ content: source, sourceRevision: '2', isPublished: true, ownerId: null })
    expect(await db('pageLifecycleActionReceipts').orderBy('effectIndex')).toMatchObject([{ state: 'applied', beforeSourceRevision: '1', afterSourceRevision: '2' }, { state: 'applied', beforeSourceRevision: '2', afterSourceRevision: '2' }])
    expect(await db('pageMutationOutbox')).not.toHaveLength(0)
    expect(await db('pageLifecycleClocks').first()).toMatchObject({ bodyEpoch: knownEpoch, bodyDigest: digest })
    await run(job)
    expect(await db('pageHistory')).toHaveLength(1)
  })
  it('rolls back canonical tags/history/outboxes if the receipt insert crashes before commit', async () => {
    await save(await definition([{ kind: 'add-tags', tagIds: [9] }]))
    const job = await queued()
    await db.raw(`CREATE FUNCTION lifecycle_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned receipt crash'; END $$; CREATE TRIGGER lifecycle_receipt_crash BEFORE INSERT ON "pageLifecycleActionReceipts" FOR EACH ROW EXECUTE FUNCTION lifecycle_fail_receipt()`)
    try { await expect(run(job)).rejects.toThrow('owned receipt crash') } finally { await db.raw('DROP TRIGGER lifecycle_receipt_crash ON "pageLifecycleActionReceipts"; DROP FUNCTION lifecycle_fail_receipt()') }
    expect(await db('pageTags')).toEqual([{ pageId: 42, tagId: 2 }]); expect(await db('pageHistory')).toEqual([]); expect(await db('pageMutationOutbox')).toEqual([]); expect(await db('outboxEvents')).toEqual([])
    await run(job)
    expect(await db('pageHistory')).toHaveLength(1); expect(await db('pageLifecycleActionReceipts')).toHaveLength(1)
  })
  it('freezes remaining actions after an external revision changes partially committed work', async () => {
    await save(await definition([{ kind: 'add-tags', tagIds: [9] }, { kind: 'set-notice', text: 'Never rebase partial work' }]))
    const job = await queued()
    await db.raw(`CREATE FUNCTION lifecycle_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned second effect crash'; END $$; CREATE TRIGGER lifecycle_notice_crash BEFORE INSERT ON "pageLifecycleNotices" FOR EACH ROW EXECUTE FUNCTION lifecycle_fail_notice()`)
    try { await expect(run(job)).rejects.toThrow('owned second effect crash') } finally { await db.raw('DROP TRIGGER lifecycle_notice_crash ON "pageLifecycleNotices"; DROP FUNCTION lifecycle_fail_notice()') }
    expect(await db('pageLifecycleActionReceipts')).toMatchObject([{ kind: 'add-tags', state: 'applied', afterSourceRevision: '2' }])
    await db('pages').where('id', 42).update({ title: 'Independent human edit' })
    await run(job)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'partial', reason: 'partial-stale' })
    expect(await db('pageLifecycleActionReceipts').orderBy('effectIndex')).toMatchObject([{ state: 'applied', afterSourceRevision: '2' }, { state: 'failed', reason: 'partial-stale' }])
    expect(await db('pageLifecycleNotices')).toEqual([])
    expect(await db('pages').first()).toMatchObject({ title: 'Independent human edit', sourceRevision: '3' })
    expect(await db('pageHistory')).toHaveLength(1)
  })
  it('retries an exhausted infrastructure job explicitly without replaying its committed tag action', async () => {
    await save(await definition([{ kind: 'add-tags', tagIds: [9] }, { kind: 'set-notice', text: 'Resume only the missing effect' }]))
    const job = await queued()
    await db.raw(`CREATE FUNCTION lifecycle_fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned retry fixture'; END $$; CREATE TRIGGER lifecycle_notice_crash BEFORE INSERT ON "pageLifecycleNotices" FOR EACH ROW EXECUTE FUNCTION lifecycle_fail_notice()`)
    try { await expect(run(job)).rejects.toThrow('owned retry fixture') } finally { await db.raw('DROP TRIGGER lifecycle_notice_crash ON "pageLifecycleNotices"; DROP FUNCTION lifecycle_fail_notice()') }
    await db('durableJobs').where('id', job.id).update({ state: 'failed', attempts: 5, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, completedAt: await current() })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    const cycle = await db('pageLifecycleCycles').first()
    expect(cycle).toMatchObject({ status: 'partial', reason: 'infrastructure-retries-exhausted' })
    await operations.resumePageLifecycleCycle({ requester: owner, sessionId: 'native-lifecycle-human', cycleId: cycle.id })
    const [resumed] = await new DurableJobStore(db).claim({ workerId: 'explicit-resume', supportedIdentities: ['page-lifecycle@1'], limit: 1 })
    await run(resumed!)
    expect(await db('pageHistory')).toHaveLength(1)
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'applied' })
  })
  it('refreshes a metadata-only stale snapshot only before any effect commits', async () => {
    await save(); const job = await queued()
    await db('pages').where('id', 42).update({ title: 'A newer human title' })
    await run(job)
    expect(await db('pageLifecycleActionReceipts').first()).toMatchObject({ state: 'applied', beforeSourceRevision: '2', afterSourceRevision: '2' })
    expect(await db('pages').first()).toMatchObject({ title: 'A newer human title', sourceRevision: '2' })
  })
  it('serializes cancellation behind a winning native effect commit and blocks the next effect', async () => {
    const rule = await save(await definition([{ kind: 'set-notice', text: 'Committed before cancellation' }, { kind: 'notify', audience: 'watchers' }]))
    const job = await queued(), gate = 0x504c544e
    await db.raw(`CREATE FUNCTION lifecycle_gate_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$; CREATE TRIGGER lifecycle_notice_gate BEFORE INSERT ON "pageLifecycleNotices" FOR EACH ROW EXECUTE FUNCTION lifecycle_gate_notice()`)
    const ready = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
    const control = db.transaction(async transaction => { await transaction.raw('SELECT pg_advisory_xact_lock(?)', [gate]); ready.resolve(); await released.promise })
    let worker: Promise<void> | undefined, cancellation: Promise<unknown> | undefined
    const waiting = async (predicate: string, bindings: Array<number | string>) => {
      // Observe the native lock wait itself; no guessed wall-clock delay.
      for (let attempt = 0; attempt < 200; attempt++) {
        const observed = await db.raw<{ rows: Array<{ waiting: boolean }> }>(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND ${predicate}) AS waiting`, bindings)
        if (observed.rows[0]!.waiting) return
      }
      throw new Error('The expected native transaction did not reach its advisory wait')
    }
    try {
      await ready.promise
      worker = run(job)
      await waiting('classid = 0 AND objid = ?::oid', [gate])
      cancellation = operations.setPageLifecycleRuleStatus({ requester: owner, sessionId: 'native-lifecycle-human', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'cancel' })
      await waiting('classid = ?::oid AND objid = (hashtext(?)::bigint & 4294967295)::oid', [0x504c5255, rule.ruleId])
      released.resolve(); await control; await Promise.all([worker, cancellation])
      expect(await db('pageLifecycleNotices')).toHaveLength(1)
      expect(await db('pageLifecycleActionReceipts').orderBy('effectIndex')).toMatchObject([{ kind: 'set-notice', state: 'applied' }, { kind: 'notify', state: 'cancelled' }])
      expect(await db('outboxEvents').where('type', 'page.lifecycle-result')).toEqual([])
      expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'partial', reason: 'cancelled' })
    } finally {
      released.resolve(); await control
      await Promise.allSettled([...(worker ? [worker] : []), ...(cancellation ? [cancellation] : [])])
      await db.raw('DROP TRIGGER lifecycle_notice_gate ON "pageLifecycleNotices"; DROP FUNCTION lifecycle_gate_notice()')
    }
  }, 15_000)
  it('cancellation wins before commit, hides rule-owned notices and never undoes completed source effects', async () => {
    const rule = await save(); const job = await queued()
    await operations.setPageLifecycleRuleStatus({ requester: owner, sessionId: 'native-lifecycle-human', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'cancel' })
    await run(job)
    expect(await db('pageLifecycleNotices')).toEqual([])
    expect(await db('durableJobs').where('id', job.id).first()).toMatchObject({ state: 'cancelled' })
    expect(await db('pages').first()).toMatchObject({ sourceRevision: '1', content: source })
  })
  it('keeps committed native effects factual after cancellation while hiding its owned notice at read time', async () => {
    const rule = await save(await definition([{ kind: 'add-tags', tagIds: [9] }, { kind: 'set-notice', text: 'Hidden after cancellation' }]))
    const job = await queued(); await run(job)
    await operations.setPageLifecycleRuleStatus({ requester: owner, sessionId: 'native-lifecycle-human', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'cancel' })
    expect(await db('pageTags').orderBy('tagId')).toEqual([{ pageId: 42, tagId: 2 }, { pageId: 42, tagId: 9 }])
    expect(await db('pageHistory')).toHaveLength(1)
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
    expect(await db('pageLifecycleActionReceipts').orderBy('effectIndex')).toMatchObject([{ state: 'applied' }, { state: 'applied' }])
    await db.transaction(async transaction => {
      const authority = await loadPageRuleAuthority(owner, transaction), currentPage = await operations.lockLifecycleNativePage(transaction, 42)
      expect(await operations.readPageLifecycleNotices({ transaction, page: currentPage!, requester: owner, authority })).toEqual([])
    })
  })
  it('refuses stale target previews and selectors wider than 1000 admitted pages without a partial save', async () => {
    const value = await definition(), request = { definition: value }
    const preview = await operations.previewPageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: request })
    await db('pages').where('id', 42).update({ title: 'Changed after preview' })
    await expect(operations.savePageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: { ...request, previewToken: preview.previewToken, unattendedConsent: true, enabled: true } })).rejects.toMatchObject({ name: 'LIFECYCLE_PREVIEW_STALE', status: 409 })
    for (let offset = 0; offset < 1000; offset += 100) await db('pages').insert(Array.from({ length: 100 }, (_, index) => ({ ...page(), id: 1000 + offset + index, path: `docs/bounded-${offset + index}`, hash: `bounded-${offset + index}` })))
    await expect(operations.previewPageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: { definition: { ...value, selector: { kind: 'subtree', localeCode: 'en', normalizedRootPath: 'docs' } } } })).rejects.toMatchObject({ name: 'LIFECYCLE_TOO_BROAD', status: 409 })
    expect(await db('pageLifecycleRules')).toEqual([])
    expect(await db('pageLifecycleNotices')).toEqual([])
  })
  it('never discloses or acts on an explicit private target after its owner changes', async () => {
    await db('pages').where('id', 42).update({ visibility: 'private', ownerId: owner.id })
    const rule = await save(), job = await queued()
    await db('pages').where('id', 42).update({ ownerId: 8 })
    await run(job)
    expect(await db('pageLifecycleNotices')).toEqual([])
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'skipped', reason: 'no-longer-selected' })
    const view = await operations.inspectPageLifecycleRule({ requester: owner, sessionId: 'native-lifecycle-human', ruleId: rule.ruleId })
    expect(view.pages).toEqual([]); expect(view.cycles).toEqual([])
  })
  it('does not enumerate, disclose, re-own or cancel another author’s unrelated, mixed-scope or private rules', async () => {
    await db('pages').insert([{ ...page(), id: 43, path: 'unrelated/source', hash: 'unrelated-source' }, { ...page(), id: 44, path: 'private-source', hash: 'private-source', visibility: 'private', ownerId: owner.id }])
    const value = await definition(), allowed = await save(value)
    await jobs.scanPageLifecycleRules(db)
    const unrelated = await save({ ...value, selector: { kind: 'ids', pageIds: [43] } })
    const privateRule = await save({ ...value, selector: { kind: 'ids', pageIds: [44] } })
    const mixed = await save({ ...value, selector: { kind: 'ids', pageIds: [42, 43] } })
    const empty = await save({ ...value, selector: { kind: 'subtree', localeCode: 'en', normalizedRootPath: 'empty' } })
    const missing = await save({ ...value, selector: { kind: 'ids', pageIds: [42, 999] } })
    await jobs.scanPageLifecycleRules(db)
    const before = { rules: await db('pageLifecycleRules').orderBy('id'), cycles: await db('pageLifecycleCycles').orderBy('id'), jobs: await db('durableJobs').orderBy('id'), receipts: await db('pageLifecycleActionReceipts').orderBy('cycleId') }
    expect(before.jobs.length).toBeGreaterThan(0)
    await scopeManager()
    const listed = await operations.listPageLifecycleRules({ requester: manager, sessionId: 'current-scoped-manager' })
    expect(listed.rules.map(rule => rule.id)).toEqual([allowed.ruleId])
    expect(listed).toMatchObject({ hasMore: false, nextCursor: null })
    for (const rule of [unrelated, privateRule, mixed, empty, missing]) {
      await expect(operations.inspectPageLifecycleRule({ requester: manager, sessionId: 'current-scoped-manager', ruleId: rule.ruleId })).rejects.toMatchObject({ name: 'LIFECYCLE_NOT_FOUND', status: 404 })
      await expect(operations.setPageLifecycleRuleStatus({ requester: manager, sessionId: 'current-scoped-manager', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'cancel' })).rejects.toMatchObject({ name: 'LIFECYCLE_NOT_FOUND', status: 404 })
      await expect(operations.previewPageLifecycle({ requester: manager, sessionId: 'current-scoped-manager', input: { definition: value, ruleId: rule.ruleId, expectedRevision: rule.revision, reown: true } })).rejects.toMatchObject({ name: 'LIFECYCLE_NOT_FOUND', status: 404 })
    }
    await expect(operations.inspectPageLifecycleRule({ requester: manager, sessionId: 'current-scoped-manager', ruleId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({ name: 'LIFECYCLE_NOT_FOUND', status: 404 })
    expect({ rules: await db('pageLifecycleRules').orderBy('id'), cycles: await db('pageLifecycleCycles').orderBy('id'), jobs: await db('durableJobs').orderBy('id'), receipts: await db('pageLifecycleActionReceipts').orderBy('cycleId') }).toEqual(before)
    expect((await operations.inspectPageLifecycleRule({ requester: manager, sessionId: 'current-scoped-manager', ruleId: allowed.ruleId })).rule.definition).toEqual(value)
    await operations.setPageLifecycleRuleStatus({ requester: manager, sessionId: 'current-scoped-manager', ruleId: allowed.ruleId, expectedRevision: allowed.revision, action: 'cancel' })
    expect(await db('pageLifecycleRules').where('id', allowed.ruleId).first()).toMatchObject({ status: 'cancelled', humanOwnerId: owner.id })
    expect(await db('durableJobs').whereIn('id', before.cycles.filter(cycle => cycle.ruleId === allowed.ruleId).map(cycle => cycle.jobId))).toMatchObject([{ state: 'cancelled' }])
  })
  it('requires current management of former targets as well as the filtered dynamic selector', async () => {
    await db('pages').insert({ ...page(), id: 43, path: 'docs/former-target', hash: 'former-target' })
    const value = { ...await definition(), selector: { kind: 'subtree' as const, localeCode: 'en', normalizedRootPath: 'docs' } }, rule = await save(value)
    await jobs.scanPageLifecycleRules(db)
    expect(await db('pageLifecycleRulePages').where('ruleId', rule.ruleId)).toHaveLength(2)
    await db('pages').where('id', 43).update({ path: 'unrelated/moved-by-human' })
    await scopeManager()
    expect((await operations.listPageLifecycleRules({ requester: manager, sessionId: 'current-scoped-manager' })).rules).toEqual([])
    await expect(operations.inspectPageLifecycleRule({ requester: manager, sessionId: 'current-scoped-manager', ruleId: rule.ruleId })).rejects.toMatchObject({ name: 'LIFECYCLE_NOT_FOUND', status: 404 })
    await expect(operations.setPageLifecycleRuleStatus({ requester: manager, sessionId: 'current-scoped-manager', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'disable' })).rejects.toMatchObject({ name: 'LIFECYCLE_NOT_FOUND', status: 404 })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'enabled', revision: 1 })
    expect(await db('durableJobs').where('state', 'cancelled')).toEqual([])
    const pending = await new DurableJobStore(db).claim({ workerId: 'settle-former-targets', supportedIdentities: ['page-lifecycle@1'], limit: 25 })
    for (const job of pending) await run(job)
    expect(await db('pageLifecycleCycles').where('pageId', 43).first()).toMatchObject({ status: 'skipped', reason: 'no-longer-selected' })
    expect((await operations.listPageLifecycleRules({ requester: manager, sessionId: 'current-scoped-manager' })).rules).toEqual([])
    await expect(operations.setPageLifecycleRuleStatus({ requester: manager, sessionId: 'current-scoped-manager', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'disable' })).rejects.toMatchObject({ name: 'LIFECYCLE_NOT_FOUND', status: 404 })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'enabled' })
  })
  it('re-owns only a currently scoped rule with explicit fresh preview and preserves own-rule retirement after access loss', async () => {
    const value = await definition(), rule = await save(value)
    await scopeManager()
    const request = { definition: value, ruleId: rule.ruleId, expectedRevision: rule.revision, reown: true }
    const preview = await operations.previewPageLifecycle({ requester: manager, sessionId: 'current-scoped-manager', input: request })
    await operations.savePageLifecycle({ requester: manager, sessionId: 'current-scoped-manager', input: { ...request, previewToken: preview.previewToken, unattendedConsent: true, enabled: true } })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ humanOwnerId: manager.id, revision: 2, authVersion: manager.authVersion })
    await db('pages').where('id', 42).update({ visibility: 'private', ownerId: owner.id })
    await operations.setPageLifecycleRuleStatus({ requester: manager, sessionId: 'current-scoped-manager', ruleId: rule.ruleId, expectedRevision: 2, action: 'cancel' })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'cancelled', revision: 3 })
  })
  it('retains actual system management without turning it into the private rule’s execution actor', async () => {
    await db('pages').where('id', 42).update({ visibility: 'private', ownerId: owner.id })
    const rule = await save()
    await scopeManager()
    await db('groups').where('id', 4).update({ permissions: JSON.stringify(['manage:system']), pageRules: '[]' })
    const listed = await operations.listPageLifecycleRules({ requester: manager, sessionId: 'current-system-manager' })
    expect(listed.rules.map(row => row.id)).toEqual([rule.ruleId])
    const inspected = await operations.inspectPageLifecycleRule({ requester: manager, sessionId: 'current-system-manager', ruleId: rule.ruleId })
    expect(inspected.rule.humanOwnerId).toBe(owner.id)
    expect(inspected.pages).toEqual([])
    await operations.setPageLifecycleRuleStatus({ requester: manager, sessionId: 'current-system-manager', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'cancel' })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'cancelled', humanOwnerId: owner.id })
  })
  it('does not use a stale manager session or reader projection to disclose current rules and notices', async () => {
    const rule = await save(), job = await queued(); await run(job)
    const retained = await db.transaction(async transaction => {
      const authority = await loadPageRuleAuthority(owner, transaction), currentPage = await operations.lockLifecycleNativePage(transaction, 42)
      if (!currentPage) throw new Error('The owned reader fixture page is missing')
      expect(await operations.readPageLifecycleNotices({ transaction, page: currentPage, requester: owner, authority })).toHaveLength(1)
      return { page: currentPage, authority }
    })
    await db('pages').where('id', 42).update({ visibility: 'private', ownerId: manager.id })
    await db.transaction(async transaction => {
      expect(await operations.readPageLifecycleNotices({ transaction, ...retained, requester: owner })).toEqual([])
    })
    await db('pages').where('id', 42).update({ visibility: 'public', ownerId: null })
    await db('users').where('id', owner.id).update({ authVersion: 1 })
    await db.transaction(async transaction => {
      expect(await operations.readPageLifecycleNotices({ transaction, ...retained, requester: owner })).toEqual([])
    })
    await scopeManager()
    await db('users').where('id', manager.id).update({ authVersion: 1 })
    await expect(operations.listPageLifecycleRules({ requester: manager, sessionId: 'stale-manager' })).rejects.toMatchObject({ name: 'LIFECYCLE_AUTHOR_UNAVAILABLE', status: 403 })
    await expect(operations.inspectPageLifecycleRule({ requester: manager, sessionId: 'stale-manager', ruleId: rule.ruleId })).rejects.toMatchObject({ name: 'LIFECYCLE_AUTHOR_UNAVAILABLE', status: 403 })
    await expect(operations.setPageLifecycleRuleStatus({ requester: manager, sessionId: 'stale-manager', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'cancel' })).rejects.toMatchObject({ name: 'LIFECYCLE_AUTHOR_UNAVAILABLE', status: 403 })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'enabled', revision: 1 })
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
  })
  it('admits only explicit native watcher channels consented for lifecycle at the effect commit', async () => {
    await db('pageWatchers').insert({ pageId: 42, userId: 8, emailEnabled: true, inAppEnabled: true })
    await db('userNotificationPreferences').insert({ userId: 8, category: 'pageLifecycle', emailEnabled: false, inAppEnabled: true })
    await save(await definition([{ kind: 'set-notice', text: 'A factual automated result' }, { kind: 'notify', audience: 'watchers' }]))
    const job = await queued(); await run(job)
    const event = await db('outboxEvents').where('type', 'page.lifecycle-result').first(), payload = JSON.parse(event.payload)
    expect(payload).toMatchObject({ pageId: 42, audience: 'watchers', outcome: 'applied', recipientIds: [8], recipientChannels: [{ userId: 8, emailEnabled: false, inAppEnabled: true }], actions: [{ kind: 'set-notice', state: 'applied' }] })
    expect(payload.actorId).toBeUndefined(); expect(payload.content).toBeUndefined()
    expect(await db('pageLifecycleActionReceipts').where('kind', 'notify').first()).toMatchObject({ state: 'applied', outboxId: event.id })
    await db('userNotificationPreferences').where({ userId: 8, category: 'pageLifecycle' }).update({ emailEnabled: true })
    expect(JSON.parse((await db('outboxEvents').where('id', event.id).first()).payload).recipientChannels).toEqual([{ userId: 8, emailEnabled: false, inAppEnabled: true }])
    expect(await db('pageHistory')).toEqual([])
  })
  it('does not fabricate successful notification or retire when no watcher has lifecycle channel consent', async () => {
    await db('pageWatchers').insert({ pageId: 42, userId: 8, emailEnabled: true, inAppEnabled: true })
    await db('userNotificationPreferences').insert({ userId: 8, category: 'pageLifecycle', emailEnabled: false, inAppEnabled: false })
    const rule = await save(await definition([{ kind: 'notify', audience: 'watchers' }], 'retire-after-success')), job = await queued()
    await run(job)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'failed', reason: 'no-eligible-recipients' })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'needs-attention', retiredAt: null })
    expect(await db('outboxEvents').where('type', 'page.lifecycle-result')).toEqual([])
    expect(await db('pageLifecycleRulePages').first()).toMatchObject({ intervalHighWater: '-1', attemptedIntervalHighWater: '10' })
  })
  it('treats external discussions as unknown even when a historical native comment clock exists', async () => {
    await db('pageLifecycleClocks').where('pageId', 42).update({ commentAnchorAt: new Date((await current()).valueOf() - 10 * 86_400_000), commentAnchorKind: 'known-change', lastCommentEvent: 'native-before-provider-change' })
    const value = { ...await definition(), condition: { kind: 'comments-inactive' as const, days: 1 } }
    const rule = await save(value), job = await queued()
    await db.transaction(async transaction => {
      await transaction.raw('SELECT pg_advisory_xact_lock(?)', [DISCUSSION_SETTINGS_LOCK])
      await transaction('commentProviders').where('key', 'default').update({ isEnabled: false })
      await transaction('commentProviders').where('key', 'giscus').update({ isEnabled: true })
    })
    await run(job)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'skipped', reason: 'unknown-clock' })
    expect(await db('pageLifecycleNotices')).toEqual([])
    const view = await operations.inspectPageLifecycleRule({ requester: owner, sessionId: 'native-lifecycle-human', ruleId: rule.ruleId })
    expect(view.pages).toMatchObject([{ pageId: 42, clock: 'unknown', anchorAt: null, due: { state: 'unknown-clock' } }])
    await expect(operations.previewPageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: { definition: value, startObserving: true } })).rejects.toMatchObject({ name: 'LIFECYCLE_UNKNOWN_CLOCK', status: 409 })
    expect(await db('pageLifecycleClocks').first()).toMatchObject({ commentAnchorKind: 'known-change', lastCommentEvent: 'native-before-provider-change' })
  })
  it('requires explicit observed-baseline consent, preserves known body events and exposes unknown comment clocks', async () => {
    const value = { ...await definition(), condition: { kind: 'comments-inactive' as const, days: 1 } }
    const first = await operations.previewPageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: { definition: value } })
    expect(first.pages[0]).toMatchObject({ clock: 'unknown', due: { state: 'unknown-clock' } })
    await save(value, { startObserving: true })
    const observed = await db('pageLifecycleClocks').first()
    expect(observed).toMatchObject({ bodyEpoch: knownEpoch, commentAnchorKind: 'observed-baseline' })
    expect(observed.commentAnchorAt).not.toBeNull()
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('pageHistory')).toEqual([])
  })
  it('coalesces interval downtime and preserves consumed high-water across disable/re-enable and rule edits', async () => {
    const value = await definition(), rule = await save(value), job = await queued(); await run(job)
    const identity = await db('pageLifecycleRulePages').first(), cycle = await db('pageLifecycleCycles').first()
    expect(identity.intervalHighWater).toBe('10'); expect(cycle).toMatchObject({ cycleNo: '10', coalescedFrom: '0', coalescedThrough: '9' })
    const disabled = await operations.setPageLifecycleRuleStatus({ requester: owner, sessionId: 'native-lifecycle-human', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'disable' })
    await save(value, { ruleId: rule.ruleId, expectedRevision: disabled.revision })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
  })
  it('admits a reviewed 26-page set in bounded 25-page durable batches without silently adding targets', async () => {
    await db('pages').insert(Array.from({ length: 25 }, (_, index) => ({ ...page(), id: 1000 + index, path: `docs/batch-${index}`, hash: `batch-${index}` })))
    const value = await definition()
    await save({ ...value, selector: { kind: 'subtree', localeCode: 'en', normalizedRootPath: 'docs' } })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(25)
    expect(await db('durableJobs').where('type', 'page-lifecycle')).toHaveLength(25)
    await db('pages').insert({ ...page(), id: 2000, path: 'docs/new-after-batch', hash: 'new-after-batch' })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(1)
    expect(await db('pageLifecycleCycles')).toHaveLength(26)
    expect(await db('pageLifecycleCycles').where('pageId', 2000)).toEqual([])
  }, 15_000)
  it('caps concurrent admitted execution batches at four across scheduler ticks', async () => {
    for (let index = 0; index < 5; index++) await save(await definition([{ kind: 'set-notice', text: `Independent rule ${index}` }]))
    expect(await jobs.scanPageLifecycleRules(db)).toBe(4)
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('pageLifecycleBatches').where('status', 'running')).toHaveLength(4)
    const [job] = await new DurableJobStore(db).claim({ workerId: 'release-one-slot', supportedIdentities: ['page-lifecycle@1'], limit: 1 })
    await run(job!); await new DurableJobStore(db).complete(job!)
    expect(await jobs.scanPageLifecycleRules(db)).toBe(1)
    expect(await db('durableJobs').where('state', 'pending')).toHaveLength(4)
  }, 15_000)
  it('serializes simultaneous rule saves at the original human twenty-enabled-rule limit', async () => {
    const value = await definition()
    const previews = await Promise.all(Array.from({ length: 21 }, () => operations.previewPageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: { definition: value } })))
    const results = await Promise.allSettled(previews.map(preview => operations.savePageLifecycle({ requester: owner, sessionId: 'native-lifecycle-human', input: { definition: value, previewToken: preview.previewToken, unattendedConsent: true, enabled: true } })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(20)
    const refused = results.filter(result => result.status === 'rejected')
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ status: 'rejected', reason: { name: 'LIFECYCLE_LIMIT' } })
    expect(await db('pageLifecycleRules').where({ humanOwnerId: owner.id, status: 'enabled' })).toHaveLength(20)
    expect(await db('pages').first()).toMatchObject({ sourceRevision: '1', content: source })
  }, 15_000)
  it('retains active-rule high-water and immutable origin after ordinary detailed receipt cleanup', async () => {
    const rule = await save(), job = await queued(); await run(job)
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    await db('pageLifecycleCycles').where('ruleId', rule.ruleId).update({ completedAt: db.raw("clock_timestamp() - interval '100 days'") })
    await jobs.cleanupPageLifecycle(db)
    expect(await db('pageLifecycleCycles')).toEqual([])
    expect(await db('pageLifecycleActionReceipts')).toEqual([])
    expect(await db('pageLifecycleRulePages').first()).toMatchObject({ intervalHighWater: '10', originalRelativePath: 'docs/start' })
    const events = await db('outboxEvents').select('*')
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('outboxEvents').select('*')).toEqual(events)
  })
  it('retains same-revision skipped-attempt dedupe after detail cleanup without consuming an uncommitted epoch', async () => {
    await db('pageLifecycleClocks').where('pageId', 42).update({ bodyAnchorAt: db.raw("clock_timestamp() - interval '500 days'") })
    const value: PageLifecycleRuleDefinition = { ...await definition(), selector: { kind: 'subtree', localeCode: 'en', normalizedRootPath: 'docs' }, condition: { kind: 'body-inactive', days: 1 } }
    const rule = await save(value), job = await queued()
    await db('pages').where('id', 42).update({ path: 'outside/review' })
    await run(job)
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    await db('pageLifecycleCycles').where('ruleId', rule.ruleId).update({ completedAt: db.raw("clock_timestamp() - interval '400 days'") })
    await jobs.cleanupPageLifecycle(db)
    expect(await db('pageLifecycleCycles')).toEqual([])
    expect(await db('pageLifecycleRulePages').first()).toMatchObject({ consumedBodyEpoch: null, attemptedRevision: 1, attemptedBodyEpoch: knownEpoch })
    await db('pages').where('id', 42).update({ path: 'docs/start' })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('pageLifecycleNotices')).toEqual([])
    await save(value, { ruleId: rule.ruleId, expectedRevision: rule.revision })
    const fresh = await queued(); await run(fresh)
    expect(await db('pageLifecycleNotices')).toHaveLength(1)
    expect(await db('pageLifecycleRulePages').first()).toMatchObject({ consumedBodyEpoch: knownEpoch, attemptedRevision: 2 })
  })
  it('keeps terminal UUID tombstones while retained jobs exist, then purges together without canonical undo', async () => {
    const rule = await save(await definition([{ kind: 'add-tags', tagIds: [9] }, { kind: 'set-notice', text: 'Retained until rule cleanup' }]))
    const job = await queued(); await run(job)
    await operations.setPageLifecycleRuleStatus({ requester: owner, sessionId: 'native-lifecycle-human', ruleId: rule.ruleId, expectedRevision: rule.revision, action: 'cancel' })
    await db('pageLifecycleRules').where('id', rule.ruleId).update({ retiredAt: db.raw("clock_timestamp() - interval '400 days'") })
    await db('pageLifecycleCycles').where('ruleId', rule.ruleId).update({ completedAt: db.raw("clock_timestamp() - interval '400 days'") })
    await jobs.cleanupPageLifecycle(db)
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toBeDefined()
    // The existing native durable cleanup has a shorter retention than tombstones.
    await db('durableJobs').where('id', job.id).delete()
    expect(await jobs.cleanupPageLifecycle(db)).toBe(true)
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toBeUndefined()
    await run(job)
    expect(await db('pageLifecycleRules')).toEqual([])
    expect(await db('pages').first()).toMatchObject({ content: source, sourceRevision: '2', ownerId: null })
    expect(await db('pageTags').orderBy('tagId')).toEqual([{ pageId: 42, tagId: 2 }, { pageId: 42, tagId: 9 }])
    expect(await db('pageHistory')).toHaveLength(1)
  })
  it('never retires a rule with zero currently eligible targets', async () => {
    const value = await definition([{ kind: 'set-notice', text: 'No implicit selection' }], 'retire-after-success')
    const rule = await save({ ...value, selector: { kind: 'ids', pageIds: [999] } })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'enabled', retiredAt: null })
    expect(await db('pageLifecycleCycles')).toEqual([])
  })
  it('reports a canonical destination collision without overwriting, renaming or creating a proposal', async () => {
    await db('pages').insert({ ...page(), id: 99, path: 'archive/docs/start', hash: 'occupied-destination', title: 'Existing destination authority' })
    await save(await definition([{ kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'original-relative-path' }]))
    const job = await queued(); await run(job)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'failed', reason: 'blocked-collision' })
    expect(await db('pageLifecycleMoveProposals')).toEqual([])
    expect(await db('pages').where('id', 99).first()).toMatchObject({ title: 'Existing destination authority', sourceRevision: '1' })
    expect(await db('pages').where('id', 42).first()).toMatchObject({ path: 'docs/start', sourceRevision: '1' })
    expect(await db('pageHistory')).toEqual([])
  })
  it('refuses private move proposals rather than converting their owner boundary to public', async () => {
    await db('pages').where('id', 42).update({ visibility: 'private', ownerId: owner.id })
    await save(await definition([{ kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'page-id' }]))
    const job = await queued(); await run(job)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'suspended', reason: 'needs-manual-native-flow' })
    expect(await db('pageLifecycleMoveProposals')).toEqual([])
    expect(await db('pages').first()).toMatchObject({ visibility: 'private', ownerId: owner.id, path: 'docs/start' })
  })
  it('rechecks destination authority before a proposal without exposing an inaccessible collision', async () => {
    await save(await definition([{ kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'original-relative-path' }]))
    const job = await queued()
    await db('groups').where('id', 3).update({ pageRules: JSON.stringify([{ match: 'SUBTREE', path: 'docs', deny: false, roles: owner.permissions }]) })
    await db('pages').insert({ ...page(), id: 99, path: 'archive/docs/start', hash: 'not-disclosable-destination' })
    await run(job)
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'suspended', reason: 'destination-unavailable' })
    expect(await db('pageLifecycleMoveProposals')).toEqual([])
    expect(await db('pages').where('id', 42).first()).toMatchObject({ path: 'docs/start', sourceRevision: '1' })
  })
  it('creates a human proposal rather than a timer move, and human refusal prevents retirement', async () => {
    const rule = await save(await definition([{ kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'original-relative-path' }], 'retire-after-success'))
    const job = await queued(); await run(job)
    expect(await db('pages').first()).toMatchObject({ path: 'docs/start', sourceRevision: '1' })
    expect(await db('pageLifecycleCycles').first()).toMatchObject({ status: 'needs-review' })
    expect(await db('pageLifecycleMoveProposals').first()).toMatchObject({ status: 'awaiting-human', destinationPath: 'archive/docs/start' })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'enabled' })
    const proposal = await db('pageLifecycleMoveProposals').first()
    await operations.refusePageLifecycleProposal({ requester: owner, sessionId: 'native-lifecycle-human', proposalId: proposal.id })
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'needs-attention' })
    expect(await db('pages').first()).toMatchObject({ path: 'docs/start' })
  })
  it('refuses a changed human proposal snapshot instead of bypassing current native move review', async () => {
    await save(await definition([{ kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'page-id' }]))
    const job = await queued(); await run(job)
    const proposal = await db('pageLifecycleMoveProposals').first()
    await db('pages').where('id', 42).update({ title: 'New human revision after proposal' })
    await expect(Page.movePage({ id: 42, destinationPath: proposal.destinationPath, destinationLocale: 'en', expectedSourceRevision: '1', user: owner, sessionId: 'native-lifecycle-human', lifecycleProposalId: proposal.id, updateLinks: false, skipStorage: true })).rejects.toThrow()
    expect(await db('pages').first()).toMatchObject({ path: 'docs/start', sourceRevision: '2' })
    expect(await db('pageLifecycleMoveProposals').first()).toMatchObject({ status: 'awaiting-human', resultSourceRevision: null })
    expect(await db('pageLifecycleActionReceipts').first()).toMatchObject({ state: 'proposed' })
    expect(await db('pageHistory')).toEqual([])
  })
  it('commits a genuine human native move and proposal receipt atomically, then retires without nesting on restart', async () => {
    const rule = await save(await definition([{ kind: 'propose-move', destinationRootPath: 'archive', destinationLocale: 'same', template: 'original-relative-path' }], 'retire-after-success'))
    const job = await queued(); await run(job)
    const proposal = await db('pageLifecycleMoveProposals').first()
    await Page.movePage({ id: 42, destinationPath: proposal.destinationPath, destinationLocale: 'en', expectedSourceRevision: '1', user: owner, sessionId: 'native-lifecycle-human', lifecycleProposalId: proposal.id, updateLinks: false, skipStorage: true })
    expect(await db('pages').first()).toMatchObject({ path: 'archive/docs/start', content: source, ownerId: null, isPublished: true })
    expect(await db('pageLifecycleMoveProposals').first()).toMatchObject({ status: 'fulfilled', resultSourceRevision: '2', fulfilledBy: owner.id })
    expect(await db('pageLifecycleActionReceipts').first()).toMatchObject({ state: 'fulfilled', afterSourceRevision: '2' })
    expect(await db('pageLifecycleRulePages').first()).toMatchObject({ originalRelativePath: 'docs/start', originalLocale: 'en' })
    expect(await jobs.scanPageLifecycleRules(db)).toBe(0)
    expect(await db('pageLifecycleRules').where('id', rule.ruleId).first()).toMatchObject({ status: 'retired' })
    await run(job)
    expect(await db('pages').first()).toMatchObject({ path: 'archive/docs/start', sourceRevision: '2' })
    expect(await db('pageHistory')).toHaveLength(1)
  })
})
