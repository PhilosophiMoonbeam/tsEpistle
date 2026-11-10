/// <reference types="bun" />

import { randomUUID } from 'node:crypto'
import knexModule from 'knex'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as createJobs } from '../../db/migrations/2.5.130.ts'
import { up as createOutbox } from '../../db/migrations/2.5.131.ts'
import { up as createApprovals } from '../../db/migrations/2.5.133.ts'
import { up as createProtection } from '../../db/migrations/2.5.134.ts'
import { up as createApprovalConstraints } from '../../db/migrations/tsfranki-000002-approval-lifecycle-constraints.ts'
import { up as addHistoryReasons } from '../../db/migrations/tsepistle-000069-page-history-reasons.ts'
import { up as createReviewRouting } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as createLifecycle } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as bindApprovalRevisions, down as retireApprovalRevisions } from '../../db/migrations/tsepistle-000078-approval-source-revisions.ts'
import { up as createEditLocks } from '../../db/migrations/tsepistle-000080-page-edit-locks.ts'
import type * as approvalOperations from '../../operations/approvals.ts'
import { enqueuePageMutationEffects } from '../../core/page-mutation-outbox.ts'

const connection = getPostgresTestConnection('_approval_revisions_test', import.meta.path)
const suite = connection ? describe : describe.skip
const reviewedRevision = '9007199254740993'
const nextRevision = '9007199254740994'
const publishedRevision = '9007199254740995'
const submitter = { id: 7, name: 'Submitter', email: 'submitter@example.test', permissions: ['read:pages', 'write:pages'] }
const reviewer = { id: 8, name: 'Reviewer', email: 'reviewer@example.test', permissions: ['read:pages', 'manage:pages'] }

