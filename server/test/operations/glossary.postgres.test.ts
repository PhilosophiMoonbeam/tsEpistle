import knexModule, { type Knex } from 'knex'
import { DateTime } from 'luxon'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createGlossaryOperations, type GlossaryOperations } from '../../operations/glossary.ts'
import { loadPageRuleAuthority } from '../../core/auth.ts'
import { up, down } from '../../db/migrations/tsepistle-000056-glossary.ts'
import type { GlossaryTermInput } from '../../../shared/glossary.ts'

const connection = getPostgresTestConnection('_glossary_test', import.meta.path)
const suite = connection ? describe : describe.skip
const requester = { id: 7, authVersion: 0, permissions: ['manage:system'], groups: [1] }
const context = { requester, sessionId: 'glossary-reader-session' }
const admin = { requester: { id: 1, authVersion: 0 }, sessionId: 'glossary-admin-session' }
const term = (name: string, overrides: Partial<GlossaryTermInput> = {}): GlossaryTermInput => ({
  locale: 'en',
  term: name,
  expansion: '',
  definition: '',
  category: '',
  aliases: [],
  relatedIds: [],
  documentationPageId: null,
  documentationLabel: '',
  references: [],
  caseSensitive: false,
  autoLink: true,
  ...overrides
})
const policy = () => [
  { match: 'EXACT', path: 'glossary', deny: false, roles: ['read:glossary', 'manage:glossary'], locales: ['en'] },
  { match: 'START', path: '', deny: false, roles: ['read:pages'], locales: ['en'] }
]

