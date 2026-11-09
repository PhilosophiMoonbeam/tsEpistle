import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import { DurableJobStore } from '../../core/durable-jobs.ts'
import type { DurableJobHandler } from '../../core/durable-jobs.ts'
import { up as addDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addOutbox } from '../../db/migrations/2.5.131.ts'
import { up as addPageWatching } from '../../db/migrations/2.5.132.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import { up as addNotificationPreferences } from '../../db/migrations/tsepistle-000058-discussion-notifications.ts'
import { createPageWatchNotificationHandler, type PageWatchWikiContext } from '../../jobs/page-watch-notification.ts'
import type * as notificationOperations from '../../operations/page-watching.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { defaultNotificationCeilings } from '../../../shared/site-notifications.ts'
import { getNotificationSettings, updateNotificationSettings } from '../../operations/notification-settings.ts'

const connection = getPostgresTestConnection('_notification_audience_test', import.meta.path)
const suite = connection ? describe : describe.skip
const recipient = { id: 7, email: 'watcher@example.test', permissions: ['read:pages'] } as Express.User
const control = { id: 8, email: 'nonwatcher@example.test', permissions: ['read:pages'] } as Express.User
const former = { path: 'docs/deleted', localeCode: 'en', visibility: 'public', ownerId: null, tags: [{ tag: 'readable' }] }
type Message = Parameters<PageWatchWikiContext['mail']['send']>[0]
type Channels = { inAppEnabled: boolean; emailEnabled: boolean }

