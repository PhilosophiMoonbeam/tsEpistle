import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { publishOutboxEvents, writeOutboxEvent } from '../../core/outbox.ts'
import { up as upDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as upOutbox } from '../../db/migrations/2.5.131.ts'
import { up as upPageWatching } from '../../db/migrations/2.5.132.ts'

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
      ).rejects.toThrow(`Invalid outbox event type: ${type}`)
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

  it('lets only one concurrent publisher own an outbox row', async () => {
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

    await expect(publishOutboxEvents(knex)).rejects.toThrow(`Page event ${eventId} notification fields are invalid`)

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
    expect(firstEventId).not.toBe(finalEventId)
  })

  it('does not fan out events to disabled or unsubscribed webhooks', async () => {
    await knex('webhooks').update({ events: JSON.stringify(['page.deleted']) })
    await writeOutboxEvent(knex, {
      type: 'page.created',
      version: 1,
      aggregateType: 'page',
      aggregateId: 8,
      payload: { pageId: 8 }
    })

    await publishOutboxEvents(knex)

    expect(await knex('durableJobs')).toEqual([])
    expect(await knex('webhookDeliveries')).toEqual([])
  })
})
