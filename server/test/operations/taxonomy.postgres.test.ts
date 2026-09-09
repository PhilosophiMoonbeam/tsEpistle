import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import auth, { loadPageRuleAuthority, type PageRuleAuthority } from '../../core/auth.ts'
import { createTaxonomyService, type TaxonomyActor } from '../../operations/taxonomy.ts'
import { up as migrateTaxonomy, down as rollbackTaxonomy } from '../../db/migrations/tsepistle-000015-taxonomy-lifecycle.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE ? fs.readFileSync(process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = database.endsWith('_taxonomy_test') && password ? { host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432), user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki', database, password } : null
const suite = connection ? describe : describe.skip
const actor: TaxonomyActor = { requester: { id: 1, permissions: ['manage:system'] }, sessionId: 'taxonomy-test' }
const now = '2026-09-01T00:00:00.000Z'
const authorityRequester = { id: 1, ownershipUserId: null, groups: [1], api: 41, permissions: ['read:pages'] }
const originalWiki = globalThis.WIKI
const denyRuleSet = [
  { match: 'START', path: '', deny: false, roles: ['read:pages'] },
  { match: 'TAG', path: 'source', deny: true, roles: ['read:pages'] }
]
suite('PostgreSQL taxonomy transactions', () => {
  let db: Knex
  let peerDb: Knex
  let service: ReturnType<typeof createTaxonomyService>
  let locked = false, failHistory = false, failRefresh = false
  const runtime = (knex: Knex) => ({
    config: {}, configSvc: {}, events: { inbound: {}, outbound: {} }, lang: {}, logger: {}, models: { knex }, startedAt: {}
  })
  const loadAuthority = async (knex: Knex): Promise<PageRuleAuthority> => {
    const previous = globalThis.WIKI
    globalThis.WIKI = runtime(knex) as never
    try { return await loadPageRuleAuthority(authorityRequester) } finally { globalThis.WIKI = previous }
  }
  const pageContext = async (knex: Knex) => ({
    path: 'p1',
    locale: 'en',
    tags: await knex('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', 1).select('tags.tag')
  })
  const pageAllowed = async (knex: Knex, authority: PageRuleAuthority) =>
    auth.checkPageAccess(authorityRequester, ['read:pages'], await pageContext(knex), authority)
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    peerDb = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    globalThis.WIKI = runtime(db) as never
    await db.schema.createTable('tags', t => { t.increments('id'); t.string('tag').unique().notNullable(); t.string('title'); t.timestamp('createdAt'); t.timestamp('updatedAt') })
    await migrateTaxonomy(db)
    await db.schema.createTable('pages', t => {
      t.increments('id'); t.string('title'); t.string('path'); t.string('localeCode'); t.string('visibility'); t.integer('ownerId'); t.bigInteger('sourceRevision').notNullable().defaultTo(1)
      t.string('hash'); t.integer('authorId'); t.text('content'); t.string('contentType'); t.string('description'); t.string('editorKey'); t.boolean('isPublished'); t.jsonb('extra'); t.timestamp('updatedAt')
    })
    await db.schema.createTable('pageTags', t => { t.integer('pageId').references('id').inTable('pages').onDelete('CASCADE'); t.integer('tagId').references('id').inTable('tags'); t.primary(['pageId', 'tagId']) })
    await db.schema.createTable('groups', t => { t.increments('id'); t.string('name'); t.jsonb('permissions'); t.jsonb('pageRules') })
    await db.schema.createTable('pageHistory', t => { t.increments('id'); t.integer('pageId'); t.bigInteger('sourceRevision'); t.text('content'); t.jsonb('extra') })
    await db.schema.createTable('pageHistoryTags', t => { t.integer('pageId').references('id').inTable('pageHistory').onDelete('CASCADE'); t.integer('tagId').references('id').inTable('tags') })
    await db.schema.createTable('outboxEvents', t => { t.uuid('id').primary(); t.text('type'); t.integer('version'); t.text('aggregateType'); t.text('aggregateId'); t.text('payload'); t.timestamp('createdAt'); t.timestamp('publishedAt') })
    await db.schema.createTable('pageMutationOutbox', t => {
      t.uuid('id').primary(); t.integer('pageId'); t.bigInteger('sourceRevision'); for (const field of ['effectKind', 'effectKey', 'desiredState', 'payloadSha256', 'payload', 'status']) t.text(field)
      t.integer('attempts'); for (const field of ['availableAt', 'createdAt', 'updatedAt']) t.timestamp(field); t.unique(['pageId', 'sourceRevision', 'effectKind'])
    })
    service = createTaxonomyService({ db, authorize(input) { if (!input.requester?.permissions?.includes('manage:system')) throw Object.assign(new Error('Forbidden'), { status: 403 }); return 1 },
      async assertUnlocked() { if (locked) throw Object.assign(new Error('Page locked'), { status: 403 }) },
      async snapshotPage(input) { if (failHistory) throw new Error('History write failed'); const tx = input.transaction!; const [h] = await tx('pageHistory').insert({ pageId: input.id, sourceRevision: input.sourceRevision, content: input.content, extra: JSON.stringify(input.extra) }).returning('id'); const assignments = await tx('pageTags').where('pageId', input.id); if (assignments.length) await tx('pageHistoryTags').insert(assignments.map(a => ({ pageId: h.id, tagId: a.tagId }))) },
      async refresh() { if (failRefresh) throw new Error('Cache unavailable'); return [] }
    })
  })
  beforeEach(async () => {
    locked = false; failHistory = false; failRefresh = false
    for (const table of ['outboxEvents', 'pageMutationOutbox', 'pageHistoryTags', 'pageHistory', 'pageTags', 'groups', 'pages']) await db(table).delete()
    await db('tags').update({ redirectToId: null }); await db('tags').delete()
    await db('tags').insert([{ id: 1, tag: 'source', title: 'Source', createdAt: now, updatedAt: now }, { id: 2, tag: 'target', title: 'Target', createdAt: now, updatedAt: now }])
    await db.raw("SELECT setval(pg_get_serial_sequence('tags', 'id'), 2)")
    await db('pages').insert([1, 2, 3].map(id => ({ id, title: `Page ${id}`, path: `p${id}`, localeCode: 'en', visibility: id === 3 ? 'private' : 'public', ownerId: id === 3 ? 7 : null, sourceRevision: 9, hash: `hash${id}`, authorId: 7, content: `# Page ${id}`, contentType: 'markdown', description: '', editorKey: 'markdown', isPublished: false, extra: '{}', updatedAt: now })))
    await db('pageTags').insert([{ pageId: 1, tagId: 1 }, { pageId: 2, tagId: 2 }, { pageId: 3, tagId: 1 }, { pageId: 3, tagId: 2 }])
    await db('groups').insert({ id: 1, name: 'Readers', permissions: JSON.stringify(['read:pages']), pageRules: JSON.stringify([{ match: 'TAG', path: 'source', deny: false, roles: ['read:pages'] }]) })
  })
  afterAll(async () => {
    if (db) {
      for (const table of ['outboxEvents', 'pageMutationOutbox', 'pageHistoryTags', 'pageHistory', 'pageTags', 'groups', 'pages', 'tags']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
    if (peerDb) await peerDb.destroy()
    globalThis.WIKI = originalWiki
  })
  it('persists rename aliases, exact historical assignments and durable projections while preserving visibility and ownership', async () => {
    const preview = await service.preview(actor, { action: 'edit', tagId: 1, tag: 'Renamed', title: 'New label' })
    expect(preview.accessChanges).toBe(false)
    const result = await service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint })
    expect(result.refreshWarnings).toEqual([])
    const source = await db('tags').where('id', 1).first()
    expect(source).toMatchObject({ tag: 'source', redirectToId: result.tagId })
    expect(await db('pageTags').where('pageId', 1).pluck('tagId')).toEqual([result.tagId])
    expect(await db('pageHistoryTags').orderBy('tagId').pluck('tagId')).toEqual([1, 1, 2])
    expect(await db('pageMutationOutbox')).toHaveLength(8)
    expect(await db('outboxEvents').where('type', 'page.updated')).toHaveLength(2)
    expect(await db('pages').where('id', 3).first()).toMatchObject({ sourceRevision: '10', visibility: 'private', ownerId: 7, content: '# Page 3', isPublished: false })
    expect(await db('groups').where('id', 1).first()).toMatchObject({ pageRules: [{ match: 'TAG', path: 'source', deny: false, roles: ['read:pages'] }] })
    await expect(rollbackTaxonomy(db)).rejects.toThrow('lifecycle data')
  })
  it('uses fresh database authority after a rename when reloadGroups is not delivered', async () => {
    await db('groups').where('id', 1).update({ pageRules: JSON.stringify(denyRuleSet) })
    const stale = await loadAuthority(db)
    expect(stale.tagAliases).toMatchObject({ source: 'source' })
    expect(await pageAllowed(db, stale)).toBe(false)
    const preview = await service.preview(actor, { action: 'edit', tagId: 1, tag: 'renamed', title: '' })
    await service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint })
    expect(await db('groups').where('id', 1).first()).toMatchObject({ pageRules: denyRuleSet })
    // Keep the pre-commit snapshot to model a peer that missed the notification.
    expect(await pageAllowed(peerDb, stale)).toBe(true)
    const freshA = await loadAuthority(db), freshB = await loadAuthority(peerDb)
    expect(freshA.tagAliases).toMatchObject({ source: 'renamed' })
    expect(freshB.tagAliases).toMatchObject({ source: 'renamed' })
    expect(await pageAllowed(db, freshA)).toBe(false)
    expect(await pageAllowed(peerDb, freshB)).toBe(false)
  })
  it('uses fresh database authority after a merge to an existing canonical tag when reloadGroups is not delivered', async () => {
    await db('groups').where('id', 1).update({ pageRules: JSON.stringify(denyRuleSet) })
    const stale = await loadAuthority(db)
    expect(stale.tagAliases).toMatchObject({ source: 'source' })
    expect(await pageAllowed(db, stale)).toBe(false)
    const preview = await service.preview(actor, { action: 'merge', tagId: 1, targetId: 2 })
    await service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint, acknowledgeAccess: true })
    expect(await db('groups').where('id', 1).first()).toMatchObject({ pageRules: denyRuleSet })
    expect(await db('pageTags').where('pageId', 1).pluck('tagId')).toEqual([2])
    // Keep the pre-commit snapshot to model a peer that missed the notification.
    expect(await pageAllowed(peerDb, stale)).toBe(true)
    const freshA = await loadAuthority(db), freshB = await loadAuthority(peerDb)
    expect(freshA.tagAliases).toMatchObject({ source: 'target' })
    expect(freshB.tagAliases).toMatchObject({ source: 'target' })
    expect(await pageAllowed(db, freshA)).toBe(false)
    expect(await pageAllowed(peerDb, freshB)).toBe(false)
  })
  it('requires acknowledgement for merge access changes and deduplicates page assignments', async () => {
    const preview = await service.preview(actor, { action: 'merge', tagId: 1, targetId: 2 })
    expect(preview.rules[0]).toMatchObject({ before: 1, after: 2, added: 1 })
    await expect(service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint })).rejects.toThrow('Acknowledge')
    expect(await db('pageHistory')).toHaveLength(0)
    await service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint, acknowledgeAccess: true })
    expect(await db('pageTags').where('pageId', 3).pluck('tagId')).toEqual([2])
    expect(await db('pageHistoryTags').where('tagId', 1)).toHaveLength(2)
  })
  it('rejects concurrent page revisions, assignments and group rule changes with no partial writes', async () => {
    const change = { action: 'archive', tagId: 1 }
    let preview = await service.preview(actor, change)
    await db('pages').where('id', 1).increment('sourceRevision', 1)
    await expect(service.apply(actor, { change, fingerprint: preview.fingerprint, acknowledgeAccess: true })).rejects.toMatchObject({ status: 409 })
    preview = await service.preview(actor, change)
    await db('pageTags').insert({ pageId: 2, tagId: 1 })
    await expect(service.apply(actor, { change, fingerprint: preview.fingerprint, acknowledgeAccess: true })).rejects.toMatchObject({ status: 409 })
    preview = await service.preview(actor, change)
    await db('groups').where('id', 1).update({ pageRules: '[]' })
    await expect(service.apply(actor, { change, fingerprint: preview.fingerprint, acknowledgeAccess: true })).rejects.toMatchObject({ status: 409 })
    expect(await db('pageHistory')).toHaveLength(0)
    expect(await db('tags').where('id', 1).first()).toMatchObject({ isArchived: false, redirectToId: null })
  })
  it('rejects an assignment committed while the reviewed mutation waits for shared authoring locks', async () => {
    const change = { action: 'archive', tagId: 1 }, preview = await service.preview(actor, change)
    const writer = await db.transaction()
    await writer('tags').where('id', 1).forShare().first()
    let reachedLock!: () => void
    const waiting = new Promise<void>(resolve => { reachedLock = resolve })
    const queryListener = ({ sql }: { sql: string }) => { if (sql.includes('from "tags"') && sql.includes('for update')) reachedLock() }
    db.on('query', queryListener)
    const outcome = service.apply(actor, { change, fingerprint: preview.fingerprint, acknowledgeAccess: true }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    try {
      await waiting
      await writer('pageTags').insert({ pageId: 2, tagId: 1 })
      await writer.commit()
      expect((await outcome).error).toMatchObject({ status: 409 })
      expect(await db('pageHistory')).toHaveLength(0)
      expect(await db('pageTags').where({ pageId: 2, tagId: 1 })).toHaveLength(1)
    } finally { db.removeListener('query', queryListener); if (!writer.isCompleted()) await writer.rollback() }
  })

  it('rolls back on protection and history failures, but reports cache failure as a saved change', async () => {
    const preview = await service.preview(actor, { action: 'edit', tagId: 1, tag: 'renamed', title: '' })
    locked = true
    await expect(service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint })).rejects.toMatchObject({ status: 403 })
    locked = false; failHistory = true
    await expect(service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint })).rejects.toThrow('History write failed')
    expect(await db('tags')).toHaveLength(2)
    expect(await db('pageMutationOutbox')).toHaveLength(0)
    failHistory = false; failRefresh = true
    const result = await service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint })
    expect(result.refreshWarnings).toHaveLength(1)
    expect(await db('tags').where('id', result.tagId).first()).toMatchObject({ tag: 'renamed' })
  })
  it('archives assignments without deleting history and restores names without reconstructing old usage', async () => {
    let preview = await service.preview(actor, { action: 'archive', tagId: 1 })
    await service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint, acknowledgeAccess: true })
    expect(await db('pageTags').where('tagId', 1)).toHaveLength(0)
    expect(await db('pageHistoryTags').where('tagId', 1)).toHaveLength(2)
    preview = await service.preview(actor, { action: 'restore', tagId: 1 })
    await service.apply(actor, { change: preview.change, fingerprint: preview.fingerprint })
    expect(await db('pageTags').where('tagId', 1)).toHaveLength(0)
    expect(await db('tags').where('id', 1).first()).toMatchObject({ isArchived: false })
  })
  it('creates unused tags, rejects duplicate names and enforces administration access for reads and writes', async () => {
    const result = await service.create(actor, { tag: '  Future ', title: 'Future' })
    expect((await service.list(actor)).find(t => t.id === result.id)).toMatchObject({ tag: 'future', pageCount: 0 })
    await expect(service.create(actor, { tag: 'future', title: '' })).rejects.toMatchObject({ status: 409 })
    const denied = { requester: undefined, sessionId: '' }
    await expect(service.list(denied)).rejects.toMatchObject({ status: 403 })
    await expect(service.create(denied, { tag: 'secret', title: '' })).rejects.toMatchObject({ status: 403 })
    await expect(service.legacyChange(actor, { action: 'archive', tagId: 1 })).rejects.toThrow('Administration')
  })
})
