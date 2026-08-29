import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { up as upOutbox } from '../../db/migrations/2.5.131.ts'
import { up as upApprovals } from '../../db/migrations/2.5.133.ts'
import { up as upProtection } from '../../db/migrations/2.5.134.ts'

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
  })
  await knex.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
  })
  await knex('users').insert([{ id: 7 }, { id: 8 }, { id: 9 }])
  await knex('pages').insert({ id: 42, isPublished: false, authorId: 7 })
  await upOutbox(knex)
  await upApprovals(knex)
  await upProtection(knex)
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
    isPublished: false
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
            findById: (id: number) => transaction('pages').where({ id }).update(input)
          }),
          findById: (id: number) => ({
            select: (...columns: string[]) => transaction('pages').where({ id }).first(...columns)
          })
        })
      },
      pageHistory: {
        addVersion: async ({ transaction }: { transaction: Knex }) => {
          const [id] = await transaction('pageHistory').insert({ pageId: 42 })
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
    const submitted = await operations.submitPageApproval({ requester: user(7, ['write:pages']), pageId: 42, assigneeId: 8, comment: 'Ready' })
    expect(submitted).toMatchObject({ pageId: 42, submitterId: 7, assigneeId: 8, status: 'submitted', revisionId: revision })
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id })).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'submitted', actorId: 7, revisionId: revision, comment: 'Ready' })
    ])
    expect(await knex('outboxEvents').where({ aggregateId: submitted.id }).first()).toMatchObject({ type: 'approval.submitted' })
  })

  it('enforces assignment, reviewer eligibility, and required decision comments', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({ requester: user(7, ['read:pages', 'write:pages']), pageId: 42, assigneeId: 8 })
    await expect(Promise.resolve(operations.transitionApproval({ requester: user(9, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'approve' }))).rejects.toMatchObject({ status: 403 })
    await expect(Promise.resolve(operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'request-changes' }))).rejects.toMatchObject({ status: 400, name: 'COMMENT_REQUIRED' })
    await expect(Promise.resolve(operations.transitionApproval({ requester: user(7, ['read:pages', 'write:pages']), requestId: submitted.id, action: 'approve' }))).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a stale revision, then resubmits, approves, and publishes atomically', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({ requester: user(7, ['read:pages', 'write:pages']), pageId: 42, assigneeId: 8 })
    page.updatedAt = new Date('2026-08-15T00:01:00.000Z')
    await expect(Promise.resolve(operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'approve' }))).rejects.toMatchObject({ status: 409, name: 'APPROVAL_STALE' })
    await operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'request-changes', comment: 'Refresh this revision' })
    const resubmitted = await operations.transitionApproval({ requester: user(7, ['read:pages', 'write:pages']), requestId: submitted.id, action: 'resubmit', comment: 'Updated' })
    expect(resubmitted).toMatchObject({ status: 'submitted', revisionId: revision })
    const approved = await operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'approve' })
    expect(approved.status).toBe('approved')
    const published = await operations.transitionApproval({ requester: user(8, ['read:pages', 'manage:pages']), requestId: submitted.id, action: 'publish' })
    expect(published.status).toBe('published')
    expect(await knex('pages').where({ id: 42 }).first()).toMatchObject({ isPublished: 1, authorId: 8 })
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id }).pluck('toStatus')).toEqual([
      'submitted', 'changes-requested', 'submitted', 'approved', 'published'
    ])
    expect(searchUpdated).toHaveBeenCalledOnce()
  })

  it('scopes active inbox rows to participants and eligible reviewers', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    await operations.submitPageApproval({ requester: user(7, ['read:pages', 'write:pages']), pageId: 42, assigneeId: 8 })
    expect(await operations.listApprovalInbox(user(7, ['read:pages', 'write:pages']))).toMatchObject({ items: [expect.objectContaining({ canReview: false })] })
    expect(await operations.listApprovalInbox(user(8, ['read:pages', 'manage:pages']))).toMatchObject({ items: [expect.objectContaining({ canReview: true })] })
    expect(await operations.listApprovalInbox(user(9, ['read:pages', 'manage:pages']))).toEqual({ items: [] })
  })

  it('audits reassignment, administrator override, rejection, and cancellation', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const first = await operations.submitPageApproval({ requester: user(7, ['read:pages', 'write:pages']), pageId: 42, assigneeId: 8 })
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

    const second = await operations.submitPageApproval({ requester: user(7, ['read:pages', 'write:pages']), pageId: 42 })
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
