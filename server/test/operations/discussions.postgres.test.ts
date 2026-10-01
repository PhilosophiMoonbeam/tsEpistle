import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createDiscussionSettingsStore, type DiscussionDefinition, writeDiscussionWorkspace } from '../../operations/discussion-settings.ts'
import { createDiscussionModerationStore } from '../../operations/discussion-moderation.ts'
import { createDiscussionPostingStore, type DiscussionPostInput } from '../../operations/discussion-posting.ts'
import { up, down } from '../../db/migrations/tsepistle-000016-discussion-moderation.ts'
import { up as addCommentMentions, down as removeCommentMentions } from '../../db/migrations/tsepistle-000033-comment-mentions.ts'
const connection = getPostgresTestConnection('_discussion_test', import.meta.path)
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
  const waitForPendingAdvisoryLock = async (classid: number, objid: number, objsubid: number): Promise<void> => {
    const deadline = performance.now() + 2_000
    do {
      const waiting = await db('pg_locks')
        .where({ locktype: 'advisory', classid, objid, objsubid, mode: 'ExclusiveLock', granted: false })
        .where('database', db.raw('(SELECT oid FROM pg_database WHERE datname = current_database())'))
        .first('pid')
      if (waiting) return
    } while (performance.now() < deadline)
    throw new Error('Expected the policy change to wait for the admitted post advisory lock')
  }
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
    await db.schema.createTable('users', table => { table.integer('id').primary(); table.string('name') })
    await db.schema.createTable('pageRatings', table => { table.integer('pageId').notNullable().references('id').inTable('pages').onDelete('CASCADE'); table.integer('userId').notNullable().references('id').inTable('users').onDelete('CASCADE'); table.string('kind', 8).notNullable(); table.integer('value').notNullable(); table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('updatedAt', { useTz: true }).notNullable(); table.unique(['pageId', 'userId']) })
    await addCommentMentions(db)
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
    for (const table of ['discussionModerationHistory', 'pageDiscussionPolicy', 'comments', 'pageRatings', 'userHandleClaims', 'users', 'pageAccessPasswords', 'pageUnlockGrants', 'pageTags', 'tags', 'pages', 'commentProviders', 'settings']) await db(table).delete()
    await db('pages').insert([{ id: 1, title: 'Public guide', path: 'guide', localeCode: 'en', visibility: 'public', ownerId: null }, { id: 2, title: 'Private notes', path: 'private', localeCode: 'en', visibility: 'private', ownerId: 7 }])
    await db('commentProviders').insert([{ key: 'default', isEnabled: true, config: JSON.stringify({ akismet: 'saved-key', minDelay: 30, unknown: 'retained' }) }, { key: 'commento', isEnabled: false, config: JSON.stringify({ instanceUrl: 'https://comments.example.invalid' }) }])
    failActivation = false; spamChecks = []
  })
  afterAll(async () => { if (db) { await removeCommentMentions(db); for (const table of ['discussionModerationHistory', 'pageDiscussionPolicy', 'comments', 'pageRatings', 'users', 'pageUnlockGrants', 'pageAccessPasswords', 'pageTags', 'tags', 'pages', 'commentProviders', 'settings']) await db.schema.dropTableIfExists(table); await db.destroy() }; globalThis.WIKI = oldWiki as never })
  it('keeps claimed mention handles permanent across account deletion', async () => {
    await db('users').insert([{ id: 7, name: 'Alice', handle: 'alice' }, { id: 8, name: 'Other' }])
    await db('userHandleClaims').insert({ handle: 'alice', userId: 7 })
    await expect(Promise.resolve(db('users').where('id', 8).update({ handle: 'Alice' }))).rejects.toThrow()
    await db('users').where('id', 7).delete()
    expect(await db('userHandleClaims').where('handle', 'alice').first()).toMatchObject({ userId: null })
    await expect(Promise.resolve(db('userHandleClaims').insert({ handle: 'alice', userId: 8 }))).rejects.toThrow()
    await expect(removeCommentMentions(db)).rejects.toThrow('permanent user mention handle claims')
  })

  it('masks credentials, preserves masked secrets and unrelated flags, and retains undeclared stored settings', async () => {
    const initial = await settings.read(); expect(initial.providers[1]?.config.akismet).toBe('********')
    await settings.patchFeatures({ featurePageRatings: false })
    const current = await settings.read(), result = await settings.write({ enabled: false, providers: [{ key: 'default', isEnabled: true, config: { akismet: '********', minDelay: 45 } }] }, current.fingerprint)
    expect(result.enabled).toBe(false)
    expect((await db('commentProviders').where('key', 'default').first()).config).toEqual({ akismet: 'saved-key', minDelay: 45, unknown: 'retained' })
    expect((await db('settings').where('key', 'features').first()).value).toMatchObject({ featurePageComments: false, featurePageRatings: false, custom: 'keep' })
  })
  it('persists a validated rating mode in the fingerprinted policy without changing provider settings', async () => {
    const initial = await settings.read()
    expect(initial).toMatchObject({ pageRatingsMode: 'thumbs', pageRatingsEnabled: false })
    const result = await settings.write({ enabled: initial.enabled, pageRatingsMode: 'stars', providers: initial.providers }, initial.fingerprint)
    expect(result).toMatchObject({ pageRatingsMode: 'stars', pageRatingsEnabled: false })
    expect((await db('settings').where('key', 'features').first()).value).toMatchObject({ featurePageComments: true, pageRatingsMode: 'stars', custom: 'keep' })
    expect((await db('commentProviders').where('key', 'default').first()).config).toEqual({ akismet: 'saved-key', minDelay: 30, unknown: 'retained' })
    const changed = await settings.read()
    expect(changed.fingerprint).not.toBe(initial.fingerprint)
    await expect(settings.write({ enabled: changed.enabled, pageRatingsMode: 'hearts', providers: changed.providers }, changed.fingerprint)).rejects.toMatchObject({ status: 400 })
    expect(await settings.read()).toMatchObject({ fingerprint: changed.fingerprint, pageRatingsMode: 'stars' })
    await expect(settings.write({ enabled: changed.enabled, pageRatingsMode: 'thumbs', providers: changed.providers }, initial.fingerprint)).rejects.toMatchObject({ status: 409 })
    await settings.patchFeatures({ featurePageRatings: true })
    expect(await settings.read()).toMatchObject({ pageRatingsMode: 'stars', pageRatingsEnabled: true })
    await expect(writeDiscussionWorkspace({ id: 7, permissions: ['read:pages'] } as never, { enabled: true, pageRatingsMode: 'stars', providers: changed.providers }, changed.fingerprint)).rejects.toMatchObject({ status: 403 })
  })
  it('persists rating availability independently from comments and preserves existing votes', async () => {
    await settings.patchFeatures({ featurePageRatings: true })
    await db('users').insert({ id: 7, name: 'Reader' })
    const vote = { pageId: 1, userId: 7, kind: 'thumbs', value: 1, createdAt: new Date('2025-01-01T00:00:00.000Z'), updatedAt: new Date('2025-01-01T00:00:00.000Z') }
    await db('pageRatings').insert(vote)
    const preservedVote = await db('pageRatings').where({ pageId: 1, userId: 7 }).first(), initial = await settings.read()
    const input = { enabled: false, pageRatingsEnabled: true, pageRatingsMode: 'stars', providers: initial.providers }
    const result = await settings.write(input, initial.fingerprint)
    expect(result).toMatchObject({ enabled: false, pageRatingsEnabled: true, pageRatingsMode: 'stars' })
    expect((await db('settings').where('key', 'features').first()).value).toMatchObject({ featurePageComments: false, featurePageRatings: true, pageRatingsMode: 'stars', custom: 'keep' })
    expect(await db('pageRatings').where({ pageId: 1, userId: 7 }).first()).toEqual(preservedVote)

    const current = await settings.read()
    await expect(settings.write({ ...input, pageRatingsEnabled: false }, initial.fingerprint)).rejects.toMatchObject({ status: 409 })
    expect(await settings.read()).toMatchObject({ fingerprint: current.fingerprint, enabled: false, pageRatingsEnabled: true, pageRatingsMode: 'stars' })

    const disabled = await settings.write({ ...input, pageRatingsEnabled: false, providers: current.providers }, current.fingerprint)
    expect(disabled).toMatchObject({ enabled: false, pageRatingsEnabled: false, pageRatingsMode: 'stars' })
    expect(await db('pageRatings').where({ pageId: 1, userId: 7 }).first()).toEqual(preservedVote)
  })
  it('rejects missing or malformed public rating gates without mutating saved settings', async () => {
    const initial = await settings.read()
    const providers = [{ key: 'default', isEnabled: true, config: { minDelay: 45 } }]
    const input = { enabled: false, pageRatingsMode: 'stars', providers }
    await expect(writeDiscussionWorkspace(admin, input, initial.fingerprint)).rejects.toMatchObject({ status: 400 })
    for (const pageRatingsEnabled of [null, 'true', 1]) {
      const invalid = { ...input, pageRatingsEnabled }
      await expect(writeDiscussionWorkspace(admin, invalid, initial.fingerprint)).rejects.toMatchObject({ status: 400 })
      await expect(settings.write(invalid, initial.fingerprint)).rejects.toMatchObject({ status: 400 })
    }
    expect(await settings.read()).toMatchObject({ fingerprint: initial.fingerprint, pageRatingsEnabled: false, pageRatingsMode: 'thumbs' })
    expect((await db('commentProviders').where('key', 'default').first()).config).toMatchObject({ minDelay: 30 })

    const invalidFingerprint = initial.fingerprint.slice(0, -1) + (initial.fingerprint.endsWith('0') ? '1' : '0')
    await expect(settings.write({ ...input, pageRatingsEnabled: true }, invalidFingerprint)).rejects.toMatchObject({ status: 409 })
    expect(await settings.read()).toMatchObject({ fingerprint: initial.fingerprint, pageRatingsEnabled: false, pageRatingsMode: 'thumbs' })
    expect((await db('commentProviders').where('key', 'default').first()).config).toMatchObject({ minDelay: 30 })
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
  it('reports committed settings if runtime activation fails and preserves an omitted internal rating gate', async () => {
    await settings.patchFeatures({ featurePageRatings: true })
    failActivation = true
    const initial = await settings.read(), result = await settings.write({ providers: [{ key: 'default', isEnabled: true, config: { akismet: '' } }] }, initial.fingerprint)
    expect(result.warnings).toHaveLength(1)
    expect(result.pageRatingsEnabled).toBe(true)
    expect((await settings.read()).providers.find(row => row.key === 'default')?.config.akismet).toBe('')
    expect((await settings.read()).pageRatingsEnabled).toBe(true)
  })
  it('rolls back provider, rating-gate and mode changes when feature persistence fails', async () => {
    const initial = await settings.read()
    await db.raw(`ALTER TABLE "settings" ADD CONSTRAINT discussion_test_failure CHECK ("key" <> 'features')`)
    try {
      await expect(settings.write({ enabled: false, pageRatingsEnabled: true, pageRatingsMode: 'stars', providers: [{ key: 'commento', isEnabled: true, config: { instanceUrl: 'https://changed.example.invalid' } }, { key: 'default', isEnabled: false, config: {} }] }, initial.fingerprint)).rejects.toThrow()
      expect(await settings.read()).toMatchObject({ fingerprint: initial.fingerprint, enabled: true, pageRatingsEnabled: false, pageRatingsMode: 'thumbs' })
      expect((await db('commentProviders').where('key', 'default').first())).toMatchObject({ isEnabled: true, config: { akismet: 'saved-key', minDelay: 30, unknown: 'retained' } })
      expect((await db('commentProviders').where('key', 'commento').first())).toMatchObject({ isEnabled: false, config: { instanceUrl: 'https://comments.example.invalid' } })
      expect((await db('settings').where('key', 'features').first())).toBeUndefined()
    } finally { await db.raw('ALTER TABLE "settings" DROP CONSTRAINT discussion_test_failure') }
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
    const privateLiteral = await posts.post(post({ content: 'Contains 100%_literal', pageId: 2 }))
    const otherPublic = await posts.post(post({ user: { ...post().user, id: 3 }, content: 'Other text' }))
    const unrelatedPrivate = await posts.post(post({ user: { ...post().user, id: 4 }, content: 'Unrelated private contribution', pageId: 2 }))
    const publicLiteral = await posts.post(post({ user: { ...post().user, id: 5 }, content: 'Public 100%_literal contribution' }))
    const ids = [privateLiteral, otherPublic, unrelatedPrivate, publicLiteral]
    await db('comments').whereIn('id', ids).update({ createdAt: '2026-01-01T00:00:00.000Z' })
    const matching = await moderation.list(admin, { search: '%_', visibility: 'private', limit: 1 })
    expect(matching.total).toBe(1)
    expect(matching.items.map(item => item.id)).toEqual([privateLiteral])
    const first = await moderation.list(admin, { limit: 1 }), next = await moderation.list(admin, { limit: 1, offset: 1 })
    const third = await moderation.list(admin, { limit: 1, offset: 2 }), fourth = await moderation.list(admin, { limit: 1, offset: 3 })
    expect([first, next, third, fourth].map(result => result.items[0]?.id)).toEqual([publicLiteral, unrelatedPrivate, otherPublic, privateLiteral])
    expect(first.items[0]).not.toHaveProperty('authorEmail')
  })
  it('closes/reopens with a reason, retains comments and rejects posts while closed', async () => {
    const id = await posts.post(post()), initial = await moderation.policy(admin, 1)
    const closed = await moderation.setPolicy(admin, 1, { closed: true, reason: 'Question has been resolved', fingerprint: initial.fingerprint })
    expect(closed.closed).toBe(true); expect((await moderation.closedPages(admin, {})).total).toBe(1)
    await expect(posts.post(post({ user: { ...post().user, id: 3 } }))).rejects.toMatchObject({ status: 409 }); expect(await db('comments').where('id', id)).toHaveLength(1)
    const reopened = await moderation.setPolicy(admin, 1, { closed: false, reason: 'New evidence available', fingerprint: closed.fingerprint })
    expect(reopened.closed).toBe(false)
    expect(await db('pageDiscussionPolicy').where('pageId', 1).first()).toMatchObject({ closed: false, reason: 'New evidence available' })
    const saved = await moderation.policy(admin, 1)
    expect(saved.closed).toBe(false)
    expect(saved.history.map(({ action, actorId, reason }) => ({ action, actorId, reason }))).toEqual([
      { action: 'reopen', actorId: 1, reason: 'New evidence available' },
      { action: 'close', actorId: 1, reason: 'Question has been resolved' }
    ])
    const accepted = await posts.post(post({ user: { ...post().user, id: 4 }, content: 'Contribution after reopening' }))
    expect(await db('comments').where('id', accepted).first()).toMatchObject({ pageId: 1, content: 'Contribution after reopening' })
    expect(await db('comments').where('id', id)).toHaveLength(1)
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
    const accepted = await posts.post(post())
    expect(accepted).not.toBe(id)
    expect(await db('comments').where('id', accepted).first()).toMatchObject({ pageId: 1, content: post().content })
    expect(await db('comments').where('id', id)).toHaveLength(1)
  })
  it('does not send private/protected content to spam checking and enforces password grants', async () => {
    await posts.post(post({ pageId: 2 })); expect(spamChecks).toEqual([])
    await db('pageAccessPasswords').insert({ pageId: 1, version: 2 })
    const requester = { id: 8, permissions: ['read:pages', 'write:comments'] } as never, input = post({ requester, user: { ...post().user, id: 8 } })
    await expect(posts.post(input)).rejects.toMatchObject({ status: 403, name: 'PAGE_LOCKED' })
    await db('pageUnlockGrants').insert({ id: 'grant', pageId: 1, sessionId: 'test-session', userId: 8, passwordVersion: 2, expiresAt: new Date(Date.now() + 60000) })
    await posts.post(input); expect(spamChecks).toEqual([])
  })
  it('normalizes reply ancestry to one visible same-page root', async () => {
    const root = await posts.post(post())
    const reply = await posts.post(post({ replyTo: root, user: { ...post().user, id: 3 } }))
    const nested = await posts.post(post({ replyTo: reply, user: { ...post().user, id: 4 } }))
    expect((await db('comments').where('id', reply).first()).replyTo).toBe(root)
    expect((await db('comments').where('id', nested).first()).replyTo).toBe(root)

    const otherPageRoot = await posts.post(post({ pageId: 2, user: { ...post().user, id: 5 } }))
    await expect(posts.post(post({ replyTo: otherPageRoot, user: { ...post().user, id: 6 } }))).rejects.toMatchObject({ status: 409 })
    await db('comments').where('id', root).update({ isHidden: true })
    await expect(posts.post(post({ replyTo: reply, user: { ...post().user, id: 7 } }))).rejects.toMatchObject({ status: 409 })
  })

  it('rejects posting when paused, external provider active or reply parent unavailable before spam checking', async () => {
    await settings.patchFeatures({ featurePageComments: false }); await expect(posts.post(post())).rejects.toMatchObject({ status: 409 })
    await settings.patchFeatures({ featurePageComments: true }); await expect(posts.post(post({ replyTo: 999 }))).rejects.toMatchObject({ status: 409 })
    const current = await settings.read(); await settings.write({ providers: [{ key: 'default', isEnabled: false, config: {} }, { key: 'commento', isEnabled: true, config: {} }] }, current.fingerprint)
    await expect(posts.post(post())).rejects.toMatchObject({ status: 409 }); expect(spamChecks).toEqual([])
  })
  it('holds the page closure boundary until an in-flight accepted post is persisted', async () => {
    const { promise: ready, resolve: entered } = Promise.withResolvers<void>()
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const slow = createDiscussionPostingStore({
      db,
      fallbackFeatures: () => ({ featurePageComments: true }),
      loadPageRuleAuthority: async requester => authorityFor(requester),
      canPost: () => true,
      async checkSpam() { entered(); await gate }
    })
    const initial = await moderation.policy(admin, 1)
    let closed = false
    const posting = slow.post(post())
    let drained: Promise<PromiseSettledResult<unknown>[]> = Promise.allSettled([posting])
    try {
      await Promise.race([ready, posting.then(() => { throw new Error('Post completed before entering the spam gate') })])
      const closing = moderation.setPolicy(admin, 1, { closed: true, reason: 'End this conversation', fingerprint: initial.fingerprint }).then(async value => {
        closed = true
        expect(await db('comments').where({ pageId: 1, content: post().content }).first()).toMatchObject({ pageId: 1, content: post().content })
        return value
      })
      drained = Promise.allSettled([posting, closing])
      await waitForPendingAdvisoryLock(72401641, 1, 2)
      expect(closed).toBe(false)
      release()
      const accepted = await posting
      expect(await db('comments').where('id', accepted).first()).toMatchObject({ pageId: 1, content: post().content })
      await closing
      await expect(posts.post(post({ user: { ...post().user, id: 3 } }))).rejects.toMatchObject({ status: 409 })
    } finally {
      release()
      await drained
    }
  })
  it('serializes a first persisted global pause against a post using fallback feature settings', async () => {
    const { promise: ready, resolve: entered } = Promise.withResolvers<void>()
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const slow = createDiscussionPostingStore({
      db,
      fallbackFeatures: () => ({ featurePageComments: true }),
      loadPageRuleAuthority: async requester => authorityFor(requester),
      canPost: () => true,
      async checkSpam() { entered(); await gate }
    })
    expect(await db('settings').where('key', 'features').first()).toBeUndefined()
    let paused = false
    const posting = slow.post(post())
    let drained: Promise<PromiseSettledResult<unknown>[]> = Promise.allSettled([posting])
    try {
      await Promise.race([ready, posting.then(() => { throw new Error('Post completed before entering the spam gate') })])
      expect(await db('settings').where('key', 'features').first()).toBeUndefined()
      const pausing = settings.patchFeatures({ featurePageComments: false }).then(async () => {
        paused = true
        expect(await db('comments').where({ pageId: 1, content: post().content }).first()).toMatchObject({ pageId: 1, content: post().content })
      })
      drained = Promise.allSettled([posting, pausing])
      await waitForPendingAdvisoryLock(0, 72401640, 1)
      expect(paused).toBe(false)
      release()
      const accepted = await posting
      expect(await db('comments').where('id', accepted).first()).toMatchObject({ pageId: 1, content: post().content })
      await pausing
      await expect(posts.post(post({ user: { ...post().user, id: 3 } }))).rejects.toMatchObject({ status: 409 })
    } finally {
      release()
      await drained
    }
  })
  it('preserves lifecycle state on downgrade and permits a clean up/down migration', async () => {
    const initial = await moderation.policy(admin, 1); await moderation.setPolicy(admin, 1, { closed: true, reason: 'Preserve this policy', fingerprint: initial.fingerprint })
    await expect(down(db)).rejects.toThrow('lifecycle data'); expect(await db.schema.hasColumn('comments', 'isHidden')).toBe(true)
    await db('discussionModerationHistory').delete(); await db('pageDiscussionPolicy').delete(); await down(db); expect(await db.schema.hasColumn('comments', 'isHidden')).toBe(false); await up(db)
  })
})
