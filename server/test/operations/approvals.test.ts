import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { up as upOutbox } from '../../db/migrations/2.5.131.ts'
import { up as upApprovals } from '../../db/migrations/2.5.133.ts'
import { up as upProtection } from '../../db/migrations/2.5.134.ts'
import { down as downApprovalConstraints, up as upApprovalConstraints } from '../../db/migrations/tsfranki-000002-approval-lifecycle-constraints.ts'

let knex: Knex
let page: Record<string, unknown>
let revision = 0
const searchUpdated = vi.fn()

const user = (id: number, permissions: string[]) => ({ id, email: `user-${id}@example.test`, name: `User ${id}`, permissions })

beforeEach(async () => {
  vi.resetModules()
  searchUpdated.mockReset()
  revision = 0
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('users', table => table.integer('id').primary())
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.boolean('isPublished').notNullable()
    table.text('render').nullable()
    table.integer('authorId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.text('content').notNullable()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
  })
  await knex.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.string('action').notNullable()
    table.bigInteger('sourceRevision').notNullable()
  })
  await knex('users').insert([{ id: 7 }, { id: 8 }, { id: 9 }])
  await knex('pages').insert({
    id: 42,
    isPublished: false,
    authorId: 7,
    sourceRevision: 1,
    content: '# Review me',
    localeCode: 'en',
    path: 'docs/review',
    visibility: 'public',
    ownerId: null
  })
  await knex.raw(`
    CREATE TRIGGER pages_source_revision_trigger
    AFTER UPDATE OF isPublished, authorId ON pages
    FOR EACH ROW
    WHEN NEW.isPublished IS NOT OLD.isPublished OR NEW.authorId IS NOT OLD.authorId
    BEGIN
      UPDATE pages SET sourceRevision = OLD.sourceRevision + 1 WHERE id = OLD.id;
    END
  `)
  await upOutbox(knex)
  await upApprovals(knex)
  await upProtection(knex)
  await upApprovalConstraints(knex)
  await knex.schema.createTable('pageMutationOutbox', table => {
    table.uuid('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind').notNullable()
    table.string('effectKey').notNullable()
    table.string('desiredState').notNullable()
    table.string('payloadSha256').notNullable()
    table.text('payload').notNullable()
    table.string('status').notNullable()
    table.integer('attempts').notNullable()
    table.string('leaseOwner').nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable()
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['pageId', 'sourceRevision', 'effectKind'])
  })
  page = {
    id: 42,
    title: 'Review me',
    path: 'docs/review',
    localeCode: 'en',
    visibility: 'public',
    ownerId: null,
    tags: [],
    updatedAt: new Date('2026-08-15T00:00:00.000Z'),
    authorId: 7,
    content: '# Review me',
    contentType: 'markdown',
    description: '',
    editorKey: 'markdown',
    hash: 'revision-one',
    isPublished: false,
    sourceRevision: 1
  }
  const getPage = async () => ({ ...page, ...(await knex('pages').where({ id: 42 }).first()) })
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: (principal: { permissions?: string[] }, permissions: string[]) => permissions.some(permission => principal.permissions?.includes(permission))
    },
    data: { searchEngine: { updated: searchUpdated } },
    models: {
      knex,
      pages: {
        getPageFromDb: getPage,
        cleanHTML: (value: string) => value,
        query: (transaction: Knex = knex) => ({
          patch: (input: Record<string, unknown>) => ({
            where: async (criteria: Record<string, unknown>) => {
              const matched = await transaction('pages').where(criteria).first('id')
              if (!matched) return 0
              await transaction('pages').where({ id: matched.id }).update(input)
              return 1
            }
          }),
          findById: (id: number) => ({
            select: (...columns: string[]) =>
              transaction('pages')
                .where({ id })
                .first(...columns)
          })
        })
      },
      pageHistory: {
        addVersion: async ({ transaction, action, sourceRevision }: { transaction: Knex; action: string; sourceRevision: string | number }) => {
          const [id] = await transaction('pageHistory').insert({ pageId: 42, action, sourceRevision })
          revision = Number(id)
          return { id: revision }
        }
      }
    }
  })
})

afterEach(async () => {
  delete (global as typeof globalThis & { WIKI?: unknown }).WIKI
  await knex.destroy()
})

