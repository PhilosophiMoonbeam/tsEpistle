import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'

import { decodeSkillResourceBundle, encodeSkillResourceBundle } from '../../agents/skills/bundle.ts'
import { buildApprovedSkillBundle, type SkillResourceInput } from '../../agents/skills/parser.ts'
import { SkillRegistry, type SkillSourceResolver } from '../../agents/skills/registry.ts'

const entryBytes = (description: string) => Buffer.from(`---\nname: release-notes\ndescription: ${description}\nallowed-tools: pages.search\n---\nSummarize recent pages.\n`)

const createSchema = async (db: Knex): Promise<void> => {
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('path').notNullable()
    table.text('content').notNullable()
    table.string('contentType').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('updatedAt').notNullable()
  })
  await db.schema.createTable('agentSkills', table => {
    table.string('id').primary()
    table.string('name').notNullable().unique()
    table.integer('rootPageId').notNullable()
    table.text('rootPath').notNullable()
    table.integer('assetFolderId').nullable()
    table.string('status').notNullable()
    table.string('exposureMode').notNullable()
    table.string('currentVersionId').nullable()
    table.integer('createdBy').notNullable()
    table.integer('updatedBy').notNullable()
    table.dateTime('createdAt').defaultTo(db.fn.now())
    table.dateTime('updatedAt').defaultTo(db.fn.now())
  })
  await db.schema.createTable('agentSkillGrants', table => {
    table.string('skillId').notNullable()
    table.integer('groupId').notNullable()
    table.primary(['skillId', 'groupId'])
  })
  await db.schema.createTable('agentSkillVersions', table => {
    table.string('id').primary()
    table.string('skillId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.dateTime('sourceUpdatedAt').notNullable()
    table.integer('sourceHistoryId').nullable()
    table.text('skillMarkdown').notNullable()
    table.text('frontmatter').notNullable()
    table.binary('resourceBundle').notNullable()
    table.text('resourceManifest').notNullable()
    table.string('contentHash').notNullable()
    table.string('approvalStatus').notNullable()
    table.integer('approvedBy').nullable()
    table.dateTime('approvedAt').nullable()
    table.dateTime('createdAt').defaultTo(db.fn.now())
    table.unique(['skillId', 'contentHash'])
  })
}

describe('immutable skill registry', () => {
  let db: Knex
  let sourceRevision: string
  let sourceDescription: string
  let registry: SkillRegistry

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createSchema(db)
    sourceRevision = '1'
    sourceDescription = 'First revision'
    await db('pages').insert({
      id: 42,
      path: 'system/agent-skills/release-notes',
      content: entryBytes(sourceDescription).toString('utf8'),
      contentType: 'markdown',
      sourceRevision,
      updatedAt: '2026-08-17T00:00:00.000Z'
    })
    const resolver: SkillSourceResolver = async () => ({
      bundle: buildApprovedSkillBundle(entryBytes(sourceDescription), 'release-notes', []),
      sourceRevision,
      sourceUpdatedAt: '2026-08-17T00:00:00.000Z',
      sourceHistoryId: null
    })
    registry = new SkillRegistry(db, 'system/agent-skills', resolver)
  })

  afterEach(async () => {
    await db.destroy()
  })

  const createSkill = async (): Promise<string> => registry.create({
    name: 'release-notes',
    rootPageId: 42,
    rootPath: 'system/agent-skills/release-notes',
    assetFolderId: null,
    exposureMode: 'groups',
    groupIds: [9, 3, 9],
    actorId: 1
  })

  it('creates a disabled mapping with normalized group grants', async () => {
    const skillId = await createSkill()
    expect(await db('agentSkills').where({ id: skillId }).first()).toMatchObject({ status: 'disabled', currentVersionId: null })
    expect(await db('agentSkillGrants').select('groupId').where({ skillId }).orderBy('groupId')).toEqual([{ groupId: 3 }, { groupId: 9 }])
    await expect(registry.setEnabled(skillId, 1, true)).rejects.toThrow('no approved version')
  })

  it('rejects source drift between preview and approval', async () => {
    const skillId = await createSkill()
    const preview = await registry.preview(skillId)
    sourceRevision = '2'
    sourceDescription = 'Changed revision'
    await expect(registry.approve({
      skillId,
      actorId: 1,
      expectedContentHash: preview.contentHash,
      expectedSourceRevision: preview.sourceRevision
    })).rejects.toThrow('changed after approval preview')
    expect(await db('agentSkillVersions').count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 0 })
  })

  it('pins immutable approved versions, enables explicitly, and reports source drift', async () => {
    const skillId = await createSkill()
    const firstPreview = await registry.preview(skillId)
    const firstVersion = await registry.approve({
      skillId,
      actorId: 1,
      expectedContentHash: firstPreview.contentHash,
      expectedSourceRevision: firstPreview.sourceRevision
    })
    await registry.setEnabled(skillId, 1, true)
    expect((await registry.list())[0]).toMatchObject({ currentVersionId: firstVersion, status: 'enabled', drifted: false })

    sourceRevision = '2'
    sourceDescription = 'Second revision'
    await db('pages').where({ id: 42 }).update({ sourceRevision: 2, content: entryBytes(sourceDescription).toString('utf8') })
    expect((await registry.list())[0]).toMatchObject({ currentVersionId: firstVersion, drifted: true })

    const secondPreview = await registry.preview(skillId)
    const secondVersion = await registry.approve({
      skillId,
      actorId: 1,
      expectedContentHash: secondPreview.contentHash,
      expectedSourceRevision: secondPreview.sourceRevision
    })
    expect(secondVersion).not.toBe(firstVersion)
    expect(await db('agentSkillVersions').select('id', 'approvalStatus').where({ skillId }).orderBy('sourceRevision')).toEqual([
      { id: firstVersion, approvalStatus: 'approved' },
      { id: secondVersion, approvalStatus: 'approved' }
    ])
  })

  it('persists terminal rejection and cannot reinterpret it as approval', async () => {
    const skillId = await createSkill()
    const preview = await registry.preview(skillId)
    const rejectedVersion = await registry.reject({
      skillId,
      actorId: 1,
      expectedContentHash: preview.contentHash,
      expectedSourceRevision: preview.sourceRevision
    })
    expect(await db('agentSkillVersions').where({ id: rejectedVersion }).first()).toMatchObject({ approvalStatus: 'rejected', approvedBy: 1 })
    await expect(registry.approve({
      skillId,
      actorId: 1,
      expectedContentHash: preview.contentHash,
      expectedSourceRevision: preview.sourceRevision
    })).rejects.toThrow('different terminal review')
  })
})

describe('skill resource bundle codec', () => {
  const resourceInput: SkillResourceInput = {
    path: 'references/API.md',
    bytes: Buffer.from('# API\n'),
    mediaType: 'text/markdown',
    sourceId: 'page:4',
    sourceRevision: '8'
  }

  it('round-trips exact bytes and rejects tampering', () => {
    const bundle = buildApprovedSkillBundle(
      Buffer.from('---\nname: docs\ndescription: Docs\n---\nRead [API](references/API.md).\n'),
      'docs',
      [resourceInput]
    )
    const encoded = encodeSkillResourceBundle(bundle.resources)
    const decoded = decodeSkillResourceBundle(encoded)
    expect(decoded[0]).toMatchObject({ path: 'references/API.md', executable: false, sourceRevision: '8' })
    expect(decoded[0]?.bytes.equals(resourceInput.bytes)).toBe(true)
    encoded[encoded.byteLength - 1] ^= 1
    expect(() => decodeSkillResourceBundle(encoded)).toThrow('hash does not match')
  })
})
