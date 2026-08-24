import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { down as downAgentLedger, up as upAgentLedger } from '../../db/migrations/2.5.139.ts'
import { down as restoreLegacyHandoffTable, up as removeLegacyHandoffTable } from '../../db/migrations/2.5.140.ts'
import { down as downProviderSecrets, up as upProviderSecrets } from '../../db/migrations/2.5.141.ts'
import { down as downProviderProfileLifecycle, up as upProviderProfileLifecycle } from '../../db/migrations/2.5.142.ts'
import { down as downPersonalSkills, up as upPersonalSkills } from '../../db/migrations/2.5.143.ts'
import { down as downPersonalSkillDiscovery, up as upPersonalSkillDiscovery } from '../../db/migrations/2.5.144.ts'
import { down as downSkillPreferences, up as upSkillPreferences } from '../../db/migrations/2.5.146.ts'
import { projectAgentThread } from '../../agents/projection.ts'
import { SkillRuntime } from '../../agents/skills/runtime.ts'

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
    for (const table of ['pageHistory', 'pages', 'assetFolders', 'apiKeys', 'userGroups', 'groups', 'users']) {
      await db.schema.dropTableIfExists(table)
    }
    await db.schema.createTable('users', table => table.integer('id').primary())
    await db.schema.createTable('groups', table => table.integer('id').primary())
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable()
      table.integer('groupId').notNullable()
    })
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
    await db('userGroups').insert({ userId: 7, groupId: 1 })
    await db('apiKeys').insert({ id: 1 })
    await db('assetFolders').insert({ id: 1 })
    await upAgentLedger(db)
    await removeLegacyHandoffTable(db)
    await upProviderSecrets(db)
    await upProviderProfileLifecycle(db)
    await upPersonalSkills(db)
    await upPersonalSkillDiscovery(db)
    await upSkillPreferences(db)
  })

  afterAll(async () => {
    if (!db) return
    for (const table of ['pageHistory', 'pages', 'assetFolders', 'apiKeys', 'userGroups', 'groups', 'users']) {
      await db.schema.dropTableIfExists(table)
    }
    await db.destroy()
  })

  it('adds the authoritative tables, removes obsolete handoffs, and adds source revision columns', async () => {
    for (const table of ['agentSessions', 'agentRuns', 'agentEvents', 'agentSkills', 'agentUserSkillPreferences', 'agentProviderProfiles', 'agentProviderSecrets', 'agentProposals', 'agentApprovals', 'agentActionExecutions', 'pageMutationOutbox']) {
      await expect(db.schema.hasTable(table)).resolves.toBe(true)
    }
    await expect(db.schema.hasTable('agentLaunchHandoffs')).resolves.toBe(false)
    await expect(db.schema.hasTable('agentSessionSkills')).resolves.toBe(false)
    await expect(db.schema.hasColumn('pages', 'sourceRevision')).resolves.toBe(true)
    await expect(db.schema.hasColumn('pageHistory', 'sourceRevision')).resolves.toBe(true)
    await expect(db.schema.hasColumn('agentProviderProfiles', 'deletedAt')).resolves.toBe(true)
    await expect(db.schema.hasColumn('agentSkills', 'ownerUserId')).resolves.toBe(true)
    await expect(db.schema.hasColumn('agentSkills', 'deletedAt')).resolves.toBe(true)
    await expect(db.schema.hasColumn('agentSkills', 'isAgentDiscoverable')).resolves.toBe(true)
    await expect(db('agentSkills').columnInfo('isAgentDiscoverable')).resolves.toMatchObject({ nullable: false, defaultValue: 'true' })
    await expect(db('agentSkills').columnInfo('rootPageId')).resolves.toMatchObject({ nullable: true })
  })
  it('projects group-visible preferences with PostgreSQL-safe aliases', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000101'
    const skillId = '00000000-0000-4000-8000-000000000102'
    const versionId = '00000000-0000-4000-8000-000000000103'
    let pageId: number | undefined
    try {
      const [page] = await db('pages').insert({
        path: 'agent-projection',
        hash: 'public:en:agent-projection',
        title: 'Agent projection',
        description: '',
        visibility: 'public',
        ownerId: null,
        isPublished: true,
        publishStartDate: '',
        publishEndDate: '',
        content: '# Agent projection\n',
        render: '<h1>Agent projection</h1>',
        toc: '[]',
        contentType: 'markdown',
        editorKey: 'markdown',
        localeCode: 'en',
        authorId: 7,
        creatorId: 7,
        extra: {},
        updatedAt: db.fn.now()
      }).returning('id')
      pageId = page?.id
      await db('agentSessions').insert({ id: sessionId, ownerId: 7, title: 'Projection', retention: 'saved', executionMode: 'agent' })
      await db('agentSkills').insert({ id: skillId, name: 'projection-skill', rootPageId: pageId, rootPath: 'agent-projection', status: 'enabled', exposureMode: 'groups', currentVersionId: null, createdBy: 7, updatedBy: 7 })
      await db('agentSkillVersions').insert({
        id: versionId,
        skillId,
        sourceRevision: 1,
        sourceUpdatedAt: db.fn.now(),
        sourceHistoryId: null,
        skillMarkdown: '# Projection skill\n',
        frontmatter: JSON.stringify({ description: 'Projection skill' }),
        resourceBundle: Buffer.alloc(0),
        resourceManifest: '[]',
        contentHash: 'a'.repeat(64),
        approvalStatus: 'approved',
        approvedBy: 7,
        approvedAt: db.fn.now()
      })
      await db('agentSkills').where({ id: skillId }).update({ currentVersionId: versionId })
      await db('agentSkillGrants').insert({ skillId, groupId: 1 })
      await db('agentUserSkillPreferences').insert({ ownerId: 7, skillId, ordinal: 0 })

      const thread = await projectAgentThread(db, 7, sessionId, { profileResolutionToken: () => 'token' })
      expect(thread.session.skills).toMatchObject([{ skillId, versionId, name: 'projection-skill' }])
    } finally {
      await db('agentUserSkillPreferences').where({ ownerId: 7, skillId }).delete()
      await db('agentSkillGrants').where({ skillId }).delete()
      await db('agentSkills').where({ id: skillId }).update({ currentVersionId: null })
      await db('agentSkillVersions').where({ id: versionId }).delete()
      await db('agentSkills').where({ id: skillId }).delete()
      await db('agentSessions').where({ id: sessionId }).delete()
      if (pageId !== undefined) await db('pages').where({ id: pageId }).delete()
    }
  })

  it('executes run skill discovery with PostgreSQL-safe aliases', async () => {
    const runId = '00000000-0000-4000-8000-000000000111'
    const sessionId = '00000000-0000-4000-8000-000000000112'
    const transportRequestId = '00000000-0000-4000-8000-000000000113'
    await db.transaction(async transaction => {
      await transaction.raw('CREATE TEMP TABLE "agentRuns" (id uuid PRIMARY KEY, "sessionId" uuid NOT NULL, "ownerId" integer NOT NULL) ON COMMIT DROP')
      await transaction('agentRuns').insert({ id: runId, sessionId, ownerId: 7 })
      const runtime = new SkillRuntime(transaction)
      await expect(runtime.listVisibleForRun({
        runId,
        principal: { userId: 7, groupIds: [] },
        transportRequestId
      })).resolves.toEqual([])
    })
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
    await db('agentProviderProfiles').where({ id: '00000000-0000-4000-8000-000000000001' }).update({ deletedAt: db.fn.now() })
    await expect(downProviderProfileLifecycle(db)).rejects.toThrow('contains removed profiles')
    await expect(downAgentLedger(db)).rejects.toThrow('agentProviderProfiles contains data')
    await db('agentProviderProfiles').where({ id: '00000000-0000-4000-8000-000000000001' }).update({ deletedAt: null })
    await downPersonalSkillDiscovery(db)
    await downSkillPreferences(db)
    await downPersonalSkills(db)
    await downProviderProfileLifecycle(db)
    await db('agentProviderProfiles').delete()
    await db('pages').delete()
    await restoreLegacyHandoffTable(db)
    await downProviderSecrets(db)
    await downAgentLedger(db)
    await expect(db.schema.hasTable('agentSessions')).resolves.toBe(false)
    await expect(db.schema.hasColumn('pages', 'sourceRevision')).resolves.toBe(false)
  })
})
