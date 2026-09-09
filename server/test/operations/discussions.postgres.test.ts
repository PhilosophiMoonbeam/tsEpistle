import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createDiscussionSettingsStore, type DiscussionDefinition } from '../../operations/discussion-settings.ts'
import { createDiscussionModerationStore } from '../../operations/discussion-moderation.ts'
import { createDiscussionPostingStore, type DiscussionPostInput } from '../../operations/discussion-posting.ts'
import { up, down } from '../../db/migrations/tsepistle-000016-discussion-moderation.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE ? fs.readFileSync(process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = database.endsWith('_discussion_test') && password ? { host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432), user: 'wiki', database, password } : null
const suite = connection ? describe : describe.skip
const definitions: DiscussionDefinition[] = [{ key: 'default', title: 'Default', isAvailable: true, props: { akismet: { type: 'string', sensitive: true }, minDelay: { type: 'number' } } }, { key: 'commento', title: 'Commento', isAvailable: true, codeTemplate: true, props: { instanceUrl: { type: 'string' } } }]
const permissions = (user: unknown): string[] => { const value = user && typeof user === 'object' ? Reflect.get(user, 'permissions') : undefined; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
const authorityFor = (requester: unknown) => ({
  requester,
  permissions: permissions(requester),
  groups: [],
  tagAliases: {}
})
const admin = { id: 1, permissions: ['manage:system', 'read:pages', 'write:comments'] } as never
suite('PostgreSQL discussion lifecycle and policy', () => {
  let db: Knex, settings: ReturnType<typeof createDiscussionSettingsStore>, moderation: ReturnType<typeof createDiscussionModerationStore>, posts: ReturnType<typeof createDiscussionPostingStore>, failActivation = false, spamChecks: number[] = [], oldWiki: unknown
  const post = (overrides: Partial<DiscussionPostInput> = {}): DiscussionPostInput => ({ pageId: 1, replyTo: 0, content: 'A useful contribution', render: '<p>A useful contribution</p>', user: { id: 1, name: 'Reader', email: 'reader@example.invalid', ip: '192.0.2.1' }, requester: admin, sessionId: 'test-session', ...overrides })
  beforeAll(async () => {
    globalThis.WIKI = {
      auth: {
        checkAccess: (user: unknown, requested: string[]) => requested.some(p => permissions(user).includes(p)),
        checkPageAccess: (user: unknown, requested: string[], _context: unknown, authority: { requester: unknown; permissions: string[] }) =>
          authority.requester === user && requested.some(p => authority.permissions.includes(p)),
        loadPageRuleAuthority: async (requester: unknown) => authorityFor(requester)
      }
    } as never
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value'); table.string('updatedAt') })
    await db.schema.createTable('commentProviders', table => { table.string('key').primary(); table.boolean('isEnabled'); table.jsonb('config') })
    await db.schema.createTable('pages', table => { table.integer('id').primary(); table.string('title'); table.string('path'); table.string('localeCode'); table.string('visibility'); table.integer('ownerId'); table.string('updatedAt') })
    await db.schema.createTable('tags', table => { table.integer('id').primary(); table.string('tag') })
    await db.schema.createTable('pageTags', table => { table.integer('pageId'); table.integer('tagId') })
    await db.schema.createTable('pageAccessPasswords', table => { table.integer('pageId').primary(); table.integer('version') })
    await db.schema.createTable('pageUnlockGrants', table => { table.string('id'); table.integer('pageId'); table.string('sessionId'); table.integer('userId'); table.integer('passwordVersion'); table.timestamp('expiresAt') })
    await db.schema.createTable('comments', table => { table.increments('id'); table.integer('pageId').references('id').inTable('pages'); table.integer('authorId'); table.text('content'); table.text('render'); table.string('name'); table.string('email'); table.string('ip'); table.integer('replyTo').defaultTo(0); table.string('createdAt'); table.string('updatedAt') })
    await up(db)
    settings = createDiscussionSettingsStore({ db, definitions: () => definitions, fallbackFeatures: () => ({ featurePageComments: true, custom: 'keep' }), async activate() { if (failActivation) throw new Error('runtime unavailable'); return [] } })
    moderation = createDiscussionModerationStore(db)
    posts = createDiscussionPostingStore({
      db,
      fallbackFeatures: () => ({ featurePageComments: true }),
      loadPageRuleAuthority: async requester => authorityFor(requester),
      canPost: (_user, _page, authority) => authority.permissions.includes('write:comments'),
      async checkSpam({ page }) { spamChecks.push(Number(page.id)) }
    })
  })
  beforeEach(async () => {
    for (const table of ['discussionModerationHistory', 'pageDiscussionPolicy', 'comments', 'pageAccessPasswords', 'pageUnlockGrants', 'pageTags', 'tags', 'pages', 'commentProviders', 'settings']) await db(table).delete()
    await db('pages').insert([{ id: 1, title: 'Public guide', path: 'guide', localeCode: 'en', visibility: 'public', ownerId: null }, { id: 2, title: 'Private notes', path: 'private', localeCode: 'en', visibility: 'private', ownerId: 7 }])
    await db('commentProviders').insert([{ key: 'default', isEnabled: true, config: JSON.stringify({ akismet: 'saved-key', minDelay: 30, unknown: 'retained' }) }, { key: 'commento', isEnabled: false, config: JSON.stringify({ instanceUrl: 'https://comments.example.invalid' }) }])
    failActivation = false; spamChecks = []
  })
  afterAll(async () => { if (db) { for (const table of ['discussionModerationHistory', 'pageDiscussionPolicy', 'comments', 'pageUnlockGrants', 'pageAccessPasswords', 'pageTags', 'tags', 'pages', 'commentProviders', 'settings']) await db.schema.dropTableIfExists(table); await db.destroy() }; globalThis.WIKI = oldWiki as never })
  it('masks credentials, preserves masked secrets and unrelated flags, and retains undeclared stored settings', async () => {
    const initial = await settings.read(); expect(initial.providers[1]?.config.akismet).toBe('********')
    await settings.patchFeatures({ featurePageRatings: false })
    const result = await settings.write({ enabled: false, providers: [{ key: 'default', isEnabled: true, config: { akismet: '********', minDelay: 45 } }] }, initial.fingerprint)
    expect(result.enabled).toBe(false)
    expect((await db('commentProviders').where('key', 'default').first()).config).toEqual({ akismet: 'saved-key', minDelay: 45, unknown: 'retained' })
    expect((await db('settings').where('key', 'features').first()).value).toMatchObject({ featurePageComments: false, featurePageRatings: false, custom: 'keep' })
  })
  it('keeps exactly one available provider and rejects unknown configuration without partial writes', async () => {
    const initial = await settings.read()
    await expect(settings.write({ providers: [{ key: 'commento', isEnabled: true, config: {} }] }, initial.fingerprint)).rejects.toMatchObject({ status: 400 })
    await expect(settings.write({ providers: [{ key: 'default', isEnabled: true, config: { unknown: 'overwrite' } }] }, initial.fingerprint)).rejects.toMatchObject({ status: 400 })
    expect((await settings.read()).fingerprint).toBe(initial.fingerprint)
  })
  it('allows only one concurrent settings review and rejects ABA changes', async () => {
    const initial = await settings.read(), input = { enabled: false, providers: [{ key: 'default', isEnabled: true, config: {} }] }
    const results = await Promise.allSettled([settings.write(input, initial.fingerprint), settings.write(input, initial.fingerprint)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    const current = await settings.read(); await settings.write({ ...input, enabled: true }, current.fingerprint)
    await expect(settings.write(input, initial.fingerprint)).rejects.toMatchObject({ status: 409 })
  })
  it('reports committed settings if runtime activation fails and permits explicit credential removal', async () => {
    failActivation = true
    const initial = await settings.read(), result = await settings.write({ providers: [{ key: 'default', isEnabled: true, config: { akismet: '' } }] }, initial.fingerprint)
    expect(result.warnings).toHaveLength(1); expect((await settings.read()).providers.find(row => row.key === 'default')?.config.akismet).toBe('')
  })
  it('rolls back every provider when a later row violates persistence', async () => {
    const initial = await settings.read()
    await db.raw(`ALTER TABLE "commentProviders" ADD CONSTRAINT discussion_test_failure CHECK (NOT ("key" = 'default' AND "isEnabled" = false))`)
    try { await expect(settings.write({ providers: [{ key: 'commento', isEnabled: true, config: { instanceUrl: 'https://changed.example.invalid' } }, { key: 'default', isEnabled: false, config: {} }] }, initial.fingerprint)).rejects.toThrow(); expect((await settings.read()).fingerprint).toBe(initial.fingerprint) } finally { await db.raw('ALTER TABLE "commentProviders" DROP CONSTRAINT discussion_test_failure') }
  })
  it('hides/restores without altering source or edit timestamp and records an administrative reason', async () => {
    const id = await posts.post(post()), initial = await moderation.inspect(admin, id)
    const hidden = await moderation.moderate(admin, id, { hidden: true, reason: 'Needs a source reference', fingerprint: initial.fingerprint })
    expect(hidden.isHidden).toBe(true); expect(hidden.content).toBe(initial.content); expect(hidden.updatedAt).toBe(initial.updatedAt); expect(hidden.history[0]).toMatchObject({ action: 'hide', actorId: 1, reason: 'Needs a source reference' })
    const restored = await moderation.moderate(admin, id, { hidden: false, reason: 'Source reference reviewed', fingerprint: hidden.fingerprint })
    expect(restored.isHidden).toBe(false); expect(restored.history).toHaveLength(2)
    await expect(moderation.moderate(admin, id, { hidden: true, reason: 'Stale review', fingerprint: initial.fingerprint })).rejects.toMatchObject({ status: 409 })
    expect((await db('discussionModerationHistory').first())).not.toHaveProperty('content')
  })
  it('serializes competing moderation actions and notices a content edit after inspection', async () => {
    const id = await posts.post(post()), initial = await moderation.inspect(admin, id), input = { hidden: true, reason: 'Review contribution', fingerprint: initial.fingerprint }
    const results = await Promise.allSettled([moderation.moderate(admin, id, input), moderation.moderate(admin, id, input)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1); expect(await db('discussionModerationHistory')).toHaveLength(1)
    const latest = await moderation.inspect(admin, id); await db('comments').where('id', id).update({ content: 'Changed by another moderator' })
    await expect(moderation.moderate(admin, id, { ...input, hidden: false, fingerprint: latest.fingerprint })).rejects.toMatchObject({ status: 409 })
  })
  it('requires system management before reading private comments, history or policies', async () => {
    const user = { id: 7, permissions: ['read:pages', 'write:comments'] } as never
    await expect(moderation.list(user, {})).rejects.toMatchObject({ status: 403 }); await expect(moderation.inspect(user, 1)).rejects.toMatchObject({ status: 403 }); await expect(moderation.policy(user, 2)).rejects.toMatchObject({ status: 403 })
  })
  it('filters literal search characters and visibility with stable pagination', async () => {
    await posts.post(post({ content: 'Contains 100%_literal', pageId: 2 }))
    await posts.post(post({ user: { ...post().user, id: 3 }, content: 'Other text' }))
    expect((await moderation.list(admin, { search: '%_', visibility: 'private', limit: 1 })).total).toBe(1)
    const first = await moderation.list(admin, { limit: 1 }), next = await moderation.list(admin, { limit: 1, offset: 1 })
    expect(first.items[0]?.id).not.toBe(next.items[0]?.id); expect(first.items[0]).not.toHaveProperty('authorEmail')
  })
  it('closes/reopens with a reason, retains comments and rejects posts while closed', async () => {
    const id = await posts.post(post()), initial = await moderation.policy(admin, 1)
    const closed = await moderation.setPolicy(admin, 1, { closed: true, reason: 'Question has been resolved', fingerprint: initial.fingerprint })
    expect(closed.closed).toBe(true); expect((await moderation.closedPages(admin, {})).total).toBe(1)
    await expect(posts.post(post({ user: { ...post().user, id: 3 } }))).rejects.toMatchObject({ status: 409 }); expect(await db('comments').where('id', id)).toHaveLength(1)
    await moderation.setPolicy(admin, 1, { closed: false, reason: 'New evidence available', fingerprint: closed.fingerprint })
    await expect(moderation.setPolicy(admin, 1, { closed: true, reason: 'Stale page review', fingerprint: initial.fingerprint })).rejects.toMatchObject({ status: 409 })
  })
  it('separates guest delays by IP and serializes simultaneous posts from the same identity', async () => {
    const user = { ...post().user, id: 2 }
    const result = await Promise.allSettled([posts.post(post({ user })), posts.post(post({ user }))])
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect((result.find(row => row.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(429)
    await expect(posts.post(post({ user: { ...user, ip: '192.0.2.2' } }))).resolves.toBeNumber()
  })
  it('uses creation time rather than edit time for posting delay', async () => {
    const id = await posts.post(post()); await db('comments').where('id', id).update({ createdAt: new Date(Date.now() - 60000).toISOString(), updatedAt: new Date().toISOString() })
    await expect(posts.post(post())).resolves.toBeNumber()
  })
  it('does not send private/protected content to spam checking and enforces password grants', async () => {
    await posts.post(post({ pageId: 2 })); expect(spamChecks).toEqual([])
    await db('pageAccessPasswords').insert({ pageId: 1, version: 2 })
    const requester = { id: 8, permissions: ['read:pages', 'write:comments'] } as never, input = post({ requester, user: { ...post().user, id: 8 } })
    await expect(posts.post(input)).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    await db('pageUnlockGrants').insert({ id: 'grant', pageId: 1, sessionId: 'test-session', userId: 8, passwordVersion: 2, expiresAt: new Date(Date.now() + 60000) })
    await posts.post(input); expect(spamChecks).toEqual([])
  })
  it('rejects posting when paused, external provider active or reply parent unavailable before spam checking', async () => {
    await settings.patchFeatures({ featurePageComments: false }); await expect(posts.post(post())).rejects.toMatchObject({ status: 409 })
    await settings.patchFeatures({ featurePageComments: true }); await expect(posts.post(post({ replyTo: 999 }))).rejects.toMatchObject({ status: 409 })
    const current = await settings.read(); await settings.write({ providers: [{ key: 'default', isEnabled: false, config: {} }, { key: 'commento', isEnabled: true, config: {} }] }, current.fingerprint)
    await expect(posts.post(post())).rejects.toMatchObject({ status: 409 }); expect(spamChecks).toEqual([])
  })
  it('holds the page closure boundary until an in-flight accepted post is persisted', async () => {
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const slow = createDiscussionPostingStore({
      db,
      fallbackFeatures: () => ({ featurePageComments: true }),
      loadPageRuleAuthority: async requester => authorityFor(requester),
      canPost: () => true,
      async checkSpam() { entered(); await gate }
    })
    const posting = slow.post(post()); await ready
    const initial = await moderation.policy(admin, 1); let closed = false
    const closing = moderation.setPolicy(admin, 1, { closed: true, reason: 'End this conversation', fingerprint: initial.fingerprint }).then(value => { closed = true; return value })
    await new Promise(resolve => setTimeout(resolve, 60)); expect(closed).toBe(false); release(); await posting; await closing
    await expect(posts.post(post({ user: { ...post().user, id: 3 } }))).rejects.toMatchObject({ status: 409 })
  })
  it('serializes a first persisted global pause against a post using fallback feature settings', async () => {
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const slow = createDiscussionPostingStore({
      db,
      fallbackFeatures: () => ({ featurePageComments: true }),
      loadPageRuleAuthority: async requester => authorityFor(requester),
      canPost: () => true,
      async checkSpam() { entered(); await gate }
    })
    const posting = slow.post(post()); await ready; let paused = false
    const pausing = settings.patchFeatures({ featurePageComments: false }).then(() => { paused = true })
    await new Promise(resolve => setTimeout(resolve, 60)); expect(paused).toBe(false); release(); await posting; await pausing
    await expect(posts.post(post({ user: { ...post().user, id: 3 } }))).rejects.toMatchObject({ status: 409 })
  })
  it('preserves lifecycle state on downgrade and permits a clean up/down migration', async () => {
    const initial = await moderation.policy(admin, 1); await moderation.setPolicy(admin, 1, { closed: true, reason: 'Preserve this policy', fingerprint: initial.fingerprint })
    await expect(down(db)).rejects.toThrow('lifecycle data'); expect(await db.schema.hasColumn('comments', 'isHidden')).toBe(true)
    await db('discussionModerationHistory').delete(); await db('pageDiscussionPolicy').delete(); await down(db); expect(await db.schema.hasColumn('comments', 'isHidden')).toBe(false); await up(db)
  })
})
