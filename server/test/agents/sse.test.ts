import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Response } from 'express'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { publishAgentGoogleSearchSuggestions, streamOwnedAgentEvents, type AgentSseRequest } from '../../agents/sse.ts'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('agent event SSE lifecycle', () => {
  let knex: Knex

  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await knex.schema.createTable('agentRuns', table => {
      table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
      table.string('id').primary()
      table.integer('ownerId').notNullable()
      table.string('sessionId').nullable()
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

  it('delivers bounded search widgets only to the admitted owner without durable event IDs', async () => {
    await knex('agentRuns').insert({ id: 'web-run', sessionId: 'web-session', ownerId: 7, googleSearchEnabled: true, status: 'running', eventSequence: 0 })
    const flushed = Promise.withResolvers<void>()
    const delivered = Promise.withResolvers<void>()
    const output: string[] = []
    const response = Object.assign(new EventEmitter(), {
      status: vi.fn(),
      set: vi.fn(),
      flushHeaders: () => flushed.resolve(),
      write: (chunk: string) => {
        output.push(chunk)
        delivered.resolve()
        return true
      },
      end: vi.fn()
    })
    response.status.mockReturnValue(response)
    response.set.mockReturnValue(response)
    const controller = new AbortController()
    const streaming = streamOwnedAgentEvents(knex, { get: () => undefined, query: {} }, response as unknown as Response, 7, 'web-run', new Map(), {
      maximumConnectionsPerUser: 1,
      reconciliationMilliseconds: 60_000,
      keepaliveMilliseconds: 60_000,
      signal: controller.signal
    })
    await flushed.promise
    try {
      const input = { ownerId: 7, sessionId: 'web-session', runId: 'web-run', suggestions: ['<a href="https://google.com/">Search</a>'] }
      await expect(publishAgentGoogleSearchSuggestions(knex, { ...input, ownerId: 8 })).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })
      await expect(publishAgentGoogleSearchSuggestions(knex, { ...input, suggestions: ['x'.repeat(32_769)] })).rejects.toMatchObject({
        code: 'INVALID_GOOGLE_SEARCH_SUGGESTIONS'
      })
      await publishAgentGoogleSearchSuggestions(knex, input)
      await delivered.promise
      expect(output).toEqual([`event: google_search.suggestions\ndata: ${JSON.stringify({ runId: input.runId, suggestions: input.suggestions })}\n\n`])
      expect(await knex('agentEvents').count('id as count').first()).toEqual({ count: 0 })
      expect((await knex('agentRuns').where({ id: 'web-run' }).first('eventSequence')).eventSequence).toBe(0)
    } finally {
      controller.abort()
      await streaming
    }
  })

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

    const request = { get: () => undefined, query: {} } satisfies AgentSseRequest
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

  it('removes attached lifecycle listeners and releases accounting once when request and response both close', async () => {
    await knex('agentRuns').insert({ id: 'run-aborted', ownerId: 7, status: 'running', eventSequence: 0 })

    const request = Object.assign(new EventEmitter(), {
      aborted: false,
      get: () => undefined,
      query: {}
    })
    const headersFlushed = Promise.withResolvers<void>()
    const response = Object.assign(new EventEmitter(), {
      status: vi.fn(),
      set: vi.fn(),
      flushHeaders: vi.fn(() => headersFlushed.resolve()),
      write: vi.fn(() => true),
      end: vi.fn()
    })
    response.status.mockReturnValue(response)
    response.set.mockReturnValue(response)
    const connections = new Map<number, number>([[7, 1]])

    const streaming = streamOwnedAgentEvents(knex, request, response as unknown as Response, 7, 'run-aborted', connections, {
      maximumConnectionsPerUser: 2,
      reconciliationMilliseconds: 60_000,
      keepaliveMilliseconds: 60_000
    })
    await headersFlushed.promise

    expect(connections.get(7)).toBe(2)
    expect(request.listenerCount('aborted')).toBe(1)
    expect(response.listenerCount('close')).toBe(1)

    request.emit('aborted')
    response.emit('close')
    await streaming

    expect(request.listenerCount('aborted')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
    expect(response.end).toHaveBeenCalledOnce()
    expect(connections.get(7)).toBe(1)
  })

  it('retains AbortSignal cleanup for a request without lifecycle hooks', async () => {
    await knex('agentRuns').insert({ id: 'run-signalled', ownerId: 7, status: 'running', eventSequence: 0 })

    const request = { get: () => undefined, query: {} } satisfies AgentSseRequest
    const headersFlushed = Promise.withResolvers<void>()
    const response = Object.assign(new EventEmitter(), {
      status: vi.fn(),
      set: vi.fn(),
      flushHeaders: vi.fn(() => headersFlushed.resolve()),
      write: vi.fn(() => true),
      end: vi.fn()
    })
    response.status.mockReturnValue(response)
    response.set.mockReturnValue(response)
    const controller = new AbortController()
    const connections = new Map<number, number>()

    const streaming = streamOwnedAgentEvents(knex, request, response as unknown as Response, 7, 'run-signalled', connections, {
      maximumConnectionsPerUser: 1,
      reconciliationMilliseconds: 60_000,
      keepaliveMilliseconds: 60_000,
      signal: controller.signal
    })
    await headersFlushed.promise
    expect(connections.get(7)).toBe(1)

    controller.abort()
    await streaming

    expect(response.listenerCount('close')).toBe(0)
    expect(response.end).toHaveBeenCalledOnce()
    expect(connections.has(7)).toBe(false)
  })
})
