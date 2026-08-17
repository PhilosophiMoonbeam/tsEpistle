import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { down, up } from '../../db/migrations/2.5.139.ts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = databaseName.endsWith('_agents_test')
  ? {
      host: process.env.WIKI_TEST_POSTGRES_HOST ?? 'wiki-postgres',
      port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
      user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
      password,
      database: databaseName
    }
  : null
const suite = connection ? describe : describe.skip

suite('PostgreSQL first-class agent migration', () => {
  let db: Knex

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    for (const table of ['pageHistory', 'pages', 'assetFolders', 'apiKeys', 'groups', 'users']) {
      await db.schema.dropTableIfExists(table)
    }
    await db.schema.createTable('users', table => table.integer('id').primary())
    await db.schema.createTable('groups', table => table.integer('id').primary())
    await db.schema.createTable('apiKeys', table => table.integer('id').primary())
    await db.schema.createTable('assetFolders', table => table.integer('id').primary())
    await db.schema.createTable('pages', table => {
      table.increments('id').primary()
      table.string('path').notNullable()
      table.string('hash').notNullable()
      table.string('title').notNullable()
      table.string('description').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.boolean('isPublished').notNullable()
      table.string('publishStartDate').notNullable()
      table.string('publishEndDate').notNullable()
      table.text('content').notNullable()
      table.text('render').notNullable()
      table.text('toc').notNullable()
      table.string('contentType').notNullable()
      table.string('editorKey').notNullable()
      table.string('localeCode').notNullable()
      table.integer('authorId').notNullable()
      table.integer('creatorId').notNullable()
      table.json('extra').notNullable()
      table.dateTime('updatedAt').notNullable().defaultTo(db.fn.now())
    })
    await db.schema.createTable('pageHistory', table => table.increments('id').primary())
    await db('users').insert([{ id: 1 }, { id: 7 }])
    await db('groups').insert({ id: 1 })
    await db('apiKeys').insert({ id: 1 })
    await db('assetFolders').insert({ id: 1 })
    await up(db)
  })

  afterAll(async () => {
    if (!db) return
    for (const table of ['pageHistory', 'pages', 'assetFolders', 'apiKeys', 'groups', 'users']) {
      await db.schema.dropTableIfExists(table)
    }
    await db.destroy()
  })

  it('adds the authoritative tables, indexes, and source revision columns', async () => {
    for (const table of ['agentSessions', 'agentRuns', 'agentEvents', 'agentSkills', 'agentProviderProfiles', 'agentProposals', 'agentApprovals', 'agentActionExecutions', 'pageMutationOutbox']) {
      await expect(db.schema.hasTable(table)).resolves.toBe(true)
    }
    await expect(db.schema.hasColumn('pages', 'sourceRevision')).resolves.toBe(true)
    await expect(db.schema.hasColumn('pageHistory', 'sourceRevision')).resolves.toBe(true)
  })

  it('increments source revision only for authoritative page fields', async () => {
    const inserted = await db('pages').insert({
      path: 'docs/start',
      hash: 'public:en:docs/start',
      title: 'Start',
      description: '',
      visibility: 'public',
      ownerId: null,
      isPublished: true,
      publishStartDate: '',
      publishEndDate: '',
      content: '# Start\n',
      render: '<h1>Start</h1>',
      toc: '[]',
      contentType: 'markdown',
      editorKey: 'markdown',
      localeCode: 'en',
      authorId: 7,
      creatorId: 7,
      extra: {},
      updatedAt: db.fn.now()
    }).returning(['id', 'sourceRevision'])
    const pageId = inserted[0]?.id
    expect(String(inserted[0]?.sourceRevision)).toBe('1')

    await db('pages').where({ id: pageId }).update({ render: '<h1>Derived</h1>', updatedAt: db.fn.now() })
    expect(String((await db('pages').where({ id: pageId }).first('sourceRevision'))?.sourceRevision)).toBe('1')

    await db('pages').where({ id: pageId }).update({ content: '# Changed\n', updatedAt: db.fn.now() })
    expect(String((await db('pages').where({ id: pageId }).first('sourceRevision'))?.sourceRevision)).toBe('2')

    await db('pages').where({ id: pageId, sourceRevision: 2 }).update({ sourceRevision: db.raw('"sourceRevision" + 1') })
    expect(String((await db('pages').where({ id: pageId }).first('sourceRevision'))?.sourceRevision)).toBe('3')
  })

  it('guards rollback once authoritative agent data exists, then permits an empty down', async () => {
    await db('agentProviderProfiles').insert({
      id: '00000000-0000-4000-8000-000000000001',
      displayName: 'Test',
      createdBy: 7,
      updatedBy: 7
    })
    await expect(down(db)).rejects.toThrow('agentProviderProfiles contains data')
    await db('agentProviderProfiles').delete()
    await db('pages').delete()
    await down(db)
    await expect(db.schema.hasTable('agentSessions')).resolves.toBe(false)
    await expect(db.schema.hasColumn('pages', 'sourceRevision')).resolves.toBe(false)
  })
})
