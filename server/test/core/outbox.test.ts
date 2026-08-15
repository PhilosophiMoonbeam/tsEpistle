/** @vitest-environment node */

import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishOutboxEvents, writeOutboxEvent } from '../../core/outbox.ts'
import { up as upDurableJobs } from '../../db/migrations/2.5.130.ts'
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
  it('rolls back an event with its surrounding domain transaction', async () => {
    await expect(knex.transaction(async transaction => {
      await writeOutboxEvent(transaction, {
        type: 'page.created',
        version: 1,
        aggregateType: 'page',
        aggregateId: 7,
        payload: { pageId: 7 }
      })
      throw new Error('domain write failed')
    })).rejects.toThrow('domain write failed')

    expect(await knex('outboxEvents')).toEqual([])
  })

  it('publishes committed events to one idempotent durable delivery', async () => {
    const eventId = await knex.transaction(transaction => writeOutboxEvent(transaction, {
      type: 'page.created',
      version: 1,
      aggregateType: 'page',
      aggregateId: 7,
      payload: { pageId: 7, visibility: 'public' }
    }))

    await Promise.all([
      publishOutboxEvents(knex),
      publishOutboxEvents(knex)
    ])
    await publishOutboxEvents(knex)

    expect(await knex('durableJobs')).toHaveLength(1)
    expect(await knex('webhookDeliveries')).toHaveLength(1)
    expect(await knex('webhookDeliveries').first()).toMatchObject({ eventId })
    expect(await knex('outboxEvents').where('id', eventId).first()).toMatchObject({
      publishedAt: expect.anything()
    })
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

    expect(await knex('pageWatchDeliveries')).toEqual([
      expect.objectContaining({ eventId, userId: 8 })
    ])
    expect(await knex('durableJobs').where('type', 'notify-page-watcher')).toHaveLength(1)
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchers').where('pageId', 42)).toEqual([])
  })

  it('groups rapid edits while retaining the final event for email and in-app delivery', async () => {
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
    await publishOutboxEvents(knex, { now })

    const jobs = await knex('durableJobs').where('type', 'notify-page-watcher')
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ eventId: finalEventId, userId: 8 })
    expect(await knex('pageWatchNotifications')).toEqual([])
    expect(await knex('pageWatchDeliveries')).toEqual([
      expect.objectContaining({ eventId: finalEventId, userId: 8 })
    ])
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
