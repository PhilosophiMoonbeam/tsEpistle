import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { DurableJob } from '../../core/durable-jobs.ts'
import { createPageWatchNotificationHandler, type PageWatchWikiContext } from '../../jobs/page-watch-notification.ts'
import { up as upNotificationPreferences } from '../../db/migrations/tsepistle-000058-discussion-notifications.ts'
import { up as upDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'

let knex: Knex
const send = vi.fn()
let user: {
  id: number
  email: string
  isActive: boolean
  groups: Array<{ id: number; permissions: string[] }>
  permissions: string[]
  getGlobalPermissions: () => string[]
}
const page = {
  id: 42,
  title: 'Getting Started',
  visibility: 'public',
  ownerId: null,
  path: 'docs/start',
  localeCode: 'en',
  tags: [],
  isPublished: true,
  publishStartDate: null,
  publishEndDate: null
}

beforeEach(async () => {
  user = {
    id: 7,
    email: 'reader@example.test',
    isActive: true,
    groups: [{ id: 3, permissions: ['read:pages'] }],
    permissions: ['read:pages'],
    getGlobalPermissions() {
      return ['read:pages']
    }
  }
  send.mockReset()
  Reflect.set(global, 'WIKI', {
    auth: {
      checkAccess: vi.fn((principal: Express.User | undefined, requested: readonly string[]) => {
        const permissions = principal && Reflect.get(principal, 'permissions')
        return Array.isArray(permissions) && requested.some(permission => permissions.includes(permission))
      }),
      checkPageAccess: vi.fn(
        (principal: Express.User | undefined, requested: readonly string[], _context: unknown, authority: { permissions: readonly string[] }) => {
          const permissions = principal && Reflect.get(principal, 'permissions')
          return Array.isArray(permissions) && requested.some(permission => permissions.includes(permission) && authority.permissions.includes(permission))
        }
      )
    }
  })
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await knex.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable().defaultTo(true)
    table.boolean('isSystem').notNullable().defaultTo(false)
    table.string('email').notNullable()
  })
  await knex('users').insert([
    { id: 7, email: user.email },
    { id: 8, email: 'author@example.test' }
  ])
  await knex.schema.createTable('outboxEvents', table => {
    table.string('id').primary()
    table.string('type').notNullable()
    table.text('payload').notNullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
  })
  await knex.schema.createTable('pageWatchers', table => {
    table.integer('pageId').notNullable()
    table.integer('userId').notNullable()
    table.boolean('emailEnabled').notNullable().defaultTo(true)
    table.boolean('inAppEnabled').notNullable().defaultTo(true)
    table.primary(['pageId', 'userId'])
  })
  await knex.schema.createTable('pageWatchDeliveries', table => {
    table.string('id').primary()
    table.string('eventId').notNullable()
    table.integer('userId').notNullable()
    table.string('jobId').nullable()
    table.dateTime('createdAt').nullable()
    table.dateTime('deliveredAt').nullable()
    table.text('lastError').nullable()
  })
  await knex.schema.createTable('pageWatchNotifications', table => {
    table.string('id').primary()
    table.string('eventId').notNullable()
    table.integer('userId').notNullable()
    table.integer('pageId').notNullable()
    table.string('eventType').notNullable()
    table.string('actorName').notNullable()
    table.string('title').notNullable()
    table.string('path').notNullable()
    table.string('localeCode').notNullable()
    table.string('visibility').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('readAt').nullable()
    table.unique(['eventId', 'userId'])
  })
  await upNotificationPreferences(knex)
  await knex.schema.createTable('comments', table => {
    table.integer('id').primary()
    table.integer('pageId').notNullable()
    table.integer('authorId').notNullable()
    table.integer('replyTo').notNullable().defaultTo(0)
    table.string('name').notNullable()
    table.text('content').notNullable()
    table.boolean('isHidden').notNullable().defaultTo(false)
  })
  await knex.schema.createTable('userHandleClaims', table => {
    table.integer('userId').notNullable()
    table.string('handle').primary()
  })
  await knex.schema.createTable('settings', table => {
    table.string('key').primary()
    table.text('value').notNullable()
  })
  await knex('settings').insert({ key: 'features', value: JSON.stringify({ featurePageComments: true }) })
  await knex.schema.createTable('commentProviders', table => {
    table.string('key').primary()
    table.boolean('isEnabled').notNullable()
  })
  await knex('commentProviders').insert({ key: 'default', isEnabled: true })
  await knex.schema.createTable('pageAccessPasswords', table => {
    table.integer('pageId').primary()
    table.integer('version').notNullable()
  })
  await knex.schema.createTable('pageUnlockGrants', table => {
    table.integer('pageId').notNullable()
    table.integer('userId').notNullable()
    table.string('sessionId').notNullable()
    table.integer('passwordVersion').notNullable()
    table.dateTime('expiresAt').notNullable()
  })
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('title').notNullable()
    table.string('path').notNullable()
    table.string('localeCode').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable().defaultTo(true)
    table.dateTime('publishStartDate').nullable()
    table.dateTime('publishEndDate').nullable()
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
    table.integer('id').primary()
    table.string('title').notNullable()
  })
  await knex.schema.createTable('deletedPageRecovery', table => {
    table.integer('pageId').primary()
    table.integer('deletionVersionId').notNullable()
    table.text('securityContext').notNullable()
  })
  await knex('pageWatchers').insert({ pageId: 42, userId: 7 })
  await knex('outboxEvents').insert({
    id: 'event-1',
    type: 'page.updated',
    payload: JSON.stringify({
      pageId: 42,
      actorId: 9,
      actorName: 'Editor',
      title: 'Getting Started',
      ownerId: null,
      tags: [],
      path: 'docs/start',
      localeCode: 'en',
      visibility: 'public'
    })
  })
  await knex('pageWatchDeliveries').insert({ id: 'delivery-1', eventId: 'event-1', userId: 7, deliveredAt: null, lastError: null })
})

