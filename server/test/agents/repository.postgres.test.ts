import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createAgentConversationFolder } from '../../agents/repository.ts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_agents_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password,
        database: databaseName
      }
    : null
const directlyInvoked =
  process.env.npm_lifecycle_event !== 'test' && process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('repository.postgres.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error('Explicit agent repository PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _agents_test and a PostgreSQL password.')
}

const suite = connection ? describe : describe.skip
const schema = `agent_repository_${randomUUID().replaceAll('-', '')}`

suite('PostgreSQL agent conversation folder repository', () => {
  let db: Knex

  beforeAll(async () => {
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await admin.destroy()
    }

    db = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await db.schema.createTable('agentConversationFolders', table => {
      table.uuid('id').primary()
      table.integer('ownerId').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('name', 64).notNullable()
      table.string('normalizedName', 64).notNullable()
      table.integer('version').notNullable()
      table.dateTime('createdAt').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.unique(['ownerId', 'normalizedName'])
    })
  })

  beforeEach(async () => {
    await db('agentConversationFolders').delete()
    await db('users').delete()
    await db('users').insert([{ id: 7 }, { id: 8 }])
  })

  afterAll(async () => {
    if (db) await db.destroy()
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.destroy()
    }
  })

  it('preserves canonical duplicate behavior across owners and connections', async () => {
    const secondConnection = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    try {
      await createAgentConversationFolder(db, 7, '  Ｆｏｌｄ\u00a0\tName  ')
      await expect(createAgentConversationFolder(secondConnection, 7, 'fold name')).rejects.toMatchObject({
        code: 'CONVERSATION_FOLDER_EXISTS',
        status: 409
      })
      await expect(createAgentConversationFolder(secondConnection, 8, 'fold name')).resolves.toMatchObject({ ownerId: 8, name: 'fold name' })
    } finally {
      await secondConnection.destroy()
    }
  })

  it('serializes same-owner cap checks on the owner row while another owner proceeds independently', async () => {
    const secondConnection = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    try {
      const now = new Date('2026-09-11T00:00:00.000Z')
      await db('agentConversationFolders').insert(
        Array.from({ length: 31 }, (_, index) => {
          const name = `Existing ${String(index + 1).padStart(2, '0')}`
          return {
            id: randomUUID(),
            ownerId: 7,
            name,
            normalizedName: name.toLowerCase(),
            version: 1,
            createdAt: now,
            updatedAt: now
          }
        })
      )

      const results = await Promise.allSettled([
        createAgentConversationFolder(db, 7, 'Race A'),
        createAgentConversationFolder(secondConnection, 7, 'Race B'),
        createAgentConversationFolder(db, 8, 'Independent')
      ])
      const sameOwnerResults = results.slice(0, 2)
      expect(sameOwnerResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(sameOwnerResults.filter(result => result.status === 'rejected')).toHaveLength(1)
      const rejected = sameOwnerResults.find(result => result.status === 'rejected')
      expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'CONVERSATION_FOLDER_LIMIT_REACHED', status: 409 } })
      expect(results[2]).toMatchObject({ status: 'fulfilled', value: { ownerId: 8, name: 'Independent' } })
      expect(await db('agentConversationFolders').where({ ownerId: 7 })).toHaveLength(32)
      expect(await db('agentConversationFolders').where({ ownerId: 8 })).toHaveLength(1)
      await expect(createAgentConversationFolder(secondConnection, 7, ' Existing 01 ')).rejects.toMatchObject({
        code: 'CONVERSATION_FOLDER_EXISTS',
        status: 409
      })
    } finally {
      await secondConnection.destroy()
    }
  })
})
