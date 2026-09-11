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
type TestUser = { id: number; email: string; name: string; permissions: string[] }

const user = (id: number, permissions: string[]): TestUser => ({ id, email: `user-${id}@example.test`, name: `User ${id}`, permissions })
const authorityFor = (requester: { permissions?: string[] } | undefined) => ({
  requester,
  permissions: requester?.permissions ?? [],
  groups: [],
  tagAliases: {}
})
const insertFixtureRows = async <T extends object>(table: string, rows: readonly T[]): Promise<void> => {
  for (let offset = 0; offset < rows.length; offset += 100) {
    await knex(table).insert(rows.slice(offset, offset + 100))
  }
}

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
    table.string('title').notNullable()
    table.dateTime('updatedAt').notNullable()
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
  await knex.schema.createTable('tags', table => {
    table.integer('id').primary()
    table.string('tag').notNullable()
  })
  await knex.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
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
    title: 'Review me',
    updatedAt: new Date('2026-08-15T00:00:00.000Z'),
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
  const getPage = async (id = 42) => {
    const storedPage = await knex('pages').where({ id }).first()
    return storedPage ? { ...page, ...storedPage } : undefined
  }
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: (principal: { permissions?: string[] }, permissions: string[]) =>
        permissions.some(permission => principal.permissions?.includes(permission)),
      checkPageAccess: (
        principal: { permissions?: string[] },
        permissions: string[],
        _context: unknown,
        authority: { requester: unknown; permissions: string[] }
      ) => authority.requester === principal && permissions.some(permission => authority.permissions.includes(permission)),
      loadPageRuleAuthority: async (requester: { permissions?: string[] } | undefined) => authorityFor(requester)
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
      sessionId: 'approval-session',
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
    await expect(
      operations.submitPageApproval({ requester, pageId: 42, sessionId: 'approval-session', expectedSourceRevision: undefined })
    ).rejects.toMatchObject({
      status: 400,
      name: 'INVALID_INPUT'
    })
    await expect(operations.submitPageApproval({ requester, pageId: 42, sessionId: 'approval-session', expectedSourceRevision: '01' })).rejects.toMatchObject({
      status: 400,
      name: 'INVALID_INPUT'
    })

    await knex('pages').where({ id: 42 }).update({ sourceRevision: 2 })
    await expect(operations.submitPageApproval({ requester, pageId: 42, sessionId: 'approval-session', expectedSourceRevision: '1' })).rejects.toMatchObject({
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
      sessionId: 'approval-session',
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    await expect(
      Promise.resolve(
        operations.transitionApproval({
          requester: user(9, ['read:pages', 'manage:pages']),
          requestId: submitted.id,
          action: 'approve',
          sessionId: 'approval-session'
        })
      )
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      Promise.resolve(
        operations.transitionApproval({
          requester: user(8, ['read:pages', 'manage:pages']),
          requestId: submitted.id,
          action: 'request-changes',
          sessionId: 'approval-session'
        })
      )
    ).rejects.toMatchObject({ status: 400, name: 'COMMENT_REQUIRED' })
    await expect(
      Promise.resolve(
        operations.transitionApproval({
          requester: user(7, ['read:pages', 'write:pages']),
          requestId: submitted.id,
          action: 'approve',
          sessionId: 'approval-session'
        })
      )
    ).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a stale revision, then resubmits, approves, and publishes atomically', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitted = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      sessionId: 'approval-session',
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    page.updatedAt = new Date('2026-08-15T00:01:00.000Z')
    await knex('pages').where({ id: 42 }).update({ updatedAt: page.updatedAt })
    await expect(
      Promise.resolve(
        operations.transitionApproval({
          requester: user(8, ['read:pages', 'manage:pages']),
          requestId: submitted.id,
          action: 'approve',
          sessionId: 'approval-session'
        })
      )
    ).rejects.toMatchObject({ status: 409, name: 'APPROVAL_STALE' })
    await operations.transitionApproval({
      requester: user(8, ['read:pages', 'manage:pages']),
      requestId: submitted.id,
      sessionId: 'approval-session',
      action: 'request-changes',
      comment: 'Refresh this revision'
    })
    const resubmitted = await operations.transitionApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      requestId: submitted.id,
      sessionId: 'approval-session',
      expectedSourceRevision: '1',
      action: 'resubmit',
      comment: 'Updated'
    })
    expect(resubmitted).toMatchObject({ status: 'submitted', revisionId: revision })
    const approved = await operations.transitionApproval({
      requester: user(8, ['read:pages', 'manage:pages']),
      requestId: submitted.id,
      action: 'approve',
      sessionId: 'approval-session'
    })
    expect(approved.status).toBe('approved')
    const published = await operations.transitionApproval({
      requester: user(8, ['read:pages', 'manage:pages']),
      requestId: submitted.id,
      action: 'publish',
      sessionId: 'approval-session'
    })
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

  it('enforces page locks for approval detail, submission, and transitions without a manage-pages bypass', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const protection = await vi.importFresh('../../operations/page-protection.ts', import.meta.url)
    const owner = user(7, ['read:pages', 'write:pages'])
    await protection.setPageProtection({
      requester: owner,
      pageId: 42,
      password: 'approval page password',
      sessionId: 'owner-session'
    })

    await expect(operations.getPageApproval({ requester: owner, pageId: 42, sessionId: 'other-session' })).rejects.toMatchObject({
      status: 403,
      name: 'PAGE_LOCKED'
    })
    await expect(
      operations.submitPageApproval({
        requester: owner,
        pageId: 42,
        sessionId: 'other-session',
        expectedSourceRevision: '1'
      })
    ).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    expect(await knex('pageApprovalRequests')).toHaveLength(0)

    const submitted = await operations.submitPageApproval({
      requester: owner,
      pageId: 42,
      sessionId: 'owner-session',
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    await expect(
      operations.transitionApproval({
        requester: user(8, ['read:pages', 'manage:pages']),
        requestId: submitted.id,
        sessionId: 'reviewer-session',
        action: 'request-changes',
        comment: 'Needs revision'
      })
    ).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    await expect(
      operations.transitionApproval({
        requester: owner,
        requestId: submitted.id,
        sessionId: 'other-session',
        action: 'cancel',
        comment: 'Withdrawn'
      })
    ).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    await expect(
      operations.submitPageApproval({
        requester: user(9, ['read:pages', 'manage:pages']),
        pageId: 42,
        sessionId: 'pages-manager-session',
        expectedSourceRevision: '1'
      })
    ).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    expect(await knex('pageApprovalRequests').where({ id: submitted.id }).first()).toMatchObject({ status: 'submitted' })
    await expect(operations.getPageApproval({ requester: owner, pageId: 42, sessionId: 'owner-session' })).resolves.toMatchObject({
      id: submitted.id,
      status: 'submitted'
    })
  })
  it('protects resubmission with current write access and the locked source revision', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submitter = user(7, ['read:pages', 'write:pages'])
    const reviewer = user(8, ['read:pages', 'manage:pages'])
    const submitted = await operations.submitPageApproval({
      requester: submitter,
      pageId: 42,
      sessionId: 'approval-session',
      expectedSourceRevision: '1'
    })
    await operations.transitionApproval({
      requester: reviewer,
      requestId: submitted.id,
      sessionId: 'reviewer-session',
      action: 'request-changes',
      comment: 'Update the page'
    })

    await expect(
      operations.transitionApproval({
        requester: user(7, ['read:pages']),
        requestId: submitted.id,
        sessionId: 'approval-session',
        action: 'resubmit',
        expectedSourceRevision: '1'
      })
    ).rejects.toMatchObject({ status: 403, name: 'APPROVAL_FORBIDDEN' })
    expect(await knex('pageHistory')).toHaveLength(1)
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id }).pluck('toStatus')).toEqual(['submitted', 'changes-requested'])

    await expect(
      operations.transitionApproval({
        requester: submitter,
        requestId: submitted.id,
        sessionId: 'approval-session',
        action: 'resubmit',
        expectedSourceRevision: '01'
      })
    ).rejects.toMatchObject({ status: 400, name: 'INVALID_INPUT' })

    await knex('pages').where({ id: 42 }).update({ sourceRevision: 2 })
    await expect(
      operations.transitionApproval({
        requester: submitter,
        requestId: submitted.id,
        sessionId: 'approval-session',
        action: 'resubmit',
        expectedSourceRevision: '1'
      })
    ).rejects.toMatchObject({ status: 409, name: 'APPROVAL_STALE' })
    expect(await knex('pageHistory')).toHaveLength(1)
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id }).pluck('toStatus')).toEqual(['submitted', 'changes-requested'])

    const resubmitted = await operations.transitionApproval({
      requester: submitter,
      requestId: submitted.id,
      sessionId: 'approval-session',
      action: 'resubmit',
      expectedSourceRevision: '2'
    })
    expect(resubmitted).toMatchObject({ status: 'submitted', revisionId: 2 })
    expect(await knex('pageHistory')).toHaveLength(2)
    expect(await knex('pageApprovalTransitions').where({ requestId: submitted.id }).pluck('toStatus')).toEqual(['submitted', 'changes-requested', 'submitted'])
  })

  it('commits one workflow and one event when submissions race', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const submissions = await Promise.allSettled([
      operations.submitPageApproval({
        requester: user(7, ['read:pages', 'write:pages']),
        pageId: 42,
        sessionId: 'approval-session',
        expectedSourceRevision: '1',
        assigneeId: 8
      }),
      operations.submitPageApproval({
        requester: user(7, ['read:pages', 'write:pages']),
        pageId: 42,
        sessionId: 'approval-session',
        expectedSourceRevision: '1',
        assigneeId: 8
      })
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
      sessionId: 'approval-session',
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
      sessionId: 'approval-session',
      assigneeId: 8
    })
    await operations.transitionApproval({
      requester: user(8, ['read:pages', 'manage:pages']),
      requestId: submitted.id,
      action: 'approve',
      sessionId: 'approval-session'
    })

    const successors = await Promise.allSettled([
      operations.transitionApproval({
        requester: user(8, ['read:pages', 'manage:pages']),
        requestId: submitted.id,
        action: 'publish',
        sessionId: 'approval-session'
      }),
      operations.transitionApproval({
        requester: user(7, ['read:pages', 'write:pages']),
        requestId: submitted.id,
        action: 'cancel',
        sessionId: 'approval-session'
      })
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
      sessionId: 'approval-session',
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    expect(await operations.listApprovalInbox(user(7, ['read:pages', 'write:pages']))).toMatchObject({ items: [expect.objectContaining({ canReview: false })] })
    expect(await operations.listApprovalInbox(user(8, ['read:pages', 'manage:pages']))).toMatchObject({ items: [expect.objectContaining({ canReview: true })] })
    expect(await operations.listApprovalInbox(user(9, ['read:pages', 'manage:pages']))).toEqual({ ownerId: 9, items: [], nextCursor: null })
  })

  it('prefilters inaccessible rows and keeps authorized ordering stable', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const requester = user(7, ['read:pages'])
    const siblingPage = {
      id: 43,
      title: 'Sibling review',
      updatedAt: new Date('2026-08-15T00:00:00.000Z'),
      isPublished: false,
      authorId: 7,
      sourceRevision: 1,
      content: '# Sibling review',
      localeCode: 'en',
      path: 'docs/sibling-review',
      visibility: 'public',
      ownerId: null
    }
    const inaccessiblePages = Array.from({ length: 101 }, (_, index) => ({
      id: 100 + index,
      title: `Private candidate ${index}`,
      updatedAt: new Date('2026-08-15T00:00:00.000Z'),
      isPublished: false,
      authorId: 9,
      sourceRevision: 1,
      content: `# Private candidate ${index}`,
      localeCode: 'en',
      path: `private/candidate-${index}`,
      visibility: 'private',
      ownerId: 9
    }))
    await insertFixtureRows('pages', [siblingPage, ...inaccessiblePages])

    const [revisionId] = await knex('pageHistory').insert({
      pageId: page.id,
      action: 'approval-inbox-test',
      sourceRevision: 1
    })
    const requestId = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
    const authorizedUpdatedAt = new Date('2026-08-16T00:00:00.000Z')
    const approval = (id: string, pageId: number, submitterId: number, assigneeId: number | null, updatedAt: Date) => ({
      id,
      pageId,
      submitterId,
      assigneeId,
      status: 'submitted',
      revisionId: Number(revisionId),
      revisionUpdatedAt: new Date('2026-08-15T00:00:00.000Z'),
      createdAt: updatedAt,
      updatedAt,
      closedAt: null
    })
    await knex('pageApprovalRequests').insert([
      approval(requestId(1), page.id, requester.id, null, authorizedUpdatedAt),
      approval(requestId(2), siblingPage.id, requester.id, null, new Date(authorizedUpdatedAt)),
      ...inaccessiblePages.map((candidate, index) => approval(requestId(1000 + index), candidate.id, 9, 9, new Date(Date.UTC(2026, 7, 17 + index))))
    ])

    const listed = await operations.listApprovalInbox(requester)
    expect(listed.items.map(item => item.id)).toEqual([requestId(2), requestId(1)])
    expect(listed.items.map(item => item.pageId)).toEqual([siblingPage.id, page.id])
    expect(listed.items).toEqual([
      expect.objectContaining({ id: requestId(2), title: siblingPage.title, visibility: 'public' }),
      expect.objectContaining({ id: requestId(1), title: page.title, visibility: 'public' })
    ])
  })

  it('bounds candidate work, batches page projections, and reaches older items through an owner-bound cursor', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const requester = user(7, ['read:pages'])
    const [revisionId] = await knex('pageHistory').insert({
      pageId: page.id,
      action: 'approval-inbox-bounded-test',
      sourceRevision: 1
    })
    const requestId = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
    const candidatePages = Array.from({ length: 500 }, (_, index) => ({
      id: 1_000 + index,
      title: `Private candidate ${index}`,
      updatedAt: new Date(Date.UTC(2026, 7, 20) - index * 1_000),
      isPublished: false,
      authorId: 9,
      sourceRevision: 1,
      content: `# Private candidate ${index}`,
      localeCode: 'en',
      path: `private/candidate-${index}`,
      visibility: 'private',
      ownerId: 7
    }))
    const targetPage = {
      id: 2_000,
      title: 'Older permitted review',
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      isPublished: false,
      authorId: 7,
      sourceRevision: 1,
      content: '# Older permitted review',
      localeCode: 'en',
      path: 'docs/older-permitted',
      visibility: 'public',
      ownerId: null
    }
    await insertFixtureRows('pages', [...candidatePages, targetPage])
    await insertFixtureRows('pageApprovalRequests', [
      ...candidatePages.map((candidate, index) => ({
        id: requestId(100_000 + index),
        pageId: candidate.id,
        submitterId: 9,
        assigneeId: null,
        status: 'submitted',
        revisionId: Number(revisionId),
        revisionUpdatedAt: candidate.updatedAt,
        createdAt: candidate.updatedAt,
        updatedAt: candidate.updatedAt,
        closedAt: null
      })),
      {
        id: requestId(900_000),
        pageId: targetPage.id,
        submitterId: 7,
        assigneeId: null,
        status: 'submitted',
        revisionId: Number(revisionId),
        revisionUpdatedAt: targetPage.updatedAt,
        createdAt: targetPage.updatedAt,
        updatedAt: targetPage.updatedAt,
        closedAt: null
      }
    ])

    const querySql: string[] = []
    knex.on('query', (query: { sql?: string }) => {
      if (typeof query.sql === 'string') querySql.push(query.sql)
    })
    const first = await operations.listApprovalInbox(requester)
    const cursor = first.nextCursor
    expect(first).toMatchObject({ ownerId: 7, items: [], nextCursor: expect.any(String) })
    expect(querySql.filter(sql => sql.includes('pageApprovalRequests'))).toHaveLength(5)
    expect(querySql.filter(sql => sql.includes('pageTags'))).toHaveLength(5)
    expect(querySql.filter(sql => sql.includes('select `pages`.`id`'))).toHaveLength(5)

    if (cursor === null) throw new Error('Expected bounded approval inbox to return a continuation cursor')
    requester.permissions = []
    await expect(operations.listApprovalInbox(requester, cursor)).resolves.toMatchObject({ ownerId: 7, items: [], nextCursor: null })
    requester.permissions = ['read:pages']
    await expect(operations.listApprovalInbox(user(8, ['read:pages']), cursor)).rejects.toMatchObject({
      status: 409,
      name: 'APPROVAL_CURSOR_EXPIRED'
    })
    const continued = await operations.listApprovalInbox(requester, cursor)
    expect(continued.items.map(item => item.id)).toEqual([requestId(900_000)])
    expect(continued.nextCursor).toBeNull()

    const now = Date.now()
    vi.setSystemTime(now + 5 * 60 * 1_000 + 1)
    try {
      await expect(operations.listApprovalInbox(requester, cursor)).rejects.toMatchObject({
        status: 409,
        name: 'APPROVAL_CURSOR_EXPIRED'
      })
    } finally {
      vi.setSystemTime(now)
    }
  })

  it('preserves tied key order and resumes after stopping inside a fetched batch', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const [revisionId] = await knex('pageHistory').insert({
      pageId: page.id,
      action: 'approval-inbox-tie-test',
      sourceRevision: 1
    })
    const requestId = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
    const sharedUpdatedAt = new Date('2026-08-20T00:00:00.000Z')
    const pages = Array.from({ length: 200 }, (_, index) => ({
      id: 3_000 + index,
      title: `Tie candidate ${index}`,
      updatedAt: sharedUpdatedAt,
      isPublished: false,
      authorId: index === 100 ? 9 : 7,
      sourceRevision: 1,
      content: `# Tie candidate ${index}`,
      localeCode: 'en',
      path: `docs/tie-${index}`,
      visibility: 'public',
      ownerId: null
    }))
    await insertFixtureRows('pages', pages)
    await insertFixtureRows(
      'pageApprovalRequests',
      pages.map((candidate, index) => ({
        id: requestId(index + 1),
        pageId: candidate.id,
        submitterId: index === 100 ? 9 : 7,
        assigneeId: null,
        status: 'submitted',
        revisionId: Number(revisionId),
        revisionUpdatedAt: sharedUpdatedAt,
        createdAt: sharedUpdatedAt,
        updatedAt: sharedUpdatedAt,
        closedAt: null
      }))
    )

    const first = await operations.listApprovalInbox(user(7, ['read:pages']))
    expect(first.items).toHaveLength(100)
    expect(first.items.at(-1)?.id).toBe(requestId(100))
    expect(first.nextCursor).toEqual(expect.any(String))
    const cursor = first.nextCursor
    if (cursor === null) throw new Error('Expected a cursor after the first tied approval window')
    const second = await operations.listApprovalInbox(user(7, ['read:pages']), cursor)
    expect(second.items.map(item => item.id)).toEqual(Array.from({ length: 99 }, (_, index) => requestId(99 - index)))
    expect(second.nextCursor).toBeNull()
  })

  it('keeps the remaining suffix when a short batch follows filtered rows', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const [revisionId] = await knex('pageHistory').insert({
      pageId: page.id,
      action: 'approval-inbox-short-suffix-test',
      sourceRevision: 1
    })
    const requestId = (suffix: number) => `40000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
    const updatedAt = new Date('2026-08-20T00:00:00.000Z')
    const pages = Array.from({ length: 102 }, (_, index) => {
      const suffix = index + 1
      return {
        id: 30_000 + index,
        title: `Short suffix ${suffix}`,
        updatedAt,
        isPublished: false,
        authorId: 7,
        sourceRevision: 1,
        content: '# Short suffix',
        localeCode: 'en',
        path: suffix === 3 ? '' : `docs/short-suffix-${suffix}`,
        visibility: 'public',
        ownerId: null
      }
    })
    await insertFixtureRows('pages', pages)
    await insertFixtureRows(
      'pageApprovalRequests',
      pages.map((candidate, index) => ({
        id: requestId(index + 1),
        pageId: candidate.id,
        submitterId: 7,
        assigneeId: null,
        status: 'submitted',
        revisionId: Number(revisionId),
        revisionUpdatedAt: updatedAt,
        createdAt: updatedAt,
        updatedAt,
        closedAt: null
      }))
    )

    const requester = user(7, ['read:pages'])
    const first = await operations.listApprovalInbox(requester)
    expect(first.items).toHaveLength(100)
    expect(first.items.map(item => item.id)).toEqual([...Array.from({ length: 99 }, (_, index) => requestId(102 - index)), requestId(2)])
    expect(first.nextCursor).toEqual(expect.any(String))
    if (first.nextCursor === null) throw new Error('Expected a cursor for the unprocessed short-batch suffix')

    const second = await operations.listApprovalInbox(requester, first.nextCursor)
    expect(second.items.map(item => item.id)).toEqual([requestId(1)])
    expect(second.nextCursor).toBeNull()
  })

  it('bounds approval cursors by owner, reuses equivalent boundaries, and preserves other owners', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const [revisionId] = await knex('pageHistory').insert({
      pageId: page.id,
      action: 'approval-cursor-quota-test',
      sourceRevision: 1
    })
    const requestId = (suffix: number) => `20000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
    const updatedAt = new Date('2026-08-20T00:00:00.000Z')
    const approvalPages = Array.from({ length: 501 }, (_, index) => ({
      id: 10_000 + index,
      title: `Cursor page ${index}`,
      updatedAt,
      isPublished: false,
      authorId: 7,
      sourceRevision: 1,
      content: '# Cursor page',
      localeCode: 'en',
      path: `docs/cursor-${index}`,
      visibility: 'public',
      ownerId: null
    }))
    await insertFixtureRows('pages', approvalPages)
    await insertFixtureRows(
      'pageApprovalRequests',
      approvalPages.map((approvalPage, index) => ({
        id: requestId(index + 1),
        pageId: approvalPage.id,
        submitterId: 7,
        assigneeId: null,
        status: 'submitted',
        revisionId: Number(revisionId),
        revisionUpdatedAt: updatedAt,
        createdAt: updatedAt,
        updatedAt,
        closedAt: null
      }))
    )

    const nextCursor = async (requester: TestUser, cursor?: string): Promise<string> => {
      const listed = await operations.listApprovalInbox(requester, cursor)
      expect(listed.items).toHaveLength(100)
      expect(listed.nextCursor).toEqual(expect.any(String))
      if (listed.nextCursor === null) throw new Error('Expected approval inbox continuation cursor')
      return listed.nextCursor
    }

    const initialNow = Date.now()
    vi.setSystemTime(initialNow)
    try {
      const ownerA = user(7, ['read:pages', 'manage:pages'])
      const ownerB = user(8, ['read:pages', 'manage:pages'])
      const bCursor = await nextCursor(ownerB)
      expect((await operations.listApprovalInbox(ownerB)).nextCursor).toBe(bCursor)

      const aFirst = await nextCursor(ownerA)
      expect((await operations.listApprovalInbox(ownerA)).nextCursor).toBe(aFirst)
      let aCursor = aFirst
      let aFourthInput: string | null = null
      for (let index = 0; index < 4; index += 1) {
        if (index === 3) aFourthInput = aCursor
        aCursor = await nextCursor(ownerA, aCursor)
      }
      if (aFourthInput === null) throw new Error('Expected fourth approval cursor boundary')
      expect((await operations.listApprovalInbox(ownerA, aFourthInput)).nextCursor).toBe(aCursor)

      await expect(operations.listApprovalInbox(ownerB, bCursor)).resolves.toMatchObject({ items: expect.any(Array) })
      vi.setSystemTime(initialNow + 5 * 60 * 1_000 - 1)
      expect((await operations.listApprovalInbox(ownerB)).nextCursor).toBe(bCursor)
      vi.setSystemTime(initialNow + 5 * 60 * 1_000 + 1)
      await expect(operations.listApprovalInbox(ownerB, bCursor)).rejects.toMatchObject({
        status: 409,
        name: 'APPROVAL_CURSOR_EXPIRED'
      })
    } finally {
      vi.setSystemTime(initialNow)
    }
  })

  it('prunes expired cursors, reclaims only the owner quota, and rejects unreclaimable global capacity', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const [revisionId] = await knex('pageHistory').insert({
      pageId: page.id,
      action: 'approval-cursor-capacity-test',
      sourceRevision: 1
    })
    const requestId = (suffix: number) => `30000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
    const updatedAt = new Date('2026-08-20T00:00:00.000Z')
    const approvalPages = Array.from({ length: 501 }, (_, index) => ({
      id: 20_000 + index,
      title: `Capacity page ${index}`,
      updatedAt,
      isPublished: false,
      authorId: 7,
      sourceRevision: 1,
      content: '# Capacity page',
      localeCode: 'en',
      path: `docs/capacity-${index}`,
      visibility: 'public',
      ownerId: null
    }))
    await insertFixtureRows('pages', approvalPages)
    await insertFixtureRows(
      'pageApprovalRequests',
      approvalPages.map((approvalPage, index) => ({
        id: requestId(index + 1),
        pageId: approvalPage.id,
        submitterId: 7,
        assigneeId: null,
        status: 'submitted',
        revisionId: Number(revisionId),
        revisionUpdatedAt: updatedAt,
        createdAt: updatedAt,
        updatedAt,
        closedAt: null
      }))
    )

    const nextCursor = async (requester: TestUser, cursor?: string): Promise<string> => {
      const listed = await operations.listApprovalInbox(requester, cursor)
      expect(listed.nextCursor).toEqual(expect.any(String))
      if (listed.nextCursor === null) throw new Error('Expected approval inbox continuation cursor')
      return listed.nextCursor
    }

    const initialNow = Date.now()
    vi.setSystemTime(initialNow)
    try {
      const owners = Array.from({ length: 32 }, (_, index) => user(1_000 + index, ['read:pages', 'manage:pages']))
      const ownerCursors = new Map<number, string>()
      for (const owner of owners) {
        let cursor = await nextCursor(owner)
        for (let count = 1; count < 4; count += 1) cursor = await nextCursor(owner, cursor)
        ownerCursors.set(owner.id, cursor)
      }

      const reclaimed = await nextCursor(owners[0], ownerCursors.get(owners[0].id))
      expect(reclaimed).toEqual(expect.any(String))
      await expect(operations.listApprovalInbox(user(2_000, ['read:pages']))).rejects.toMatchObject({
        status: 503,
        name: 'NOTIFICATION_CURSOR_CAPACITY'
      })

      vi.setSystemTime(initialNow + 5 * 60 * 1_000 + 1)
      await expect(operations.listApprovalInbox(user(2_001, ['read:pages']))).resolves.toMatchObject({
        nextCursor: expect.any(String)
      })
    } finally {
      vi.setSystemTime(initialNow)
    }
  })

  it('audits reassignment, administrator override, rejection, and cancellation', async () => {
    const operations = await vi.importFresh('../../operations/approvals.ts', import.meta.url)
    const first = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      sessionId: 'approval-session',
      expectedSourceRevision: '1',
      assigneeId: 8
    })
    const reassigned = await operations.transitionApproval({
      requester: user(9, ['read:pages', 'manage:system']),
      requestId: first.id,
      sessionId: 'approval-session',
      action: 'reassign',
      assigneeId: 9,
      comment: 'Administrator reassignment'
    })
    expect(reassigned).toMatchObject({ status: 'submitted', assigneeId: 9 })
    const rejected = await operations.transitionApproval({
      requester: user(9, ['read:pages', 'manage:system']),
      requestId: first.id,
      sessionId: 'approval-session',
      action: 'reject',
      comment: 'Does not meet publication policy'
    })
    expect(rejected).toMatchObject({ status: 'rejected', closedAt: expect.anything() })

    const second = await operations.submitPageApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      pageId: 42,
      sessionId: 'approval-session',
      expectedSourceRevision: '1'
    })
    const cancelled = await operations.transitionApproval({
      requester: user(7, ['read:pages', 'write:pages']),
      requestId: second.id,
      sessionId: 'approval-session',
      action: 'cancel',
      comment: 'Withdrawn'
    })
    expect(cancelled).toMatchObject({ status: 'cancelled', closedAt: expect.anything() })
    expect(await knex('pageApprovalTransitions').where({ requestId: first.id }).pluck('toStatus')).toEqual(['submitted', 'submitted', 'rejected'])
    expect(await knex('pageApprovalTransitions').where({ requestId: second.id }).pluck('toStatus')).toEqual(['submitted', 'cancelled'])
  })
})
