import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { streamOwnedAgentEvents } from '../../agents/sse.ts'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('agent event SSE lifecycle', () => {
  let knex: Knex

  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await knex.schema.createTable('agentRuns', table => {
      table.string('id').primary()
      table.integer('ownerId').notNullable()
      table.string('status').notNullable()
      table.integer('eventSequence').notNullable()
    })
    await knex.schema.createTable('agentEvents', table => {
      table.string('id').primary()
      table.string('runId').notNullable()
      table.integer('sequence').notNullable()
      table.string('type').notNullable()
      table.integer('attempt').notNullable()
      table.integer('schemaVersion').notNullable()
      table.string('dataSha256').notNullable()
      table.text('data').notNullable()
      table.dateTime('createdAt').notNullable()
    })
  })

  afterEach(async () => knex.destroy())

  it('ends a partial run after its final event and releases connection accounting', async () => {
    const data = '{"outcome":"partial"}'
    await knex('agentRuns').insert({ id: 'run-partial', ownerId: 7, status: 'partial', eventSequence: 1 })
    await knex('agentEvents').insert({
      id: 'event-partial',
      runId: 'run-partial',
      sequence: 1,
      type: 'run.partial',
      attempt: 1,
      schemaVersion: 1,
      dataSha256: sha256(data),
      data,
      createdAt: new Date('2026-08-17T12:00:00.000Z')
    })

    const request = { get: () => undefined, query: {} } as unknown as Request
    const response = Object.assign(new EventEmitter(), {
      status: vi.fn(),
      set: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn()
    })
    response.status.mockReturnValue(response)
    response.set.mockReturnValue(response)
    const connections = new Map<number, number>()

    await streamOwnedAgentEvents(knex, request, response as unknown as Response, 7, 'run-partial', connections, {
      maximumConnectionsPerUser: 1,
      reconciliationMilliseconds: 1,
      keepaliveMilliseconds: 60_000
    })

    expect(response.write).toHaveBeenCalledOnce()
    expect(response.write).toHaveBeenCalledWith(expect.stringContaining('event: run.partial'))
    expect(response.end).toHaveBeenCalledOnce()
    expect(connections.has(7)).toBe(false)
  })
})
