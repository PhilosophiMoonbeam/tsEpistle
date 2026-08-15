/** @vitest-environment node */

import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishOutboxEvents, writeOutboxEvent } from '../../core/outbox.ts'
import { up as upDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as upOutbox } from '../../db/migrations/2.5.131.ts'

let knex: Knex

beforeEach(async () => {
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await upDurableJobs(knex)
  await upOutbox(knex)
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
