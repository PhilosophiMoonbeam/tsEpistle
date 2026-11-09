import createKnex, { type Knex } from 'knex'
import * as Y from 'yjs'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as notesUp } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import { up as importUp } from '../../db/migrations/tsepistle-000072-hedgedoc-import.ts'
import { hedgedocImport, hedgeDocDigest } from '../../operations/hedgedoc-import.ts'
import { createLiveNotesStore, readLiveNotePublication } from '../../operations/live-notes.ts'
import { encodeCollaborationUpdate, decodeCollaborationUpdate } from '../../../shared/collaboration.ts'
import type { HedgeDocInput, HedgeDocReview } from '../../../shared/hedgedoc-import.ts'

const connection = getPostgresTestConnection('_hedgedoc_import_test', import.meta.path)
const suite = connection ? describe : describe.skip
const owner = { id: 7, authVersion: 0 } as Express.User
const peer = { id: 8, authVersion: 0 } as Express.User
const tables = ['hedgedocImports', 'liveNoteConnections', 'liveNoteRequests', 'liveNoteRevisions', 'liveNotes', 'assetData', 'assets', 'storage', 'tags', 'userGroups', 'groups', 'users']
const fixture = (): HedgeDocInput => ({ snapshot: { format: 'hedgedoc-content-v1', namespace: 'selected-read-only-export', notes: [{ id: 'original-id', markdown: '# Imported\n![selected](https://source.invalid/selected.txt)', author: 'Untrusted original label', timestamp: '2018-02-03T04:05:06Z', historyComplete: false, history: [{ id: 'old', author: 'Someone else', timestamp: '2017-01-01T00:00:00Z', markdown: 'Older unverified source' }], assets: [{ id: 'asset-one', url: 'https://source.invalid/selected.txt', mime: 'text/plain', base64: Buffer.from('selected asset').toString('base64'), sha256: hedgeDocDigest('selected asset') }] }] }, choices: [{ sourceId: 'original-id', ownerId: 7, target: { kind: 'create', key: 'selected-native-note' }, assets: [{ sourceId: 'asset-one', action: 'import', filename: 'selected.txt', rewrite: true }] }] })
const executeInput = (input: HedgeDocInput, review: HedgeDocReview) => ({ ...input, reviewDigest: review.items[0]!.reviewDigest })
suite('owned PostgreSQL reviewed HedgeDoc content import', () => {
  let db: Knex
  let originalWiki: unknown
  beforeAll(async () => {
    // Execution must reuse the sole connection held by its native asset fence.
    db = createKnex({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    originalWiki = Reflect.get(globalThis, 'WIKI')
    // Install the complete native auth runtime guard; authority comes from this owned database.
    Reflect.set(globalThis, 'WIKI', {
      config: { db: { type: 'postgres' }, lang: { code: 'en' }, uploads: { maxFiles: 1, maxFileSize: 1024 * 1024 } },
      configSvc: {}, lang: {}, startedAt: {}, events: {}, logger: console,
      models: { knex: db },
      auth: { loadPageRuleAuthority, checkPageAccess: auth.checkPageAccess }
    })
    await db.schema.createTable('users', table => { table.integer('id').primary(); table.boolean('isActive').notNullable().defaultTo(true); table.integer('authVersion').notNullable().defaultTo(0); table.text('name').notNullable().defaultTo('Native actor'); table.text('email').notNullable().defaultTo('native@example.invalid') })
    await db.schema.createTable('groups', table => { table.integer('id').primary(); table.text('name').notNullable(); table.jsonb('permissions').notNullable(); table.jsonb('pageRules').notNullable() })
    await db.schema.createTable('userGroups', table => { table.integer('userId'); table.integer('groupId') })
    await db.schema.createTable('tags', table => { table.integer('id').primary(); table.text('tag').notNullable(); table.integer('redirectToId'); table.boolean('isArchived').notNullable().defaultTo(false) })
    await db.schema.createTable('storage', table => { table.string('key').primary(); table.boolean('isEnabled'); table.string('mode'); table.string('syncInterval'); table.jsonb('config') })
    await db.schema.createTable('assets', table => { table.increments('id'); table.string('filename'); table.string('hash').unique(); table.string('ext'); table.string('kind'); table.string('mime'); table.integer('fileSize'); table.integer('folderId').nullable(); table.integer('authorId'); table.jsonb('metadata'); table.timestamp('createdAt', { useTz: true }); table.timestamp('updatedAt', { useTz: true }) })
    await db.schema.createTable('assetData', table => { table.integer('id').primary().references('id').inTable('assets'); table.binary('data') })
    await notesUp(db); await importUp(db)
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('users').insert([{ id: 7 }, { id: 8 }])
    await db('groups').insert({ id: 3, name: 'Native import owners', permissions: JSON.stringify(['write:notes', 'write:assets']), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['write:assets'] }]) })
    await db('userGroups').insert([{ userId: 7, groupId: 3 }, { userId: 8, groupId: 3 }])
  })
  afterAll(async () => {
    if (db) { for (const table of tables) await db.schema.dropTableIfExists(table); await db.destroy() }
    Reflect.set(globalThis, 'WIKI', originalWiki)
  })
  const store = () => hedgedocImport
  const notes = () => createLiveNotesStore({ db, secret: 'test-only-session-root', audience: 'urn:hedgedoc:test' })

  it('inventories without writes, imports real native content/assets, retains untrusted history and supplies captured publication authority', async () => {
    const input = fixture(), original = structuredClone(input)
    const review = await store().review(owner, input)
    for (const table of ['liveNotes', 'liveNoteRevisions', 'assets', 'assetData', 'hedgedocImports']) expect(await db(table).select()).toHaveLength(0)
    const receipt = await store().execute(owner, executeInput(input, review))
    expect(receipt).toMatchObject({ status: 'imported', assets: [{ sourceId: 'asset-one', status: 'imported', destination: '/selected.txt' }] })
    const note = await notes().read(owner, receipt.key)
    expect(note).toMatchObject({ ownerId: 7, access: 'private' })
    const captured = await db.transaction(tx => readLiveNotePublication(tx, owner, note.id, receipt.revision))
    expect(captured).toEqual({ text: '# Imported\n![selected](/selected.txt)', revision: receipt.revision })
    expect((await db('assetData').first()).data.toString('utf8')).toBe('selected asset')
    const history = await notes().history(owner, receipt.key)
    expect(history.items).toHaveLength(1); expect(history.items[0]!.actorId).toBe(7)
    expect(new Date(history.items[0]!.createdAt).getUTCFullYear()).toBeGreaterThan(2018)
    const provenance = await store().provenance(owner, receipt.key)
    expect(provenance).toMatchObject({ untrusted: true, importedBy: 7, source: input.snapshot.notes[0], nativeRevision: receipt.revision })
    await expect(store().provenance(peer, receipt.key)).rejects.toMatchObject({ name: 'NOTE_NOT_FOUND' })
    expect(input).toEqual(original)
  })
  it('rewrites only admitted native Markdown destinations and preserves code, literals, references, HTML and directive source', async () => {
    const input = fixture()
    const url = input.snapshot.notes[0]!.assets[0]!.url
    const unchanged = [
      `Prose ${url}`,
      `\`[literal](${url})\``,
      `\\[escaped](${url})`,
      `\`\`\`md\n![code](${url})\n\`\`\``,
      `[reference][asset]\n\n[asset]: ${url}`,
      `<span>[html](${url})</span>`,
      `# [heading](${url})`,
      `\`\`\`wiki-extension\n{"url":"${url}"}\n\`\`\``
    ]
    input.snapshot.notes[0]!.markdown = [`[link](${url}) and ![image](<${url}>)`, ...unchanged].join('\n\n')
    const review = await store().review(owner, input)
    const receipt = await store().execute(owner, executeInput(input, review))
    const note = await notes().read(owner, receipt.key)
    const captured = await db.transaction(tx => readLiveNotePublication(tx, owner, note.id, receipt.revision))
    expect(captured!.text).toBe(['[link](/selected.txt) and ![image](</selected.txt>)', ...unchanged].join('\n\n'))
    expect((await store().provenance(owner, receipt.key)).source.markdown).toBe(input.snapshot.notes[0]!.markdown)
  })
  it('resumes a batch after interruption between items with exact stable associations and per-item asset outcomes', async () => {
    const input = fixture()
    const secondSource = structuredClone(input.snapshot.notes[0]!)
    secondSource.id = 'second-original-id'; secondSource.markdown = '# Second selected note'
    input.snapshot.notes.push(secondSource)
    input.choices.push({ sourceId: secondSource.id, ownerId: 7, target: { kind: 'create', key: 'second-native-note' }, assets: [{ sourceId: 'asset-one', action: 'skip' }] })
    const review = await store().review(owner, input)
    const first = await store().execute(owner, { snapshot: input.snapshot, choices: [input.choices[0]], reviewDigest: review.items[0]!.reviewDigest })
    // An interrupted operator resumes using a fresh operation instance and the original finite snapshot.
    const resumedReview = await store().review(owner, input)
    expect(resumedReview.items.map(item => item.status)).toEqual(['imported', 'ready'])
    const resumed = await store().execute(owner, { snapshot: input.snapshot, choices: [input.choices[1]], reviewDigest: review.items[1]!.reviewDigest })
    expect(resumed.assets).toEqual([{ sourceId: 'asset-one', status: 'skipped', destination: null }])
    expect(Number((await db('liveNotes').where('key', first.key).first()).revision)).toBe(first.revision)
    expect(await db('hedgedocImports').select()).toHaveLength(2)
    expect(await db('liveNoteRevisions').select()).toHaveLength(2)
    expect(await db('assets').select()).toHaveLength(1)
  })
  it('rolls back a native interruption after admitted asset insertion and resumes without orphan bytes or duplicate history', async () => {
    const input = fixture(), review = await store().review(owner, input)
    await db.raw("CREATE FUNCTION fail_selected_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned interrupt'; END $$")
    await db.raw('CREATE TRIGGER interrupt_selected_import BEFORE INSERT ON "liveNoteRevisions" FOR EACH ROW EXECUTE FUNCTION fail_selected_import()')
    try {
      await expect(store().execute(owner, executeInput(input, review))).rejects.toThrow('owned interrupt')
      for (const table of ['liveNotes', 'liveNoteRevisions', 'assets', 'assetData', 'hedgedocImports']) expect(await db(table).select()).toHaveLength(0)
    } finally { await db.raw('DROP TRIGGER interrupt_selected_import ON "liveNoteRevisions"'); await db.raw('DROP FUNCTION fail_selected_import()') }
    const concurrent = await Promise.allSettled([store().execute(owner, executeInput(input, review)), store().execute(owner, executeInput(input, review))])
    const committed = concurrent.filter(result => result.status === 'fulfilled')
    expect(committed.some(result => result.status === 'fulfilled' && result.value.status === 'imported')).toBe(true)
    for (const result of concurrent) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'ASSET_LOCATION_BUSY' })
    expect((await store().execute(owner, executeInput(input, review))).status).toBe('already-imported')
    for (const table of ['liveNotes', 'liveNoteRevisions', 'assets', 'assetData', 'hedgedocImports']) expect(await db(table).select()).toHaveLength(1)
  })
  it('does not overwrite a native concurrent edit and never replays imported revisions on repeat', async () => {
    const input = fixture(), review = await store().review(owner, input)
    const first = await store().execute(owner, executeInput(input, review))
    const note = await notes().read(owner, first.key)
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, decodeCollaborationUpdate(note.state)); const before = Y.encodeStateVector(doc)
      doc.getText('content').insert(0, 'Native edit\n')
      await notes().applyUpdate(owner, first.key, { requestId: 'native-concurrent-edit', update: encodeCollaborationUpdate(Y.encodeStateAsUpdate(doc, before)) })
    } finally { doc.destroy() }
    expect((await store().execute(owner, executeInput(input, review))).status).toBe('already-imported')
    const current = await notes().read(owner, first.key)
    expect((await db.transaction(tx => readLiveNotePublication(tx, owner, current.id, current.revision)))!.text).toStartWith('Native edit\n')
    expect((await notes().history(owner, first.key)).items).toHaveLength(2)
    const destination = await notes().create(owner, { key: 'independent-native-target' })
    const update = fixture(); update.snapshot.namespace = 'another-source'; update.choices[0]!.target = { kind: 'update', key: destination.key, expectedRevision: destination.revision }
    update.choices[0]!.assets = [{ sourceId: 'asset-one', action: 'skip' }]
    const updateReview = await store().review(owner, update)
    await notes().updateAccess(owner, destination.key, { expectedRevision: destination.revision, access: 'read' })
    await expect(store().execute(owner, executeInput(update, updateReview))).rejects.toMatchObject({ name: 'HEDGEDOC_DESTINATION_CONFLICT' })
    expect((await db('hedgedocImports').select()).length).toBe(1)
  })
  it('atomically updates an explicitly reviewed existing note without deleting its native history or identity', async () => {
    const destination = await notes().create(owner, { key: 'reviewed-update-target' })
    const input = fixture()
    input.choices[0]!.target = { kind: 'update', key: destination.key, expectedRevision: destination.revision }
    input.choices[0]!.assets = [{ sourceId: 'asset-one', action: 'skip' }]
    const review = await store().review(owner, input)
    const receipt = await store().execute(owner, executeInput(input, review))
    const current = await notes().read(owner, destination.key)
    expect(current.id).toBe(destination.id)
    expect(current.revision).toBe(destination.revision + 1)
    expect((await notes().history(owner, destination.key)).items).toHaveLength(2)
    expect(await db.transaction(tx => readLiveNotePublication(tx, owner, destination.id, destination.revision))).toEqual({ text: '', revision: 0 })
    expect((await db.transaction(tx => readLiveNotePublication(tx, owner, destination.id, receipt.revision)))!.text).toBe(input.snapshot.notes[0]!.markdown)
    expect(await db('assets').select()).toHaveLength(0)
  })
  it('refuses administrator impersonation, revoked sessions and independent asset authority', async () => {
    const input = fixture()
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['manage:system']) })
    input.choices[0]!.ownerId = 8
    await expect(store().review(owner, input)).rejects.toMatchObject({ name: 'HEDGEDOC_OWNER_REQUIRED' })
    input.choices[0]!.ownerId = 7
    const review = await store().review(owner, input)
    await db('users').where('id', 7).update({ authVersion: 1 })
    await expect(store().execute(owner, executeInput(input, review))).rejects.toMatchObject({ name: 'AUTH_REQUIRED' })
    await db('users').where('id', 7).update({ authVersion: 0 })
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['write:notes']) })
    await expect(store().execute(owner, executeInput(input, review))).rejects.toMatchObject({ name: 'HEDGEDOC_ASSET_FORBIDDEN' })
    await db('groups').where('id', 3).update({
      permissions: JSON.stringify(['write:notes', 'write:assets']),
      pageRules: JSON.stringify([
        { match: 'START', path: '', deny: false, roles: ['write:assets'] },
        { match: 'EXACT', path: 'selected.txt', deny: true, roles: ['write:assets'] }
      ])
    })
    // A current note owner with global asset permission still cannot import into a denied native path.
    await expect(store().execute(owner, executeInput(input, review))).rejects.toMatchObject({ name: 'HEDGEDOC_ASSET_FORBIDDEN' })
    for (const table of ['liveNotes', 'liveNoteRevisions', 'assets', 'assetData', 'hedgedocImports']) expect(await db(table).select()).toHaveLength(0)
  })
  it('refuses source drift, corrupted bytes and asset collisions; preserves skipped source URLs and detects later asset mutation', async () => {
    const input = fixture(), review = await store().review(owner, input)
    const changed = structuredClone(input); changed.snapshot.notes[0]!.markdown += ' changed'
    await expect(store().execute(owner, executeInput(changed, review))).rejects.toMatchObject({ name: 'HEDGEDOC_REVIEW_CONFLICT' })
    const corrupt = structuredClone(input); corrupt.snapshot.notes[0]!.assets[0]!.base64 = Buffer.from('corrupt').toString('base64')
    await expect(store().review(owner, corrupt)).rejects.toMatchObject({ name: 'HEDGEDOC_ASSET_INVALID' })
    const receipt = await store().execute(owner, executeInput(input, review))
    const colliding = fixture(); colliding.snapshot.namespace = 'different-instance'; colliding.choices[0]!.target.key = 'other-native-note'
    await expect(store().review(owner, colliding)).rejects.toMatchObject({ name: 'HEDGEDOC_ASSET_CONFLICT' })
    colliding.choices[0]!.assets = [{ sourceId: 'asset-one', action: 'skip' }]
    const skippedReview = await store().review(owner, colliding)
    const skipped = await store().execute(owner, executeInput(colliding, skippedReview))
    expect(skipped.assets).toEqual([{ sourceId: 'asset-one', status: 'skipped', destination: null }])
    const skippedNote = await notes().read(owner, skipped.key)
    expect((await db.transaction(tx => readLiveNotePublication(tx, owner, skippedNote.id, skipped.revision)))!.text).toContain('https://source.invalid/selected.txt')
    await db('assetData').update({ data: Buffer.from('native replacement') })
    await expect(store().execute(owner, executeInput(input, review))).rejects.toMatchObject({ name: 'HEDGEDOC_ASSET_CONFLICT' })
    expect((await db('assetData').first()).data.toString()).toBe('native replacement')
    expect(Number((await db('liveNotes').where('key', receipt.key).first()).revision)).toBe(receipt.revision)
  })
})
