import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up } from '../../db/migrations/tsepistle-000073-page-feedback.ts'
import { up as addLifecycle } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as addDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addPageWatchers } from '../../db/migrations/2.5.132.ts'
import { up as addNotificationPreferences } from '../../db/migrations/tsepistle-000058-discussion-notifications.ts'
import { up as addMentionClaims } from '../../db/migrations/tsepistle-000033-comment-mentions.ts'
import { createPageFeedbackStore, type FeedbackDependencies, type PageFeedbackOperations } from '../../operations/page-feedback.ts'
import { createDiscussionPostingStore } from '../../operations/discussion-posting.ts'
import type { PageRuleAuthority } from '../../helpers/group-access.ts'
import type { PagePrincipal } from '../../helpers/page-access.ts'

const connection = getPostgresTestConnection('_page_feedback_test', import.meta.path)
const suite = connection ? describe : describe.skip
const author = { id: 7, authVersion: 0 } as Express.User
const moderator = { id: 8, authVersion: 0 } as Express.User
const reader = { id: 9, authVersion: 0 } as Express.User
const permissions = (user: unknown): string[] => user && typeof user === 'object' && Array.isArray(Reflect.get(user, 'permissions')) ? Reflect.get(user, 'permissions') : []
const contextFor = (requester: PagePrincipal, _tx: Knex.Transaction): Promise<PageRuleAuthority> => Promise.resolve({ requester, permissions: permissions(requester), groups: [], tagAliases: {} })