afterEach(async () => {
  await knex.destroy()
  vi.restoreAllMocks()
})

const job: DurableJob = {
  id: 'job-1',
  type: 'notify-page-watcher',
  version: 1,
  payload: { deliveryId: 'delivery-1', eventId: 'event-1', userId: 7, emailEnabled: true, inAppEnabled: true },
  state: 'running',
  attempts: 1,
  maxAttempts: 5,
  nextRunAt: new Date(),
  leaseOwner: 'test-worker',
  leaseExpiresAt: new Date(),
  lastError: null,
  deduplicationKey: 'page-watch:7:event-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null
}

const wiki = (pageResult: Record<string, unknown> | undefined): PageWatchWikiContext => ({
  config: { host: 'https://wiki.example.test/' },
  mail: { send },
  auth: {
    loadPageRuleAuthority: vi.fn(async requester => ({
      requester,
      permissions: requester?.permissions ?? [],
      groups: [],
      tagAliases: {}
    }))
  },
  models: {
    pages: { getPageFromDb: vi.fn().mockResolvedValue(pageResult) },
    users: {
      query: () => ({
        findById: () => ({
          withGraphJoined: () => ({
            modifyGraph: async () => user
          })
        })
      }),
      getRootUser: vi.fn()
    }
  }
})

const discussionJob = (): DurableJob => ({ ...job, payload: { ...job.payload, category: 'mention', commentId: 202 } })
const seedDiscussion = async (): Promise<void> => {
  user.getGlobalPermissions = () => ['read:pages', 'read:comments']
  await knex('comments').insert([
    { id: 201, pageId: 42, authorId: 7, name: 'Reader', content: 'Root contribution', replyTo: 0 },
    { id: 202, pageId: 42, authorId: 8, name: 'Author', content: '@reader confidential comment body', replyTo: 201 }
  ])
  await knex('userHandleClaims').insert({ userId: 7, handle: 'reader' })
  await knex('userNotificationPreferences').insert({ userId: 7, category: 'mention', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() })
  await knex('outboxEvents')
    .where('id', 'event-1')
    .update({ type: 'discussion.comment-created', payload: JSON.stringify({ pageId: 42, commentId: 202, actorId: 8 }) })
}

