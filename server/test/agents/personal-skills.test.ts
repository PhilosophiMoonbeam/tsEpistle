import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PersonalSkillRegistry } from '../../agents/skills/personal.ts'

const skillDocument = (name: string, description: string, body = '# Instructions\n\nUse the documented process.\n'): string => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

const createSchema = async (db: Knex): Promise<void> => {
  await db.schema.createTable('users', table => table.integer('id').primary())
  await db('users').insert([{ id: 7 }, { id: 8 }])
  await db.schema.createTable('agentSkills', table => {
    table.string('id').primary()
    table.string('name').notNullable()
    table.integer('rootPageId').nullable()
    table.text('rootPath').notNullable()
    table.integer('assetFolderId').nullable()
    table.string('status').notNullable()
    table.string('exposureMode').notNullable()
    table.string('currentVersionId').nullable()
    table.boolean('isAgentDiscoverable').notNullable().defaultTo(true)
    table.integer('ownerUserId').nullable()
    table.dateTime('deletedAt').nullable()
    table.integer('createdBy').notNullable()
    table.integer('updatedBy').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
  })
  await db.schema.createTable('agentSkillVersions', table => {
    table.string('id').primary()
    table.string('skillId').notNullable()
    table.integer('sourceRevision').notNullable()
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
    table.dateTime('createdAt').notNullable()
    table.unique(['skillId', 'contentHash'])
  })
  await db.raw('CREATE UNIQUE INDEX personal_skill_owner_name ON agentSkills (ownerUserId, name) WHERE ownerUserId IS NOT NULL AND deletedAt IS NULL')
}

describe('personal skill registry', () => {
  let db: Knex
  let registry: PersonalSkillRegistry

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createSchema(db)
    registry = new PersonalSkillRegistry(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('creates immutable revisions and soft-removes the current document', async () => {
    const created = await registry.create({ ownerId: 7, name: 'release-helper', skillMarkdown: skillDocument('release-helper', 'Prepare releases'), isAgentDiscoverable: true })
    expect(created).toMatchObject({ name: 'release-helper', description: 'Prepare releases' })
    expect(await registry.list(7)).toEqual([created])

    const updated = await registry.update({
      ownerId: 7,
      skillId: created.id,
      expectedVersionId: created.versionId,
      skillMarkdown: skillDocument('release-helper', 'Prepare safer releases', '# Instructions\n\nCheck the release notes first.\n'),
      isAgentDiscoverable: false
    })
    expect(updated.versionId).not.toBe(created.versionId)
    expect(updated.description).toBe('Prepare safer releases')
    expect(updated.isAgentDiscoverable).toBe(false)
    expect(await db('agentSkillVersions').where({ skillId: created.id }).orderBy('sourceRevision').pluck('sourceRevision')).toEqual([1, 2])

    await expect(registry.update({ ownerId: 7, skillId: created.id, expectedVersionId: created.versionId, skillMarkdown: updated.skillMarkdown, isAgentDiscoverable: true })).rejects.toThrow('changed')
    await registry.remove({ ownerId: 7, skillId: created.id, expectedVersionId: updated.versionId })
    expect(await registry.list(7)).toEqual([])
    expect(await db('agentSkills').where({ id: created.id }).first('status', 'deletedAt')).toMatchObject({ status: 'disabled', deletedAt: expect.anything() })
    expect(await db('agentSkillVersions').where({ skillId: created.id }).count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 2 })
  })

  it('isolates owners while allowing the same personal name', async () => {
    const first = await registry.create({ ownerId: 7, name: 'my-guide', skillMarkdown: skillDocument('my-guide', 'Owner seven'), isAgentDiscoverable: true })
    const second = await registry.create({ ownerId: 8, name: 'my-guide', skillMarkdown: skillDocument('my-guide', 'Owner eight'), isAgentDiscoverable: false })

    expect((await registry.list(7)).map(skill => skill.id)).toEqual([first.id])
    expect((await registry.list(8)).map(skill => skill.id)).toEqual([second.id])
    await expect(registry.get(8, first.id)).rejects.toThrow('unavailable')
    await expect(registry.create({ ownerId: 7, name: 'my-guide', skillMarkdown: skillDocument('my-guide', 'Duplicate'), isAgentDiscoverable: true })).rejects.toThrow('already exists')
  })

  it('rejects mismatched names, remote resources, and likely secrets', async () => {
    await expect(registry.create({ ownerId: 7, name: 'expected-name', skillMarkdown: skillDocument('wrong-name', 'Wrong'), isAgentDiscoverable: true })).rejects.toThrow('must match')
    await expect(registry.create({ ownerId: 7, name: 'remote-guide', skillMarkdown: skillDocument('remote-guide', 'Remote', 'Read [this](https://example.com/guide).\n'), isAgentDiscoverable: true })).rejects.toThrow('mutable remote URLs')
    await expect(registry.create({ ownerId: 7, name: 'secret-guide', skillMarkdown: skillDocument('secret-guide', 'Secret', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890.\n'), isAgentDiscoverable: true })).rejects.toThrow('secret')
  })
})
