import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeSkillResourceBundle } from '../../agents/skills/bundle.ts'
import { buildApprovedSkillBundle } from '../../agents/skills/parser.ts'
import { SkillRuntime } from '../../agents/skills/runtime.ts'

const sessionId = '00000000-0000-4000-8000-000000000001'
const skillId = '00000000-0000-4000-8000-000000000002'
const versionId = '00000000-0000-4000-8000-000000000003'
const runId = '00000000-0000-4000-8000-000000000004'
const requestId = '00000000-0000-4000-8000-000000000005'
const entry = Buffer.from('---\nname: release-notes\ndescription: Release notes\nallowed-tools:\n  - pages.get\n  - pages.prepareDelete\n---\nRead [guidance](references/GUIDE.md).\n')
const bundle = buildApprovedSkillBundle(entry, 'release-notes', [{
  path: 'references/GUIDE.md',
  bytes: Buffer.from('# Guidance\n'),
  mediaType: 'text/markdown',
  sourceId: 'page:55',
  sourceRevision: '4'
}])

const createSchema = async (db: Knex): Promise<void> => {
  await db.schema.createTable('agentSkills', table => {
    table.string('id').primary()
    table.string('name').notNullable()
    table.string('status').notNullable()
    table.string('exposureMode').notNullable()
    table.integer('ownerUserId').nullable()
    table.boolean('isAgentDiscoverable').notNullable().defaultTo(true)
    table.dateTime('deletedAt').nullable()
    table.string('currentVersionId').nullable()
  })
  await db.schema.createTable('agentSkillVersions', table => {
    table.string('id').primary()
    table.string('skillId').notNullable()
    table.string('approvalStatus').notNullable()
    table.string('contentHash').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.text('skillMarkdown').notNullable()
    table.text('frontmatter').notNullable()
    table.binary('resourceBundle').notNullable()
  })
  await db.schema.createTable('agentSkillGrants', table => {
    table.string('skillId').notNullable()
    table.integer('groupId').notNullable()
  })
  await db.schema.createTable('agentSessions', table => {
    table.string('id').primary()
    table.integer('ownerId').notNullable()
    table.integer('version').notNullable()
    table.dateTime('updatedAt').defaultTo(db.fn.now())
  })
  await db.schema.createTable('agentRuns', table => {
    table.string('id').primary()
    table.string('sessionId').notNullable()
    table.integer('ownerId').notNullable()
    table.string('status').notNullable()
  })
  await db.schema.createTable('agentSessionSkills', table => {
    table.string('sessionId').notNullable()
    table.string('skillVersionId').notNullable()
    table.integer('ordinal').notNullable()
    table.integer('selectedBy').notNullable()
    table.dateTime('selectedAt').defaultTo(db.fn.now())
  })
  await db.schema.createTable('agentRunSkills', table => {
    table.string('runId').notNullable()
    table.string('skillVersionId').notNullable()
    table.integer('ordinal').notNullable()
  })
  await db.schema.createTable('agentSkillUses', table => {
    table.string('id').primary()
    table.string('skillVersionId').notNullable()
    table.string('runId').nullable()
    table.string('sessionId').nullable()
    table.integer('requesterUserId').nullable()
    table.integer('requesterApiKeyId').nullable()
    table.string('transportRequestId').notNullable()
    table.string('externalSessionSha256').nullable()
    table.text('resourcePath').nullable()
    table.string('purpose').notNullable()
    table.string('contentHash').notNullable()
    table.dateTime('createdAt').defaultTo(db.fn.now())
  })
}

