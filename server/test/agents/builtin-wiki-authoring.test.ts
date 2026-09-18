import createKnex, { type Knex } from 'knex'
import { AGENT_TOOL_NAMES } from '../../../shared/agents/contracts.ts'

import { installBuiltinWikiAuthoring } from '../../agents/skills/builtin/install.ts'
import { buildApprovedSkillBundle } from '../../agents/skills/parser.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

describe('built-in wiki-authoring installation', () => {
  let db: Knex
  let createPage: ReturnType<typeof vi.fn>
  let getRootUser: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('pages', table => {
      table.increments('id').primary()
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
      table.text('content').notNullable()
      table.string('contentType').notNullable()
      table.string('editorKey').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.boolean('isPublished').notNullable()
      table.boolean('isSearchable').notNullable()
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
    })
    await db.schema.createTable('agentSkillGrants', table => {
      table.string('skillId').notNullable()
      table.integer('groupId').notNullable()
    })
    getRootUser = vi.fn(async () => ({ id: 1, name: 'Administrator', permissions: ['manage:system'] }))
    createPage = vi.fn(async input => {
      const [id] = await db('pages').insert({
        path: input.path,
        localeCode: input.locale,
        content: input.content,
        contentType: 'markdown',
        editorKey: input.editor,
        visibility: input.visibility,
        ownerId: null,
        isPublished: input.isPublished,
        isSearchable: input.isSearchable
      })
      return { id }
    })
  })

  afterEach(async () => db.destroy())

  const install = () => installBuiltinWikiAuthoring({ db, namespace: 'system/agent-skills', locale: 'en', getRootUser, createPage })

  it('creates a reviewed-source candidate once without approving or enabling it', async () => {
    expect(await install()).toBe('installed')
    const page = await db('pages').first()
    const skill = await db('agentSkills').first()
    expect(page).toMatchObject({ path: 'system/agent-skills/wiki-authoring', isPublished: 0, isSearchable: 0 })
    const bundled = buildApprovedSkillBundle(Buffer.from(page.content), 'wiki-authoring', [])
    expect(bundled.entry.frontmatter.name).toBe('wiki-authoring')
    const knownTools = new Set<string>(Object.values(AGENT_TOOL_NAMES))
    expect(bundled.entry.frontmatter.allowedTools.every(name => knownTools.has(name))).toBe(true)
    expect(skill).toMatchObject({ name: 'wiki-authoring', rootPageId: page.id, status: 'disabled', currentVersionId: null, exposureMode: 'all_agent_users' })
    await db('pages').where({ id: page.id }).update({ content: 'Administrator-edited source' })
    expect(await install()).toBe('already-installed')
    expect(createPage).toHaveBeenCalledTimes(1)
    expect((await db('pages').where({ id: page.id }).first('content')).content).toBe('Administrator-edited source')
    expect(await db('agentSkills').count<{ count: number }>({ count: '*' }).first()).toMatchObject({ count: 1 })
  })

  it('does not replace a conflicting page or treat it as trusted bundled source', async () => {
    await db('pages').insert({
      path: 'system/agent-skills/wiki-authoring',
      localeCode: 'en',
      content: 'Different source',
      contentType: 'markdown',
      editorKey: 'markdown',
      visibility: 'public',
      ownerId: null,
      isPublished: false,
      isSearchable: false
    })
    expect(await install()).toBe('conflict')
    expect(createPage).not.toHaveBeenCalled()
    expect(await db('agentSkills').first()).toBeUndefined()
  })
})
