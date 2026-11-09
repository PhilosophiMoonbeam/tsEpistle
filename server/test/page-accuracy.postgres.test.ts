import knexModule, { type Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
import { getPostgresTestConnection } from './postgres-test-connection.mts'
import { up as createApprovalSchema } from '../db/migrations/2.5.133.ts'
import { up as createProtectionSchema } from '../db/migrations/2.5.134.ts'
import { up as installRevisionTrigger } from '../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { up as createAccuracySchema } from '../db/migrations/tsepistle-000070-page-accuracy-attestations.ts'
import { up as createReviewRoutingSchema } from '../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as createDurableJobsSchema } from '../db/migrations/2.5.130.ts'
import { up as addDurableLeaseToken } from '../db/migrations/2.5.158.ts'
import type authService from '../core/auth.ts'
import type * as accuracyHelpers from '../helpers/page-accuracy.ts'
import type pageOperations from '../operations/pages.ts'
import type { PageOperationInput } from '../operations/pages.ts'

interface AccuracyFixturePage extends Record<string, unknown> {
  id: number
  sourceRevision: string
  updatedAt: Date
  authorId: number
  path: string
  localeCode: string
  visibility: 'public' | 'private'
  ownerId: number | null
}

const connection = getPostgresTestConnection('_page_accuracy_test', import.meta.path)
const suite = connection ? describe : describe.skip
const serverTime = new Date('2026-10-01T12:00:00.000Z')
const sessionId = 'accuracy-human-browser'
const currentRevision = { expectedSourceRevision: '8' }
const editor = {
  id: 7,
  authVersion: 0,
  name: 'Outdated browser name',
  email: 'outdated@example.test',
  permissions: ['read:pages', 'write:pages']
} as Express.User
const reader = { id: 8, authVersion: 0, permissions: ['read:pages'] } as Express.User
const broadRules = [{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages'], locales: [] }]

suite('PostgreSQL revision-bound human page accuracy', () => {
  let db: Knex
  let verifier: Knex
  let auth: typeof authService
  let accuracy: typeof accuracyHelpers
  let operations: typeof pageOperations
  const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')

  const verify = (mutation: unknown, context: PageOperationInput = {}) =>
    operations.verifyAccuracy({ id: 42, requester: editor, sessionId, input: mutation, ...context })
  const page = () => db<AccuracyFixturePage>('pages').where({ id: 42 }).first()
  const read = async (requester = editor, source?: AccuracyFixturePage) =>
    accuracy.readPageAccuracy({
      knex: db,
      requester,
      sessionId,
      delegated: false,
      loadAuthority: auth.loadPageRuleAuthority,
      page: source ?? (await page())!
    })
  const retainedState = async () => ({
    page: await page(),
    history: await db('pageHistory').orderBy('id'),
    approvals: await db('pageApprovalRequests').orderBy('id'),
    transitions: await db('pageApprovalTransitions').orderBy('id')
  })
  const attestations = () => db('pageAccuracyAttestations').orderBy('verifiedAt').orderBy('id')

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    verifier = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    // The runner owns a fresh database per file. Base dependencies are deliberately
    // small; accuracy, approval, protection and revision behavior use real migrations.
    await db.raw(`
      CREATE TABLE users (
        id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true, "authVersion" integer NOT NULL DEFAULT 0,
        "isSystem" boolean NOT NULL DEFAULT false
      );
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" (
        "userId" integer NOT NULL REFERENCES users(id), "groupId" integer NOT NULL REFERENCES groups(id),
        PRIMARY KEY ("userId", "groupId")
      );
      CREATE TABLE pages (
        id integer PRIMARY KEY, "sourceRevision" bigint NOT NULL DEFAULT 8,
        path text NOT NULL, hash text NOT NULL DEFAULT '', "localeCode" text NOT NULL,
        title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL,
        render text NOT NULL DEFAULT '', "renderedSourceRevision" bigint,
        visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL DEFAULT true, "publishStartDate" text NOT NULL DEFAULT '',
        "publishEndDate" text NOT NULL DEFAULT '', "contentType" text NOT NULL DEFAULT 'markdown',
        "editorKey" text NOT NULL DEFAULT 'markdown', "authorId" integer NOT NULL, "creatorId" integer NOT NULL,
        extra jsonb NOT NULL DEFAULT '{}', "updatedAt" timestamptz NOT NULL
      );
      CREATE TABLE tags (
        id integer PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL,
        "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY ("pageId", "tagId")
      );
      CREATE TABLE "pageHistory" (id integer PRIMARY KEY, "sourceRevision" bigint NOT NULL, content text NOT NULL);
    `)
    await createApprovalSchema(db)
    await createProtectionSchema(db)
    await installRevisionTrigger(db)
    await createAccuracySchema(db)
    await createDurableJobsSchema(db)
    await addDurableLeaseToken(db)
    await createReviewRoutingSchema(db)
    // Bound a regression's deadlock/lock wait without relying on a timed sleep.
    // The single-connection verifier pool keeps both settings and backend identity.
    await verifier.raw("SET statement_timeout = '4s'")
    Reflect.set(globalThis, 'WIKI', {
      config: {}, configSvc: {}, events: {}, lang: {}, logger: {}, startedAt: {}, models: { knex: db }
    })
    // Bind the fixture before evaluating the module graph: static imports of
    // operations/protection would capture the preload WIKI instead of this DB.
    auth = (await import('../core/auth.ts')).default
    Reflect.get(globalThis, 'WIKI').auth = auth
    accuracy = await import('../helpers/page-accuracy.ts')
    operations = (await import('../operations/pages.ts')).default
  })

  beforeEach(async () => {
    vi.setSystemTime(serverTime)
    await db('durableJobs').delete()
    await db.raw('TRUNCATE pages, users, groups, tags, "pageHistory" RESTART IDENTITY CASCADE')
    await db('users').insert([
      { id: 2, name: 'Guest', email: 'guest@example.test', isSystem: true },
      { id: 7, name: 'Current human editor', email: 'editor@example.test', isSystem: false },
      { id: 8, name: 'Read-only human', email: 'reader@example.test', isSystem: false },
      { id: 9, name: 'System worker', email: 'worker@example.test', isSystem: true },
      { id: 10, name: 'API service', email: 'api@localhost', isSystem: false }
    ])
    await db('groups').insert([
      { id: 3, name: 'Writers', permissions: JSON.stringify(['read:pages', 'write:pages']), pageRules: JSON.stringify(broadRules) },
      { id: 4, name: 'Readers', permissions: JSON.stringify(['read:pages']), pageRules: JSON.stringify(broadRules) }
    ])
    await db('userGroups').insert([
      { userId: 7, groupId: 3 }, { userId: 8, groupId: 4 }, { userId: 9, groupId: 3 }, { userId: 10, groupId: 3 }
    ])
    await db('pages').insert({
      id: 42, sourceRevision: '8', renderedSourceRevision: '8', path: 'handbook/accuracy', localeCode: 'en',
      title: 'Reviewable handbook', content: 'Reviewed canonical content.', render: '<p>Reviewed canonical content.</p>',
      visibility: 'public', ownerId: null, isPublished: true, authorId: 7, creatorId: 7,
      updatedAt: new Date('2020-01-02T03:04:05.000Z')
    })
    await db('tags').insert({ id: 5, tag: 'handbook', title: 'Handbook' })
    await db('pageTags').insert({ pageId: 42, tagId: 5 })
    // Canonical history records the PREVIOUS revision; current revision 8 has no
    // history row. Approval and modification are deliberately older than accuracy.
    await db('pageHistory').insert({ id: 1, sourceRevision: '7', content: 'Previous canonical content.' })
    await db('pageApprovalRequests').insert({
      id: '00000000-0000-4000-8000-000000000001', pageId: 42, submitterId: 7, assigneeId: 8,
      status: 'approved', revisionId: 1, revisionUpdatedAt: new Date('2020-01-01T00:00:00.000Z'),
      createdAt: new Date('2020-01-01T00:00:00.000Z'), updatedAt: new Date('2020-01-02T00:00:00.000Z'), closedAt: null
    })
    await db('pageApprovalTransitions').insert({
      id: '00000000-0000-4000-8000-000000000002', requestId: '00000000-0000-4000-8000-000000000001',
      fromStatus: 'submitted', toStatus: 'approved', actorId: 8, revisionId: 1, comment: 'Approved publication.',
      createdAt: new Date('2020-01-02T00:00:00.000Z')
    })
  })

  afterEach(() => vi.setSystemTime())
  afterAll(async () => {
    try {
      await Promise.all([db?.destroy(), verifier?.destroy()])
    } finally {
      auth?.revocationList.close()
      if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
      else Reflect.deleteProperty(globalThis, 'WIKI')
    }
  })

  it('does not enroll review routing or schedule reminders from human accuracy alone', async () => {
    const before = await retainedState()
    await verify(currentRevision)
    expect(await db('pageReviewRouting')).toEqual([])
    expect(await db('durableJobs')).toEqual([])
    expect(await retainedState()).toEqual(before)
  })

  it('rolls back the appended human fact when its transactional review reconciliation cannot persist', async () => {
    await db('pageReviewRouting').insert({
      pageId: 42, enabled: true, observedSourceRevision: '8', unverifiedAt: serverTime,
      createdAt: serverTime, updatedAt: serverTime
    })
    const before = await retainedState()
    await db.raw(`ALTER TABLE "durableJobs" ADD CONSTRAINT accuracy_reconcile_failure CHECK ("type" <> 'page-review-reminder')`)
    try {
      await expect(verify(currentRevision)).rejects.toThrow()
      expect(await attestations()).toHaveLength(0)
      expect(await db('durableJobs')).toHaveLength(0)
      expect(await retainedState()).toEqual(before)
    } finally {
      await db.raw('ALTER TABLE "durableJobs" DROP CONSTRAINT accuracy_reconcile_failure')
    }
    const result = await verify(currentRevision)
    expect(result.latestAttestation).toMatchObject({ sourceRevision: '8', verifiedBy: 7, verifiedAt: serverTime.toISOString() })
    expect(await attestations()).toHaveLength(1)
    expect(await db('durableJobs')).toHaveLength(1)
  })

  it('appends explicit server-derived human facts without editing content, revision, modification or approval', async () => {
    const before = await retainedState()
    expect(await read()).toMatchObject({ latestAttestation: null, status: 'needs-verification', canVerify: true })
    const first = await verify(currentRevision)
    expect(first).toMatchObject({
      sourceRevision: '8', updatedAt: '2020-01-02T03:04:05.000Z', status: 'verified-fresh', canVerify: true,
      asOf: serverTime.toISOString(),
      latestAttestation: {
        pageId: 42, sourceRevision: '8', verifiedBy: 7, verifiedByName: 'Current human editor', verifiedAt: serverTime.toISOString()
      }
    })
    const firstRows = await attestations()
    expect(firstRows).toEqual([expect.objectContaining({
      id: first.latestAttestation!.id, pageId: 42, sourceRevision: '8', verifiedBy: 7, verifiedAt: serverTime
    })])
    vi.setSystemTime(new Date(serverTime.valueOf() + 1_000))
    const second = await verify(currentRevision)
    const rows = await attestations()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(firstRows[0])
    expect(rows[1]).toMatchObject({ id: second.latestAttestation!.id, verifiedAt: new Date(serverTime.valueOf() + 1_000) })
    expect(second.latestAttestation!.id).not.toBe(first.latestAttestation!.id)
    expect((await read()).latestAttestation).toEqual(second.latestAttestation)
    expect(await retainedState()).toEqual(before)
  })

  for (const [label, mutation, status, name] of [
    ['missing body', undefined, 400, 'INVALID_INPUT'],
    ['missing expected revision', {}, 400, 'INVALID_INPUT'],
    ['previous revision', { expectedSourceRevision: '7' }, 409, 'PAGE_ACCURACY_STALE'],
    ['future revision', { expectedSourceRevision: '9' }, 409, 'PAGE_ACCURACY_STALE'],
    ['client actor and timestamp', { ...currentRevision, verifiedBy: 8, verifiedAt: '2000-01-01T00:00:00.000Z' }, 400, 'INVALID_INPUT']
  ] as const) {
    it(`rejects ${label} without appending or changing the page`, async () => {
      const before = await retainedState()
      await expect(verify(mutation)).rejects.toMatchObject({ status, name })
      expect(await attestations()).toEqual([])
      expect(await retainedState()).toEqual(before)
    })
  }

  for (const [label, context] of [
    ['anonymous', { requester: undefined }],
    ['guest', { requester: { id: 2, authVersion: 0, permissions: ['read:pages', 'write:pages'] } }],
    ['delegated agent', { agentScope: { kind: 'all' } }],
    ['delegated ownership', { requester: { ...editor, ownershipUserId: 8 } }],
    ['system account', { requester: { id: 9, authVersion: 0, permissions: ['read:pages', 'write:pages'] } }],
    ['API principal', { requester: { ...editor, api: 91, grp: 3 } }],
    ['API service account', { requester: { id: 10, authVersion: 0, permissions: ['read:pages', 'write:pages'] } }],
    ['sessionless human', { sessionId: '' }]
  ] satisfies Array<[string, PageOperationInput]>) {
    it(`refuses ${label} attestation even with the correct revision`, async () => {
      await expect(verify(currentRevision, context)).rejects.toMatchObject({ status: 401, name: 'AUTH_REQUIRED' })
      expect(await attestations()).toEqual([])
    })
  }

  it('allows an authorized reader to see verification without disclosing writer-only attribution or permitting attestation', async () => {
    await verify(currentRevision)
    expect(await read(reader)).toMatchObject({
      status: 'verified-fresh', canVerify: false, author: null,
      latestAttestation: { sourceRevision: '8', verifiedBy: null, verifiedByName: null }
    })
    await expect(verify(currentRevision, { requester: reader })).rejects.toMatchObject({ status: 403, name: 'PAGE_VERIFY_FORBIDDEN' })
    expect(await attestations()).toHaveLength(1)
  })

  for (const revocation of ['permission', 'membership', 'page rule', 'inactive account', 'session generation'] as const) {
    it(`uses fresh ${revocation} instead of stale browser claims`, async () => {
      expect((await read()).canVerify).toBe(true)
      if (revocation === 'permission') await db('groups').where({ id: 3 }).update({ permissions: JSON.stringify(['read:pages']) })
      if (revocation === 'membership') {
        await db('userGroups').where({ userId: 7, groupId: 3 }).delete()
        await db('userGroups').insert({ userId: 7, groupId: 4 })
      }
      if (revocation === 'page rule') await db('groups').where({ id: 3 }).update({ pageRules: JSON.stringify([
        ...broadRules, { match: 'TAG', path: 'handbook', deny: true, roles: ['write:pages'], locales: [] }
      ]) })
      if (revocation === 'inactive account') await db('users').where({ id: 7 }).update({ isActive: false })
      if (revocation === 'session generation') await db('users').where({ id: 7 }).update({ authVersion: 1 })
      const revokedSession = revocation === 'inactive account' || revocation === 'session generation'
      await expect(verify(currentRevision)).rejects.toMatchObject({
        status: revokedSession ? 401 : 403, name: revokedSession ? 'AUTH_REQUIRED' : 'PAGE_VERIFY_FORBIDDEN'
      })
      expect(await attestations()).toEqual([])
      if (!revokedSession) expect((await read()).canVerify).toBe(false)
    })
  }

  it('hides a newly private page from the former public writer while allowing its current human owner', async () => {
    await db('pages').where({ id: 42 }).update({ visibility: 'private', ownerId: 8 })
    await expect(verify({ expectedSourceRevision: '9' })).rejects.toMatchObject({ status: 404, name: 'PAGE_NOT_FOUND' })
    await expect(read()).rejects.toMatchObject({ status: 404, name: 'PAGE_NOT_FOUND' })
    expect(await attestations()).toEqual([])
    expect(await verify({ expectedSourceRevision: '9' }, { requester: reader })).toMatchObject({
      canVerify: true, latestAttestation: { verifiedBy: 8, sourceRevision: '9' }
    })
  })

  it('requires a current password-version grant for this human and browser session', async () => {
    await db('pageAccessPasswords').insert({ pageId: 42, passwordHash: 'unused-by-grant-read', version: 2, updatedBy: 7, updatedAt: serverTime })
    await db('pageUnlockGrants').insert({
      id: '00000000-0000-4000-8000-000000000003', pageId: 42, userId: 7, sessionId,
      passwordVersion: 1, createdAt: serverTime, expiresAt: new Date('2100-01-01T00:00:00.000Z')
    })
    await expect(verify(currentRevision)).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    await expect(read()).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    expect(await attestations()).toEqual([])
    await db('pageUnlockGrants').where({ pageId: 42 }).update({ passwordVersion: 2 })
    await expect(verify(currentRevision, { sessionId: 'other-browser-session' })).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    expect((await verify(currentRevision)).latestAttestation).toMatchObject({ verifiedBy: 7 })
    await db('pageUnlockGrants').where({ pageId: 42 }).update({ expiresAt: new Date(serverTime.valueOf() - 1_000) })
    await expect(verify(currentRevision)).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    expect(await attestations()).toHaveLength(1)
  })

  it('keeps old revision facts but never projects them as current after an edit or through a stale reader snapshot', async () => {
    const oldPage = await page()
    const oldView = await verify(currentRevision)
    const historical = await attestations()
    await db('pages').where({ id: 42 }).update({ content: 'Changed canonical content.', updatedAt: new Date(serverTime.valueOf() + 1_000) })
    expect(String((await page()).sourceRevision)).toBe('9')
    expect(await read()).toMatchObject({ sourceRevision: '9', latestAttestation: null, status: 'needs-verification', canVerify: true })
    expect(await read(editor, oldPage)).toMatchObject({ sourceRevision: '8', latestAttestation: null, status: 'needs-verification', canVerify: false })
    await expect(verify(currentRevision)).rejects.toMatchObject({ status: 409, name: 'PAGE_ACCURACY_STALE' })
    expect(await attestations()).toEqual(historical)
    const current = await verify({ expectedSourceRevision: '9' })
    expect(current.latestAttestation).toMatchObject({ sourceRevision: '9' })
    expect(current.latestAttestation!.id).not.toBe(oldView.latestAttestation!.id)
    expect((await read()).latestAttestation).toEqual(current.latestAttestation)
    expect(await attestations()).toHaveLength(2)
  })

  it('serializes with the existing page-before-tag writer and rejects its superseded revision without deadlock', async () => {
    const backend = await verifier.raw('SELECT pg_backend_pid() AS pid')
    const verifierPid = backend.rows[0].pid as number
    const writer = await db.transaction()
    let pending: Promise<{ value?: unknown; error?: unknown }> | undefined
    try {
      await writer.raw("SET LOCAL statement_timeout = '4s'")
      const writerBackend = await writer.raw('SELECT pg_backend_pid() AS pid')
      const writerPid = writerBackend.rows[0].pid as number
      // Exact competing lock schedule: createTaxonomyService.apply locks changed
      // pages FOR UPDATE before catalog tags FOR UPDATE (taxonomy.ts:91-92).
      await writer('pages').where({ id: 42 }).forUpdate().first()
      pending = accuracy.attestPageAccuracy({
        knex: verifier, requester: editor, sessionId, delegated: false,
        loadAuthority: auth.loadPageRuleAuthority, pageId: 42, mutation: currentRevision
      }).then(value => ({ value }), (error: unknown) => ({ error }))
      const deadline = performance.now() + 3_000
      for (;;) {
        const waiting = await db.raw('SELECT ?::integer = ANY(pg_blocking_pids(?::integer)) AS blocked', [writerPid, verifierPid])
        if (waiting.rows[0].blocked === true) break
        if (performance.now() >= deadline) throw new Error('Accuracy did not reach the writer transaction before the synchronization deadline.')
      }
      // A tags-first verifier would now deadlock with this real page-first
      // schedule. A correct verifier waits, then compares the committed revision.
      await writer('tags').orderBy('id').select('id').forUpdate()
      await writer('tags').where({ id: 5 }).update({ title: 'Revised handbook label' })
      await writer('pages').where({ id: 42 }).update({ content: 'Writer committed newer canonical content.', updatedAt: serverTime })
      await writer.commit()
      expect(await pending).toMatchObject({ error: { status: 409, name: 'PAGE_ACCURACY_STALE' } })
      expect(await page()).toMatchObject({ sourceRevision: '9', content: 'Writer committed newer canonical content.' })
      expect(await db('tags').where({ id: 5 }).first()).toMatchObject({ title: 'Revised handbook label' })
      expect(await attestations()).toEqual([])
      expect(await read()).toMatchObject({ sourceRevision: '9', latestAttestation: null, status: 'needs-verification' })
    } finally {
      if (!writer.isCompleted()) await writer.rollback()
      await pending
    }
  }, 15_000)
})
