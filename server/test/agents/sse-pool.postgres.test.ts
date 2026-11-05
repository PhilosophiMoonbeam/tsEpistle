import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import createKnex from 'knex'
import { AgentEventSchema, AgentRunStreamReadySchema } from '../../../shared/agents/contracts.ts'
import { appendAgentEvent } from '../../agents/repository.ts'
import { streamOwnedAgentEvents } from '../../agents/sse.ts'
import { describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_sse_pool_test', import.meta.path)
const suite = connection ? describe : describe.skip
const operationTimeout = 3_500

const bounded = async <T>(operation: PromiseLike<T>, label: string, milliseconds = operationTimeout): Promise<T> => {
  const deadline = Promise.withResolvers<never>()
  // Native PostgreSQL and loopback HTTP must keep their real I/O clock. This is
  // only a failure deadline, never a sleep used to schedule the asserted work.
  const timer = setTimeout(() => deadline.reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds)
  try {
    return await Promise.race([operation, deadline.promise])
  } finally {
    clearTimeout(timer)
  }
}

const createDatabase = async () => {
  if (!connection) throw new Error('SSE pool regression requires its runner-assigned PostgreSQL database')
  const schema = `agent_sse_pool_${randomUUID().replaceAll('-', '')}`
  const adminConfig = { client: 'pg', connection, acquireConnectionTimeout: 1_500, pool: { min: 0, max: 1 } }
  const admin = createKnex(adminConfig)
  try {
    await bounded(admin.raw(`CREATE SCHEMA "${schema}"`), 'isolated schema creation')
  } finally {
    await bounded(admin.destroy(), 'schema administration shutdown')
  }
  const db = createKnex({
    client: 'pg',
    connection,
    searchPath: [schema],
    acquireConnectionTimeout: 1_500,
    pool: { min: 0, max: 2 }
  })
  return {
    db,
    destroy: async () => {
      try {
        await bounded(db.destroy(), 'two-connection pool shutdown', 5_000)
      } finally {
        const cleanup = createKnex(adminConfig)
        try {
          await bounded(cleanup.raw(`DROP SCHEMA "${schema}" CASCADE`), 'isolated schema removal')
        } finally {
          await bounded(cleanup.destroy(), 'schema cleanup shutdown')
        }
      }
    }
  }
}

interface SseConsumer {
  nextBlock(): Promise<string>
  cancel(): Promise<void>
}

const consumeSse = (response: Response): SseConsumer => {
  if (!response.body) throw new Error('Owned event stream has no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  return {
    nextBlock: async (): Promise<string> => {
      while (true) {
        const boundary = pending.indexOf('\n\n')
        if (boundary >= 0) {
          const block = pending.slice(0, boundary)
          pending = pending.slice(boundary + 2)
          return block
        }
        const chunk = await reader.read()
        if (chunk.done) throw new Error('Owned nonterminal event stream ended before delivering its next frame')
        pending += decoder.decode(chunk.value, { stream: true })
      }
    },
    cancel: () => reader.cancel()
  }
}

const field = (block: string, name: string): string | undefined =>
  block
    .split('\n')
    .find(line => line.startsWith(`${name}: `))
    ?.slice(name.length + 2)
const readEvent = async (consumer: SseConsumer) => {
  let block = await consumer.nextBlock()
  while (block.startsWith(':')) block = await consumer.nextBlock()
  const data = field(block, 'data')
  if (!data) throw new Error('Owned SSE event has no canonical envelope')
  const event = AgentEventSchema.parse(JSON.parse(data))
  expect(field(block, 'id')).toBe(String(event.sequence))
  expect(field(block, 'event')).toBe(event.type)
  return event
}

const closeServer = async (server: Server): Promise<void> => {
  const closed = Promise.withResolvers<void>()
  server.close(error => (error ? closed.reject(error) : closed.resolve()))
  server.closeAllConnections()
  await bounded(closed.promise, 'loopback HTTP shutdown')
}

suite('owned PostgreSQL SSE pool availability', () => {
  // The existing native producer consumer has one subscriber and a larger pool.
  // Two live HTTP subscribers must not monopolize the connections their producer
  // and reconciliation queries need, even while their run remains nonterminal.
  it('keeps two owned nonterminal HTTP subscribers live in a two-connection pool', async () => {
    const database = await createDatabase()
    const db = database.db
    const ownerId = 7
    const sessionId = randomUUID()
    const runId = randomUUID()
    const replayId = randomUUID()
    const liveId = randomUUID()
    const replayData = { text: 'persisted before either subscriber' }
    const liveData = { text: 'persisted while both subscribers are live' }
    const shutdown = new AbortController()
    const controllers: AbortController[] = []
    const consumers: SseConsumer[] = []
    const handlers: Promise<void>[] = []
    const streamFailure = Promise.withResolvers<never>()
    void streamFailure.promise.catch(() => {})
    const guard = <T>(operation: PromiseLike<T>, label: string): Promise<T> => bounded(Promise.race([operation, streamFailure.promise]), label)
    let closing = false
    let host: Server | undefined
    try {
      // Narrow durable fixture: these are the real repository/SSE columns, not a
      // provider, engine or authentication mock. PostgreSQL enforces event identity
      // and per-run sequence uniqueness; appendAgentEvent writes payload hashes.
      await bounded(
        db.schema.createTable('agentRuns', table => {
          table.uuid('id').primary()
          table.uuid('sessionId').notNullable()
          table.integer('ownerId').notNullable()
          table.string('status', 32).notNullable()
          table.integer('attempts').notNullable()
          table.integer('eventSequence').notNullable()
          table.dateTime('updatedAt').notNullable()
        }),
        'run fixture schema'
      )
      await bounded(
        db.schema.createTable('agentEvents', table => {
          table.uuid('id').primary()
          table.uuid('runId').notNullable().references('id').inTable('agentRuns').onDelete('CASCADE')
          table.integer('sequence').notNullable()
          table.string('type', 64).notNullable()
          table.integer('attempt').notNullable()
          table.integer('schemaVersion').notNullable()
          table.string('dataSha256', 64).notNullable()
          table.text('data').notNullable()
          table.dateTime('createdAt').notNullable()
          table.unique(['runId', 'sequence'])
        }),
        'event fixture schema'
      )
      await bounded(
        db('agentRuns').insert({ id: runId, sessionId, ownerId, status: 'running', attempts: 1, eventSequence: 0, updatedAt: new Date() }),
        'owned nonterminal run'
      )
      await bounded(appendAgentEvent(db, { id: replayId, ownerId, runId, attempt: 1, type: 'message.delta', data: replayData }), 'replay event persistence')

      const connections = new Map<number, number>()
      const app = express()
      app.get('/owned-events', (req, res) => {
        // The fixed owner is the authenticated-adapter seam. Exercise production
        // ownership lookup and streaming unchanged; no security bypass is tested.
        const handler = streamOwnedAgentEvents(db, req, res, ownerId, runId, connections, {
          maximumConnectionsPerUser: 2,
          reconciliationMilliseconds: 20,
          keepaliveMilliseconds: 50,
          signal: shutdown.signal
        }).then(
          () => {
            if (!closing) streamFailure.reject(new Error('Owned nonterminal SSE handler closed while both subscribers must remain live'))
          },
          error => {
            if (!closing) streamFailure.reject(error)
            if (!res.destroyed && !res.writableEnded) {
              if (!res.headersSent) res.status(500)
              res.end()
            }
          }
        )
        handlers.push(handler)
      })
      host = app.listen(0, '127.0.0.1')
      await bounded(once(host, 'listening'), 'loopback HTTP startup')
      const baseUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`
      for (let index = 0; index < 2; index++) {
        const controller = new AbortController()
        controllers.push(controller)
        const response = await guard(
          fetch(`${baseUrl}/owned-events`, { headers: { accept: 'text/event-stream' }, signal: controller.signal }),
          `subscriber ${index + 1} connection`
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        const consumer = consumeSse(response)
        consumers.push(consumer)
        const readyBlock = await guard(consumer.nextBlock(), `subscriber ${index + 1} ready frame`)
        expect(field(readyBlock, 'event')).toBe('stream.ready')
        expect(field(readyBlock, 'id')).toBeUndefined()
        const readyData = field(readyBlock, 'data')
        if (!readyData) throw new Error('Owned event stream has no ready projection')
        expect(AgentRunStreamReadySchema.parse(JSON.parse(readyData))).toEqual({ schemaVersion: 1, ownerId, sessionId, runId, replayThroughSequence: 1 })
      }

      // Do not release either subscriber to make this SELECT or the producer's
      // transaction succeed. A stream acquisition error is surfaced verbatim,
      // rather than mistaken for an HTTP ownership/admission failure.
      const unrelated = await guard(db.raw('SELECT 42 AS answer'), 'unrelated SELECT with both streams open')
      expect(unrelated.rows).toEqual([{ answer: 42 }])
      await guard(
        appendAgentEvent(db, { id: liveId, ownerId, runId, attempt: 1, type: 'message.delta', data: liveData }),
        'live event persistence with both streams open'
      )
      const delivered = await guard(
        Promise.all(consumers.map(async consumer => [await readEvent(consumer), await readEvent(consumer)])),
        'replay and live delivery to both subscribers'
      )
      for (const events of delivered) {
        expect(events).toEqual([
          { id: replayId, runId, sequence: 1, type: 'message.delta', attempt: 1, schemaVersion: 1, data: replayData, createdAt: expect.any(String) },
          { id: liveId, runId, sequence: 2, type: 'message.delta', attempt: 1, schemaVersion: 1, data: liveData, createdAt: expect.any(String) }
        ])
      }
      expect(await guard(Promise.all(consumers.map(consumer => consumer.nextBlock())), 'both nonterminal streams remain live')).toEqual([
        ': keepalive',
        ': keepalive'
      ])
      expect(await guard(db('agentRuns').where({ id: runId, ownerId }).first('status', 'eventSequence'), 'nonterminal run projection')).toEqual({
        status: 'running',
        eventSequence: 2
      })
      const persisted = await guard(
        db('agentEvents').where({ runId }).orderBy('sequence').select('id', 'sequence', 'data', 'dataSha256'),
        'durable sequence and hash projection'
      )
      expect(persisted).toEqual(
        [replayData, liveData].map((data, index) => ({
          id: index === 0 ? replayId : liveId,
          sequence: index + 1,
          data: JSON.stringify(data),
          dataSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex')
        }))
      )
    } finally {
      closing = true
      shutdown.abort()
      for (const controller of controllers) controller.abort()
      try {
        await bounded(Promise.allSettled(consumers.map(consumer => consumer.cancel())), 'owned HTTP reader cancellation')
      } finally {
        try {
          if (host) await closeServer(host)
        } finally {
          try {
            await bounded(Promise.all(handlers), 'owned SSE handler shutdown', 5_000)
          } finally {
            await database.destroy()
          }
        }
      }
    }
  }, 30_000)
})