suite('native PostgreSQL feedback authority, admissions and atomic decisions', () => {
  let db: Knex, store: PageFeedbackOperations, second: PageFeedbackOperations
  let boardId: string, ideaId: string, now: Date, priorWiki: unknown
  let deniedRead: Set<string>, deniedManage: Set<string>
  const actor = (requester: Express.User = author) => ({ requester, sessionId: `feedback-session-${requester.id}` })
  const transition = (overrides: Record<string, unknown> = {}) => ({ ...actor(moderator), boardId, ideaId, requestId: randomUUID(), expectedBoardRevision: '1', expectedIdeaRevision: '1', expectedSourceRevision: '1', targetState: 'planned' as const, explanation: 'Reviewed under current board authority.', ...overrides })
  // Reset and drop every native child before its parent, including lifecycle comment event dedupe.
  const tables = ['pageWatchDeliveries', 'pageWatchNotifications', 'pageWatchers', 'userNotificationPreferences', 'userHandleClaims', 'durableJobs', 'pageLifecycleMoveProposals', 'pageLifecycleActionReceipts', 'pageLifecycleCycles', 'pageLifecycleNotices', 'pageLifecycleBatches', 'pageLifecycleRulePages', 'pageLifecyclePreviews', 'pageLifecycleRules', 'pageLifecycleCommentEvents', 'pageLifecycleClocks', 'feedbackWriteAdmissions', 'feedbackAdmissions', 'feedbackRequestReceipts', 'feedbackTransitions', 'feedbackSubscriptions', 'feedbackVotes', 'feedbackIdeas', 'feedbackCategories', 'feedbackBoards', 'outboxEvents', 'comments', 'pageDiscussionPolicy', 'pageUnlockGrants', 'pageAccessPasswords', 'pageTags', 'tags', 'pageHistory', 'pages', 'userGroups', 'groups', 'users', 'commentProviders', 'settings']
  beforeAll(async () => {
    priorWiki = globalThis.WIKI
    globalThis.WIKI = { auth: {
      checkAccess: (user: unknown, requested: string[]) => requested.some(permission => permissions(user).includes(permission)),
      checkPageAccess: (user: PagePrincipal, requested: string[], page: { path: string }, authority: PageRuleAuthority) => authority.requester === user &&
        !deniedRead.has(`${user?.id}:${page.path}`) && requested.some(permission => authority.permissions.includes(permission))
    } } as never
    db = createKnex({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 10 } })
    await db.schema.createTable('users', table => { table.integer('id').primary(); table.boolean('isActive').defaultTo(true); table.boolean('isSystem').defaultTo(false); table.integer('authVersion').defaultTo(0); table.string('name'); table.string('email') })
    await db.schema.createTable('groups', table => { table.integer('id').primary(); table.jsonb('permissions').notNullable() })
    await db.schema.createTable('userGroups', table => { table.integer('userId'); table.integer('groupId') })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary(); table.string('title'); table.string('path'); table.string('localeCode'); table.string('visibility'); table.integer('ownerId');
      table.bigInteger('sourceRevision').defaultTo(1); table.text('content').notNullable().defaultTo(''); table.string('contentType').notNullable().defaultTo('markdown'); table.boolean('isPublished').defaultTo(true); table.string('publishStartDate'); table.string('publishEndDate')
    })
    await db.schema.createTable('pageHistory', table => { table.integer('pageId').references('id').inTable('pages'); table.text('content') })
    await db.schema.createTable('tags', table => { table.integer('id').primary(); table.string('tag') })
    await db.schema.createTable('pageTags', table => { table.integer('pageId'); table.integer('tagId') })
    await db.schema.createTable('pageAccessPasswords', table => { table.integer('pageId').primary(); table.integer('version') })
    await db.schema.createTable('pageUnlockGrants', table => { table.string('id'); table.integer('pageId'); table.string('sessionId'); table.integer('userId'); table.integer('passwordVersion'); table.timestamp('expiresAt') })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value') })
    await db.schema.createTable('commentProviders', table => { table.string('key').primary(); table.boolean('isEnabled'); table.jsonb('config') })
    await db.schema.createTable('pageDiscussionPolicy', table => { table.integer('pageId').primary(); table.boolean('closed') })
    await db.schema.createTable('comments', table => {
      table.increments('id'); table.integer('pageId'); table.integer('authorId'); table.text('content'); table.text('render'); table.string('name'); table.string('email'); table.string('ip');
      table.integer('replyTo').defaultTo(0); table.boolean('isHidden').defaultTo(false); table.string('createdAt'); table.string('updatedAt')
    })
    await db.schema.createTable('outboxEvents', table => {
      table.uuid('id').primary(); table.string('type'); table.integer('version'); table.string('aggregateType'); table.string('aggregateId'); table.text('payload'); table.timestamp('createdAt'); table.timestamp('publishedAt').nullable()
    })
    await db('pages').insert({ id: 99, title: 'Existing canonical page', path: 'existing', localeCode: 'en', visibility: 'public', content: 'Canonical source survives.' })
    await db('pageHistory').insert({ pageId: 99, content: 'Historical source survives.' })
    await addDurableJobs(db)
    await addPageWatchers(db)
    await addNotificationPreferences(db)
    await addMentionClaims(db)
    await up(db)
    await addLifecycle(db)
    expect((await db('pages').where('id', 99).first()).content).toBe('Canonical source survives.')
    expect((await db('pageHistory').where('pageId', 99).first()).content).toBe('Historical source survives.')
    expect(await db('feedbackIdeas')).toHaveLength(0); expect(await db('feedbackBoards')).toHaveLength(0); expect(await db('feedbackVotes')).toHaveLength(0); expect(await db('feedbackSubscriptions')).toHaveLength(0)
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    now = new Date('2026-11-08T12:00:00.000Z'); deniedRead = new Set(); deniedManage = new Set()
    await db('users').insert([7, 8, 9].map(id => ({ id, name: `Human ${id}`, email: `human${id}@example.invalid` })))
    await db('groups').insert([
      { id: 3, permissions: JSON.stringify(['read:pages', 'write:pages', 'write:comments']) },
      { id: 4, permissions: JSON.stringify(['read:pages', 'manage:pages', 'write:comments']) }
    ])
    await db('userGroups').insert([{ userId: 7, groupId: 3 }, { userId: 8, groupId: 4 }, { userId: 9, groupId: 3 }])
    await db('pages').insert([
      { id: 1, title: 'Feedback anchor', path: 'feedback', localeCode: 'en', visibility: 'public' },
      { id: 2, title: 'A useful proposal', path: 'ideas/useful', localeCode: 'en', visibility: 'public' },
      { id: 3, title: 'A hidden useful proposal', path: 'ideas/hidden', localeCode: 'en', visibility: 'private', ownerId: 7 }
    ])
    await db('settings').insert({ key: 'features', value: JSON.stringify({ featurePageComments: true }) })
    await db('commentProviders').insert({ key: 'default', isEnabled: true, config: JSON.stringify({ minDelay: 0 }) })
    const posts = createDiscussionPostingStore({ db, fallbackFeatures: () => ({ featurePageComments: true }), loadPageRuleAuthority: contextFor,
      canPost: (_requester, _page, authority) => authority.permissions.includes('write:comments'), checkSpam: async () => {} })
    const deps: FeedbackDependencies = {
      db, secret: 'feedback-native-test-secret', now: () => now, loadAuthority: contextFor,
      checkManage: (requester, page, authority) => authority.permissions.includes('manage:pages') && !deniedManage.has(`${requester?.id}:${page.path}`),
      postComment: async (tx, input) => {
        return posts.postInTransaction(tx, {
          pageId: input.pageId, requester: input.requester, sessionId: input.sessionId, content: input.draft.content, render: '<p>A deliberate native comment</p>',
          replyTo: input.draft.replyTo, annotations: input.draft.annotations,
          user: { id: input.requester!.id, name: 'Moderator', email: 'human8@example.invalid', ip: '192.0.2.1' }
        }, { rootTransitionEventId: input.rootTransitionEventId })
      }
    }
    store = createPageFeedbackStore(deps); second = createPageFeedbackStore(deps)
    const board = await store.configureFeedbackBoard({ ...actor(moderator), boardPageId: 1, name: 'Explicit board', enabled: true })
    boardId = board.id
    ideaId = (await store.submitExistingFeedbackIdea({ ...actor(), boardId, pageId: 2, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true })).ideaId
  })
  afterAll(async () => {
    globalThis.WIKI = priorWiki as never
    if (db) { for (const table of tables) await db.schema.dropTableIfExists(table); await db.destroy() }
  })
  it('allows permitted guest discovery without mistaking the reserved guest identity for an enrolled human', async () => {
    for (const ownershipUserId of [undefined, null, 2]) {
      const guest = { id: 2, authVersion: 0, permissions: ['read:pages'], ...(ownershipUserId === undefined ? {} : { ownershipUserId }) } as Express.User
      const list = await store.listFeedbackIdeas({ ...actor(guest), boardId })
      expect(list.items.map(item => item.pageId)).toEqual([2]); expect(list.board.canSubmit).toBe(false)
      expect(list.items[0]!.canEditSource).toBe(false); expect(list.items[0]!.canModerate).toBe(false)
      // Bun's promise matchers need native promises; await Knex's transaction rollback before inspecting state.
      await expect(Promise.resolve(store.setFeedbackVote({ ...actor(guest), boardId, ideaId, voted: true, expectedIdeaRevision: '1' }))).rejects.toMatchObject({ status: 401 })
      await expect(Promise.resolve(store.setFeedbackSubscription({ ...actor(guest), boardId, ideaId, subscribed: true }))).rejects.toMatchObject({ status: 401 })
      expect(await db('feedbackVotes')).toHaveLength(0); expect(await db('feedbackSubscriptions')).toHaveLength(0)
    }
    deniedRead.add('2:feedback')
    const revoked = { id: 2, authVersion: 0, permissions: ['read:pages'], ownershipUserId: null } as Express.User
    await expect(Promise.resolve(store.suggestFeedbackDuplicates({ ...actor(revoked), boardId, q: '' }))).rejects.toMatchObject({ status: 404 })
  })
  it('never enrolls descendants or grants private read, and filters before totals, facets, suggestions and pagination', async () => {
    await store.submitExistingFeedbackIdea({ ...actor(), boardId, pageId: 3, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true })
    const list = await store.listFeedbackIdeas({ ...actor(reader), boardId, query: { limit: 1 } })
    expect(list.items.map(item => item.pageId)).toEqual([2]); expect(list.total).toBe(1); expect(list.permittedTotal).toBe(1); expect(list.nextCursor).toBeNull()
    expect(list.facets.statuses).toEqual({ proposed: 1 })
    expect((await store.suggestFeedbackDuplicates({ ...actor(reader), boardId, q: 'hidden' })).length).toBe(0)
    deniedRead.add('9:feedback')
    await expect(Promise.resolve(store.listFeedbackIdeas({ ...actor(reader), boardId }))).rejects.toMatchObject({ status: 404 })
    expect(await db('feedbackIdeas')).toHaveLength(2)
  })
  it('atomically commits native status/comment/root event/receipt, and duplicate independent-instance commands do not repost', async () => {
    const command = transition({ comment: { content: 'A deliberate native comment', replyTo: 0 } })
    const [first, duplicate] = await Promise.all([store.transitionFeedbackIdea(command), second.transitionFeedbackIdea(command)])
    expect(duplicate).toEqual(first)
    expect(await db('feedbackRequestReceipts')).toHaveLength(1)
    expect(await db('comments')).toHaveLength(1)
    expect(await db('feedbackTransitions').where('kind', 'status')).toHaveLength(1)
    expect(await db('outboxEvents').where('type', 'feedback.status-changed')).toHaveLength(1)
    const commentEvent = await db('outboxEvents').where('type', 'discussion.comment-created').first()
    expect(JSON.parse(commentEvent.payload).rootTransitionEventId).toBe(first.rootTransitionEventId)
    expect(await store.getFeedbackRequestReceipt({ ...actor(moderator), boardId, ideaId, requestId: command.requestId })).toEqual(first)
    expect(await store.getFeedbackRequestReceipt({ ...actor(), boardId, ideaId, requestId: command.requestId })).toBeNull()
  })
  it('atomically snapshots only admitted consented role/channel pairs, never ballots or later opt-ins', async () => {
    await db('userNotificationPreferences').insert([
      { userId: author.id, category: 'feedbackStatus', inAppEnabled: false, emailEnabled: true, updatedAt: now },
      { userId: reader.id, category: 'feedbackStatus', inAppEnabled: true, emailEnabled: false, updatedAt: now }
    ])
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    const first = await store.transitionFeedbackIdea(transition())
    const firstRoot = JSON.parse((await db('outboxEvents').where('id', first.rootTransitionEventId).first()).payload)
    expect(firstRoot.recipientChannels).toEqual([{ userId: author.id, inAppEnabled: false, emailEnabled: true }])
    await store.setFeedbackSubscription({ ...actor(reader), boardId, ideaId, subscribed: true })
    const second = await store.transitionFeedbackIdea(transition({ expectedIdeaRevision: first.ideaRevision, targetState: 'completed' }))
    const secondRoot = JSON.parse((await db('outboxEvents').where('id', second.rootTransitionEventId).first()).payload)
    expect(secondRoot.recipientChannels.sort((a: { userId: number }, b: { userId: number }) => a.userId - b.userId)).toEqual([
      { userId: author.id, inAppEnabled: false, emailEnabled: true },
      { userId: reader.id, inAppEnabled: true, emailEnabled: false }
    ])
    await db('userNotificationPreferences').where({ userId: reader.id, category: 'feedbackStatus' }).update({ emailEnabled: true, updatedAt: new Date(now.valueOf() + 1) })
    const retainedFirst = JSON.parse((await db('outboxEvents').where('id', first.rootTransitionEventId).first()).payload)
    const retainedSecond = JSON.parse((await db('outboxEvents').where('id', second.rootTransitionEventId).first()).payload)
    expect(retainedFirst.recipientChannels).toEqual(firstRoot.recipientChannels)
    expect(retainedSecond.recipientChannels.find((entry: { userId: number }) => entry.userId === reader.id).emailEnabled).toBe(false)
  })
  it('rolls back every status/comment/event/receipt effect when native discussion is closed', async () => {
    await db('pageDiscussionPolicy').insert({ pageId: 2, closed: true })
    await expect(Promise.resolve(store.transitionFeedbackIdea(transition({ comment: { content: 'A deliberate native comment', replyTo: 0 } })))).rejects.toMatchObject({ status: 409 })
    expect((await db('feedbackIdeas').where({ id: ideaId }).first()).state).toBe('proposed')
    expect(await db('comments')).toHaveLength(0); expect(await db('outboxEvents')).toHaveLength(0); expect(await db('feedbackRequestReceipts')).toHaveLength(0)
    expect(await db('feedbackTransitions').where('kind', 'status')).toHaveLength(0)
  })
  it('serializes conflicting status decisions and fences a source change without retry', async () => {
    const outcomes = await Promise.allSettled([store.transitionFeedbackIdea(transition()), second.transitionFeedbackIdea(transition({ targetState: 'completed' }))])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.status === 'rejected' ? outcome.reason.status : 0)).toEqual([409])
    const current = await db('feedbackIdeas').where({ id: ideaId }).first()
    const sourceEdit = await db.transaction()
    await sourceEdit('pages').where('id', 2).forUpdate().first()
    await sourceEdit('pages').where('id', 2).update({ sourceRevision: '2' })
    const stale = store.transitionFeedbackIdea(transition({ expectedIdeaRevision: String(current.ideaRevision), targetState: 'closed' }))
    await sourceEdit.commit()
    await expect(Promise.resolve(stale)).rejects.toMatchObject({ status: 409 })
    expect(await db('feedbackRequestReceipts')).toHaveLength(1)
  })
  it('holds the native page fence before board locks for competing status commands with lifecycle-aware comments', async () => {
    await db('userGroups').where('userId', reader.id).update({ groupId: 4 })
    const outcomes = await Promise.allSettled([
      store.transitionFeedbackIdea(transition({ comment: { content: 'First deliberate native comment', replyTo: 0 } })),
      second.transitionFeedbackIdea({ ...transition({ targetState: 'completed', comment: { content: 'Second deliberate native comment', replyTo: 0 } }), ...actor(reader) })
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.status === 'rejected' ? outcome.reason.status : 0)).toEqual([409])
    expect(await db('comments')).toHaveLength(1)
    expect(await db('outboxEvents').where('type', 'feedback.status-changed')).toHaveLength(1)
    expect(await db('feedbackRequestReceipts')).toHaveLength(1)
  })
  it('rolls back native comment and outbox insertion when durable receipt storage fails', async () => {
    await db.raw('ALTER TABLE "feedbackRequestReceipts" ADD CONSTRAINT feedback_test_receipt_failure CHECK (false)')
    try {
      await expect(Promise.resolve(store.transitionFeedbackIdea(transition({ comment: { content: 'A deliberate native comment', replyTo: 0 } })))).rejects.toThrow()
      expect((await db('feedbackIdeas').where({ id: ideaId }).first()).state).toBe('proposed')
      expect(await db('comments')).toHaveLength(0); expect(await db('outboxEvents')).toHaveLength(0)
      expect(await db('feedbackRequestReceipts')).toHaveLength(0); expect(await db('feedbackTransitions').where('kind', 'status')).toHaveLength(0)
    } finally {
      await db.raw('ALTER TABLE "feedbackRequestReceipts" DROP CONSTRAINT feedback_test_receipt_failure')
    }
  })
  it('retains one ballot across duplicate requests and closed-state retraction without making voting subscription', async () => {
    const vote = { ...actor(), boardId, ideaId, voted: true, expectedIdeaRevision: '1' }
    await Promise.all([store.setFeedbackVote(vote), second.setFeedbackVote(vote)])
    expect(await db('feedbackVotes').where({ voted: true })).toHaveLength(1); expect(await db('feedbackSubscriptions')).toHaveLength(0)
    const original = (await db('feedbackVotes').first()).activatedAt
    await store.setFeedbackVote(vote)
    expect((await db('feedbackVotes').first()).activatedAt).toEqual(original)
    const result = await store.transitionFeedbackIdea(transition({ targetState: 'closed' }))
    expect(await store.setFeedbackVote({ ...vote, expectedIdeaRevision: result.ideaRevision })).toMatchObject({ voted: true })
    await expect(Promise.resolve(store.setFeedbackVote({ ...vote, ...actor(reader), expectedIdeaRevision: result.ideaRevision }))).rejects.toMatchObject({ status: 409 })
    await store.setFeedbackVote({ ...vote, voted: false, expectedIdeaRevision: result.ideaRevision })
    expect(await db('feedbackVotes').where({ voted: true })).toHaveLength(0)
    expect(await db('feedbackSubscriptions')).toHaveLength(0)
  })
  it('serializes native concurrent new-vote/closed-status decisions without retaining an unauthorized late ballot', async () => {
    const outcomes = await Promise.allSettled([
      store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: '1' }),
      second.transitionFeedbackIdea(transition({ targetState: 'closed' }))
    ])
    expect(outcomes[1]!.status).toBe('fulfilled')
    if (outcomes[0]!.status === 'rejected') expect(outcomes[0]!.reason).toMatchObject({ status: 409 })
    expect((await db('feedbackIdeas').where({ id: ideaId }).first()).state).toBe('closed')
    expect(await db('feedbackVotes').where({ ideaId, userId: reader.id, voted: true })).toHaveLength(outcomes[0]!.status === 'fulfilled' ? 1 : 0)
  })
  it('uses current retained ballots for Top/Trending and preserves explicit completed/closed filters', async () => {
    await db('pages').insert([
      { id: 4, title: 'Completed proposal', path: 'ideas/completed', localeCode: 'en', visibility: 'public' },
      { id: 5, title: 'Closed proposal', path: 'ideas/closed', localeCode: 'en', visibility: 'public' }
    ])
    const completed = await store.submitExistingFeedbackIdea({ ...actor(), boardId, pageId: 4, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true })
    const closed = await store.submitExistingFeedbackIdea({ ...actor(), boardId, pageId: 5, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true })
    await store.transitionFeedbackIdea({ ...transition({ targetState: 'completed' }), ideaId: completed.ideaId })
    await store.transitionFeedbackIdea({ ...transition({ targetState: 'closed' }), ideaId: closed.ideaId })
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId: completed.ideaId, voted: true, expectedIdeaRevision: '2' })
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    await db('feedbackVotes').where({ ideaId }).update({ activatedAt: new Date(now.valueOf() - 8 * 86400000) })
    const top = await store.listFeedbackIdeas({ ...actor(reader), boardId })
    expect(top.items.map(item => item.pageId)).toEqual([2])
    const trending = await store.listFeedbackIdeas({ ...actor(reader), boardId, query: { sort: 'trending' } })
    expect(trending.items.map(item => item.pageId)).toEqual([4, 2])
    expect(trending.items.map(item => item.trendingCount)).toEqual([1, 0])
    const explicit = await store.listFeedbackIdeas({ ...actor(reader), boardId, query: { sort: 'top', statuses: ['closed', 'completed'] } })
    expect(explicit.items.map(item => item.pageId)).toEqual([4, 5])
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: false, expectedIdeaRevision: '1' })
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    const toggled = await store.listFeedbackIdeas({ ...actor(reader), boardId, query: { sort: 'trending' } })
    expect(toggled.items.find(item => item.id === ideaId)!.trendingCount).toBe(1)
    await db('users').where('id', reader.id).update({ isActive: false })
    const inactive = await store.listFeedbackIdeas({ ...actor(), boardId, query: { sort: 'trending' } })
    expect(inactive.items.every(item => item.voteCount === 0 && item.trendingCount === 0)).toBe(true)
  })
  it('fences current password, account and per-page authority revocation, including receipt inspection', async () => {
    const committed = await store.transitionFeedbackIdea(transition())
    await db('pageAccessPasswords').insert({ pageId: 2, version: 1 })
    await expect(Promise.resolve(store.getFeedbackRequestReceipt({ ...actor(moderator), boardId, ideaId, requestId: committed.requestId }))).rejects.toMatchObject({ status: 404 })
    expect((await store.listFeedbackIdeas({ ...actor(reader), boardId })).total).toBe(0)
    await db('pageUnlockGrants').insert({ id: randomUUID(), pageId: 2, sessionId: actor(moderator).sessionId, userId: moderator.id, passwordVersion: 1, expiresAt: new Date(now.valueOf() + 86400000) })
    expect(await store.getFeedbackRequestReceipt({ ...actor(moderator), boardId, ideaId, requestId: committed.requestId })).toEqual(committed)
    await db('users').where('id', moderator.id).update({ authVersion: 1 })
    await expect(Promise.resolve(store.getFeedbackRequestReceipt({ ...actor(moderator), boardId, ideaId, requestId: committed.requestId }))).rejects.toMatchObject({ status: 401 })
    expect(await db('feedbackRequestReceipts')).toHaveLength(1)
  })
  it('uses current recipient-owned unlock grants only for background delivery, never another session at inbox read', async () => {
    await store.setFeedbackSubscription({ ...actor(reader), boardId, ideaId, subscribed: true })
    const permitted = await db.transaction(tx => store.feedbackNotificationContext(tx, { ...actor(reader), boardId, ideaId }))
    expect(permitted).toMatchObject({ pageId: 2, title: 'A useful proposal', subscriberIds: [reader.id] })
    await db('pageAccessPasswords').insert([{ pageId: 1, version: 1 }, { pageId: 2, version: 1 }])
    await db('pageUnlockGrants').insert([1, 2].map(pageId => ({ id: randomUUID(), pageId, sessionId: 'another-session', userId: reader.id, passwordVersion: 1, expiresAt: new Date('2099-01-01T00:00:00.000Z') })))
    expect(await db.transaction(tx => store.feedbackNotificationContext(tx, { ...actor(reader), boardId, ideaId }))).toBeNull()
    expect(await db.transaction(tx => store.feedbackNotificationContext(tx, { requester: reader, sessionId: null, boardId, ideaId }))).toMatchObject({ pageId: 2 })
    await db('pageAccessPasswords').where('pageId', 1).update({ version: 2 })
    expect(await db.transaction(tx => store.feedbackNotificationContext(tx, { requester: reader, sessionId: null, boardId, ideaId }))).toBeNull()
  })
  it('deletes account-owned votes/subscriptions without transferring historical attribution', async () => {
    await store.setFeedbackVote({ ...actor(), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    await store.setFeedbackSubscription({ ...actor(), boardId, ideaId, subscribed: true })
    await db('users').where('id', author.id).delete()
    expect(await db('feedbackVotes')).toHaveLength(0); expect(await db('feedbackSubscriptions')).toHaveLength(0)
    expect((await db('feedbackIdeas').where({ id: ideaId }).first()).submittedBy).toBeNull()
    expect((await db('feedbackTransitions').where('kind', 'submitted').first()).actorId).toBeNull()
    expect(await db('pages')).toHaveLength(3)
  })
  it('moves explicit membership without resetting ballots or changing canonical tags/access, then deletes only confirmed metadata', async () => {
    await db('pages').insert({ id: 4, title: 'Destination anchor', path: 'destination', localeCode: 'en', visibility: 'public' })
    const destination = await store.configureFeedbackBoard({ ...actor(moderator), boardPageId: 4, name: 'Destination', enabled: true })
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    const moved = await store.moveFeedbackIdea({ ...actor(moderator), boardId, ideaId, destinationBoardId: destination.id, expectedBoardRevision: '1', expectedDestinationBoardRevision: '1', expectedIdeaRevision: '1', expectedSourceRevision: '1', explanation: 'Explicit transfer with retained votes.' })
    expect(moved.ideaId).toBe(ideaId); expect((await db('feedbackVotes').where({ ideaId }).first()).voted).toBe(true)
    expect((await db('pages').where('id', 2).first()).visibility).toBe('public')
    await expect(Promise.resolve(store.deleteFeedbackMetadata({ ...actor(moderator), boardId: destination.id, expectedBoardRevision: '1', confirmed: true }))).rejects.toMatchObject({ status: 409 })
    const disabled = await store.configureFeedbackBoard({ ...actor(moderator), boardId: destination.id, boardPageId: 4, name: 'Destination', enabled: false, expectedBoardRevision: '1' })
    now = new Date(now.valueOf() + 366 * 86400000)
    expect(await db('feedbackIdeas').where({ id: ideaId })).toHaveLength(1)
    await store.deleteFeedbackMetadata({ ...actor(moderator), boardId: destination.id, expectedBoardRevision: disabled.boardRevision, confirmed: true })
    expect(await db('feedbackIdeas').where({ id: ideaId })).toHaveLength(0)
    expect(await db('pages')).toHaveLength(4)
  })
  it('rejects committed submission/write overflow with retry information instead of partial success', async () => {
    await db('feedbackAdmissions').insert(Array.from({ length: 9 }, () => ({ id: randomUUID(), boardId, actorId: author.id, createdAt: now })))
    await db('pages').insert({ id: 4, title: 'Over the cap', path: 'over-cap', localeCode: 'en', visibility: 'public' })
    await expect(Promise.resolve(store.submitExistingFeedbackIdea({ ...actor(), boardId, pageId: 4, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true }))).rejects.toMatchObject({ status: 429, retryAfterMilliseconds: 86400000 })
    expect(await db('feedbackIdeas').where('pageId', 4)).toHaveLength(0)
    await db('feedbackWriteAdmissions').insert(Array.from({ length: 60 }, () => ({ id: randomUUID(), actorId: author.id, createdAt: now })))
    await expect(Promise.resolve(store.setFeedbackVote({ ...actor(), boardId, ideaId, voted: true, expectedIdeaRevision: '1' }))).rejects.toMatchObject({ status: 429, retryAfterMilliseconds: 60000 })
    expect(await db('feedbackVotes')).toHaveLength(0)
  })
  it('rejects membership and enabled-board overflow explicitly instead of returning a truncated total', async () => {
    const ids = Array.from({ length: 4999 }, (_, index) => index + 10)
    await db('pages').insert(ids.map(id => ({ id, title: `Proposal ${id}`, path: `ideas/${id}`, localeCode: 'en', visibility: 'public' })))
    await db('feedbackIdeas').insert(ids.map(pageId => ({ id: randomUUID(), boardId, pageId, state: 'proposed', submittedAt: now })))
    await db('pages').insert({ id: 6000, title: 'Overflow', path: 'ideas/overflow', localeCode: 'en', visibility: 'public' })
    await expect(Promise.resolve(store.submitExistingFeedbackIdea({ ...actor(), boardId, pageId: 6000, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true }))).rejects.toMatchObject({ status: 409, name: 'FEEDBACK_BOARD_FULL' })
    expect(await db('feedbackIdeas').where('pageId', 6000)).toHaveLength(0)
    await db('feedbackIdeas').insert({ id: randomUUID(), boardId, pageId: 6000, state: 'proposed', submittedAt: now })
    await expect(Promise.resolve(store.listFeedbackIdeas({ ...actor(reader), boardId }))).rejects.toMatchObject({ status: 409 })
    const anchors = Array.from({ length: 100 }, (_, index) => index + 10000)
    await db('pages').insert(anchors.map(id => ({ id, title: `Anchor ${id}`, path: `boards/${id}`, localeCode: 'en', visibility: 'public' })))
    await db('feedbackBoards').insert(anchors.slice(0, 99).map(boardPageId => ({ id: randomUUID(), boardPageId, name: `Board ${boardPageId}`, enabled: true })))
    await expect(Promise.resolve(store.configureFeedbackBoard({ ...actor(moderator), boardPageId: anchors[99]!, name: 'One too many', enabled: true }))).rejects.toMatchObject({ status: 409 })
    expect(await db('feedbackBoards').where('boardPageId', anchors[99]!)).toHaveLength(0)
  })
  it('requires page management on BOTH contexts and does not rewrite canonical source/tags during categorization', async () => {
    deniedManage.add('8:ideas/useful')
    await expect(Promise.resolve(store.transitionFeedbackIdea(transition()))).rejects.toMatchObject({ status: 403 })
    deniedManage.clear()
    await db('tags').insert({ id: 1, tag: 'unrelated' }); await db('pageTags').insert({ pageId: 2, tagId: 1 })
    const category = await store.configureFeedbackCategory({ ...actor(moderator), boardId, label: 'Roadmap', active: true, displayOrder: 0, expectedBoardRevision: '1' })
    await store.setFeedbackCategory({ ...actor(moderator), boardId, ideaId, categoryId: category.categoryId, expectedBoardRevision: category.boardRevision, expectedIdeaRevision: '1', expectedSourceRevision: '1' })
    expect(await db('pageTags')).toEqual([{ pageId: 2, tagId: 1 }]); expect(String((await db('pages').where('id', 2).first()).sourceRevision)).toBe('1')
    const retired = await store.configureFeedbackCategory({ ...actor(moderator), boardId, categoryId: category.categoryId, label: 'Roadmap', active: false, displayOrder: 0, expectedBoardRevision: category.boardRevision })
    expect(retired.boardRevision).toBe('3')
    const regular = await store.listFeedbackIdeas({ ...actor(reader), boardId }); expect(regular.items[0]!.categoryId).toBeNull(); expect(regular.items[0]!.categoryLabel).toBeNull()
    const triage = await store.getFeedbackIdea({ ...actor(moderator), boardId, ideaId }); expect(triage.idea.categoryLabel).toBe('Removed category: Roadmap')
  })
  it('keeps author withdrawal separate from native source-write rights and forbids undoing moderator withdrawal', async () => {
    const completed = await store.transitionFeedbackIdea(transition({ targetState: 'completed' }))
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['read:pages']) })
    const withdrawn = await store.transitionFeedbackIdea({ ...transition({ targetState: 'withdrawn', expectedIdeaRevision: completed.ideaRevision }), ...actor() })
    expect((await db('feedbackIdeas').where({ id: ideaId }).first()).previousState).toBe('completed')
    const restored = await store.transitionFeedbackIdea({ ...transition({ targetState: 'proposed', expectedIdeaRevision: withdrawn.ideaRevision }), ...actor() })
    expect(restored.state).toBe('proposed')
    expect((await store.getFeedbackIdea({ ...actor(), boardId, ideaId })).idea.canEditSource).toBe(false)
    const moderated = await store.transitionFeedbackIdea(transition({ targetState: 'withdrawn', expectedIdeaRevision: restored.ideaRevision }))
    await expect(Promise.resolve(store.transitionFeedbackIdea({ ...transition({ targetState: 'proposed', expectedIdeaRevision: moderated.ideaRevision }), ...actor() }))).rejects.toMatchObject({ status: 403 })
    expect(String((await db('pages').where('id', 2).first()).sourceRevision)).toBe('1')
  })
  it('retains withdrawn membership/votes/audit beyond 365 days and allows only current moderator restoration after day 30', async () => {
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    const withdrawn = await store.transitionFeedbackIdea({ ...transition(), ...actor(), targetState: 'withdrawn' })
    expect((await store.listFeedbackIdeas({ ...actor(reader), boardId })).items).toEqual([])
    now = new Date(now.valueOf() + 366 * 86400000)
    await expect(Promise.resolve(store.transitionFeedbackIdea({ ...transition(), ...actor(), expectedIdeaRevision: withdrawn.ideaRevision, targetState: 'proposed' }))).rejects.toMatchObject({ status: 403 })
    expect(await db('feedbackVotes')).toHaveLength(1); expect(await db('feedbackIdeas')).toHaveLength(1)
    const restored = await store.transitionFeedbackIdea(transition({ expectedIdeaRevision: withdrawn.ideaRevision, targetState: 'proposed' }))
    expect(restored.state).toBe('proposed'); expect(await db('feedbackTransitions').where('kind', 'status')).toHaveLength(2)
    expect(await db('pages')).toHaveLength(3)
  })
  it('retains board-only history and ballots when native canonical rows disappear, without exposing missing-page metadata', async () => {
    const result = await store.transitionFeedbackIdea(transition())
    await store.setFeedbackVote({ ...actor(reader), boardId, ideaId, voted: true, expectedIdeaRevision: result.ideaRevision })
    await store.setFeedbackSubscription({ ...actor(reader), boardId, ideaId, subscribed: true })
    await db('pages').where('id', 2).delete()
    expect(await db('feedbackIdeas')).toHaveLength(1); expect(await db('feedbackVotes')).toHaveLength(1)
    expect(await db('feedbackSubscriptions')).toHaveLength(1); expect(await db('feedbackRequestReceipts')).toHaveLength(1)
    expect((await store.listFeedbackIdeas({ ...actor(reader), boardId })).items).toEqual([])
    expect(await db.transaction(tx => store.feedbackNotificationContext(tx, { requester: reader, sessionId: null, boardId, ideaId }))).toBeNull()
    await db('pages').where('id', 1).delete()
    await expect(Promise.resolve(store.listFeedbackIdeas({ ...actor(reader), boardId }))).rejects.toMatchObject({ status: 404 })
    expect(await db('feedbackBoards')).toHaveLength(1); expect(await db('feedbackTransitions').where('kind', 'status')).toHaveLength(1)
  })
  it('invalidates cursor continuation after current authority/score changes and rejects wrong requester reuse', async () => {
    await db('pages').insert({ id: 4, title: 'Another permitted proposal', path: 'ideas/another', localeCode: 'en', visibility: 'public' })
    await store.submitExistingFeedbackIdea({ ...actor(), boardId, pageId: 4, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true })
    const first = await store.listFeedbackIdeas({ ...actor(reader), boardId, query: { limit: 1 } })
    expect(first.nextCursor).not.toBeNull()
    await expect(Promise.resolve(store.listFeedbackIdeas({ ...actor(), boardId, query: { limit: 1, cursor: first.nextCursor } }))).rejects.toMatchObject({ status: 409 })
    await store.setFeedbackVote({ ...actor(), boardId, ideaId, voted: true, expectedIdeaRevision: '1' })
    await expect(Promise.resolve(store.listFeedbackIdeas({ ...actor(reader), boardId, query: { limit: 1, cursor: first.nextCursor } }))).rejects.toMatchObject({ status: 409 })
  })
  it('prelocks actor authority without holding native page fences, then rejects revoked post-create admission atomically', async () => {
    const creation = await db.transaction()
    try {
      await store.prepareFeedbackSubmission(creation, { ...actor(), boardId, expectedBoardRevision: '1', acknowledged: true })
      // A different moderator can change the anchor/board while native creation is in progress.
      await store.configureFeedbackBoard({ ...actor(moderator), boardId, boardPageId: 1, name: 'Explicit board', enabled: false, expectedBoardRevision: '1' })
      await creation('pages').insert({ id: 4, title: 'Revoked submission', path: 'new-page', localeCode: 'en', visibility: 'public' })
      await expect(store.admitCreatedFeedbackIdea(creation, { ...actor(), boardId, pageId: 4, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true })).rejects.toMatchObject({ status: 404 })
    } finally {
      await creation.rollback()
    }
    expect(await db('pages').where('id', 4)).toHaveLength(0)
    expect(await db('feedbackIdeas').where('pageId', 4)).toHaveLength(0)
  })
  it('rolls back canonical-transaction insertion on failed attachment without altering pre-existing pages', async () => {
    await expect(Promise.resolve(db.transaction(async tx => {
      await tx('pages').insert({ id: 4, title: 'Must roll back', path: 'new-page', localeCode: 'en', visibility: 'public' })
      await store.admitCreatedFeedbackIdea(tx, { ...actor(), boardId, pageId: 4, expectedBoardRevision: '999', expectedSourceRevision: '1', acknowledged: true })
    }))).rejects.toMatchObject({ status: 409 })
    expect(await db('pages').where('id', 4)).toHaveLength(0)
    expect((await db('pages').where('id', 2).first()).title).toBe('A useful proposal')
    expect(await db('feedbackIdeas')).toHaveLength(1)
  })
})