suite('PostgreSQL notification audience delivery and read projection', () => {
  let db: Knex
  let operations: typeof notificationOperations
  let handler: DurableJobHandler
  const originalWiki = Reflect.get(globalThis, 'WIKI')
  const messages: Message[] = []
  const tables = [
    'settings',
    'userNotificationPreferences',
    'pageWatchNotifications',
    'pageWatchDeliveries',
    'pageWatchers',
    'webhookDeliveries',
    'outboxEvents',
    'webhooks',
    'durableJobs',
    'deletedPageRecovery',
    'pageHistory',
    'pageAccessPasswords',
    'pageTags',
    'pages',
    'tags',
    'userGroups',
    'groups',
    'users'
  ]

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer REFERENCES users(id), "groupId" integer REFERENCES groups(id),
        PRIMARY KEY ("userId", "groupId"));
      CREATE TABLE pages (id integer PRIMARY KEY, title text NOT NULL, path text NOT NULL, "localeCode" text NOT NULL,
        visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL DEFAULT true,
        "publishStartDate" text, "publishEndDate" text);
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false);
      CREATE TABLE "pageTags" ("pageId" integer REFERENCES pages(id) ON DELETE CASCADE, "tagId" integer REFERENCES tags(id));
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE, version integer NOT NULL);
      CREATE TABLE "pageHistory" (id integer PRIMARY KEY, title text NOT NULL);
      CREATE TABLE "deletedPageRecovery" ("pageId" integer PRIMARY KEY, "deletionVersionId" integer REFERENCES "pageHistory"(id),
        "securityContext" jsonb NOT NULL);
      CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL, "updatedAt" timestamptz);
    `)
    await addDurableJobs(db)
    await addLeaseToken(db)
    await addOutbox(db)
    await addPageWatching(db)
    await addNotificationPreferences(db)
    const wiki = {
      config: { host: 'https://wiki.example.test' },
      configSvc: {},
      events: {},
      lang: {},
      logger: {},
      startedAt: {},
      auth: { checkAccess: auth.checkAccess, checkPageAccess: auth.checkPageAccess, loadPageRuleAuthority },
      mail: {
        async send(message: Message) {
          messages.push(message)
        }
      },
      models: {
        knex: db,
        pages: { getPageFromDb: (id: number, transaction?: Knex.Transaction) => (transaction ?? db)('pages').where({ id }).first() },
        users: undefined as unknown
      }
    }
    Reflect.set(globalThis, 'WIKI', wiki)
    const [{ default: User }, { default: Group }] = await Promise.all([import('../../models/users.ts'), import('../../models/groups.ts')])
    User.knex(db)
    Group.knex(db)
    wiki.models.users = User
    handler = createPageWatchNotificationHandler(wiki as unknown as PageWatchWikiContext)
    operations = await vi.importFresh('../../operations/page-watching.ts', import.meta.url)
  })

  beforeEach(async () => {
    messages.length = 0
    for (const table of tables) await db(table).delete()
    await db('users').insert([
      { id: 2, email: 'guest@example.test' },
      { id: recipient.id, email: recipient.email },
      { id: control.id, email: control.email },
      { id: 9, email: 'actor@example.test' }
    ])
    await db('groups').insert({
      id: 3,
      name: 'Notification readers',
      permissions: JSON.stringify(['read:pages']),
      pageRules: JSON.stringify([{ match: 'TAG', path: 'readable', deny: false, roles: ['read:pages'], locales: ['en'] }])
    })
    await db('userGroups').insert([2, 7, 8, 9].map(userId => ({ userId, groupId: 3 })))
    await db('tags').insert([
      { id: 1, tag: 'readable' },
      { id: 2, tag: 'restricted' }
    ])
    await db('pages').insert({ id: 42, title: 'Live guide', path: former.path, localeCode: 'en', visibility: 'public', ownerId: null })
    await db('pageTags').insert({ pageId: 42, tagId: 1 })
  })

  afterAll(async () => {
    Reflect.set(globalThis, 'WIKI', originalWiki)
    if (!db) return
    for (const table of tables) await db.schema.dropTableIfExists(table)
    await db.destroy()
  })

  const watch = async (userId: number, channels: Channels): Promise<void> => {
    await db('pageWatchers').insert({ pageId: 42, userId, createdAt: new Date('2026-01-01T00:00:00.000Z'), ...channels })
  }
  const preference = async (userId: number, category: string, channels: Channels): Promise<void> => {
    await db('userNotificationPreferences').insert({ userId, category, updatedAt: new Date('2026-01-01T00:00:00.000Z'), ...channels })
  }
  const deletePage = async (): Promise<void> => {
    await db('pageHistory').insert({ id: 501, title: 'Safe deleted guide' })
    await db('deletedPageRecovery').insert({ pageId: 42, deletionVersionId: 501, securityContext: JSON.stringify({ version: 1, former, protection: null }) })
    await db('pages').where({ id: 42 }).delete()
  }
  const createEvent = async (type = 'page.deleted', createdAt = new Date('2026-01-01T12:00:00.000Z')): Promise<string> => {
    const eventId = randomUUID()
    await db('outboxEvents').insert({
      id: eventId,
      type,
      aggregateType: 'page',
      aggregateId: '42',
      createdAt,
      payload: JSON.stringify({ ...former, pageId: 42, actorId: 9, actorName: 'Editor', title: 'Stale event title' })
    })
    return eventId
  }
  const deliverEvent = async (eventId: string, audienceAt = new Date('2026-01-01T12:00:00.000Z')): Promise<void> => {
    const store = new DurableJobStore(db)
    const audience = await store.enqueue({
      type: 'notify-page-watcher',
      version: 1,
      payload: { mode: 'audience', eventId, afterUserId: 0, audienceAt: audienceAt.toISOString() },
      deduplicationKey: `notification-audience:${eventId}:0`
    })
    const context = { knex: db, signal: new AbortController().signal }
    await handler(audience, context)
    await handler(audience, context)
    const deliveries = await db('pageWatchDeliveries').where({ eventId }).orderBy('userId').select('jobId')
    for (const delivery of deliveries) {
      const job = await store.get(delivery.jobId)
      if (!job) throw new Error('Native notification delivery has no durable job')
      await handler(job, context)
      await handler(job, context)
    }
  }
  const deliver = async (type = 'page.deleted'): Promise<string> => {
    const eventId = await createEvent(type)
    await deliverEvent(eventId)
    return eventId
  }
  it('serializes sparse preference saves while preserving hidden channels under ceilings', async () => {
    await preference(7, 'mention', { inAppEnabled: false, emailEnabled: true })
    await db('settings').insert({ key: 'notificationCeilings', value: JSON.stringify({ ceilings: { ...defaultNotificationCeilings(), mention: 'in-app-only' }, suppressedBefore: {} }) })
    await Promise.all([
      operations.updateNotificationPreferences(recipient, { preferences: { mention: { inApp: true } } }),
      operations.updateNotificationPreferences(recipient, { preferences: { pageDeleted: { email: true } } })
    ])
    const current = await operations.getNotificationPreferences(recipient)
    expect(current.preferences.mention).toEqual({ inApp: true, email: true })
    await Promise.all([
      operations.updateNotificationPreferences(recipient, { preferences: { commentReply: { inApp: true } } }),
      operations.updateNotificationPreferences(recipient, { preferences: { commentReply: { email: true } } })
    ])
    const merged = await operations.getNotificationPreferences(recipient)
    expect(merged.preferences.commentReply).toEqual({ inApp: true, email: true })
    expect(current.preferences.pageDeleted).toEqual({ inApp: false, email: true })
  })

  it('rechecks administrator authority and prevents stale settings overwrites or suppressed-work resurrection', async () => {
    await expect(getNotificationSettings(db, recipient)).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['manage:system', 'read:pages']) })
    const initial = await getNotificationSettings(db, recipient)
    const off = await updateNotificationSettings(db, recipient, { ceilings: { ...initial.ceilings, pageWatch: 'off' }, fingerprint: initial.fingerprint })
    await expect(updateNotificationSettings(db, recipient, { ceilings: initial.ceilings, fingerprint: initial.fingerprint })).rejects.toMatchObject({ status: 409 })
    await watch(7, { inAppEnabled: true, emailEnabled: true })
    await updateNotificationSettings(db, recipient, { ceilings: initial.ceilings, fingerprint: off.fingerprint })
    // The event predates the off/on transition even though audience selection runs afterward.
    await deliver('page.updated')
    expect(messages).toEqual([])
    expect(await db('pageWatchNotifications')).toEqual([])
    expect((await db('pageWatchers').where('userId', 7).first()).emailEnabled).toBe(true)
    await db('users').where('id', 7).update({ authVersion: 1 })
    await expect(getNotificationSettings(db, recipient)).rejects.toMatchObject({ status: 403 })
  })

  it('keeps successful versions usable across category and channel cutoff transitions', async () => {
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['manage:system', 'read:pages']) })
    const initial = await getNotificationSettings(db, recipient)
    const emailOnly = await updateNotificationSettings(db, recipient, { ceilings: { ...initial.ceilings, pageWatch: 'in-app-only' }, fingerprint: initial.fingerprint })
    const earlierCategory = await updateNotificationSettings(db, recipient, { ceilings: { ...emailOnly.ceilings, pageCreated: 'off' }, fingerprint: emailOnly.fingerprint })
    const bothChannels = await updateNotificationSettings(db, recipient, { ceilings: { ...earlierCategory.ceilings, pageWatch: 'off' }, fingerprint: earlierCategory.fingerprint })
    await updateNotificationSettings(db, recipient, { ceilings: initial.ceilings, fingerprint: bothChannels.fingerprint })
    await expect(updateNotificationSettings(db, recipient, {
      ceilings: { ...initial.ceilings, pageDeleted: 'off' },
      fingerprint: bothChannels.fingerprint
    })).rejects.toMatchObject({ status: 409 })
    expect((await getNotificationSettings(db, recipient)).ceilings).toEqual(initial.ceilings)
  })

  it.each([
    ['pageWatch', 'page.updated', 'off', 0],
    ['pageWatch', 'page.updated', 'in-app-only', 1],
    ['pageCreated', 'page.created', 'off', 0],
    ['pageCreated', 'page.created', 'in-app-only', 1]
  ] as const)('does not resurrect %s work created during %s/%s before audience processing', async (category, type, mode, retainedInApp) => {
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['manage:system', 'read:pages']) })
    if (category === 'pageWatch') await watch(7, { inAppEnabled: true, emailEnabled: true })
    else await preference(7, category, { inAppEnabled: true, emailEnabled: true })
    const initial = await getNotificationSettings(db, recipient)
    const disabled = await updateNotificationSettings(db, recipient, { ceilings: { ...initial.ceilings, [category]: mode }, fingerprint: initial.fingerprint })
    const saved = await db('settings').where('key', 'notificationCeilings').first('updatedAt')
    // Cross the persisted millisecond boundary before creating the real disabled-period root.
    await db.raw('SELECT pg_sleep(0.002)')
    const createdAt = new Date()
    expect(createdAt.valueOf()).toBeGreaterThan(new Date(saved.updatedAt).valueOf())
    const eventId = await createEvent(type, createdAt)
    await updateNotificationSettings(db, recipient, { ceilings: initial.ceilings, fingerprint: disabled.fingerprint })
    const reenabled = await db('settings').where('key', 'notificationCeilings').first('updatedAt')
    await deliverEvent(eventId, new Date())
    expect(messages).toEqual([])
    expect(await db('pageWatchNotifications').where({ eventId })).toHaveLength(retainedInApp)
    const stored = category === 'pageWatch'
      ? await db('pageWatchers').where({ userId: 7, pageId: 42 }).first()
      : await db('userNotificationPreferences').where({ userId: 7, category }).first()
    expect(stored).toMatchObject({ inAppEnabled: true, emailEnabled: true })
    // New work after re-enable still uses the unchanged consented channels.
    await db.raw('SELECT pg_sleep(0.002)')
    const freshCreatedAt = new Date()
    expect(freshCreatedAt.valueOf()).toBeGreaterThan(new Date(reenabled.updatedAt).valueOf())
    const freshId = await createEvent(type, freshCreatedAt)
    const previousJob = await db<{ nextRunAt: Date }>('durableJobs')
      .join('pageWatchDeliveries', 'pageWatchDeliveries.jobId', 'durableJobs.id')
      .where('pageWatchDeliveries.eventId', eventId).first('durableJobs.nextRunAt')
    // This helper directly dispatches jobs. Model the next audience after the
    // first native scheduled delivery, not another delivery in its debounce bucket.
    const freshAudienceAt = new Date(Math.max(Date.now(), previousJob?.nextRunAt.valueOf() ?? 0))
    await deliverEvent(freshId, freshAudienceAt)
    expect(messages).toHaveLength(1)
    expect(await db('pageWatchNotifications').where({ eventId: freshId })).toHaveLength(1)
  })

  it('explicit all-email opt-out includes concurrent hidden-category changes and legacy watches', async () => {
    await watch(7, { inAppEnabled: true, emailEnabled: true })
    await preference(7, 'futureCategory', { inAppEnabled: true, emailEnabled: true })
    await Promise.all([
      operations.updateNotificationPreferences(recipient, { preferences: { mention: { inApp: true } } }),
      operations.updateNotificationPreferences(recipient, { preferences: {}, stopAllEmail: true })
    ])
    const current = await operations.getNotificationPreferences(recipient)
    expect(current.preferences.mention).toEqual({ inApp: true, email: false })
    expect(await db('userNotificationPreferences').where('userId', 7).where('emailEnabled', true)).toEqual([])
    expect((await db('pageWatchers').where('userId', 7).first()).emailEnabled).toBe(false)
  })

  it('holds the shared ceiling lock through dispatch so an administrator save cannot complete ahead of an authorized email', async () => {
    await db('groups').where('id', 3).update({ permissions: JSON.stringify(['manage:system', 'read:pages']) })
    await watch(7, { inAppEnabled: true, emailEnabled: true })
    const settings = await getNotificationSettings(db, recipient)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const wiki = Reflect.get(globalThis, 'WIKI') as unknown as PageWatchWikiContext
    const originalSend = wiki.mail.send
    wiki.mail.send = async message => {
      entered.resolve()
      await release.promise
      messages.push(message)
    }
    let dispatch: Promise<string> | undefined
    let saved: Promise<unknown> | undefined
    try {
      dispatch = deliver('page.updated')
      await entered.promise
      saved = updateNotificationSettings(db, recipient, { ceilings: { ...settings.ceilings, pageWatch: 'off' }, fingerprint: settings.fingerprint })
      const locked = await db.transaction(async tx => {
        const result = await tx.raw('SELECT pg_try_advisory_xact_lock(?) AS acquired', [771020])
        return result.rows[0].acquired as boolean
      })
      expect(locked).toBe(false)
      expect(messages).toHaveLength(0)
      release.resolve()
      await Promise.all([dispatch, saved])
      expect(messages).toHaveLength(1)
      expect((await getNotificationSettings(db, recipient)).ceilings.pageWatch).toBe('off')
      expect(await db('pageWatchNotifications')).toHaveLength(1)
    } finally {
      release.resolve()
      await Promise.allSettled([dispatch, saved].filter((promise): promise is Promise<string> | Promise<unknown> => promise !== undefined))
      wiki.mail.send = originalSend
    }
  })

  it.each([
    ['in-app', { inAppEnabled: true, emailEnabled: false }, { inAppEnabled: false, emailEnabled: true }],
    ['email', { inAppEnabled: false, emailEnabled: true }, { inAppEnabled: true, emailEnabled: false }],
    ['both channels', { inAppEnabled: true, emailEnabled: true }, { inAppEnabled: false, emailEnabled: true }]
  ] as const)('delivers explicit deletion %s once for a watcher and projects safe current recovery metadata', async (_channel, enabled, legacy) => {
    await watch(7, legacy)
    for (const userId of [2, 7, 8, 9]) await preference(userId, 'pageDeleted', enabled)
    await deletePage()
    const eventId = await deliver()
    // The nonwatching control proves the deleted recovery scope is actually authorized.
    for (const requester of [control, recipient]) {
      const inbox = await operations.listPageWatchNotifications(requester)
      expect(inbox.items).toEqual(
        enabled.inAppEnabled
          ? [
              expect.objectContaining({
                pageId: 42,
                eventType: 'page.deleted',
                category: 'pageDeleted',
                commentId: null,
                actorName: 'Editor',
                title: 'Safe deleted guide',
                path: former.path,
                readAt: null
              })
            ]
          : []
      )
      expect(inbox.unreadCount).toBe(enabled.inAppEnabled ? 1 : 0)
      const mail = messages.filter(message => message.to === requester.email)
      expect(mail).toHaveLength(enabled.emailEnabled ? 1 : 0)
      if (enabled.emailEnabled)
        expect(mail[0]).toMatchObject({
          template: 'page-watch',
          data: { action: 'deleted', actorName: 'Editor', pageTitle: 'Safe deleted guide', url: 'https://wiki.example.test/en/docs/deleted' }
        })
      if (enabled.inAppEnabled) {
        const id = inbox.items[0]!.id
        await operations.markPageWatchNotificationRead({ ...requester, id: 9 } as Express.User, id)
        expect((await operations.listPageWatchNotifications(requester)).items[0]?.readAt).toBeNull()
        await operations.markPageWatchNotificationRead(requester, id)
        const read = await operations.listPageWatchNotifications(requester)
        expect(read.items).toEqual([expect.objectContaining({ id, category: 'pageDeleted', title: 'Safe deleted guide', readAt: expect.any(String) })])
        expect(read.unreadCount).toBe(0)
      }
    }
    expect(messages).toHaveLength(enabled.emailEnabled ? 2 : 0)
    expect(await db('pageWatchNotifications').where({ eventId })).toHaveLength(enabled.inAppEnabled ? 2 : 0)
    expect(await db('pageWatchDeliveries').where({ eventId }).orderBy('userId').select('userId', 'lastError')).toEqual([
      { userId: 7, lastError: null },
      { userId: 8, lastError: null }
    ])
    expect(await db('pageWatchers').where({ pageId: 42 })).toEqual([])
  })

  it('preserves legacy watch channels for live events without enabling opted-out global categories', async () => {
    await watch(7, { inAppEnabled: true, emailEnabled: false })
    await preference(7, 'pageCreated', { inAppEnabled: false, emailEnabled: true })
    await preference(7, 'pageDeleted', { inAppEnabled: false, emailEnabled: true })
    await preference(8, 'pageCreated', { inAppEnabled: false, emailEnabled: false })
    await preference(8, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    for (const type of ['page.created', 'page.updated']) await deliver(type)
    expect(messages).toEqual([])
    const inbox = await operations.listPageWatchNotifications(recipient)
    expect(inbox.items).toHaveLength(2)
    expect(inbox.items.every(item => item.category === 'pageWatch' && item.title === 'Live guide')).toBe(true)
    expect((await operations.listPageWatchNotifications(control)).items).toEqual([])
    expect(await db('pageWatchDeliveries').where({ userId: 8 })).toEqual([])
  })

  it.each(['absent', 'disabled'] as const)('does not turn an enabled legacy watch into a default deletion subscription when preference is %s', async state => {
    await watch(7, { inAppEnabled: true, emailEnabled: true })
    if (state === 'disabled') await preference(7, 'pageDeleted', { inAppEnabled: false, emailEnabled: false })
    await preference(8, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    await deletePage()
    await deliver()
    expect((await operations.listPageWatchNotifications(control)).items).toHaveLength(1)
    expect(messages.filter(message => message.to === control.email)).toHaveLength(1)
    expect((await operations.listPageWatchNotifications(recipient)).items).toEqual([])
    expect(messages.filter(message => message.to === recipient.email)).toEqual([])
  })

  const withhold = async (change: string): Promise<void> => {
    if (change === 'protected recovery') {
      await db('deletedPageRecovery')
        .where({ pageId: 42 })
        .update({ securityContext: JSON.stringify({ version: 1, former, protection: { version: 1 } }) })
    } else if (change === 'missing recovery') {
      await db('deletedPageRecovery').where({ pageId: 42 }).delete()
    } else if (change === 'revoked membership') {
      await db('userGroups').whereIn('userId', [7, 8]).delete()
    } else {
      await db('pages').insert({
        id: 99,
        title: 'Restricted replacement',
        path: former.path,
        localeCode: 'en',
        visibility: 'public',
        ownerId: null,
        isPublished: change !== 'unpublished replacement'
      })
      await db('pageTags').insert({ pageId: 99, tagId: change === 'unauthorized replacement' ? 2 : 1 })
      if (change === 'protected replacement') await db('pageAccessPasswords').insert({ pageId: 99, version: 1 })
    }
  }
  const withheldScopes = [
    'protected recovery',
    'missing recovery',
    'revoked membership',
    'protected replacement',
    'unpublished replacement',
    'unauthorized replacement'
  ] as const

  it.each(withheldScopes)('withholds deletion inbox and mail for %s at delivery', async change => {
    await watch(7, { inAppEnabled: true, emailEnabled: true })
    for (const userId of [7, 8]) await preference(userId, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    await deletePage()
    await withhold(change)
    await deliver()
    expect(messages).toEqual([])
    expect(await db('pageWatchNotifications')).toEqual([])
    expect((await operations.listPageWatchNotifications(recipient)).items).toEqual([])
    expect((await operations.listPageWatchNotifications(control)).items).toEqual([])
  })

  it.each(withheldScopes)('reauthorizes delivered deletion read state and projection after %s', async change => {
    await watch(7, { inAppEnabled: false, emailEnabled: true })
    await preference(7, 'pageDeleted', { inAppEnabled: true, emailEnabled: false })
    await deletePage()
    await deliver()
    const initial = await operations.listPageWatchNotifications(recipient)
    expect(initial.items).toEqual([expect.objectContaining({ category: 'pageDeleted', title: 'Safe deleted guide', readAt: null })])
    await withhold(change)
    await operations.markPageWatchNotificationRead(recipient, initial.items[0]!.id)
    expect(await db('pageWatchNotifications').where({ userId: 7 })).toEqual([])
    expect((await operations.listPageWatchNotifications(recipient)).items).toEqual([])
    expect(messages).toEqual([])
  })

  it('projects only the currently authorized replacement title rather than stale deleted metadata', async () => {
    await watch(7, { inAppEnabled: false, emailEnabled: true })
    await preference(7, 'pageDeleted', { inAppEnabled: true, emailEnabled: true })
    await deletePage()
    await db('pages').insert({ id: 99, title: 'Authorized replacement', path: former.path, localeCode: 'en', visibility: 'public', ownerId: null })
    await db('pageTags').insert({ pageId: 99, tagId: 1 })
    await deliver()
    const inbox = await operations.listPageWatchNotifications(recipient)
    expect(inbox.items).toEqual([expect.objectContaining({ pageId: 42, category: 'pageDeleted', title: 'Authorized replacement' })])
    expect(messages).toEqual([expect.objectContaining({ data: expect.objectContaining({ pageTitle: 'Authorized replacement' }) })])
    expect(JSON.stringify({ inbox, messages })).not.toContain('Safe deleted guide')
    expect(JSON.stringify({ inbox, messages })).not.toContain('Stale event title')
  })
})