describe('skill selection and pinned runtime', () => {
  let db: Knex
  let runtime: SkillRuntime

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createSchema(db)
    await db('agentSkills').insert({
      id: skillId,
      name: 'release-notes',
      status: 'enabled',
      exposureMode: 'groups',
      currentVersionId: versionId
    })
    await db('agentSkillVersions').insert({
      id: versionId,
      skillId,
      approvalStatus: 'approved',
      contentHash: bundle.contentHash,
      sourceRevision: 7,
      skillMarkdown: bundle.entry.text,
      frontmatter: JSON.stringify({
        name: 'release-notes',
        description: 'Release notes',
        license: null,
        compatibility: null,
        metadata: {},
        'allowed-tools': ['pages.get', 'pages.prepareDelete']
      }),
      resourceBundle: encodeSkillResourceBundle(bundle.resources)
    })
    await db('agentSkillGrants').insert({ skillId, groupId: 3 })
    await db('agentSessions').insert({ id: sessionId, ownerId: 7, version: 1 })
    runtime = new SkillRuntime(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('lists only skills visible through live group grants', async () => {
    expect(await runtime.listVisible({ userId: 7, groupIds: [3] })).toMatchObject([{ id: skillId, versionId, description: 'Release notes' }])
    expect(await runtime.listVisible({ userId: 7, groupIds: [9] })).toEqual([])
  })

  it('exposes personal skills only to their owner and never to API keys', async () => {
    const personalSkillId = '00000000-0000-4000-8000-000000000006'
    const personalVersionId = '00000000-0000-4000-8000-000000000007'
    await db('agentSkills').insert({
      id: personalSkillId,
      name: 'personal-guide',
      status: 'enabled',
      exposureMode: 'owner',
      ownerUserId: 7,
      isAgentDiscoverable: false,
      currentVersionId: personalVersionId
    })
    await db('agentSkillVersions').insert({
      id: personalVersionId,
      skillId: personalSkillId,
      approvalStatus: 'approved',
      contentHash: 'personal-content',
      sourceRevision: 1,
      skillMarkdown: '---\nname: personal-guide\ndescription: Personal guide\n---\nUse it.\n',
      frontmatter: JSON.stringify({ name: 'personal-guide', description: 'Personal guide', license: null, compatibility: null, metadata: {}, 'allowed-tools': [] }),
      resourceBundle: encodeSkillResourceBundle([])
    })

    await expect(runtime.assertVisibleVersions([personalVersionId], { userId: 7, groupIds: [] })).resolves.toEqual([personalVersionId])
    await expect(runtime.assertVisibleVersions([personalVersionId], { userId: 8, groupIds: [] })).rejects.toThrow('unavailable')
    expect(await runtime.listVisible({ userId: 7, groupIds: [] })).toMatchObject([{ id: personalSkillId, exposureMode: 'owner', isAgentDiscoverable: false }])
    expect(await runtime.listVisible({ userId: 8, groupIds: [] })).toEqual([])
    expect(await runtime.listVisibleForApiKey({
      principal: { apiKeyId: 9, groupIds: [3] },
      transportRequestId: requestId
    })).toMatchObject([{ id: skillId, exposureMode: 'groups' }])
    await db('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running' })
    expect(await runtime.listVisibleForRun({
      runId,
      principal: { userId: 7, groupIds: [] },
      transportRequestId: requestId
    })).toEqual([])
  })

  it('lets an active run discover and read visible skills with provenance', async () => {
    await db('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running' })
    expect(await runtime.listVisibleForRun({
      runId,
      principal: { userId: 7, groupIds: [3] },
      transportRequestId: requestId
    })).toMatchObject([{ name: 'release-notes', versionId, description: 'Release notes' }])

    const resource = await runtime.readVisibleResourceForRun({
      runId,
      skillName: 'release-notes',
      versionId,
      path: 'SKILL.md',
      principal: { userId: 7, groupIds: [3] },
      transportRequestId: requestId
    })
    expect(resource.bytes.toString('utf8')).toBe(entry.toString('utf8'))
    expect(await db('agentSkillUses').select('runId', 'sessionId', 'requesterUserId', 'purpose', 'resourcePath')).toEqual([
      { runId, sessionId, requesterUserId: 7, purpose: 'listed', resourcePath: null },
      { runId, sessionId, requesterUserId: 7, purpose: 'read', resourcePath: 'SKILL.md' }
    ])
    await expect(runtime.readVisibleResourceForRun({
      runId,
      skillName: 'release-notes',
      versionId,
      path: 'SKILL.md',
      principal: { userId: 8, groupIds: [3] },
      transportRequestId: requestId
    })).rejects.toThrow('run is unavailable')
  })

  it('pins an ordered immutable version and rejects stale session mutation', async () => {
    const nextVersion = await runtime.setSessionSkills({ sessionId,
    expectedVersion: 1,
    skillVersionIds: [versionId],
    principal: { userId: 7, groupIds: [3] }, transportRequestId: requestId })
    expect(nextVersion).toBe(2)
    expect(await runtime.listSessionSkills(sessionId, { userId: 7, groupIds: [] })).toEqual([{
      id: skillId,
      name: 'release-notes',
      versionId,
      contentHash: bundle.contentHash,
      ordinal: 0
    }])
    await expect(runtime.setSessionSkills({ sessionId,
    expectedVersion: 1,
    skillVersionIds: [],
    principal: { userId: 7, groupIds: [3] }, transportRequestId: requestId })).rejects.toThrow('version changed')
  })

  it('stops new selection after revocation without breaking retained pinned history', async () => {
    await runtime.setSessionSkills({ sessionId,
    expectedVersion: 1,
    skillVersionIds: [versionId],
    principal: { userId: 7, groupIds: [3] }, transportRequestId: requestId })
    await db('agentSkills').where({ id: skillId }).update({ status: 'disabled' })
    expect(await runtime.listVisible({ userId: 7, groupIds: [3] })).toEqual([])

    const resource = await runtime.readSessionResource({
      sessionId,
      skillName: 'release-notes',
      versionId,
      path: 'references/GUIDE.md',
      principal: { userId: 7, groupIds: [3] },
      transportRequestId: requestId
    })
    expect(resource.bytes.toString('utf8')).toBe('# Guidance\n')
    expect(await db('agentSkillUses').select('purpose', 'resourcePath')).toEqual(expect.arrayContaining([
      { purpose: 'selected', resourcePath: null },
      { purpose: 'read', resourcePath: 'references/GUIDE.md' }
    ]))

    await runtime.setSessionSkills({ sessionId, expectedVersion: 2, skillVersionIds: [], principal: { userId: 7, groupIds: [3] }, transportRequestId: requestId })
    await expect(runtime.setSessionSkills({ sessionId,
    expectedVersion: 3,
    skillVersionIds: [versionId],
    principal: { userId: 7, groupIds: [3] }, transportRequestId: requestId })).rejects.toThrow('unavailable')
  })

  it('copies session pins to a run and allowed-tools cannot grant unavailable actions', async () => {
    await runtime.setSessionSkills({ sessionId,
    expectedVersion: 1,
    skillVersionIds: [versionId],
    principal: { userId: 7, groupIds: [3] }, transportRequestId: requestId })
    await db('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'queued' })
    await runtime.pinRunSkills(runId, sessionId)
    await db('agentSkills').where({ id: skillId }).update({ status: 'disabled' })

    const prompts = await runtime.getRunPrompts({
      runId,
      principal: { userId: 7, groupIds: [3] },
      transportRequestId: requestId,
      availableTools: ['pages.search', 'pages.get']
    })
    expect(prompts).toMatchObject([{ name: 'release-notes', versionId, allowedTools: ['pages.get'] }])
    expect(await db('agentSkillUses').select('purpose', 'resourcePath')).toEqual(expect.arrayContaining([
      { purpose: 'selected', resourcePath: null },
      { purpose: 'injected', resourcePath: 'SKILL.md' }
    ]))
  })

  it('blocks skill mutation while a run is active', async () => {
    await db('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running' })
    await expect(runtime.setSessionSkills({ sessionId,
    expectedVersion: 1,
    skillVersionIds: [versionId],
    principal: { userId: 7, groupIds: [3] }, transportRequestId: requestId })).rejects.toThrow('run is active')
  })
})