suite('PostgreSQL approval canonical revision boundary', () => {
  let db: Knex
  let writer: Knex
  let operations: typeof approvalOperations
  const originalWiki = Reflect.get(globalThis, 'WIKI')

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    writer = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 2 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL);
      CREATE TABLE groups (id integer PRIMARY KEY);
      CREATE TABLE pages (
        id integer PRIMARY KEY, "sourceRevision" bigint NOT NULL, "renderedSourceRevision" bigint,
        path text NOT NULL, hash text NOT NULL DEFAULT '', "localeCode" varchar(35) NOT NULL,
        title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL DEFAULT '',
        render text NOT NULL DEFAULT '', toc jsonb NOT NULL DEFAULT '[]'::jsonb,
        "contentType" text NOT NULL DEFAULT 'markdown', "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(), "editorKey" text NOT NULL DEFAULT 'markdown',
        "authorId" integer NOT NULL DEFAULT 7, "creatorId" integer NOT NULL DEFAULT 7, "ownerId" integer,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb, visibility text NOT NULL DEFAULT 'public',
        "isPublished" boolean NOT NULL DEFAULT false, "isSearchable" boolean NOT NULL DEFAULT true,
        "publishStartDate" varchar(255) NOT NULL DEFAULT '', "publishEndDate" varchar(255) NOT NULL DEFAULT ''
      );
      CREATE TABLE "pageHistory" (
        id serial PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL,
        "authorId" integer NOT NULL, content text NOT NULL, "contentType" text NOT NULL,
        extra jsonb, description text NOT NULL, "editorKey" text NOT NULL, hash text NOT NULL,
        visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL, "localeCode" varchar(35) NOT NULL, path text NOT NULL,
        "publishEndDate" varchar(255) NOT NULL, "publishStartDate" varchar(255) NOT NULL,
        title text NOT NULL, action text NOT NULL, "versionDate" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL);
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL, PRIMARY KEY ("pageId", "tagId"));
      CREATE TABLE "pageHistoryTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL, PRIMARY KEY ("pageId", "tagId"));
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL,
        "effectKind" varchar(64) NOT NULL, "effectKey" varchar(255) NOT NULL,
        "desiredState" varchar(32) NOT NULL, "payloadSha256" varchar(64) NOT NULL, payload text NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        "leaseOwner" varchar(255), "leaseToken" uuid, "leaseExpiresAt" timestamp,
        "availableAt" timestamp NOT NULL DEFAULT now(), result text, postcondition text,
        "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(),
        UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
    `)
    // Migration69 replaces the deployed trigger function, including attribution-only changes.
    await addHistoryReasons(db)
    await db.raw('CREATE TRIGGER pages_source_revision_trigger BEFORE UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION wiki_increment_page_source_revision()')
    await createJobs(db)
    await createOutbox(db)
    await createApprovals(db)
    await createApprovalConstraints(db)
    await bindApprovalRevisions(db)
    await createProtection(db)
    await createReviewRouting(db)
    await createLifecycle(db)
    await createEditLocks(db)
    await db('users').insert([submitter, reviewer].map(({ id, name, email }) => ({ id, name, email })))
    await db('users').insert({ id: 9, name: 'Replacement attribution', email: 'replacement@example.test' })

    const wiki = {
      auth: {
        checkAccess: (actor: { permissions?: string[] }, permissions: readonly string[]) => permissions.some(permission => actor.permissions?.includes(permission)),
        checkPageAccess: (actor: unknown, permissions: readonly string[], _page: unknown, authority: { requester: unknown; permissions: string[] }) =>
          authority.requester === actor && permissions.some(permission => authority.permissions.includes(permission)),
        loadPageRuleAuthority: async (actor: { permissions?: string[] }) => ({ requester: actor, permissions: actor.permissions ?? [], groups: [], tagAliases: {} })
      },
      config: { db: { type: 'postgres' } },
      logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
      models: { knex: db, pages: undefined as unknown, pageHistory: undefined as unknown, tags: undefined as unknown }
    }
    Reflect.set(globalThis, 'WIKI', wiki)
    // The production models and operations capture WIKI at evaluation; do not mock their persistence/CAS boundary.
    const [{ default: Page }, { default: PageHistory }, { default: Tag }, approval] = await Promise.all([
      import('../../models/pages.ts'), import('../../models/pageHistory.ts'), import('../../models/tags.ts'), import('../../operations/approvals.ts')
    ])
    Page.knex(db)
    PageHistory.knex(db)
    Tag.knex(db)
    Object.assign(wiki.models, { pages: Page, pageHistory: PageHistory, tags: Tag })
    operations = approval
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE "pageEditLockAudit", "pageEditLocks", "pageApprovalTransitions", "pageApprovalRequests", "pageHistoryTags", "pageHistory", "pageLifecycleClocks", "pageMutationOutbox", "outboxEvents", "pageTags", pages RESTART IDENTITY CASCADE')
    await db('pages').insert({ id: 42, title: 'Exact review', path: 'approval/exact-review', localeCode: 'en', content: '# Exact review', sourceRevision: reviewedRevision, updatedAt: '2026-11-01T00:00:00.000Z' })
  })

  afterAll(async () => {
    Reflect.set(globalThis, 'WIKI', originalWiki)
    await Promise.all([db?.destroy(), writer?.destroy()])
  })

  const submit = () => operations.submitPageApproval({ requester: submitter, pageId: 42, sessionId: 'submitter-session', expectedSourceRevision: reviewedRevision, assigneeId: 8 })
  const transition = (requestId: string, action: 'approve' | 'publish') => operations.transitionApproval({ requester: reviewer, requestId, action, sessionId: 'reviewer-session' })

  it('rejects unchanged-timestamp attribution drift, rebinds on resubmit, and reports exact publication revisions once', async () => {
    const request = await submit()
    const snapshot = await db('pageHistory').where({ id: request.revisionId }).first()
    const before = await db('pages').where({ id: 42 }).first('updatedAt')
    await writer('pages').where({ id: 42 }).update({ authorId: 9 })
    expect(await db('pages').where({ id: 42 }).first('updatedAt', 'sourceRevision')).toEqual({ updatedAt: before.updatedAt, sourceRevision: nextRevision })

    await expect(transition(request.id, 'approve')).rejects.toMatchObject({ status: 409, name: 'APPROVAL_STALE' })
    expect(await operations.getPageApproval({ requester: submitter, pageId: 42, sessionId: 'submitter-session' })).toMatchObject({ stale: true, reviewedSourceRevision: reviewedRevision, publishedSourceRevision: null })
    expect((await operations.listApprovalInbox(reviewer)).items).toEqual([expect.objectContaining({ stale: true, reviewedSourceRevision: reviewedRevision, publishedSourceRevision: null })])
    expect(await db('pageHistory').where({ id: request.revisionId }).first()).toEqual(snapshot)
    expect(await db('pageApprovalTransitions').where({ requestId: request.id })).toHaveLength(1)

    await operations.transitionApproval({ requester: reviewer, requestId: request.id, action: 'request-changes', sessionId: 'reviewer-session', comment: 'Review the new attribution' })
    const resubmitted = await operations.transitionApproval({ requester: submitter, requestId: request.id, action: 'resubmit', sessionId: 'submitter-session', expectedSourceRevision: nextRevision })
    expect(resubmitted).toMatchObject({ reviewedSourceRevision: nextRevision, publishedSourceRevision: null })
    await transition(request.id, 'approve')
    const publications = await Promise.allSettled([transition(request.id, 'publish'), transition(request.id, 'publish')])
    expect(publications.filter(result => result.status === 'fulfilled')).toEqual([expect.objectContaining({ value: expect.objectContaining({ status: 'published', reviewedSourceRevision: nextRevision, publishedSourceRevision: publishedRevision }) })])
    expect(publications.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ name: 'APPROVAL_FORBIDDEN' }) })])
    expect(await db('pages').where({ id: 42 }).first('sourceRevision', 'isPublished')).toEqual({ sourceRevision: publishedRevision, isPublished: true })
    expect(await db('pageHistory').where({ action: 'approval-published' })).toEqual([expect.objectContaining({ sourceRevision: nextRevision })])
    expect(await db('pageMutationOutbox').pluck('sourceRevision')).toEqual(Array(4).fill(publishedRevision))
    const publication = await db('outboxEvents').where({ aggregateId: request.id, type: 'approval.publish' }).first()
    expect(JSON.parse(publication.payload)).toMatchObject({ requestId: request.id, pageId: 42, status: 'published', reviewedSourceRevision: nextRevision, publishedSourceRevision: publishedRevision })
    expect(await db('pageApprovalTransitions').where({ requestId: request.id, toStatus: 'published' }).first()).toMatchObject({ reviewedSourceRevision: nextRevision, publishedSourceRevision: publishedRevision })
    expect(await operations.getPageApproval({ requester: reviewer, pageId: 42, sessionId: 'reviewer-session' })).toMatchObject({ stale: false, reviewedSourceRevision: nextRevision, publishedSourceRevision: publishedRevision })
  })

  it('fails approved publication after a concurrent locked attribution update without writing publication history or events', async () => {
    const request = await submit()
    await transition(request.id, 'approve')
    const history = await db('pageHistory').orderBy('id')
    const timestamps = await db('pages').where({ id: 42 }).first('updatedAt')
    const transaction = await writer.transaction()
    let pending: Promise<unknown> | undefined
    try {
      await transaction('pages').where({ id: 42 }).forUpdate().first()
      await transaction('pages').where({ id: 42 }).update({ creatorId: 9 })
      const backend = await transaction.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')
      // Publication must read the revision after this row lock is released, never its pre-lock timestamp/snapshot.
      pending = transition(request.id, 'publish').then(value => ({ value }), (error: unknown) => ({ error }))
      const deadline = Date.now() + 3_000
      let blocked = false
      // Observe the real PostgreSQL waiter, not an assumed delay or a test-only operation hook.
      while (!blocked && Date.now() < deadline) {
        const result = await db.raw<{ rows: Array<{ blocked: boolean }> }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND ?::integer = ANY(pg_blocking_pids(pid))) AS blocked`,
          [backend.rows[0].pid]
        )
        blocked = result.rows[0].blocked
      }
      expect(blocked).toBe(true)
      await transaction.commit()
      expect(await pending).toMatchObject({ error: { status: 409, name: 'APPROVAL_STALE' } })
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
      await pending
    }
    expect(await db('pages').where({ id: 42 }).first('updatedAt', 'sourceRevision', 'isPublished')).toEqual({ updatedAt: timestamps.updatedAt, sourceRevision: nextRevision, isPublished: false })
    expect(await db('pageApprovalRequests').where({ id: request.id }).first()).toMatchObject({ status: 'approved', reviewedSourceRevision: reviewedRevision, publishedSourceRevision: null })
    expect(await db('pageHistory').orderBy('id')).toEqual(history)
    expect(await db('pageMutationOutbox')).toHaveLength(0)
    expect(await db('outboxEvents').where({ type: 'approval.publish' })).toHaveLength(0)
  })

  it('reports the actual unchanged publication revision when publication changes no canonical authored fields', async () => {
    await writer('pages').where({ id: 42 }).update({ isPublished: true, authorId: 8 })
    await enqueuePageMutationEffects(db, {
      pageId: 42, sourceRevision: nextRevision, desiredState: 'present', action: 'create',
      source: '# Exact review', contentType: 'markdown',
      location: { locale: 'en', path: 'approval/exact-review', visibility: 'public', ownerId: null }
    })
    const existingEffects = await db('pageMutationOutbox').orderBy('effectKind')
    const request = await operations.submitPageApproval({
      requester: submitter, pageId: 42, sessionId: 'submitter-session', expectedSourceRevision: nextRevision, assigneeId: 8
    })
    await transition(request.id, 'approve')
    expect(await transition(request.id, 'publish')).toMatchObject({ reviewedSourceRevision: nextRevision, publishedSourceRevision: nextRevision })
    const publication = await db('outboxEvents').where({ aggregateId: request.id, type: 'approval.publish' }).first()
    expect(JSON.parse(publication.payload)).toMatchObject({ reviewedSourceRevision: nextRevision, publishedSourceRevision: nextRevision })
    expect(await db('pages').where({ id: 42 }).first('sourceRevision')).toEqual({ sourceRevision: nextRevision })
    expect(await db('pageMutationOutbox').orderBy('effectKind')).toEqual(existingEffects)
  })

  it('does not replace canonical review identity with a changed timestamp', async () => {
    const request = await submit()
    await writer('pages').where({ id: 42 }).update({ updatedAt: '2026-11-02T00:00:00.000Z' })
    expect(await operations.getPageApproval({ requester: reviewer, pageId: 42, sessionId: 'reviewer-session' })).toMatchObject({ stale: false, reviewedSourceRevision: reviewedRevision })
    expect(await transition(request.id, 'approve')).toMatchObject({ status: 'approved', reviewedSourceRevision: reviewedRevision })
  })

  it('treats unresolved legacy active reviews as stale but keeps terminal history historical', async () => {
    const request = await submit()
    await db('pageApprovalRequests').where({ id: request.id }).update({ reviewedSourceRevision: null })
    expect(await operations.getPageApproval({ requester: reviewer, pageId: 42, sessionId: 'reviewer-session' })).toMatchObject({ stale: true, reviewedSourceRevision: null })
    await expect(transition(request.id, 'approve')).rejects.toMatchObject({ status: 409, name: 'APPROVAL_STALE' })
    await db('pageApprovalRequests').where({ id: request.id }).update({ status: 'approved' })
    await expect(transition(request.id, 'publish')).rejects.toMatchObject({ status: 409, name: 'APPROVAL_STALE' })
    await operations.transitionApproval({ requester: submitter, requestId: request.id, action: 'cancel', sessionId: 'submitter-session' })
    expect(await operations.getPageApproval({ requester: reviewer, pageId: 42, sessionId: 'reviewer-session' })).toMatchObject({ status: 'cancelled', stale: false, reviewedSourceRevision: null, publishedSourceRevision: null })
  })

  it('allows exact authorized approval records while edit-locked but refuses publication atomically', async () => {
    await db('pageEditLocks').insert({ pageId: 42, isEditLocked: true, lockVersion: '1', updatedBy: 7, reason: 'Await canonical release' })
    const request = await submit()
    await transition(request.id, 'approve')
    const page = await db('pages').where({ id: 42 }).first()
    const workflow = await db('pageApprovalRequests').where({ id: request.id }).first()
    const transitions = await db('pageApprovalTransitions').where({ requestId: request.id }).orderBy('createdAt')
    await expect(transition(request.id, 'publish')).rejects.toMatchObject({ name: 'PAGE_EDIT_LOCKED', status: 409 })
    expect(await db('pages').where({ id: 42 }).first()).toEqual(page)
    expect(await db('pageApprovalRequests').where({ id: request.id }).first()).toEqual(workflow)
    expect(await db('pageApprovalTransitions').where({ requestId: request.id }).orderBy('createdAt')).toEqual(transitions)
  })

  it('preserves legacy reassignment bindings, refuses duplicate submissions, and rejects provenance-erasing rollback', async () => {
    await db.raw('CREATE SCHEMA approval_legacy')
    const legacy = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: ['approval_legacy'], pool: { min: 0, max: 1 } })
    try {
      // Deliberately retain orphan/mismatched history in the legacy fixture rather than hiding it behind new FKs.
      await legacy.raw(`
        CREATE TABLE "pageHistory" (id integer PRIMARY KEY, "pageId" integer NOT NULL, action text NOT NULL, "sourceRevision" bigint);
        CREATE TABLE "pageApprovalRequests" (id uuid PRIMARY KEY, "pageId" integer NOT NULL, status text NOT NULL, "revisionId" integer NOT NULL);
        CREATE TABLE "pageApprovalTransitions" (id uuid PRIMARY KEY, "requestId" uuid NOT NULL, "revisionId" integer NOT NULL, "fromStatus" text, "toStatus" text NOT NULL);
      `)
      const cases = [
        { revision: reviewedRevision, pageId: 1, historyPageId: 1, action: 'approval-submitted', status: 'submitted', expected: reviewedRevision },
        { revision: '1', pageId: 2, historyPageId: 2, action: 'approval-submitted', status: 'submitted', expected: null },
        { revision: nextRevision, pageId: 3, historyPageId: 99, action: 'approval-submitted', status: 'approved', expected: null },
        { revision: nextRevision, pageId: 4, historyPageId: 4, action: 'updated', status: 'submitted', expected: null },
        { revision: nextRevision, pageId: 5, historyPageId: 5, action: 'approval-submitted', status: 'submitted', expected: null },
        { revision: nextRevision, pageId: 6, historyPageId: 6, action: 'approval-resubmitted', status: 'published', expected: nextRevision },
        { revision: null, pageId: 7, historyPageId: 7, action: 'approval-submitted', status: 'submitted', expected: null },
        { revision: nextRevision, pageId: 8, historyPageId: 8, action: 'approval-submitted', status: 'submitted', expected: null }
      ]
      const requests = cases.map((fixture, index) => ({ id: randomUUID(), pageId: fixture.pageId, status: fixture.status, revisionId: index + 1 }))
      await legacy('pageApprovalRequests').insert(requests)
      await legacy('pageHistory').insert(cases.filter(fixture => fixture.pageId !== 8).map(fixture => ({ id: fixture.pageId, pageId: fixture.historyPageId, action: fixture.action, sourceRevision: fixture.revision })))
      const submissions = requests.map(request => ({ id: randomUUID(), requestId: request.id, revisionId: request.revisionId, fromStatus: request.pageId === 6 ? 'changes-requested' : null, toStatus: 'submitted' }))
      const reassignments = [submissions[0], submissions[5]].map(submission => ({ ...submission, id: randomUUID(), fromStatus: 'submitted' }))
      await legacy('pageApprovalTransitions').insert([...submissions, ...reassignments, { ...submissions[4], id: randomUUID() }])
      const immutableHistory = await legacy('pageHistory').orderBy('id')
      const immutableTransitions = await legacy('pageApprovalTransitions').orderBy('id')
      await bindApprovalRevisions(legacy)
      const migrated = await legacy('pageApprovalRequests').orderBy('pageId')
      expect(migrated.map(row => row.reviewedSourceRevision)).toEqual(cases.map(fixture => fixture.expected))
      expect(migrated.map(row => row.publishedSourceRevision)).toEqual(cases.map(() => null))
      expect(migrated.map(row => row.status)).toEqual(cases.map(fixture => fixture.status))
      expect(await legacy('pageHistory').orderBy('id')).toEqual(immutableHistory)
      expect((await legacy('pageApprovalTransitions').orderBy('id')).map(({ reviewedSourceRevision: _reviewed, publishedSourceRevision: _published, ...row }) => row)).toEqual(immutableTransitions)
      expect(await legacy('pageApprovalTransitions').where({ requestId: requests[0].id }).first()).toMatchObject({ reviewedSourceRevision: reviewedRevision, publishedSourceRevision: null })
      expect(await legacy('pageApprovalTransitions').where({ requestId: requests[1].id }).first()).toMatchObject({ reviewedSourceRevision: null, publishedSourceRevision: null })
      expect(await legacy('pageApprovalTransitions').where({ id: reassignments[0].id }).first()).toMatchObject({ reviewedSourceRevision: reviewedRevision, publishedSourceRevision: null })
      expect(await legacy('pageApprovalTransitions').where({ id: reassignments[1].id }).first()).toMatchObject({ reviewedSourceRevision: nextRevision, publishedSourceRevision: null })
      expect(await legacy('pageApprovalTransitions').where({ requestId: requests[4].id }).pluck('reviewedSourceRevision')).toEqual([null, null])
      await expect(retireApprovalRevisions()).rejects.toThrow('fix forward')
      expect(await legacy.schema.hasColumn('pageApprovalRequests', 'reviewedSourceRevision')).toBe(true)
    } finally {
      await legacy.destroy()
      await db.raw('DROP SCHEMA approval_legacy CASCADE')
    }
  })
})
