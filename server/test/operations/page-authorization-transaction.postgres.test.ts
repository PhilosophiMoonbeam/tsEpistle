import knexModule, { type Knex } from 'knex'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import pageErrors from '../../helpers/error.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_page_auth_tx_test', import.meta.path)
const suite = connection ? describe : describe.skip
const permissions = ['read:pages', 'read:history', 'write:pages']
const requester = { id: 7, permissions }

suite('PostgreSQL page authorization on the decision transaction', () => {
  let db: Knex
  let pages: typeof import('../../models/pages.ts').default
  let history: typeof import('../../models/pageHistory.ts').default
  let operations: typeof import('../../operations/pages.ts').default

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection!,
      acquireConnectionTimeout: 1500, pool: { min: 0, max: 2 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary(); table.text('name'); table.text('email')
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary(); table.text('name'); table.jsonb('permissions'); table.jsonb('pageRules')
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId'); table.integer('groupId')
    })
    await db.schema.createTable('tags', table => {
      table.integer('id').primary(); table.text('tag'); table.text('title')
      table.integer('redirectToId'); table.boolean('isArchived').notNullable().defaultTo(false)
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      for (const name of ['path', 'hash', 'title', 'description', 'visibility', 'content', 'render', 'contentType', 'editorKey', 'localeCode']) table.text(name)
      table.bigInteger('sourceRevision'); table.bigInteger('renderedSourceRevision'); table.string('changeReason', 200)
      table.integer('ownerId'); table.integer('authorId'); table.integer('creatorId')
      table.boolean('isPublished'); table.boolean('isSearchable')
      for (const name of ['publishStartDate', 'publishEndDate', 'createdAt', 'updatedAt']) table.timestamp(name)
      table.jsonb('toc'); table.jsonb('extra')
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId'); table.integer('tagId')
    })
    await db.schema.createTable('pageHistory', table => {
      table.integer('id').primary(); table.integer('pageId'); table.integer('authorId'); table.integer('ownerId')
      for (const name of ['path', 'hash', 'title', 'description', 'visibility', 'content', 'contentType', 'editorKey', 'localeCode', 'action']) table.text(name)
      table.bigInteger('sourceRevision'); table.string('changeReason', 200)
      table.boolean('isPublished'); table.boolean('isSearchable')
      for (const name of ['publishStartDate', 'publishEndDate', 'createdAt', 'updatedAt', 'versionDate']) table.timestamp(name)
      table.jsonb('extra')
    })
    await db.schema.createTable('pageHistoryTags', table => {
      table.integer('pageId'); table.integer('tagId')
    })
    await db.schema.createTable('pageAccessPasswords', table => {
      table.integer('pageId').primary(); table.text('passwordHash'); table.integer('version')
      table.integer('updatedBy'); table.timestamp('updatedAt')
    })
    await db.schema.createTable('pageUnlockGrants', table => {
      table.text('id').primary(); table.integer('pageId'); table.text('sessionId'); table.integer('userId')
      table.integer('passwordVersion'); table.timestamp('createdAt'); table.timestamp('expiresAt')
    })
    await db('users').insert({ id: requester.id, name: 'Transaction editor', email: 'transaction@example.test' })
    await db('groups').insert({ id: 3, name: 'Editors', permissions: JSON.stringify(permissions),
      pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: permissions }]) })
    await db('userGroups').insert({ userId: requester.id, groupId: 3 })
    await db('tags').insert({ id: 1, tag: 'finance', title: 'Finance' })
    const models: Record<string, unknown> & { knex: Knex } = { knex: db }
    vi.stubGlobal('WIKI', { config: {}, configSvc: {}, events: { inbound: {}, outbound: {} }, lang: {},
      logger: console, models, startedAt: {}, Error: pageErrors,
      auth: { loadPageRuleAuthority, checkPageAccess: auth.checkPageAccess, checkAccess: auth.checkAccess } })
    const [pageModule, historyModule, operationModule] = await Promise.all([
      import('../../models/pages.ts'), import('../../models/pageHistory.ts'), import('../../operations/pages.ts')
    ])
    pages = pageModule.default.bindKnex(db)
    history = historyModule.default.bindKnex(db)
    models.pages = pages
    models.pageHistory = history
    operations = operationModule.default
  })

  afterAll(async () => {
    try { if (db) await db.destroy() } finally { vi.unstubAllGlobals() }
  })

  it('reads current and historical source and enforces grant expiry while LISTEN occupies the other connection', async () => {
    const bcrypt = (await import('bcryptjs-then')).default
    const passwordHash = await bcrypt.hash('owned-native-unlock-fixture', 4)
    const listener = await db.client.acquireConnection()
    try {
      await db.raw('LISTEN tsepistle_page_authorization_transaction').connection(listener)
      await db.transaction(async transaction => {
        const now = new Date()
        const page = { id: 42, path: 'docs/transaction', hash: 'transaction-page', title: 'Current transaction source',
          description: '', visibility: 'public', ownerId: null, authorId: requester.id, creatorId: requester.id,
          sourceRevision: '4', renderedSourceRevision: '4', changeReason: null,
          isPublished: true, isSearchable: true, publishStartDate: null, publishEndDate: null,
          content: 'Current source admitted inside the decision transaction', render: '<p>Current source</p>',
          toc: '[]', contentType: 'markdown', editorKey: 'markdown', localeCode: 'en', extra: '{}', createdAt: now, updatedAt: now }
        await transaction('pages').insert(page)
        await transaction('pageTags').insert({ pageId: page.id, tagId: 1 })
        const { creatorId, renderedSourceRevision, render, toc, ...historical } = page
        await transaction('pageHistory').insert({ ...historical, id: 61, pageId: page.id, sourceRevision: '3',
          title: 'Historical transaction source', content: 'Historical source with the original finance tag', action: 'updated', versionDate: now })
        await transaction('pageHistoryTags').insert({ pageId: 61, tagId: 1 })
        const authority = await loadPageRuleAuthority(requester, transaction)
        // The row and its tags are uncommitted, join metadata is cold, and no
        // spare connection exists. A global/nested read cannot satisfy this.
        const current = await pages.getPageFromDb(page.id, transaction)
        expect(current).toMatchObject({ title: page.title, content: page.content, sourceRevision: '4' })
        expect(current?.tags.map(tag => tag.tag)).toEqual(['finance'])
        const version = await history.getVersion({ pageId: page.id, versionId: 61, requester, authority, transaction })
        expect(version).toMatchObject({ title: 'Historical transaction source', content: 'Historical source with the original finance tag', sourceRevision: '3', tags: ['finance'] })
        await transaction('pageAccessPasswords').insert({ pageId: page.id, passwordHash,
          version: 1, updatedBy: requester.id, updatedAt: now })
        const sessionId = 'page-authorization-transaction'
        await transaction('pageUnlockGrants').insert({ id: 'owned-grant', pageId: page.id, sessionId,
          userId: requester.id, passwordVersion: 1, createdAt: now, expiresAt: new Date(now.valueOf() + 60_000) })
        const admitted = await operations.authorizedPageSource({ id: page.id, requester, sessionId }, authority, transaction)
        expect(admitted.content).toBe(page.content)
        await operations.authorizeMutation({ kind: 'restore', input: { pageId: page.id, versionId: 61 }, requester, sessionId, authority }, transaction)
        await transaction('pageUnlockGrants').where({ id: 'owned-grant' }).update({ expiresAt: new Date(now.valueOf() - 1) })
        await expect(operations.authorizedPageSource({ id: page.id, requester, sessionId }, authority, transaction))
          .rejects.toMatchObject({ name: 'PAGE_LOCKED', status: 403 })
        await expect(operations.authorizeMutation({ kind: 'restore', input: { pageId: page.id, versionId: 61 }, requester, sessionId, authority }, transaction))
          .rejects.toMatchObject({ name: 'PAGE_LOCKED', status: 403 })
      })
    } finally {
      try { await db.raw('UNLISTEN tsepistle_page_authorization_transaction').connection(listener) }
      finally { await db.client.releaseConnection(listener) }
    }
  }, 15_000)
})