describe('page approval workflow', () => {
  it('binds a submission to an immutable revision and audit transition', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({
      requester: user(7, ['write:pages']),
      pageId: 42,
      expectedSourceRevision: '1',
      assigneeId: 8,
      comment: 'Ready'
    })
    expect(submitted).toMatchObject({ pageId: 42, submitterId: 7, assigneeId: 8, status: 'submitted', revisionId: revision })
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id })).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'submitted', actorId: 7, revisionId: revision, comment: 'Ready' })
    ])
    expect(await knex('outboxEvents').where({ aggregateId: submitted.id }).first()).toMatchObject({ type: 'approval.submitted' })
  })

  it('requires the canonical current page source revision when submitting', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const requester = user(7, ['read:pages', 'write:pages'])
    await expect(operations.submitPageApproval({ requester, pageId: 42, expectedSourceRevision: undefined })).rejects.toMatchObject({
      status: 400,
      name: 'INVALID_INPUT'
    })
    await expect(operations.submitPageApproval({ requester, pageId: 42, expectedSourceRevision: '01' })).rejects.toMatchObject({
      status: 400,
      name: 'INVALID_INPUT'
    })

    await knex('pages').where({ id: 42 }).update({ sourceRevision: 2 })
    await expect(operations.submitPageApproval({ requester, pageId: 42, expectedSourceRevision: '1' })).rejects.toMatchObject({
      status: 409,
      name: 'APPROVAL_STALE'
    })
    expect(await knex('pageApprovalRequests')).toHaveLength(0)
    expect(await knex('pageHistory')).toHaveLength(0)
    expect(await knex('outboxEvents')).toHaveLength(0)
  })

  it('enforces assignment, reviewer eligibility, and required decision comments', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    await expect(
      Promise.resolve(operations.transitionApproval({ requester: user(9, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'approve' }))
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      Promise.resolve(operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'request-changes' }))
    ).rejects.toMatchObject({ status: 400, name: 'COMMENT_REQUIRED' })
    await expect(
      Promise.resolve(operations.transitionApproval({ requester: user(7, ['read:pages', 'write:pages']), requestId: submitted.id, action: 'approve' }))
    ).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a stale revision, then resubmits, approves, and publishes atomically', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    page.updatedAt = new Date('2026-08-15T00:01:00.000Z')
    await expect(
      Promise.resolve(operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'approve' }))
    ).rejects.toMatchObject({ status: 409, name: 'APPROVAL_STALE' })
    await operations.transitionApproval({
      requester: user(8, ['read:pages', 'manage:pages']),
      requestId: submitted.id,
      action: 'request-changes',
      comment: 'Refresh this revision'
    })
    const resubmitted = await operations.transitionApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      requestId: submitted.id,
      action: 'resubmit',
      comment: 'Updated'
    })
    expect(resubmitted).toMatchObject({ status: 'submitted', revisionId: revision })
    const approved = await operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'approve' })
    expect(approved.status).toBe('approved')
    const published = await operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'publish' })
    expect(published.status).toBe('published')
    expect(await knex('pages').where({ id: 42 }).first()).toMatchObject({ isPublished: 1, authorId: 8, sourceRevision: 2 })
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id }).pluck('toStatus')).toEqual([
      'submitted',
      'changes-requested',
      'submitted',
      'approved',
      'published'
    ])
    expect(searchUpdated).not.toHaveBeenCalled()
    const publicationRevision = await knex('pageHistory').where({ pageId: 42, action: 'approval-published' }).first()
    expect(publicationRevision).toMatchObject({ sourceRevision: 1 })
    const projections = await knex('pageMutationOutbox').where({ pageId: 42 }).orderBy('effectKind')
    expect(projections).toHaveLength(4)
    expect(projections.map(row => row.effectKind)).toEqual(['knowledge', 'links', 'render', 'search'])
    expect(projections.map(row => row.sourceRevision)).toEqual([2, 2, 2, 2])
    expect(projections.map(row => JSON.parse(String(row.payload)))).toEqual([
      expect.objectContaining({ effectKind: 'knowledge', sourceRevision: '2', desiredState: 'present', action: 'update' }),
      expect.objectContaining({ effectKind: 'links', sourceRevision: '2', desiredState: 'present', action: 'update' }),
      expect.objectContaining({ effectKind: 'render', sourceRevision: '2', desiredState: 'present', action: 'update' }),
      expect.objectContaining({ effectKind: 'search', sourceRevision: '2', desiredState: 'present', action: 'update' })
    ])
  })

  it('commits one workflow and one event when submissions race', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submissions = await Promise.allSettled([
      operations.submitPageApproval({ requester: user(7, ['read:pages', 'write:pages']), pageId: 42, expectedSourceRevision: '1', assigneeId: 8 }),
      operations.submitPageApproval({ requester: user(7, ['read:pages', 'write:pages']), pageId: 42, expectedSourceRevision: '1', assigneeId: 8 })
    ])
    expect(submissions.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = submissions.find(result => result.status === 'rejected')
    expect(rejected && rejected.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ status: 409, name: 'APPROVAL_ACTIVE' })
    expect(await knex('pageApprovalRequests').where({ pageId: 42 })).toHaveLength(1)
    expect(await knex('pageApprovalTransitions').where({ toStatus: 'submitted' })).toHaveLength(1)
    expect(await knex('outboxEvents').where({ type: 'approval.submitted' })).toHaveLength(1)
  })

  it('refuses the lifecycle constraint migration without discarding duplicate active workflows', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    await downApprovalConstraints(knex)
    await knex('pageApprovalRequests').insert({
      ...submitted,
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: new Date('2026-08-15T00:01:00.000Z'),
      updatedAt: new Date('2026-08-15T00:01:00.000Z')
    })

    await expect(upApprovalConstraints(knex)).rejects.toThrow('Page 42 has duplicate active approval workflows')
    expect(await knex('pageApprovalRequests').where({ pageId: 42 })).toHaveLength(2)
  })

  it('commits one successor and one event when publish and cancel race', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    await operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'approve' })

    const successors = await Promise.allSettled([
      operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'publish' }),
      operations.transitionApproval({ requester: user(7, ['read:pages', 'write:pages']), requestId: submitted.id, action: 'cancel' })
    ])
    expect(successors.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const request = await knex('pageApprovalRequests').where({ id: submitted.id }).first()
    expect(['published', 'cancelled']).toContain(request.status)
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id })).toHaveLength(3)
    expect(await knex('outboxEvents').where({ aggregateId: submitted.id })).toHaveLength(3)
  })

  it('scopes active inbox rows to participants and eligible reviewers', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    expect(await operations.listApprovalInbox(user(7, ['read:pages', 'write:pages']))).toMatchObject({ items: [expect.objectContaining({ canReview: false })] })
    expect(await operations.listApprovalInbox(user(8, ['read:pages', 'manage:pages']))).toMatchObject({ items: [expect.objectContaining({ canReview: true })] })
    expect(await operations.listApprovalInbox(user(9, ['read:pages', 'manage:pages']))).toEqual({ items: [] })
  })

  it('audits reassignment, administrator override, rejection, and cancellation', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const first = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    const reassigned = await operations.transitionApproval({
      requester: user(9, ['read:pages', 'manage:system']),
      requestId: first.id,
      action: 'reassign',
      assigneeId: 9,
      comment: 'Administrator reassignment'
    })
    expect(reassigned).toMatchObject({ status: 'submitted', assigneeId: 9 })
    const rejected = await operations.transitionApproval({
      requester: user(9, ['read:pages', 'manage:system']),
      requestId: first.id,
      action: 'reject',
      comment: 'Does not meet publication policy'
    })
    expect(rejected).toMatchObject({ status: 'rejected', closedAt: expect.anything() })

    const second = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      expectedSourceRevision: '1'
    })
    const cancelled = await operations.transitionApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      requestId: second.id,
      action: 'cancel',
      comment: 'Withdrawn'
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', closedAt: expect.anything() })
    expect(await knex('pageApprovalTransitions').where({ requestId: first.id }).pluck('toStatus')).toEqual(['submitted', 'submitted', 'rejected'])
    expect(await knex('pageApprovalTransitions').where({ requestId: second.id }).pluck('toStatus')).toEqual(['submitted', 'cancelled'])
  })
})
