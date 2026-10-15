import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { publishOutboxEvents, writeOutboxEvent } from '../../core/outbox.ts'
import { up as upDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as upOutbox } from '../../db/migrations/2.5.131.ts'
import { up as upPageWatching } from '../../db/migrations/2.5.132.ts'
import { up as upNotificationPreferences } from '../../db/migrations/tsepistle-000058-discussion-notifications.ts'

let knex: Knex

beforeEach(async () => {
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await upDurableJobs(knex)
  await addDurableJobLeaseToken(knex)
  await knex.schema.createTable('users', table => {
    table.integer('id').primary()
  })
  await knex('users').insert([{ id: 7 }, { id: 8 }])
  await upOutbox(knex)
  await upPageWatching(knex)
  await upNotificationPreferences(knex)
  const now = new Date()
  await knex('webhooks').insert({
    id: '00000000-0000-4000-8000-000000000010',
    name: 'Page events',
    url: 'https://hooks.example.test/wiki',
    events: JSON.stringify(['page.created']),
    secretCiphertext: 'encrypted',
    isEnabled: true,
    createdAt: now,
    updatedAt: now
  })
})

afterEach(async () => {
  await knex.destroy()
})

describe('transactional outbox', () => {
  it('accepts hyphenated event words and rejects malformed separators', async () => {
    const acceptedTypes = ['page.visibility-changed', 'page.ownership-transferred']
    for (const type of acceptedTypes) {
      await writeOutboxEvent(knex, {
        type,
        version: 1,
        aggregateType: 'page',
        aggregateId: 7,
        payload: { pageId: 7 }
      })
    }

    const malformedTypes = [
      'Page.visibility-changed',
      'page.visibility Changed',
      '.page.visibility-changed',
      'page.visibility-changed.',
      'page..visibility-changed',
      'page.-visibility-changed',
      'page.visibility-changed-',
      'page.visibility--changed',
      'page.visibility_changed'
    ]
    for (const type of malformedTypes) {
      await expect(
        writeOutboxEvent(knex, {
          type,
          version: 1,
          aggregateType: 'page',
          aggregateId: 7,
          payload: { pageId: 7 }
        })
      ).rejects.toBeInstanceOf(TypeError)
    }

    expect(await knex('outboxEvents').orderBy('type').pluck('type')).toEqual([...acceptedTypes].sort())
  })

  it('rolls back an event with its surrounding domain transaction', async () => {
    await expect(
      Promise.resolve(
        knex.transaction(async transaction => {
          await writeOutboxEvent(transaction, {
            type: 'page.created',
            version: 1,
            aggregateType: 'page',
            aggregateId: 7,
            payload: { pageId: 7 }
          })
          throw new Error('domain write failed')
        })
      )
    ).rejects.toThrow('domain write failed')

    expect(await knex('outboxEvents')).toEqual([])
  })

  it('publishes once under serialized SQLite competing invocations and replay', async () => {
    const eventId = await knex.transaction(transaction =>
      writeOutboxEvent(transaction, {
        type: 'page.created',
        version: 1,
        aggregateType: 'page',
        aggregateId: 7,
        payload: { pageId: 7, visibility: 'public' }
      })
    )

    const published = await Promise.all([publishOutboxEvents(knex), publishOutboxEvents(knex)])
    expect(published.reduce((total, count) => total + count, 0)).toBe(1)
    await publishOutboxEvents(knex)

    expect(await knex('durableJobs')).toHaveLength(1)
    expect(await knex('webhookDeliveries')).toHaveLength(1)
    expect(await knex('webhookDeliveries').first()).toMatchObject({ eventId })
    expect(await knex('outboxEvents').where('id', eventId).first()).toMatchObject({
      publishedAt: expect.anything()
    })
  })

  it('rolls back fanout, jobs, deliveries, and publication together', async () => {
    await knex('pageWatchers').insert({ pageId: 7, userId: 8, createdAt: new Date() })
    const eventId = await writeOutboxEvent(knex, {
      type: 'page.created',
      version: 1,
      aggregateType: 'page',
      aggregateId: 7,
      payload: { pageId: 7 }
    })

    await expect(publishOutboxEvents(knex)).rejects.toBeInstanceOf(TypeError)

    expect(await knex('durableJobs')).toEqual([])
    expect(await knex('webhookDeliveries')).toEqual([])
    expect(await knex('pageWatchDeliveries')).toEqual([])
    expect(await knex('outboxEvents').where('id', eventId).first()).toMatchObject({ publishedAt: null })
  })

  it('fans page events out to watchers, excludes the actor, and removes subscriptions after deletion', async () => {
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 7, createdAt: new Date() },
      { pageId: 42, userId: 8, createdAt: new Date() }
    ])
    const eventId = await writeOutboxEvent(knex, {
      type: 'page.deleted',
      version: 1,
      aggregateType: 'page',
      aggregateId: 42,
      payload: {
        pageId: 42,
        actorId: 7,
        actorName: 'Editor',
        title: 'Deleted page',
        path: 'docs/deleted',
        localeCode: 'en',
        visibility: 'public'
      }
    })

    await publishOutboxEvents(knex)
    await publishOutboxEvents(knex)

    expect(await knex('pageWatchDeliveries')).toEqual([expect.objectContaining({ eventId, userId: 8 })])
    expect(await knex('durableJobs').where('type', 'notify-page-watcher')).toHaveLength(1)
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchers').where('pageId', 42)).toEqual([])
  })

  it('keeps the newest aggregate event when an older event publishes last', async () => {
    const now = new Date('2026-08-14T12:00:30.000Z')
    await knex('pageWatchers').insert({ pageId: 42, userId: 8, createdAt: now })
    const firstEventId = await writeOutboxEvent(knex, {
      type: 'page.updated',
      version: 1,
      aggregateType: 'page',
      aggregateId: 42,
      payload: { pageId: 42, actorId: 7, actorName: 'Editor', title: 'First edit', path: 'docs/page', localeCode: 'en', visibility: 'public' },
      createdAt: new Date(now.valueOf() - 2_000)
    })
    const finalEventId = await writeOutboxEvent(knex, {
      type: 'page.updated',
      version: 1,
      aggregateType: 'page',
      aggregateId: 42,
      payload: { pageId: 42, actorId: 7, actorName: 'Editor', title: 'Final edit', path: 'docs/page', localeCode: 'en', visibility: 'public' },
      createdAt: new Date(now.valueOf() - 1_000)
    })
    await knex('outboxEvents').where('id', firstEventId).update({ publishedAt: now })
    await publishOutboxEvents(knex, { now })
    await knex('outboxEvents').where('id', firstEventId).update({ publishedAt: null })
    await publishOutboxEvents(knex, { now })

    const jobs = await knex('durableJobs').where('type', 'notify-page-watcher')
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ eventId: finalEventId, userId: 8 })
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchDeliveries')).toEqual([expect.objectContaining({ eventId: finalEventId, userId: 8 })])
  })

  it('keeps new category defaults off and fans global opt-ins out without changing explicit watches', async () => {
    await knex('users').insert({ id: 9 })
    await knex('pageWatchers').insert({ pageId: 42, userId: 9, createdAt: new Date(), emailEnabled: false, inAppEnabled: true })
    await knex('userNotificationPreferences').insert([
      { userId: 7, category: 'pageCreated', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() },
      { userId: 8, category: 'pageCreated', inAppEnabled: true, emailEnabled: false, updatedAt: new Date() }
    ])
    const eventId = await writeOutboxEvent(knex, {
      type: 'page.created',
      version: 1,
      aggregateType: 'page',
      aggregateId: 42,
      payload: { pageId: 42, actorId: 7, actorName: 'Author', title: 'New page', path: 'docs/new', localeCode: 'en', visibility: 'public' }
    })
    await publishOutboxEvents(knex)
    const jobs = (await knex('durableJobs').where('type', 'notify-page-watcher')).map(row => JSON.parse(row.payload))
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventId, userId: 8, category: 'pageCreated', emailEnabled: false, inAppEnabled: true }),
        expect.objectContaining({ eventId, userId: 9, category: 'pageWatch', emailEnabled: false, inAppEnabled: true })
      ])
    )
    expect(jobs).toHaveLength(2)
  })

  it('deduplicates discussion audiences by mention, reply, then watched comment and never exports internal events', async () => {
    await knex.schema.createTable('comments', table => {
      table.integer('id').primary()
      table.integer('pageId').notNullable()
      table.integer('authorId').notNullable()
      table.integer('replyTo').notNullable()
      table.string('name').notNullable()
      table.text('content').notNullable()
      table.boolean('isHidden').notNullable()
    })
    await knex.schema.createTable('userHandleClaims', table => {
      table.integer('userId').notNullable()
      table.string('handle').primary()
    })
    await knex('users').insert([{ id: 9 }, { id: 10 }])
    await knex('webhooks').update({ events: JSON.stringify(['*', 'discussion.comment-created']) })
    await knex('comments').insert([
      { id: 100, pageId: 42, authorId: 7, replyTo: 0, name: 'Reader', content: 'Root', isHidden: false },
      { id: 101, pageId: 42, authorId: 8, replyTo: 100, name: 'Author', content: '@reader @outsider reply', isHidden: false }
    ])
    await knex('userHandleClaims').insert([
      { userId: 7, handle: 'reader' },
      { userId: 9, handle: 'outsider' }
    ])
    await knex('pageWatchers').insert([
      { pageId: 42, userId: 7, createdAt: new Date() },
      { pageId: 42, userId: 10, createdAt: new Date() }
    ])
    await knex('userNotificationPreferences').insert([
      ...['mention', 'commentReply', 'watchedPageComment'].map(category => ({
        userId: 7,
        category,
        inAppEnabled: true,
        emailEnabled: true,
        updatedAt: new Date()
      })),
      { userId: 8, category: 'watchedPageComment', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() },
      { userId: 9, category: 'mention', inAppEnabled: true, emailEnabled: true, updatedAt: new Date() }
    ])
    const eventId = await writeOutboxEvent(knex, {
      type: 'discussion.comment-created',
      version: 1,
      aggregateType: 'comment',
      aggregateId: 101,
      payload: { pageId: 42, commentId: 101, actorId: 8 }
    })
    await publishOutboxEvents(knex)
    const deliveries = await knex('pageWatchDeliveries')
    expect(deliveries).toEqual([expect.objectContaining({ eventId, userId: 7 })])
    const jobs = await knex('durableJobs')
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ userId: 7, category: 'mention', commentId: 101 })
    expect(await knex('webhookDeliveries')).toEqual([])
    expect(JSON.stringify(jobs)).not.toContain('@reader')
    await knex('userNotificationPreferences').where({ userId: 7, category: 'mention' }).update({ inAppEnabled: false, emailEnabled: false })
    await knex('comments').insert({ id: 102, pageId: 42, authorId: 8, replyTo: 100, name: 'Author', content: '@reader another reply', isHidden: false })
    const replyEventId = await writeOutboxEvent(knex, {
      type: 'discussion.comment-created',
      version: 1,
      aggregateType: 'comment',
      aggregateId: 102,
      payload: { pageId: 42, commentId: 102, actorId: 8 }
    })
    await publishOutboxEvents(knex)
    const replyJobs = (await knex('durableJobs')).map(row => JSON.parse(row.payload)).filter(payload => payload.eventId === replyEventId)
    expect(replyJobs).toEqual([expect.objectContaining({ userId: 7, category: 'commentReply', commentId: 102 })])
    await knex('userNotificationPreferences').where({ userId: 7, category: 'commentReply' }).update({ inAppEnabled: false, emailEnabled: false })
    await knex('comments').insert({ id: 103, pageId: 42, authorId: 8, replyTo: 100, name: 'Author', content: '@reader watched reply', isHidden: false })
    const watchedEventId = await writeOutboxEvent(knex, {
      type: 'discussion.comment-created',
      version: 1,
      aggregateType: 'comment',
      aggregateId: 103,
      payload: { pageId: 42, commentId: 103, actorId: 8 }
    })
    await publishOutboxEvents(knex)
    const watchedJobs = (await knex('durableJobs')).map(row => JSON.parse(row.payload)).filter(payload => payload.eventId === watchedEventId)
    expect(watchedJobs).toEqual([expect.objectContaining({ userId: 7, category: 'watchedPageComment', commentId: 103 })])
    expect(await knex('pageWatchDeliveries')).toHaveLength(3)
    expect(await knex('webhookDeliveries')).toEqual([])
  })

  it('bounds each audience page and persists a keyset continuation rather than truncating recipients', async () => {
    const userIds = Array.from({ length: 120 }, (_, index) => index + 20)
    await knex('users').insert(userIds.map(id => ({ id })))
    await knex('pageWatchers').insert(userIds.map(userId => ({ pageId: 42, userId, createdAt: new Date() })))
    const eventId = await writeOutboxEvent(knex, {
      type: 'page.updated',
      version: 1,
      aggregateType: 'page',
      aggregateId: 42,
      payload: { pageId: 42, actorId: 7, actorName: 'Author', title: 'Edit', path: 'docs/edit', localeCode: 'en', visibility: 'public' }
    })
    await publishOutboxEvents(knex)
    const receipts = await knex('pageWatchDeliveries').where('eventId', eventId).orderBy('userId')
    expect(receipts.length).toBeGreaterThan(0)
    expect(receipts.length).toBeLessThan(userIds.length)
    const jobs = (await knex('durableJobs').where('type', 'notify-page-watcher')).map(row => JSON.parse(row.payload))
    const continuations = jobs.filter(payload => payload.mode === 'audience')
    expect(continuations).toHaveLength(1)
    expect(continuations[0]).toMatchObject({ eventId, afterUserId: receipts[receipts.length - 1].userId })
    expect(await knex('outboxEvents').where('id', eventId).first()).toMatchObject({ publishedAt: expect.anything() })
  })

  it('does not fan out events to disabled or unsubscribed webhooks', async () => {
    await knex('webhooks').update({ events: JSON.stringify(['page.deleted']) })
    const unsubscribedEventId = await writeOutboxEvent(knex, {
      type: 'page.created',
      version: 1,
      aggregateType: 'page',
      aggregateId: 8,
      payload: { pageId: 8 }
    })

    await publishOutboxEvents(knex)

    expect(await knex('durableJobs')).toEqual([])
    expect(await knex('webhookDeliveries')).toEqual([])
    expect(await knex('outboxEvents').where('id', unsubscribedEventId).first()).toMatchObject({ publishedAt: expect.anything() })

    await knex('webhooks').update({ events: JSON.stringify(['page.created']), isEnabled: false })
    const disabledEventId = await writeOutboxEvent(knex, {
      type: 'page.created',
      version: 1,
      aggregateType: 'page',
      aggregateId: 9,
      payload: { pageId: 9 }
    })

    await publishOutboxEvents(knex)

    expect(await knex('durableJobs')).toEqual([])
    expect(await knex('webhookDeliveries')).toEqual([])
    expect(await knex('outboxEvents').where('id', disabledEventId).first()).toMatchObject({ publishedAt: expect.anything() })
  })
})
