import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createGlossaryOperations, type GlossaryOperations } from '../../operations/glossary.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import type { PageRuleAuthority } from '../../helpers/group-access.ts'

// Exercise native authorization/projection without PostgreSQL-only mutation or
// search syntax. Existing glossary PostgreSQL tests cover writes and name search.
describe('native glossary reads for MCP principals', () => {
  let db: Knex
  let operations: GlossaryOperations
  let enabled: boolean
  let canRead: boolean
  const requester = createApiPrincipal(9, 3, ['use:mcp', 'read:glossary', 'read:pages'])
  const context = { requester, sessionId: '' }

  beforeEach(async () => {
    enabled = true
    canRead = true
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('glossaryTerms', table => {
      table.integer('id').primary()
      table.integer('revision')
      for (const name of ['locale', 'term', 'expansion', 'category', 'definition', 'documentationLabel', 'references', 'createdAt', 'updatedAt'])
        table.text(name)
      table.integer('documentationPageId').nullable()
      table.boolean('autoLink')
      table.boolean('caseSensitive')
    })
    await db.schema.createTable('glossaryNames', table => {
      table.integer('termId')
      table.text('name')
      table.text('key')
      table.boolean('isAlias')
    })
    await db.schema.createTable('glossaryTermRelations', table => {
      table.integer('leftId')
      table.integer('rightId')
      table.text('locale')
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      for (const name of ['title', 'path', 'localeCode', 'visibility', 'publishStartDate', 'publishEndDate']) table.text(name)
      table.integer('ownerId').nullable()
      table.boolean('isPublished')
    })
    await db.schema.createTable('tags', table => {
      table.integer('id')
      table.text('tag')
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId')
      table.integer('tagId')
    })
    await db.schema.createTable('pageAccessPasswords', table => {
      table.integer('pageId')
      table.integer('version')
    })
    const base = {
      revision: 1,
      expansion: '',
      category: '',
      definition: 'A definition',
      documentationPageId: null,
      documentationLabel: '',
      references: '[]',
      autoLink: true,
      caseSensitive: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z'
    }
    await db('glossaryTerms').insert([
      { ...base, id: 1, locale: 'en', term: 'Alpha', documentationPageId: 42, documentationLabel: 'Confidential label' },
      { ...base, id: 2, locale: 'en', term: 'Beta' },
      { ...base, id: 3, locale: 'fr', term: 'French secret' }
    ])
    await db('pages').insert({
      id: 42,
      title: 'Confidential title',
      path: 'secret/guide',
      localeCode: 'en',
      visibility: 'private',
      ownerId: 99,
      isPublished: true
    })
    operations = createGlossaryOperations({
      db,
      enabled: () => enabled,
      loadAuthority: async current =>
        ({
          requester: current,
          permissions: canRead ? ['read:glossary', 'read:pages'] : ['read:pages'],
          groups: [
            {
              id: 3,
              pageRules: [
                { match: 'EXACT', path: 'glossary', locales: ['en'], deny: false, roles: ['read:glossary'] },
                { match: 'START', path: '', deny: false, roles: ['read:pages'] }
              ]
            }
          ],
          tagAliases: {}
        }) satisfies PageRuleAuthority
    })
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('bounds continuation pages, reauthorizes each locale, and scopes term IDs to the requested locale', async () => {
    const page = await operations.list(context, { locale: 'en', limit: 1 })
    expect(page).toMatchObject({ items: [{ id: 1, locale: 'en' }], complete: false })
    expect(page.nextCursor).not.toBeNull()
    expect(await operations.list(context, { locale: 'en', limit: 1, cursor: page.nextCursor })).toMatchObject({
      items: [{ id: 2 }],
      complete: true,
      nextCursor: null
    })
    await expect(operations.list(context, { locale: 'fr', limit: 1 })).rejects.toMatchObject({ status: 403 })
    await expect(operations.get(context, 3, 'en')).rejects.toMatchObject({ status: 404 })
    await expect(operations.get(context, 3, 'fr')).rejects.toMatchObject({ status: 403 })
    await expect(operations.list(context, { locale: 'en', limit: 101 })).rejects.toMatchObject({ status: 400 })
    canRead = false
    await expect(operations.list(context, { locale: 'en', limit: 1, cursor: page.nextCursor })).rejects.toMatchObject({ status: 403 })
    await expect(operations.get(context, 1, 'en')).rejects.toMatchObject({ status: 403 })
    enabled = false
    await expect(operations.get(context, 1, 'en')).rejects.toMatchObject({ status: 404 })
  })

  it('never exposes private or password-protected documentation through an API principal without a session grant', async () => {
    const privateTerm = await operations.get(context, 1, 'en')
    expect(privateTerm).toMatchObject({ definition: 'A definition', documentation: null, documentationPageId: null, documentationLabel: '' })
    expect(JSON.stringify(privateTerm)).not.toContain('Confidential')
    await db('pages').where({ id: 42 }).update({ visibility: 'public', ownerId: null })
    await db('pageAccessPasswords').insert({ pageId: 42, version: 1 })
    expect(await operations.get(context, 1, 'en')).toMatchObject({ documentation: null, documentationPageId: null, documentationLabel: '' })
    await db('pageAccessPasswords').delete()
    expect(await operations.get(context, 1, 'en')).toMatchObject({
      documentation: { id: 42, title: 'Confidential title', label: 'Confidential label', href: '/en/secret/guide' }
    })
  })
})