suite('PostgreSQL glossary authority and atomic catalogs', () => {
  let db: Knex,
    operations: GlossaryOperations,
    enabled = true
  const originalWiki = Reflect.get(globalThis, 'WIKI')
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, "isActive" boolean NOT NULL DEFAULT true, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer REFERENCES users(id), "groupId" integer REFERENCES groups(id), PRIMARY KEY ("userId", "groupId"));
      CREATE TABLE tags (id integer PRIMARY KEY, tag text, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false);
      CREATE TABLE pages (id integer PRIMARY KEY, title text NOT NULL, path text NOT NULL, "localeCode" text NOT NULL,
        visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL DEFAULT true, "publishStartDate" text, "publishEndDate" text);
      CREATE TABLE "pageTags" ("pageId" integer REFERENCES pages(id), "tagId" integer REFERENCES tags(id));
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY REFERENCES pages(id), version integer NOT NULL);
      CREATE TABLE "pageUnlockGrants" (id text PRIMARY KEY, "pageId" integer REFERENCES pages(id), "sessionId" text,
        "userId" integer, "passwordVersion" integer, "expiresAt" timestamptz);
    `)
    await up(db)
    // Native authority loading requires the same initialized runtime envelope as
    // authentication; memberships, groups and tags still come from this database.
    Reflect.set(globalThis, 'WIKI', {
      config: {
        api: { isEnabled: true },
        auth: { audience: 'urn:test', tokenExpiration: '30m', tokenRenewal: '15m' },
        certs: { public: 'unused-public-key', private: 'unused-private-key' },
        features: { featurePageComments: false },
        host: 'https://wiki.example.invalid',
        sessionSecret: 'glossary-test-session-secret'
      },
      startedAt: DateTime.utc(),
      configSvc: { saveToDb: vi.fn() },
      events: { inbound: { on: vi.fn() }, outbound: { emit: vi.fn() } },
      lang: { t: (key: string) => key },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      models: { knex: db }
    })
    operations = createGlossaryOperations({ db, enabled: () => enabled, loadAuthority: loadPageRuleAuthority })
  })
  beforeEach(async () => {
    enabled = true
    for (const table of [
      'glossaryTermRelations',
      'glossaryNames',
      'glossaryTerms',
      'pageUnlockGrants',
      'pageAccessPasswords',
      'pageTags',
      'pages',
      'tags',
      'userGroups',
      'groups',
      'users'
    ])
      await db(table).delete()
    await db('users').insert([{ id: 1 }, { id: 7 }])
    await db('groups').insert([
      { id: 1, name: 'System', permissions: JSON.stringify(['manage:system']), pageRules: '[]' },
      { id: 3, name: 'Glossary editors', permissions: JSON.stringify(['read:glossary', 'manage:glossary', 'read:pages']), pageRules: JSON.stringify(policy()) }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 7, groupId: 3 }
    ])
  })
  afterAll(async () => {
    Reflect.set(globalThis, 'WIKI', originalWiki)
    if (!db) return
    for (const table of [
      'glossaryTermRelations',
      'glossaryNames',
      'glossaryTerms',
      'pageUnlockGrants',
      'pageAccessPasswords',
      'pageTags',
      'pages',
      'tags',
      'userGroups',
      'groups',
      'users'
    ])
      await db.schema.dropTableIfExists(table)
    await db.destroy()
  })

  it('uses current membership and exact locale/path rules rather than cached requester permissions', async () => {
    expect(await operations.access(context, 'en')).toMatchObject({ canRead: true, canManage: true })
    expect(await operations.access(context, 'fr')).toMatchObject({ canRead: false, canManage: false })
    await expect(operations.create(context, term('French', { locale: 'fr' }))).rejects.toMatchObject({ status: 403 })
    await db('groups')
      .where({ id: 3 })
      .update({
        pageRules: JSON.stringify([{ match: 'EXACT', path: 'another-path', deny: false, roles: ['read:glossary', 'manage:glossary'], locales: ['en'] }])
      })
    await expect(operations.list(context, { locale: 'en' })).rejects.toMatchObject({ status: 403 })
    await expect(operations.create(context, term('Denied'))).rejects.toMatchObject({ status: 403 })
    await db('groups')
      .where({ id: 3 })
      .update({ pageRules: JSON.stringify(policy()) })
    await db('userGroups').where({ userId: 7 }).delete()
    await expect(operations.create(context, term('Revoked'))).rejects.toMatchObject({ status: 403 })
    expect(await db('glossaryTerms')).toHaveLength(0)
  })

  it('rechecks session authority after waiting for another catalog writer', async () => {
    const lock = await db.transaction()
    await lock.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['tsepistle:glossary:en'])
    const pending = operations.create(context, term('Stale account'))
    // Attach the rejection handler before releasing the queued write.
    const outcome = pending.then(
      () => null,
      error => error
    )
    try {
      await db('users').where({ id: 7 }).update({ authVersion: 1 })
    } finally {
      await lock.commit()
    }
    expect(await outcome).toMatchObject({ status: 401 })
    expect(await db('glossaryTerms')).toHaveLength(0)
  })

  it('serializes account authority with a groups-first security writer without deadlocking', async () => {
    const writer = await db.transaction()
    await writer('groups').select('id').orderBy('id').forUpdate()
    let reachedGroupLock!: () => void
    const groupLock = new Promise<void>(resolve => { reachedGroupLock = resolve })
    const observe = (query: { sql: string }) => {
      if (query.sql.includes('from "groups"') && query.sql.includes('for share')) reachedGroupLock()
    }
    db.on('query', observe)
    const outcome = operations.access(context, 'en').then(value => value, error => error)
    try {
      await groupLock
      await writer('users').where({ id: 7 }).forUpdate().first()
      await writer('users').where({ id: 7 }).update({ authVersion: 1 })
      await writer.commit()
      expect(await outcome).toMatchObject({ status: 401 })
    } finally {
      db.off('query', observe)
      if (!writer.isCompleted()) await writer.rollback()
      await outcome
    }
  })

  it('atomically arbitrates canonical and alias claims across racing saves and keeps the old term on conflict', async () => {
    const results = await Promise.allSettled([
      operations.create(context, term('First', { aliases: ['  CAFÉ  '] })),
      operations.create(context, term('Cafe\u0301'))
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 409, name: 'GLOSSARY_NAME_CONFLICT' })
    const owner = await operations.lookup(context, 'en', ' café ')
    const other = await operations.create(context, term('Other', { aliases: ['Unchanged'] }))
    await expect(
      operations.update(context, other.id, { ...term('Replacement', { aliases: ['café'] }), expectedRevision: other.revision })
    ).rejects.toMatchObject({ status: 409 })
    expect((await operations.get(context, other.id)).term).toBe('Other')
    expect((await operations.lookup(context, 'en', 'Unchanged')).id).toBe(other.id)
    await expect(
      Promise.resolve(db('glossaryNames').insert({ locale: 'en', key: 'café', name: 'CAFE', termId: other.id, isAlias: true }))
    ).rejects.toMatchObject({ code: '23505' })
    expect((await operations.lookup(context, 'en', 'CAFÉ')).id).toBe(owner.id)
  })

  it('stores full Unicode-expanded canonical and alias keys independently of the 255-character name limit', async () => {
    const canonical = 'İ'.repeat(255)
    const alias = `${'İ'.repeat(254)}A`
    const entry = await operations.create(context, term(canonical, { aliases: [alias] }))
    expect(await db('glossaryNames').where({ termId: entry.id }).orderBy('isAlias').select('name', 'key', 'isAlias')).toEqual([
      { name: canonical, key: 'i\u0307'.repeat(255), isAlias: false },
      { name: alias, key: `${'i\u0307'.repeat(254)}a`, isAlias: true }
    ])
    expect((await operations.lookup(context, 'en', canonical)).id).toBe(entry.id)
    expect((await operations.lookup(context, 'en', alias)).id).toBe(entry.id)
    await expect(operations.create(context, term('Another', { aliases: [canonical] }))).rejects.toMatchObject({
      status: 409,
      name: 'GLOSSARY_NAME_CONFLICT'
    })
    await expect(operations.create(context, term('İ'.repeat(256)))).rejects.toMatchObject({ status: 400, name: 'GLOSSARY_INVALID_INPUT' })
    expect(await db('glossaryTerms')).toHaveLength(1)
  })

  it('preserves authored Markdown layout while rejecting forbidden controls and unsafe reference URLs', async () => {
    const definition = '\tIndented Markdown\r\n\nTrailing spaces  \n'
    const entry = await operations.create(context, term('Authored', { definition }))
    expect((await operations.get(context, entry.id)).definition).toBe(definition)
    for (const code of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f]) {
      const control = String.fromCharCode(code)
      for (const invalid of [term(`Invalid${control}name`), term('Invalid', { definition: `Before${control}after` })]) {
        await expect(operations.create(context, invalid)).rejects.toMatchObject({ status: 400, name: 'GLOSSARY_INVALID_INPUT' })
      }
    }
    for (const url of [
      'javascript:alert(1)',
      'https://user:password@example.test/path',
      'https://example.test/a b',
      'https://example.test/a\tb',
      'https://example.test/a\nb',
      'https://example.test/a\rb',
      'https://example.test/a\u00a0b',
      'https://example.test/a\u0000b',
      'https://example.test/a\u001fb',
      'https://example.test/a\u007fb'
    ]) {
      await expect(operations.create(context, term('Invalid reference', { references: [{ label: 'Reference', url }] }))).rejects.toMatchObject({
        status: 400,
        name: 'GLOSSARY_INVALID_INPUT'
      })
    }
    expect(await db('glossaryTerms')).toHaveLength(1)
  })

  it('fences both ends of symmetric relations and enforces same-locale relations in the database', async () => {
    const first = await operations.create(context, term('One'))
    const second = await operations.create(context, term('Two'))
    const linked = await operations.update(context, first.id, { ...term('One', { relatedIds: [second.id] }), expectedRevision: first.revision })
    const counterpart = await operations.get(context, second.id)
    expect(counterpart.relatedIds).toEqual([first.id])
    expect(counterpart.revision).toBe(second.revision + 1)
    await expect(operations.update(context, second.id, { ...term('Two'), expectedRevision: second.revision })).rejects.toMatchObject({ status: 409 })
    await expect(operations.remove(context, first.id, first.revision)).rejects.toMatchObject({ status: 409 })
    const french = await operations.create(admin, term('Trois', { locale: 'fr' }))
    await expect(
      operations.update(context, first.id, { ...term('One', { relatedIds: [french.id] }), expectedRevision: linked.revision })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      Promise.resolve(db('glossaryTermRelations').insert({ locale: 'en', leftId: Math.min(first.id, french.id), rightId: Math.max(first.id, french.id) }))
    ).rejects.toMatchObject({ code: '23503' })
    await operations.remove(context, first.id, linked.revision)
    expect(await operations.get(context, second.id)).toMatchObject({ relatedIds: [], revision: counterpart.revision + 1 })
  })

  it('withholds all documentation metadata until current page access and session unlock both allow it, following moves by ID', async () => {
    await db('pages').insert({ id: 42, title: 'Confidential title', path: 'secret/guide', localeCode: 'en', visibility: 'private', ownerId: 9 })
    const entry = await operations.create(admin, term('Documented', { documentationPageId: 42, documentationLabel: 'Confidential label' }))
    const read = await operations.get(context, entry.id)
    expect(read).toMatchObject({ documentation: null, documentationPageId: null, documentationLabel: '' })
    expect(JSON.stringify(read)).not.toContain('Confidential')
    await db('pages').where({ id: 42 }).update({ visibility: 'public', ownerId: null })
    await db('pageAccessPasswords').insert({ pageId: 42, version: 1 })
    expect((await operations.lookup(context, 'en', 'Documented')).documentation).toBeNull()
    await db('pageUnlockGrants').insert({
      id: 'grant',
      pageId: 42,
      sessionId: context.sessionId,
      userId: 7,
      passwordVersion: 1,
      expiresAt: new Date(Date.now() + 60_000)
    })
    expect((await operations.get(context, entry.id)).documentation?.href).toBe('/en/secret/guide')
    await db('pages').where({ id: 42 }).update({ path: 'moved/guide' })
    expect((await operations.get(context, entry.id)).documentation?.href).toBe('/en/moved/guide')
    expect((await operations.get({ ...context, sessionId: 'another-session' }, entry.id)).documentation).toBeNull()
    await db('pageAccessPasswords').where({ pageId: 42 }).update({ version: 2 })
    expect((await operations.get(context, entry.id)).documentation).toBeNull()
    await db('pageAccessPasswords').where({ pageId: 42 }).delete()
    await db('pages').where({ id: 42 }).update({ isPublished: false })
    expect((await operations.get(context, entry.id)).documentation).toBeNull()
  })

  it('preserves redacted documentation on omitted fields, rejects unauthorized changes, and permits explicit unlinking', async () => {
    await db('pages').insert([
      { id: 42, title: 'Confidential title', path: 'secret/guide', localeCode: 'en', visibility: 'private', ownerId: 9 },
      { id: 43, title: 'Another confidential title', path: 'secret/other', localeCode: 'en', visibility: 'private', ownerId: 9 }
    ])
    const entry = await operations.create(admin, term('Documented', { documentationPageId: 42, documentationLabel: 'Confidential label' }))
    let edited = await operations.update(context, entry.id, {
      locale: 'en',
      term: 'Documented',
      definition: 'Updated public definition',
      expectedRevision: entry.revision
    })
    expect(edited).toMatchObject({
      definition: 'Updated public definition',
      revision: entry.revision + 1,
      documentation: null,
      documentationPageId: null,
      documentationLabel: ''
    })
    expect(JSON.stringify(edited)).not.toContain('Confidential')
    expect(await operations.get(admin, entry.id)).toMatchObject({ documentationPageId: 42, documentationLabel: 'Confidential label' })
    for (const unchanged of [{ documentationPageId: 42 }, { documentationLabel: 'Confidential label' }]) {
      edited = await operations.update(context, entry.id, {
        locale: 'en',
        term: 'Documented',
        definition: 'Updated public definition',
        ...unchanged,
        expectedRevision: edited.revision
      })
      expect(edited).toMatchObject({ documentation: null, documentationPageId: null, documentationLabel: '' })
      expect(JSON.stringify(edited)).not.toContain('Confidential')
      expect(await operations.get(admin, entry.id)).toMatchObject({ documentationPageId: 42, documentationLabel: 'Confidential label' })
    }
    for (const change of [{ documentationPageId: 43, documentationLabel: 'Replacement label' }, { documentationLabel: 'Replacement label' }]) {
      await expect(operations.update(context, entry.id, { locale: 'en', term: 'Changed', ...change, expectedRevision: edited.revision })).rejects.toMatchObject(
        { status: 400, name: 'GLOSSARY_INVALID_INPUT' }
      )
      expect(await operations.get(admin, entry.id)).toMatchObject({
        term: 'Documented',
        definition: 'Updated public definition',
        revision: edited.revision,
        documentationPageId: 42,
        documentationLabel: 'Confidential label'
      })
    }
    await operations.update(context, entry.id, {
      locale: 'en',
      term: 'Documented',
      documentationPageId: null,
      documentationLabel: '',
      expectedRevision: edited.revision
    })
    expect(await operations.get(admin, entry.id)).toMatchObject({ documentation: null, documentationPageId: null, documentationLabel: '' })
  })

  for (const protection of ['private', 'locked'] as const) {
    for (const label of ['Confidential original label', '']) {
      for (const change of ['replace', 'unlink'] as const) {
        it(`rejects ${change} of ${protection} documentation with an omitted ${label ? 'nonempty' : 'empty'} label without mutation or disclosure`, async () => {
          await db('pages').insert([
            { id: 42, title: 'Original guide', path: 'original/guide', localeCode: 'en', visibility: 'public', ownerId: null },
            { id: 43, title: 'Readable replacement', path: 'replacement/guide', localeCode: 'en', visibility: 'public', ownerId: null }
          ])
          const entry = await operations.create(
            context,
            term('Documented', { aliases: ['Original alias'], documentationPageId: 42, documentationLabel: label })
          )
          // Revoke access after creation: the save must use current native page
          // authority, not the requester's cached permissions or past readability.
          if (protection === 'private') await db('pages').where({ id: 42 }).update({ visibility: 'private', ownerId: 9 })
          else await db('pageAccessPasswords').insert({ pageId: 42, version: 1 })
          const redacted = await operations.get(context, entry.id)
          expect(redacted).toMatchObject({
            revision: entry.revision,
            documentation: null,
            documentationPageId: null,
            documentationLabel: ''
          })
          expect(JSON.stringify(redacted)).not.toContain('Confidential original label')
          const stored = await db('glossaryTerms').where({ id: entry.id }).first()
          const names = await db('glossaryNames').where({ termId: entry.id }).orderBy('key')
          const replacementId = change === 'replace' ? 43 : null
          await expect(
            operations.update(context, entry.id, {
              locale: 'en',
              term: 'Attempted replacement',
              aliases: ['Attempted alias'],
              definition: 'Must not be committed',
              documentationPageId: replacementId,
              expectedRevision: redacted.revision
            })
          ).rejects.toMatchObject({ status: 400, name: 'GLOSSARY_INVALID_INPUT' })
          expect(await db('glossaryTerms').where({ id: entry.id }).first()).toEqual(stored)
          expect(await db('glossaryNames').where({ termId: entry.id }).orderBy('key')).toEqual(names)
          expect(await operations.get(context, entry.id)).toEqual(redacted)

          // Explicit replacement/clearing needs no knowledge of the hidden label.
          const replacementLabel = change === 'replace' ? 'New public label' : ''
          const edited = await operations.update(context, entry.id, {
            locale: 'en',
            term: 'Documented',
            documentationPageId: replacementId,
            documentationLabel: replacementLabel,
            expectedRevision: redacted.revision
          })
          expect(edited).toMatchObject({
            revision: redacted.revision + 1,
            documentationPageId: replacementId,
            documentationLabel: replacementLabel,
            documentation: change === 'replace' ? { id: 43, label: 'New public label' } : null
          })
          expect(JSON.stringify(edited)).not.toContain('Confidential original label')
          expect(await db('glossaryTerms').where({ id: entry.id }).first()).toMatchObject({
            documentationPageId: replacementId,
            documentationLabel: replacementLabel
          })
          if (change === 'unlink') {
            const relinked = await operations.update(context, entry.id, {
              locale: 'en',
              term: 'Documented',
              documentationPageId: 43,
              expectedRevision: edited.revision
            })
            expect(relinked).toMatchObject({
              documentationPageId: 43,
              documentationLabel: '',
              documentation: { id: 43, label: 'Readable replacement' }
            })
            expect(JSON.stringify(relinked)).not.toContain('Confidential original label')
          }
        })
      }
    }
  }

  it('uses current documentation tags for page-rule authorization without disclosing denied metadata', async () => {
    await db('pages').insert({ id: 42, title: 'Tagged guide', path: 'guide', localeCode: 'en', visibility: 'public', ownerId: null })
    await db('tags').insert({ id: 1, tag: 'documentation' })
    await db('pageTags').insert({ pageId: 42, tagId: 1 })
    await db('groups')
      .where({ id: 3 })
      .update({
        pageRules: JSON.stringify([
          { match: 'EXACT', path: 'glossary', deny: false, roles: ['read:glossary', 'manage:glossary'], locales: ['en'] },
          { match: 'TAG', path: 'documentation', deny: false, roles: ['read:pages'], locales: ['en'] }
        ])
      })
    const entry = await operations.create(context, term('Tagged', { documentationPageId: 42, documentationLabel: 'Tagged label' }))
    expect(entry.documentation).toMatchObject({ id: 42, title: 'Tagged guide', label: 'Tagged label', href: '/en/guide' })
    await db('pageTags').where({ pageId: 42 }).delete()
    const read = await operations.get(context, entry.id)
    expect(read).toMatchObject({ documentation: null, documentationPageId: null, documentationLabel: '' })
    expect(JSON.stringify(read)).not.toContain('Tagged guide')
    expect(JSON.stringify(read)).not.toContain('Tagged label')
  })

  it('reauthorizes bounded continuations and preserves names and data when disabled or rollback is refused', async () => {
    await operations.create(context, term('Alpha'))
    await operations.create(context, term('Beta'))
    const page = await operations.list(context, { locale: 'en', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.complete).toBe(false)
    expect(page.nextCursor).not.toBeNull()
    const next = await operations.list(context, { locale: 'en', limit: 1, cursor: page.nextCursor })
    expect(next.items.map(item => item.term)).toEqual(['Beta'])
    expect(next).toMatchObject({ complete: true, nextCursor: null })
    const links = await operations.autolink(context, { locale: 'en', limit: 1 })
    expect(links.complete).toBe(false)
    await expect(operations.autolink(context, { locale: 'en', cursor: page.nextCursor })).rejects.toMatchObject({ status: 400 })
    await db('userGroups').where({ userId: 7 }).delete()
    await expect(operations.list(context, { locale: 'en', cursor: page.nextCursor })).rejects.toMatchObject({ status: 403 })
    enabled = false
    expect(await operations.access(context, 'en')).toMatchObject({ enabled: false, canRead: false, canManage: false })
    await expect(operations.lookup(admin, 'en', 'Alpha')).rejects.toMatchObject({ name: 'GLOSSARY_DISABLED' })
    await expect(operations.create(admin, term('Gamma'))).rejects.toMatchObject({ name: 'GLOSSARY_DISABLED' })
    await expect(down(db)).rejects.toThrow('Cannot discard populated glossary data')
    expect(await db('glossaryTerms')).toHaveLength(2)
    expect(await db('glossaryNames')).toHaveLength(2)
  })
})
