import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'
import { up as createApiKeys } from '../../db/migrations/2.2.3.ts'
import { up } from '../../db/migrations/tsepistle-000028-browser-session-cookies.ts'

interface UserRow {
  id: number
  authVersion: number
  sessionsRevokedAt: string | null
}

describe('browser session cookie cutover migration', () => {
  let database: Knex | undefined

  afterEach(async () => await database?.destroy())

  it('advances human auth generations without touching API-key tables', async () => {
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    database = db
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.integer('authVersion').notNullable().defaultTo(0)
      table.timestamp('sessionsRevokedAt', { useTz: true }).nullable()
    })
    await db.schema.createTable('userKeys', table => {
      table.increments('id').primary()
      table.string('kind').notNullable()
      table.string('token').notNullable()
      table.string('createdAt').notNullable()
      table.string('validUntil').notNullable()
      table.integer('userId').unsigned().references('id').inTable('users')
      table.integer('authVersion').notNullable().defaultTo(0)
    })
    await createApiKeys(db)
    await db<UserRow>('users').insert([
      { id: 1, authVersion: 0, sessionsRevokedAt: null },
      { id: 2, authVersion: 17, sessionsRevokedAt: '2026-01-02T03:04:05.000Z' },
      { id: 7, authVersion: 5, sessionsRevokedAt: '2026-02-03T04:05:06.000Z' }
    ])
    await db('userKeys').insert([
      {
        id: 11,
        kind: 'resetPwd',
        token: 'zero-generation-one-time-key',
        createdAt: '2026-03-04T05:06:07.000Z',
        validUntil: '2026-03-05T05:06:07.000Z',
        userId: 1,
        authVersion: 0
      },
      {
        id: 12,
        kind: 'changePwd',
        token: 'nonzero-generation-one-time-key',
        createdAt: '2026-04-05T06:07:08.000Z',
        validUntil: '2026-04-06T06:07:08.000Z',
        userId: 7,
        authVersion: 5
      }
    ])
    await db('apiKeys').insert([
      {
        id: 21,
        name: 'active-api-key',
        key: 'active-api-credential',
        expiration: '2030-01-01T00:00:00.000Z',
        isRevoked: false,
        createdAt: '2026-05-06T07:08:09.000Z',
        updatedAt: '2026-05-07T07:08:09.000Z'
      },
      {
        id: 22,
        name: 'revoked-api-key',
        key: 'revoked-api-credential',
        expiration: '2026-01-01T00:00:00.000Z',
        isRevoked: true,
        createdAt: '2025-06-07T08:09:10.000Z',
        updatedAt: '2025-06-08T08:09:10.000Z'
      }
    ])
    const guestBefore = await db<UserRow>('users').where({ id: 2 }).first()
    const userKeysBefore = await db('userKeys').orderBy('id')
    const apiKeysBefore = await db('apiKeys').orderBy('id')
    const startedAt = Date.now()

    await up(db)

    const finishedAt = Date.now()
    const humans = await db<UserRow>('users').whereNot('id', 2).orderBy('id')
    expect(humans.map(({ id, authVersion }) => ({ id, authVersion }))).toEqual([
      { id: 1, authVersion: 1 },
      { id: 7, authVersion: 6 }
    ])
    for (const human of humans) {
      expect(typeof human.sessionsRevokedAt).toBe('string')
      const revokedAt = Date.parse(human.sessionsRevokedAt!)
      expect(revokedAt).toBeGreaterThanOrEqual(startedAt)
      expect(revokedAt).toBeLessThanOrEqual(finishedAt)
      expect(human.sessionsRevokedAt).toBe(new Date(revokedAt).toISOString())
    }
    expect(await db<UserRow>('users').where({ id: 2 }).first()).toEqual(guestBefore)
    expect(await db('userKeys').orderBy('id')).toEqual(userKeysBefore)
    expect(await db('apiKeys').orderBy('id')).toEqual(apiKeysBefore)
  })
})
