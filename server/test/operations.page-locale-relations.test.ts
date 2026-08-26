import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  linkPageLocaleRelation,
  listPageLocaleRelations,
  unlinkPageLocaleRelation
} from '../operations/page-locale-relations.ts'
import { localeRelationMovePatch } from '../helpers/page-locale-relations.ts'

const originalWiki = Reflect.get(globalThis, 'WIKI')
const editor = { id: 7 }

const row = (id: number, localeCode: string, localeGroupId: string | null = null) => ({
  id,
  localeCode,
  localeGroupId,
  ownerId: null,
  path: `guide/${localeCode}-${id}`,
  title: `${localeCode.toUpperCase()} ${id}`,
  visibility: 'public'
})

describe('page locale relations', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('localeCode').notNullable()
      table.uuid('localeGroupId').nullable()
      table.integer('ownerId').nullable()
      table.string('path').notNullable()
      table.string('title').notNullable()
      table.string('visibility').notNullable()
      table.unique(['localeGroupId', 'localeCode'])
    })
    Reflect.set(globalThis, 'WIKI', {
      auth: {
        checkAccess: (requester: { id?: number } | undefined, permissions: readonly string[]) =>
          requester?.id === editor.id && permissions.some(permission => permission === 'read:pages' || permission === 'write:pages')
      },
      models: { knex: db }
    })
  })

  afterEach(async () => {
    await db.destroy()
    if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else Reflect.set(globalThis, 'WIKI', originalWiki)
  })

  it('links translations and returns a stable locale-ordered set', async () => {
    await db('pages').insert([row(1, 'en'), row(2, 'fr')])

    await expect(linkPageLocaleRelation({ pageId: 1, relatedPageId: 2, requester: editor })).resolves.toEqual([
      { id: 1, locale: 'en', path: 'guide/en-1', title: 'EN 1', visibility: 'public' },
      { id: 2, locale: 'fr', path: 'guide/fr-2', title: 'FR 2', visibility: 'public' }
    ])

    const linked = await db('pages').orderBy('id').select('localeGroupId') as Array<{ localeGroupId: string | null }>
    expect(linked[0]!.localeGroupId).toMatch(/^[0-9a-f-]{36}$/)
    expect(linked[1]!.localeGroupId).toBe(linked[0]!.localeGroupId)
  })

  it('merges translation sets but rejects duplicate locales atomically', async () => {
    await db('pages').insert([
      row(1, 'en', '00000000-0000-4000-8000-000000000001'),
      row(2, 'fr', '00000000-0000-4000-8000-000000000001'),
      row(3, 'de', '00000000-0000-4000-8000-000000000002'),
      row(4, 'fr', '00000000-0000-4000-8000-000000000002')
    ])

    await expect(linkPageLocaleRelation({ pageId: 1, relatedPageId: 3, requester: editor }))
      .rejects.toMatchObject({ status: 409 })

    const groups = await db('pages').orderBy('id').pluck('localeGroupId')
    expect(groups).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000002'
    ])
  })

  it('unlinks one translation and removes a meaningless singleton group', async () => {
    const groupId = '00000000-0000-4000-8000-000000000003'
    await db('pages').insert([row(1, 'en', groupId), row(2, 'fr', groupId)])

    await expect(unlinkPageLocaleRelation({ pageId: 1, relatedPageId: 2, requester: editor })).resolves.toEqual([
      { id: 1, locale: 'en', path: 'guide/en-1', title: 'EN 1', visibility: 'public' }
    ])

    await expect(db('pages').orderBy('id').pluck('localeGroupId')).resolves.toEqual([null, null])
  })

  it('detaches only when a locale move would duplicate a translation', async () => {
    const groupId = '00000000-0000-4000-8000-000000000004'
    await db('pages').insert([row(1, 'en', groupId), row(2, 'fr', groupId)])
    const page = row(1, 'en', groupId)

    await db.transaction(async transaction => {
      await expect(localeRelationMovePatch(transaction, page, 'de')).resolves.toEqual({})
      await expect(localeRelationMovePatch(transaction, page, 'fr')).resolves.toEqual({ localeGroupId: null })
    })
  })

  it('does not disclose unreadable relation membership', async () => {
    await db('pages').insert([row(1, 'en'), row(2, 'fr')])

    await expect(listPageLocaleRelations({ pageId: 1 })).rejects.toMatchObject({ status: 404 })
    await expect(linkPageLocaleRelation({ pageId: 1, relatedPageId: 2 })).rejects.toMatchObject({ status: 404 })
  })
})