const seedDeletion = async (protection: unknown = null): Promise<void> => {
  await knex('userNotificationPreferences').insert({ userId: 7, category: 'pageDeleted', inAppEnabled: true, emailEnabled: false, updatedAt: new Date() })
  await knex('pageHistory').insert({ id: 501, title: 'Getting Started' })
  await knex('deletedPageRecovery').insert({
    pageId: 42,
    deletionVersionId: 501,
    securityContext: JSON.stringify({
      version: 1,
      former: { path: page.path, localeCode: page.localeCode, visibility: page.visibility, ownerId: page.ownerId, tags: [] },
      protection
    })
  })
  const event = await knex('outboxEvents').where('id', 'event-1').first()
  await knex('outboxEvents').where('id', 'event-1').update({ type: 'page.deleted', payload: event.payload })
}
const deletionJob = (): DurableJob => ({ ...job, payload: { ...job.payload, category: 'pageDeleted', commentId: null, emailEnabled: false } })

describe('page watch notification handler', () => {
  it.each([
    ['mention', 'mention'],
    ['commentReply', 'comment-reply'],
    ['watchedPageComment', 'watched-comment']
  ] as const)('delivers one owned %s by current category priority with a real destination and no retained or emailed excerpt', async (category, action) => {
    await seedDiscussion()
    await knex('userNotificationPreferences').insert([
      { userId: 7, category: 'commentReply', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() },
      { userId: 7, category: 'watchedPageComment', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() }
    ])
    if (category !== 'mention')
      await knex('userNotificationPreferences').where({ userId: 7, category: 'mention' }).update({ inAppEnabled: false, emailEnabled: false })
    if (category === 'watchedPageComment')
      await knex('userNotificationPreferences').where({ userId: 7, category: 'commentReply' }).update({ inAppEnabled: false, emailEnabled: false })
    const handler = createPageWatchNotificationHandler(wiki({ ...page, isPublished: true }))
    await handler(discussionJob(), { knex, signal: new AbortController().signal })
    await handler(discussionJob(), { knex, signal: new AbortController().signal })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ data: { action, url: 'https://wiki.example.test/en/docs/start#comment-post-id-202' } })
    const inbox = await knex('pageWatchNotifications')
    expect(inbox).toEqual([expect.objectContaining({ userId: 7, category, commentId: 202, readAt: null })])
    expect(JSON.stringify(inbox)).not.toContain('confidential comment body')
    expect(JSON.stringify(send.mock.calls)).not.toContain('confidential comment body')
  })

  it('reauthorizes a pending recipient preference before either channel dispatches', async () => {
    await seedDiscussion()
    await knex('userNotificationPreferences').where({ userId: 7, category: 'mention' }).update({ inAppEnabled: false, emailEnabled: false })
    await createPageWatchNotificationHandler(wiki({ ...page, isPublished: true }))(discussionJob(), { knex, signal: new AbortController().signal })
    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchDeliveries').where('id', 'delivery-1').first()).toMatchObject({ deliveredAt: expect.anything() })
  })

  it.each(['hidden', 'revoked', 'protected', 'provider', 'paused', 'future', 'expired'] as const)(
    'withholds discussion delivery after %s access changes',
    async change => {
      await seedDiscussion()
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-15T12:00:00.000Z'))
      if (change === 'hidden') await knex('comments').where('id', 202).update({ isHidden: true })
      if (change === 'revoked') user.getGlobalPermissions = () => ['read:pages']
      if (change === 'protected') await knex('pageAccessPasswords').insert({ pageId: 42, version: 1 })
      if (change === 'provider') await knex('commentProviders').where('key', 'default').update({ isEnabled: false })
      if (change === 'paused')
        await knex('settings')
          .where('key', 'features')
          .update({ value: JSON.stringify({ featurePageComments: false }) })
      await createPageWatchNotificationHandler(
        wiki({
          ...page,
          publishStartDate: change === 'future' ? '2026-06-16T12:00:00.000Z' : null,
          publishEndDate: change === 'expired' ? '2026-06-14T12:00:00.000Z' : null
        })
      )(discussionJob(), { knex, signal: new AbortController().signal })
      expect(send).not.toHaveBeenCalled()
      expect(await knex('pageWatchNotifications')).toEqual([])
      expect(await knex('pageWatchDeliveries').where('id', 'delivery-1').first()).toMatchObject({ deliveredAt: expect.anything() })
    }
  )

  it.each(['future', 'expired'] as const)('withholds global page creation delivery outside its %s publication window', async boundary => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-15T12:00:00.000Z'))
    await knex('userNotificationPreferences').insert({ userId: 7, category: 'pageCreated', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() })
    await knex('outboxEvents').where('id', 'event-1').update({ type: 'page.created' })
    await createPageWatchNotificationHandler(
      wiki({
        ...page,
        publishStartDate: boundary === 'future' ? '2026-06-16T12:00:00.000Z' : null,
        publishEndDate: boundary === 'expired' ? '2026-06-14T12:00:00.000Z' : null
      })
    )({ ...job, payload: { ...job.payload, category: 'pageCreated', commentId: null } }, { knex, signal: new AbortController().signal })
    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchDeliveries').where('id', 'delivery-1').first()).toMatchObject({ deliveredAt: expect.anything() })
  })

  it('delivers opted-in deletion metadata against current location authority without requiring a deleted page row', async () => {
    await seedDeletion()
    await createPageWatchNotificationHandler(wiki(undefined))(deletionJob(), { knex, signal: new AbortController().signal })
    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications')).toEqual([
      expect.objectContaining({ userId: 7, category: 'pageDeleted', commentId: null, title: 'Getting Started' })
    ])
  })

  it.each(['deleted-protected', 'replacement-protected', 'replacement-denied', 'replacement-readable', 'replacement-future', 'replacement-expired'] as const)(
    'reauthorizes %s deletion scope without stale title delivery',
    async change => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-15T12:00:00.000Z'))
      await seedDeletion(change === 'deleted-protected' ? { passwordHash: 'redacted', version: 1, updatedBy: 8, updatedAt: new Date().toISOString() } : null)
      if (change !== 'deleted-protected') {
        await knex('pages').insert({
          id: 99,
          title: 'Replacement title',
          path: page.path,
          localeCode: page.localeCode,
          visibility: 'public',
          ownerId: null,
          isPublished: true,
          publishStartDate: change === 'replacement-future' ? '2026-06-16T12:00:00.000Z' : null,
          publishEndDate: change === 'replacement-expired' ? '2026-06-14T12:00:00.000Z' : null
        })
        if (change === 'replacement-protected') await knex('pageAccessPasswords').insert({ pageId: 99, version: 1 })
        if (change === 'replacement-denied') {
          await knex('tags').insert({ id: 1, tag: 'restricted' })
          await knex('pageTags').insert({ pageId: 99, tagId: 1 })
          const runtime = WIKI as unknown as { auth: { checkPageAccess: unknown } }
          runtime.auth.checkPageAccess = vi.fn(
            (_requester: unknown, _permissions: unknown, context: { tags: Array<{ tag: string }> }) => !context.tags.some(tag => tag.tag === 'restricted')
          )
        }
      }
      await createPageWatchNotificationHandler(wiki(undefined))(deletionJob(), { knex, signal: new AbortController().signal })
      expect(send).not.toHaveBeenCalled()
      const inbox = await knex('pageWatchNotifications')
      if (change === 'replacement-readable')
        expect(inbox).toEqual([expect.objectContaining({ userId: 7, category: 'pageDeleted', title: 'Replacement title' })])
      else expect(inbox).toEqual([])
    }
  )

  it('fans out discussion jobs only to current page watchers or visible participants, never a global mention directory', async () => {
    await upDurableJobs(knex)
    await addDurableJobLeaseToken(knex)
    await seedDiscussion()
    await knex('users').insert([20, 21, 22, 23, 24].map(id => ({ id, email: `reader-${id}@example.test` })))
    await knex('pageWatchers').insert({ pageId: 42, userId: 20 })
    await knex('comments').insert([
      { id: 203, pageId: 42, authorId: 21, name: 'Participant', content: 'Visible contribution', isHidden: false },
      { id: 204, pageId: 42, authorId: 23, name: 'Hidden participant', content: 'Hidden contribution', isHidden: true },
      { id: 205, pageId: 43, authorId: 24, name: 'Other page participant', content: 'Unrelated contribution', isHidden: false }
    ])
    await knex('userHandleClaims').insert([
      { userId: 21, handle: 'participant' },
      { userId: 22, handle: 'outsider' },
      { userId: 23, handle: 'hidden' },
      { userId: 24, handle: 'other-page' }
    ])
    await knex('comments').where('id', 202).update({ content: '@reader @participant @outsider @hidden @other-page confidential comment body' })
    await knex('userNotificationPreferences').insert([
      { userId: 7, category: 'commentReply', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() },
      { userId: 7, category: 'watchedPageComment', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() },
      { userId: 20, category: 'watchedPageComment', inAppEnabled: true, emailEnabled: false, updatedAt: new Date() },
      ...[21, 22, 23, 24].map(userId => ({ userId, category: 'mention', inAppEnabled: true, emailEnabled: false, updatedAt: new Date() }))
    ])
    const audienceJob = {
      ...job,
      payload: { mode: 'audience', eventId: 'event-1', afterUserId: 0, audienceAt: '2026-06-15T12:00:00.000Z' }
    }
    await createPageWatchNotificationHandler(wiki(page))(audienceJob, { knex, signal: new AbortController().signal })
    const jobs = await knex<{ payload: string }>('durableJobs').select('payload')
    const recipients = jobs.map(row => JSON.parse(row.payload))
    expect(recipients).toHaveLength(3)
    expect(recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 7, category: 'mention', commentId: 202 }),
        expect.objectContaining({ userId: 20, category: 'watchedPageComment', commentId: 202 }),
        expect.objectContaining({ userId: 21, category: 'mention', commentId: 202 })
      ])
    )
    expect(JSON.stringify(recipients)).not.toContain('confidential comment body')
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['page', 'discussion'] as const)('resumes %s keyset audience jobs idempotently until every remaining recipient has a durable receipt', async kind => {
    await upDurableJobs(knex)
    await addDurableJobLeaseToken(knex)
    if (kind === 'discussion') await seedDiscussion()
    const userIds = Array.from({ length: 120 }, (_, index) => index + 20)
    await knex('users').insert(userIds.map(id => ({ id, email: `reader-${id}@example.test` })))
    await knex('pageWatchers').insert(userIds.map(userId => ({ pageId: 42, userId })))
    if (kind === 'discussion')
      await knex('userNotificationPreferences').insert(
        userIds.map(userId => ({ userId, category: 'watchedPageComment', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() }))
      )
    const audienceJob = { ...job, payload: { mode: 'audience', eventId: 'event-1', afterUserId: 19, audienceAt: new Date().toISOString() } }
    const handler = createPageWatchNotificationHandler(wiki(page))
    await handler(audienceJob, { knex, signal: new AbortController().signal })
    const firstReceipts = await knex('pageWatchDeliveries').where('userId', '>=', 20)
    expect(firstReceipts.length).toBeGreaterThan(0)
    expect(firstReceipts.length).toBeLessThan(userIds.length)
    await handler(audienceJob, { knex, signal: new AbortController().signal })
    expect(await knex('pageWatchDeliveries').where('userId', '>=', 20)).toHaveLength(firstReceipts.length)
    const continuation = (await knex('durableJobs')).find(row => JSON.parse(row.payload).mode === 'audience')
    expect(continuation).toBeDefined()
    await handler({ ...job, payload: JSON.parse(continuation!.payload) }, { knex, signal: new AbortController().signal })
    const receipts = await knex('pageWatchDeliveries').where('userId', '>=', 20).orderBy('userId')
    expect(receipts.map(row => row.userId)).toEqual(userIds)
    expect(new Set(receipts.map(row => row.eventId + ':' + row.userId)).size).toBe(userIds.length)
    expect(send).not.toHaveBeenCalled()
  })
  it('sends one stable-message-id page-watch template and records completion idempotently', async () => {
    const handler = createPageWatchNotificationHandler(wiki(page))

    await handler(job, { knex, signal: new AbortController().signal })
    await handler(job, { knex, signal: new AbortController().signal })

    expect(send).toHaveBeenCalledOnce()
    const message = send.mock.calls[0]?.[0] as {
      template?: string
      to?: string
      messageId?: string
      subject?: string
      text?: string
      data?: Record<string, unknown>
    }
    expect(message).toMatchObject({
      template: 'page-watch',
      to: 'reader@example.test',
      messageId: '<page-watch-delivery-1@wiki.local>',
      data: { action: 'updated', actorName: 'Editor', pageTitle: 'Getting Started', url: 'https://wiki.example.test/en/docs/start' }
    })
    expect(message).not.toHaveProperty('subject')
    expect(message).not.toHaveProperty('text')
    expect(await knex('pageWatchNotifications')).toEqual([expect.objectContaining({ eventId: 'event-1', userId: 7, title: 'Getting Started' })])
    expect(await knex('pageWatchDeliveries').where('id', 'delivery-1').first()).toMatchObject({ deliveredAt: expect.anything(), lastError: null })
  })
  it('uses the encoded destination in page-watch template data', async () => {
    const specialPage = {
      ...page,
      visibility: 'private',
      ownerId: 7,
      localeCode: 'français locale',
      path: 'docs/space path/hash#fragment/percent%value/question?query/encoded%2Fslash/日本語'
    }
    const expectedUrl =
      'https://wiki.example.test/_private/fran%C3%A7ais%20locale/docs/space%20path/hash%23fragment/percent%25value/question%3Fquery/encoded%252Fslash/%E6%97%A5%E6%9C%AC%E8%AA%9E'

    await createPageWatchNotificationHandler(wiki(specialPage))(job, { knex, signal: new AbortController().signal })

    const message = send.mock.calls[0]?.[0] as { data?: { url?: string }; subject?: string; text?: string }
    expect(message.data?.url).toBe(expectedUrl)
    expect(message).not.toHaveProperty('subject')
    expect(message).not.toHaveProperty('text')
    expect(message.data?.url).not.toContain('#')
    expect(message.data?.url).not.toContain('?')
  })
  it('maps every page event to a localized template action label', async () => {
    const cases = [
      ['page.created', 'created'],
      ['page.updated', 'updated'],
      ['page.restored', 'restored'],
      ['page.moved', 'moved'],
      ['page.deleted', 'deleted'],
      ['page.visibility-changed', 'changed-visibility'],
      ['page.ownership-transferred', 'transferred-ownership'],
      ['page.unknown', 'changed']
    ] as const
    const handler = createPageWatchNotificationHandler(wiki(page))

    for (const [index, [type, action]] of cases.entries()) {
      const eventId = `action-event-${index}`,
        deliveryId = `action-delivery-${index}`
      await knex('outboxEvents').insert({
        id: eventId,
        type,
        payload: JSON.stringify({
          pageId: 42,
          actorId: 9,
          actorName: 'Editor',
          title: 'Getting Started',
          ownerId: null,
          tags: [],
          path: 'docs/start',
          localeCode: 'en',
          visibility: 'public'
        })
      })
      await knex('pageWatchDeliveries').insert({ id: deliveryId, eventId, userId: 7, deliveredAt: null, lastError: null })
      await handler({ ...job, payload: { ...job.payload, eventId, deliveryId } }, { knex, signal: new AbortController().signal })
      expect(send.mock.calls[index]?.[0].data.action).toBe(action)
    }
  })
  it('uses the recipient authority snapshot before dispatching a notification', async () => {
    const deniedWiki = wiki(page)
    const loadPageRuleAuthority = vi.fn(async requester => ({
      requester,
      permissions: [],
      groups: [],
      tagAliases: {}
    }))
    deniedWiki.auth.loadPageRuleAuthority = loadPageRuleAuthority
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'previous-notification',
        eventId: 'event-previous',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-user-previous-notification',
        eventId: 'event-other-user-previous',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-page-previous-notification',
        eventId: 'event-other-page-previous',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    await createPageWatchNotificationHandler(deniedWiki)(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('purges prior notifications when the current page is deleted', async () => {
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'deleted-page-notification',
        eventId: 'event-deleted-prior',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior title',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'deleted-page-other-user-notification',
        eventId: 'event-deleted-other-user',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'deleted-page-other-page-notification',
        eventId: 'event-deleted-other-page',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    await createPageWatchNotificationHandler(wiki(undefined))(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('purges unavailable recipients without touching another user', async () => {
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'inactive-user-notification',
        eventId: 'event-inactive-prior',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior title',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-user-notification',
        eventId: 'event-other-user',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'other-page-notification',
        eventId: 'event-other-page',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    const inactiveWiki = wiki(page)
    inactiveWiki.models.users.query = () => ({
      findById: () => ({ withGraphJoined: () => ({ modifyGraph: async () => ({ ...user, isActive: false }) }) })
    })

    await createPageWatchNotificationHandler(inactiveWiki)(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('delivers the in-app channel without sending email when email is disabled', async () => {
    const inAppOnlyJob: DurableJob = {
      ...job,
      payload: { ...job.payload, emailEnabled: false, inAppEnabled: true }
    }

    await createPageWatchNotificationHandler(wiki(page))(inAppOnlyJob, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchNotifications')).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({ deliveredAt: expect.anything() })
  })

  it('removes the subscription without sending after page access is revoked', async () => {
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 8 },
      { pageId: 99, userId: 7 }
    ])
    await knex('pageWatchNotifications').insert([
      {
        id: 'revoked-user-notification',
        eventId: 'event-revoked-prior',
        userId: 7,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Prior title',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'revoked-other-user-notification',
        eventId: 'event-revoked-other-user',
        userId: 8,
        pageId: 42,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other user',
        path: 'docs/start',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      },
      {
        id: 'revoked-other-page-notification',
        eventId: 'event-revoked-other-page',
        userId: 7,
        pageId: 99,
        eventType: 'page.updated',
        actorName: 'Editor',
        title: 'Other page',
        path: 'docs/other',
        localeCode: 'en',
        visibility: 'public',
        createdAt: new Date(),
        readAt: null
      }
    ])
    const deniedUser = { ...user, permissions: [], getGlobalPermissions: () => [] }
    const deniedWiki = wiki(page)
    deniedWiki.models.users.query = () => ({
      findById: () => ({ withGraphJoined: () => ({ modifyGraph: async () => deniedUser }) })
    })

    await createPageWatchNotificationHandler(deniedWiki)(job, { knex, signal: new AbortController().signal })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchers').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchers').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 42 })).toEqual([])
    expect(await knex('pageWatchNotifications').where({ userId: 8, pageId: 42 })).toHaveLength(1)
    expect(await knex('pageWatchNotifications').where({ userId: 7, pageId: 99 })).toHaveLength(1)
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: expect.anything(),
      lastError: expect.any(String)
    })
  })

  it('does not dispatch or commit when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(createPageWatchNotificationHandler(wiki(page))(job, { knex, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })

    expect(send).not.toHaveBeenCalled()
    expect(await knex('pageWatchers')).toEqual([expect.objectContaining({ pageId: 42, userId: 7 })])
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchDeliveries').first()).toMatchObject({
      deliveredAt: null,
      lastError: null
    })
  })
})
