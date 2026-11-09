import { EventEmitter } from 'node:events'
import knexModule, { type Knex } from 'knex'
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as reviewSchema } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as accuracySchema } from '../../db/migrations/tsepistle-000070-page-accuracy-attestations.ts'
import { up as durableSchema } from '../../db/migrations/2.5.130.ts'
import { up as leaseSchema } from '../../db/migrations/2.5.158.ts'
import { up as inboxSchema } from '../../db/migrations/2.5.132.ts'
import { up as preferencesSchema } from '../../db/migrations/tsepistle-000058-discussion-notifications.ts'
import { up as outboxSchema } from '../../db/migrations/2.5.131.ts'
import { up as feedbackSchema } from '../../db/migrations/tsepistle-000073-page-feedback.ts'
import { up as governedSchema } from '../../db/migrations/tsepistle-000076-governed-notifications.ts'
import { up as lifecycleSchema } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { DurableJobStore, type DurableJob } from '../../core/durable-jobs.ts'
import type * as Governed from '../../jobs/governed-notifications.ts'
import type * as Reminders from '../../jobs/page-review-reminders.ts'
import type * as Routing from '../../operations/page-review-routing.ts'
import type * as Outbox from '../../core/outbox.ts'
import type * as Notifications from '../../operations/page-watching.ts'
import type * as Feedback from '../../operations/page-feedback.ts'
import type * as Lifecycle from '../../operations/page-lifecycle.ts'
import type * as LifecycleJobs from '../../jobs/page-lifecycle.ts'
import { defaultNotificationCeilings, NOTIFICATION_CATEGORIES } from '../../../shared/site-notifications.ts'
import { getNotificationSettings, updateNotificationSettings } from '../../operations/notification-settings.ts'

const connection = getPostgresTestConnection('_governed_notify_test', import.meta.path)
const suite = connection ? describe : describe.skip
suite('native governed notification consumers', () => {
  let db: Knex, governed: typeof Governed, reminders: typeof Reminders, routing: typeof Routing
  let outbox: typeof Outbox, notifications: typeof Notifications
  let feedback: typeof Feedback, lifecycle: typeof Lifecycle, lifecycleJobs: typeof LifecycleJobs
  let ambiguousMail = false
  let failBeforeHandoff = false
  const requester = { id: 7, authVersion: 0 } as Express.User
  let mailCalls = 0
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection!, pool: { min: 0, max: 5 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text, email text, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text, permissions jsonb, "pageRules" jsonb);
      CREATE TABLE "userGroups" ("userId" integer REFERENCES users(id) ON DELETE CASCADE, "groupId" integer REFERENCES groups(id) ON DELETE CASCADE, PRIMARY KEY("userId","groupId"));
      CREATE TABLE pages (id integer PRIMARY KEY, "sourceRevision" bigint NOT NULL, "creatorId" integer, "authorId" integer, "ownerId" integer, visibility text, path text, "localeCode" text, title text, content text, "contentType" text NOT NULL DEFAULT 'markdown', "updatedAt" timestamptz, "isPublished" boolean DEFAULT true, "publishStartDate" text DEFAULT '', "publishEndDate" text DEFAULT '');
      CREATE TABLE tags (id integer PRIMARY KEY, tag text, "redirectToId" integer, "isArchived" boolean DEFAULT false);
      CREATE TABLE "pageTags" ("pageId" integer, "tagId" integer);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, "passwordHash" text, version integer);
      CREATE TABLE "pageUnlockGrants" (id text PRIMARY KEY, "pageId" integer, "sessionId" text, "userId" integer, "passwordVersion" integer, "expiresAt" timestamptz);
      CREATE TABLE settings (key text PRIMARY KEY, value text, "updatedAt" timestamptz);
      CREATE TABLE "commentProviders" (key text PRIMARY KEY, "isEnabled" boolean);
      CREATE TABLE comments (id integer PRIMARY KEY, "pageId" integer REFERENCES pages(id) ON DELETE CASCADE,
        "authorId" integer REFERENCES users(id) ON DELETE SET NULL, "replyTo" integer NOT NULL DEFAULT 0,
        name text NOT NULL, content text NOT NULL, "isHidden" boolean NOT NULL DEFAULT false);
    `)
    await durableSchema(db); await leaseSchema(db); await outboxSchema(db); await accuracySchema(db); await reviewSchema(db); await inboxSchema(db); await preferencesSchema(db); await feedbackSchema(db); await governedSchema(db)
    await lifecycleSchema(db)
    vi.stubGlobal('WIKI', { config: { host: 'https://wiki.example.test', sessionSecret: 'native-governance-test', db: { type: 'postgres' }, lang: { code: 'en', namespacing: false } }, configSvc: {}, lang: {}, startedAt: {}, events: { inbound: new EventEmitter(), outbound: new EventEmitter() }, models: { knex: db }, logger: console, mail: { async send(options: { messageId: string }, _configuration: unknown, beforeHandoff?: () => Promise<void>) {
      if (failBeforeHandoff) throw new Error('Mail rendering unavailable before transport admission')
      if (beforeHandoff) await beforeHandoff()
      const receipts = options.messageId.startsWith('<page-review-') ? 'pageReviewChannelReceipts' : 'governedNotificationReceipts'
      expect((await db(receipts).where({ channel: 'email', messageId: options.messageId }).first('status'))?.status).toBe('sending')
      mailCalls++
      if (ambiguousMail) throw new Error('External acceptance lost')
      return { accepted: ['writer@example.test'] }
    } } })
    // Native modules capture WIKI at evaluation; bind the database before exercising that module-loading boundary.
    Reflect.get(globalThis, 'WIKI').auth = (await import('../../core/auth.ts')).default
    governed = await import('../../jobs/governed-notifications.ts')
    reminders = await import('../../jobs/page-review-reminders.ts')
    routing = await import('../../operations/page-review-routing.ts')
    outbox = await import('../../core/outbox.ts')
    notifications = await import('../../operations/page-watching.ts')
    feedback = await import('../../operations/page-feedback.ts')
    lifecycle = await import('../../operations/page-lifecycle.ts')
    lifecycleJobs = await import('../../jobs/page-lifecycle.ts')
    const Page = (await import('../../models/pages.ts')).default
    Page.knex(db)
  })
  beforeEach(async () => {
    mailCalls = 0; ambiguousMail = false; failBeforeHandoff = false
    await db.raw('TRUNCATE pages,users,groups,tags,"durableJobs","outboxEvents",webhooks,settings,"feedbackBoards","pageLifecycleRules" CASCADE')
    await db('users').insert([{ id: 7, name: 'Writer', email: 'writer@example.test' }, { id: 8, name: 'Other', email: 'other@example.test' }])
    await db('groups').insert({ id: 3, name: 'Writers', permissions: JSON.stringify(['read:pages', 'write:pages']), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages'], locales: [] }]) })
    await db('userGroups').insert({ userId: 7, groupId: 3 })
    await db('pages').insert({ id: 42, sourceRevision: '8', creatorId: 7, authorId: 7, ownerId: null, visibility: 'public', path: 'reviewable', localeCode: 'en', title: 'Current title', content: 'canonical source', updatedAt: new Date() })
    await db('userNotificationPreferences').insert({ userId: 7, category: 'reviewReminder', emailEnabled: false, inAppEnabled: true, updatedAt: new Date() })
  })
  const feedbackEvent = async (emailEnabled: boolean, commentId: number | null = null) => {
    const boardId = randomUUID(), ideaId = randomUUID(), eventId = randomUUID(), now = new Date()
    await db('pages').insert({ id: 43, sourceRevision: '1', creatorId: 7, authorId: 7, ownerId: null, visibility: 'public', path: 'feedback', localeCode: 'en', title: 'Feedback anchor', content: '', updatedAt: now })
    await db('feedbackBoards').insert({ id: boardId, boardPageId: 43, name: 'Feedback', enabled: true })
    await db('feedbackIdeas').insert({ id: ideaId, boardId, pageId: 42, submittedBy: 7, state: 'planned', submittedAt: now })
    await db('userNotificationPreferences').insert({ userId: 7, category: 'feedbackStatus', emailEnabled, inAppEnabled: true, updatedAt: now })
    await db.transaction(async tx => {
      const event = { id: eventId, type: 'feedback.status-changed', version: 1, aggregateType: 'feedback-idea', aggregateId: ideaId, createdAt: now, payload: { boardId, ideaId, pageId: 42, actorId: 8, rootTransitionEventId: eventId, commentId } }
      const recipientChannels = await governed.snapshotFeedbackNotificationAudience(tx, event)
      await outbox.writeOutboxEvent(tx, { ...event, payload: { ...event.payload, recipientChannels } })
    })
    return { boardId, ideaId, eventId }
  }
  const invokeGoverned = async () => {
    const jobs = await new DurableJobStore(db).claim({ workerId: 'governed-mail', supportedIdentities: ['notify-governed@1'], limit: 10 })
    for (const job of jobs) await governed.createGovernedNotificationHandler()(job, { knex: db, signal: new AbortController().signal })
    return jobs
  }
  afterAll(async () => { try { await db?.destroy() } finally { vi.unstubAllGlobals() } })
  const enableAndClaim = async () => {
    await routing.updatePageReviewRouting({ knex: db, requester, sessionId: 'browser', delegated: false, pageId: 42, mutation: { command: 'enable', expectedSourceRevision: '8', expectedRoutingRevision: '0', enabled: true } })
    const jobs = await new DurableJobStore(db).claim({ workerId: 'governed-native', supportedIdentities: ['page-review-reminder@1'], limit: 10 })
    const job = jobs.find(value => value.payload.cycleId !== undefined)
    if (!job) throw new Error('Expected real due review cycle')
    return job
  }
  const setCeiling = async (category: 'feedbackStatus' | 'reviewReminder' | 'pageLifecycle', mode: 'off' | 'in-app-only' | 'existing-consented-channels') => {
    const group = await db<{ permissions: string[] }>('groups').where('id', 3).first('permissions')
    if (!group) throw new Error('Expected native recipient authority group')
    await db('groups').where('id', 3).update({ permissions: JSON.stringify([...new Set([...group.permissions, 'manage:system'])]) })
    try {
      const current = await getNotificationSettings(db, requester)
      await updateNotificationSettings(db, requester, { ceilings: { ...current.ceilings, [category]: mode }, fingerprint: current.fingerprint })
    } finally {
      // Do not retain system-manager authority while exercising recipient ACL.
      await db('groups').where('id', 3).update({ permissions: JSON.stringify(group.permissions) })
    }
  }
  const savedConsent = async () => ({
    preferences: await db('userNotificationPreferences').orderBy('userId').orderBy('category'),
    watches: await db('pageWatchers').orderBy('userId').orderBy('pageId')
  })
  const consentToChannels = async () => {
    const now = new Date()
    await db('users').insert({ id: 9, name: 'In-app recipient', email: 'in-app@example.test' })
    await db('userGroups').insert({ userId: 9, groupId: 3 })
    await db('userNotificationPreferences').insert(NOTIFICATION_CATEGORIES.flatMap(category => [7, 9].map(userId => ({ userId, category, inAppEnabled: true, emailEnabled: userId === 7, updatedAt: now }))))
      .onConflict(['userId', 'category']).merge(['inAppEnabled', 'emailEnabled', 'updatedAt'])
    await db('pageWatchers').insert([7, 9].map(userId => ({ userId, pageId: 42, inAppEnabled: true, emailEnabled: true, createdAt: now })))
    return savedConsent()
  }
  it('applies feedback ceilings to real status roots without changing consent or reviving earlier channels', async () => {
    const consent = await consentToChannels()
    const moderator = { id: 8, authVersion: 0 } as Express.User
    const permissions = ['read:pages', 'write:pages', 'manage:pages']
    await db('groups').insert({ id: 4, name: 'Feedback moderators', permissions: JSON.stringify(permissions), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: permissions, locales: [] }]) })
    await db('userGroups').insert({ userId: 8, groupId: 4 })
    await db('pages').insert({ id: 43, sourceRevision: '1', creatorId: 7, authorId: 7, ownerId: null, visibility: 'public', path: 'feedback', localeCode: 'en', title: 'Feedback anchor', content: '', updatedAt: new Date() })
    const board = await feedback.configureFeedbackBoard({ requester: moderator, sessionId: 'moderator-browser', boardPageId: 43, name: 'Native feedback', enabled: true })
    const idea = await feedback.submitExistingFeedbackIdea({ requester, sessionId: 'browser', boardId: board.id, pageId: 42, expectedBoardRevision: board.boardRevision, expectedSourceRevision: '8', acknowledged: true })
    const eventIds: string[] = [], jobs: DurableJob[] = []
    let ideaRevision = idea.ideaRevision
    for (const [mode, targetState, channels] of [
      ['off', 'planned', []],
      ['in-app-only', 'completed', ['in-app']],
      ['existing-consented-channels', 'closed', ['email', 'in-app']]
    ] as const) {
      await setCeiling('feedbackStatus', mode)
      // Fresh roots must be newer than the saved millisecond suppression boundary.
      await db.raw('SELECT pg_sleep(0.002)')
      expect((await notifications.getNotificationPreferences(requester)).ceilings).toEqual({ ...defaultNotificationCeilings(), feedbackStatus: mode })
      const transition = await feedback.transitionFeedbackIdea({ requester: moderator, sessionId: 'moderator-browser', boardId: board.id, ideaId: idea.ideaId, requestId: randomUUID(), expectedBoardRevision: board.boardRevision, expectedIdeaRevision: ideaRevision, expectedSourceRevision: '8', targetState, explanation: 'An explicit native status decision.' })
      ideaRevision = transition.ideaRevision
      eventIds.push(transition.rootTransitionEventId)
      const root = await db('outboxEvents').where('id', transition.rootTransitionEventId).first()
      expect(JSON.parse(root.payload).recipientChannels.sort((left: { userId: number }, right: { userId: number }) => left.userId - right.userId)).toEqual(mode === 'off' ? [] : [
        { userId: 7, inAppEnabled: true, emailEnabled: mode === 'existing-consented-channels' },
        { userId: 9, inAppEnabled: true, emailEnabled: false }
      ])
      await outbox.publishOutboxEvents(db)
      jobs.push(...await invokeGoverned())
      expect(await db('governedNotificationReceipts').where('eventId', root.id).orderBy('userId').orderBy('channel').select('userId', 'channel', 'status')).toEqual([
        ...channels.map(channel => ({ userId: 7, channel, status: channel === 'email' ? 'sent' : 'delivered' })),
        ...(mode === 'off' ? [] : [{ userId: 9, channel: 'in-app', status: 'delivered' }])
      ])
      expect(await db('pageWatchNotifications').where('eventId', root.id)).toHaveLength(mode === 'off' ? 0 : 2)
      expect(mailCalls).toBe(mode === 'existing-consented-channels' ? 1 : 0)
      expect(await savedConsent()).toEqual(consent)
    }
    const receipts = await db('governedNotificationReceipts').orderBy('id')
    await db('outboxEvents').whereIn('id', eventIds).update({ publishedAt: null })
    await outbox.publishOutboxEvents(db)
    expect(await invokeGoverned()).toHaveLength(0)
    for (const job of jobs) await governed.createGovernedNotificationHandler()(job, { knex: db, signal: new AbortController().signal })
    expect(await db('governedNotificationReceipts').orderBy('id')).toEqual(receipts)
    expect(await db('pageWatchNotifications')).toHaveLength(4)
    expect(mailCalls).toBe(1)
    expect(await savedConsent()).toEqual(consent)
  })
  it('applies review ceilings to fresh native schedule generations without reviving suppressed cycle channels', async () => {
    const consent = await consentToChannels()
    const jobs: DurableJob[] = []
    const selected = await routing.updatePageReviewRouting({ knex: db, requester, sessionId: 'browser', delegated: false, pageId: 42, mutation: { command: 'route', expectedSourceRevision: '8', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [7, 9] } } })
    let routingRevision = selected.routingRevision
    const handler = reminders.createPageReviewReminderHandler(governed.governedReviewNotificationAdapter)
    for (const mode of ['off', 'in-app-only', 'existing-consented-channels'] as const) {
      await setCeiling('reviewReminder', mode)
      await db.raw('SELECT pg_sleep(0.002)')
      expect((await notifications.getNotificationPreferences(requester)).ceilings).toEqual({ ...defaultNotificationCeilings(), reviewReminder: mode })
      if (mode === 'off') {
        const enabled = await routing.updatePageReviewRouting({ knex: db, requester, sessionId: 'browser', delegated: false, pageId: 42, mutation: { command: 'enable', expectedSourceRevision: '8', expectedRoutingRevision: routingRevision, enabled: true } })
        routingRevision = enabled.routingRevision
      } else {
        const now = await db.transaction(tx => routing.reviewDatabaseNow(tx))
        const scheduled = await routing.updatePageReviewRouting({ knex: db, requester, sessionId: 'browser', delegated: false, pageId: 42, mutation: { command: 'reschedule', expectedSourceRevision: '8', expectedRoutingRevision: routingRevision, schedule: { mode: 'independent', anchorAt: new Date(now.valueOf() - 10 * 86_400_000).toISOString(), intervalDays: 1, acknowledgeIndependentAccuracy: true } } })
        routingRevision = scheduled.routingRevision
      }
      const claimed = await new DurableJobStore(db).claim({ workerId: 'ceiling-review', supportedIdentities: ['page-review-reminder@1'], limit: 10 })
      const job = claimed.find(value => value.payload.cycleId !== undefined)
      if (!job) throw new Error('Expected native review cycle for the fresh schedule')
      jobs.push(job)
      await handler(job, { knex: db, signal: new AbortController().signal })
      expect(await db('pageReviewChannelReceipts').where('cycleId', job.payload.cycleId).orderBy('userId').orderBy('channel').select('userId', 'channel', 'status', 'consentAtAdmission')).toEqual([
        { userId: 7, channel: 'email', status: mode === 'existing-consented-channels' ? 'sent' : 'suppressed', consentAtAdmission: true },
        { userId: 7, channel: 'in-app', status: mode === 'off' ? 'suppressed' : 'delivered', consentAtAdmission: true },
        { userId: 9, channel: 'in-app', status: mode === 'off' ? 'suppressed' : 'delivered', consentAtAdmission: true }
      ])
      expect(await db('pageWatchNotifications').where('eventId', job.payload.cycleId)).toHaveLength(mode === 'off' ? 0 : 2)
      expect(mailCalls).toBe(mode === 'existing-consented-channels' ? 1 : 0)
      expect(await savedConsent()).toEqual(consent)
    }
    const receipts = await db('pageReviewChannelReceipts').orderBy('id')
    await reminders.scanPageReviewReminders(db)
    for (const job of jobs) await handler(job, { knex: db, signal: new AbortController().signal })
    expect(await db('pageReviewChannelReceipts').orderBy('id')).toEqual(receipts)
    expect(await db('pageWatchNotifications')).toHaveLength(4)
    expect(mailCalls).toBe(1)
    expect(await savedConsent()).toEqual(consent)
  })
  it('applies lifecycle ceilings to genuinely committed notify effects without reviving earlier root channels', async () => {
    const consent = await consentToChannels()
    const eventIds: string[] = [], notificationJobs: DurableJob[] = []
    for (const mode of ['off', 'in-app-only', 'existing-consented-channels'] as const) {
      await setCeiling('pageLifecycle', mode)
      await db.raw('SELECT pg_sleep(0.002)')
      expect((await notifications.getNotificationPreferences(requester)).ceilings).toEqual({ ...defaultNotificationCeilings(), pageLifecycle: mode })
      const now = await db.transaction(tx => lifecycle.pageLifecycleDatabaseNow(tx))
      const definition = { version: 1 as const, selector: { kind: 'ids' as const, pageIds: [42] }, condition: { kind: 'interval' as const, anchorAt: new Date(now.valueOf() - 10 * 86_400_000).toISOString(), days: 1 }, terminalPolicy: 'keep' as const, effects: [{ kind: 'notify' as const, audience: 'watchers' as const }] }
      const preview = await lifecycle.previewPageLifecycle({ requester, sessionId: 'browser', input: { definition } })
      expect(preview.pages.map(page => page.pageId)).toEqual([42])
      const rule = await lifecycle.savePageLifecycle({ requester, sessionId: 'browser', input: { definition, previewToken: preview.previewToken, unattendedConsent: true, enabled: true } })
      expect(await lifecycleJobs.scanPageLifecycleRules(db)).toBe(1)
      const claimed = await new DurableJobStore(db).claim({ workerId: 'ceiling-lifecycle', supportedIdentities: ['page-lifecycle@1'], limit: 10 })
      const job = claimed.find(value => value.payload.ruleId === rule.ruleId)
      if (!job) throw new Error('Expected native lifecycle work for the saved rule')
      await lifecycleJobs.createPageLifecycleHandler()(job, { knex: db, signal: new AbortController().signal })
      const root = await db('outboxEvents').where({ type: 'page.lifecycle-result' }).whereRaw("(payload::jsonb ->> 'ruleId') = ?", [rule.ruleId]).first()
      expect(root).toBeDefined()
      eventIds.push(root.id)
      // Lifecycle records actual consent at effect commit; its publisher applies the ceiling.
      expect(JSON.parse(root.payload).recipientChannels.sort((left: { userId: number }, right: { userId: number }) => left.userId - right.userId)).toEqual([
        { userId: 7, inAppEnabled: true, emailEnabled: true },
        { userId: 9, inAppEnabled: true, emailEnabled: false }
      ])
      await outbox.publishOutboxEvents(db)
      notificationJobs.push(...await invokeGoverned())
      const channels = mode === 'off' ? [] : mode === 'in-app-only' ? ['in-app'] : ['email', 'in-app']
      expect(await db('governedNotificationReceipts').where('eventId', root.id).orderBy('userId').orderBy('channel').select('userId', 'channel', 'status')).toEqual([
        ...channels.map(channel => ({ userId: 7, channel, status: channel === 'email' ? 'sent' : 'delivered' })),
        ...(mode === 'off' ? [] : [{ userId: 9, channel: 'in-app', status: 'delivered' }])
      ])
      expect(await db('pageWatchNotifications').where('eventId', root.id)).toHaveLength(mode === 'off' ? 0 : 2)
      expect(mailCalls).toBe(mode === 'existing-consented-channels' ? 1 : 0)
      expect(await savedConsent()).toEqual(consent)
    }
    const receipts = await db('governedNotificationReceipts').orderBy('id')
    expect(await lifecycleJobs.scanPageLifecycleRules(db)).toBe(0)
    await db('outboxEvents').whereIn('id', eventIds).update({ publishedAt: null })
    await outbox.publishOutboxEvents(db)
    expect(await invokeGoverned()).toHaveLength(0)
    for (const job of notificationJobs) await governed.createGovernedNotificationHandler()(job, { knex: db, signal: new AbortController().signal })
    expect(await db('governedNotificationReceipts').orderBy('id')).toEqual(receipts)
    expect(await db('pageWatchNotifications')).toHaveLength(4)
    expect(mailCalls).toBe(1)
    expect(await savedConsent()).toEqual(consent)
  })
  it('commits the real native inbox FK and receipt once, permits scheduled self-review and never enables its email sibling', async () => {
    const job = await enableAndClaim()
    const handler = reminders.createPageReviewReminderHandler(governed.governedReviewNotificationAdapter)
    await handler(job, { knex: db, signal: new AbortController().signal })
    await handler(job, { knex: db, signal: new AbortController().signal })
    const inbox = await db('pageWatchNotifications')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ userId: 7, category: 'reviewReminder', actorName: '', title: 'Current title' })
    expect(await db('outboxEvents').where('id', inbox[0].eventId).first()).toMatchObject({ type: 'page.review-reminder' })
    expect(await db('pageReviewChannelReceipts').first()).toMatchObject({ status: 'delivered' })
    expect(mailCalls).toBe(0)
    await db('pages').where('id', 42).update({ title: 'New permitted title', path: 'new-route' })
    const projection = await db.transaction(tx => governed.projectGovernedInboxRow(tx, inbox[0], 7, requester, 'browser'))
    expect(projection?.page).toMatchObject({ title: 'New permitted title', path: 'new-route' })
    for (const mode of ['off', 'existing-consented-channels'] as const) {
      await setCeiling('reviewReminder', mode)
      const retained = await notifications.listPageWatchNotifications(requester, undefined, 'browser')
      expect(retained.items).toEqual([expect.objectContaining({ id: inbox[0].id, title: 'New permitted title', path: 'new-route' })])
      await notifications.markPageWatchNotificationRead(requester, inbox[0].id, 'browser')
      expect((await db('pageWatchNotifications').where('id', inbox[0].id).first()).readAt).not.toBeNull()
    }
    await db('pages').where('id', 42).update({ visibility: 'private', ownerId: 8 })
    expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).items).toEqual([])
    expect(await db('pageWatchNotifications').where('id', inbox[0].id)).toHaveLength(0)
  })
  it('suppresses an already admitted recipient after password or consent revocation before delivery', async () => {
    const job = await enableAndClaim()
    await db('pageAccessPasswords').insert({ pageId: 42, version: 1 })
    await reminders.createPageReviewReminderHandler(governed.governedReviewNotificationAdapter)(job, { knex: db, signal: new AbortController().signal })
    expect(await db('pageWatchNotifications')).toHaveLength(0)
    expect(mailCalls).toBe(0)
    await db('pageAccessPasswords').delete()
    await db('userNotificationPreferences').where({ userId: 7, category: 'reviewReminder' }).update({ inAppEnabled: false })
    await reminders.createPageReviewReminderHandler(governed.governedReviewNotificationAdapter)(job, { knex: db, signal: new AbortController().signal })
    expect(await db('pageWatchNotifications')).toHaveLength(0)
  })
  it('preserves admitted channel consent at root publication and deduplicates feedback across publisher restarts', async () => {
    await db('webhooks').insert({ id: randomUUID(), name: 'Catch all', url: 'https://hooks.example.test/receive', events: JSON.stringify(['*']), secretCiphertext: 'test-only', isEnabled: true, createdAt: new Date(), updatedAt: new Date() })
    const { eventId, boardId } = await feedbackEvent(false)
    await db('userNotificationPreferences').where({ userId: 7, category: 'feedbackStatus' }).update({ emailEnabled: true })
    await outbox.publishOutboxEvents(db)
    await db('outboxEvents').where('id', eventId).update({ publishedAt: null })
    await outbox.publishOutboxEvents(db)
    const jobs = await invokeGoverned()
    expect(jobs).toHaveLength(1)
    expect(await db('webhookDeliveries')).toHaveLength(0)
    expect(await db('governedNotificationReceipts').where('eventId', eventId)).toEqual([expect.objectContaining({ userId: 7, channel: 'in-app', status: 'delivered' })])
    expect(await db('pageWatchNotifications').where('eventId', eventId)).toHaveLength(1)
    expect(mailCalls).toBe(0)
    await db('governedNotificationReceipts').where('eventId', eventId).update({ updatedAt: db.raw("clock_timestamp() - interval '91 days'") })
    await governed.cleanupGovernedNotifications(db)
    await db('outboxEvents').where('id', eventId).update({ publishedAt: null })
    await outbox.publishOutboxEvents(db)
    expect(await invokeGoverned()).toHaveLength(0)
    expect(await db('governedNotificationReceipts').where('eventId', eventId)).toHaveLength(1)
    await db('feedbackBoards').where('id', boardId).update({ enabled: false })
    expect((await governed.listOwnGovernedNotificationReceipts({ knex: db, requester, sessionId: 'browser' })).items).toEqual([])
    const inbox = await db('pageWatchNotifications').where('eventId', eventId).first()
    expect(await db.transaction(tx => governed.projectGovernedInboxRow(tx, inbox, 7, requester, 'browser'))).toBeNull()
  })
  it.each(['idea page', 'board page', 'disabled board'] as const)('retains delivered feedback through ceiling/cutoff changes but purges on lost %s access', async scope => {
    const { eventId, boardId } = await feedbackEvent(false)
    await outbox.publishOutboxEvents(db)
    await invokeGoverned()
    const delivered = await notifications.listPageWatchNotifications(requester, undefined, 'browser')
    const entry = delivered.items[0]
    if (!entry) throw new Error('Expected native delivered feedback inbox entry')
    expect(entry).toMatchObject({ category: 'feedbackStatus', readAt: null })
    for (const mode of ['off', 'in-app-only', 'existing-consented-channels'] as const) {
      await setCeiling('feedbackStatus', mode)
      const retained = await notifications.listPageWatchNotifications(requester, undefined, 'browser')
      expect(retained.items).toEqual([expect.objectContaining({ id: entry.id, pageId: 42, title: 'Current title' })])
      await notifications.markPageWatchNotificationRead(requester, entry.id, 'browser')
      expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).unreadCount).toBe(0)
      expect((await governed.listOwnGovernedNotificationReceipts({ knex: db, requester, sessionId: 'browser' })).items)
        .toEqual([expect.objectContaining({ channel: 'in-app', status: 'delivered' })])
    }
    await db('userNotificationPreferences').where({ userId: 7, category: 'feedbackStatus' }).update({ inAppEnabled: false })
    expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).items).toHaveLength(1)
    if (scope === 'disabled board') await db('feedbackBoards').where('id', boardId).update({ enabled: false })
    else await db('pages').where('id', scope === 'idea page' ? 42 : 43).update({ visibility: 'private', ownerId: 8 })
    await notifications.markPageWatchNotificationRead(requester, entry.id, 'browser')
    expect(await db('pageWatchNotifications').where('eventId', eventId)).toHaveLength(0)
    expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).items).toEqual([])
    expect((await governed.listOwnGovernedNotificationReceipts({ knex: db, requester, sessionId: 'browser' })).items).toEqual([])
    expect(mailCalls).toBe(0)
  })

  it('retains unknown SMTP outcomes across ceilings without admitting a resend or replaying the original root', async () => {
    const { eventId } = await feedbackEvent(true)
    await outbox.publishOutboxEvents(db)
    ambiguousMail = true
    await invokeGoverned()
    const email = await db('governedNotificationReceipts').where({ eventId, channel: 'email' }).first()
    expect(email).toMatchObject({ status: 'unknown', attempt: 0 })
    for (const mode of ['off', 'existing-consented-channels'] as const) {
      await setCeiling('feedbackStatus', mode)
      const visible = await governed.listOwnGovernedNotificationReceipts({ knex: db, requester, sessionId: 'browser' })
      expect(visible.items.find(row => row.id === email.id)).toMatchObject({ status: 'unknown', canResend: false, attempt: 0 })
      await expect(governed.resendOwnGovernedNotification({ knex: db, requester, sessionId: 'browser', id: email.id, acknowledged: true }))
        .rejects.toMatchObject({ status: 409, code: 'GOVERNED_RESEND_UNAVAILABLE' })
      expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).items).toHaveLength(1)
    }
    await db('outboxEvents').where('id', eventId).update({ publishedAt: null })
    await outbox.publishOutboxEvents(db)
    expect(await invokeGoverned()).toHaveLength(0)
    expect(mailCalls).toBe(1)
    expect(await db('governedNotificationEmailAttempts').where('receiptId', email.id)).toEqual([
      expect.objectContaining({ attempt: 0, status: 'unknown', duplicateAcknowledged: false })
    ])
  })
  it.each(['comment permission', 'hidden comment', 'deleted comment', 'disabled discussion'] as const)('retains readable status and delivery receipts without exposing an optional %s', async restriction => {
    if (restriction !== 'comment permission') {
      await db('groups').where('id', 3).update({
        permissions: JSON.stringify(['read:pages', 'write:pages', 'read:comments']),
        pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages', 'read:comments'], locales: [] }])
      })
    }
    await db('settings').insert({ key: 'features', value: JSON.stringify({ featurePageComments: true }) })
    await db('commentProviders').insert({ key: 'default', isEnabled: true }).onConflict('key').merge()
    await db('comments').insert({ id: 501, pageId: 42, authorId: 8, name: 'Other', content: 'Private discussion detail', replyTo: 0, isHidden: false })
    const { eventId, ideaId } = await feedbackEvent(false, 501)
    await db('feedbackSubscriptions').insert({ ideaId, userId: 7, createdAt: new Date() })
    if (restriction === 'hidden comment') await db('comments').where('id', 501).update({ isHidden: true })
    else if (restriction === 'deleted comment') await db('comments').where('id', 501).delete()
    else if (restriction === 'disabled discussion') await db('settings').where('key', 'features').update({ value: JSON.stringify({ featurePageComments: false }) })
    await outbox.publishOutboxEvents(db)
    await invokeGoverned()
    const receipt = await db('governedNotificationReceipts').where('eventId', eventId).first()
    expect(await db('governedNotificationReceipts').where('eventId', eventId)).toEqual([
      expect.objectContaining({ userId: 7, channel: 'in-app', status: 'delivered' })
    ])
    const inbox = await notifications.listPageWatchNotifications(requester, undefined, 'browser')
    expect(inbox.items).toEqual([expect.objectContaining({ category: 'feedbackStatus', pageId: 42, commentId: null })])
    const entry = inbox.items[0]
    if (!entry) throw new Error('Expected independently readable status entry')
    expect(entry).not.toHaveProperty('content')
    expect(entry).not.toHaveProperty('rootTransitionEventId')
    await notifications.markPageWatchNotificationRead(requester, entry.id, 'browser')
    expect((await db('pageWatchNotifications').where('id', entry.id).first()).readAt).not.toBeNull()
    expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).items)
      .toEqual([expect.objectContaining({ id: entry.id, commentId: null })])
    const visibleReceipts = await governed.listOwnGovernedNotificationReceipts({ knex: db, requester, sessionId: 'browser' })
    expect(visibleReceipts.items).toEqual([expect.objectContaining({ id: receipt.id, status: 'delivered', canResend: false })])
    expect(visibleReceipts.items[0]).not.toHaveProperty('commentId')
    expect(visibleReceipts.items[0]).not.toHaveProperty('content')
    expect(mailCalls).toBe(0)
  })
  it.each(['comment permission', 'hidden comment'] as const)('drops the optional anchor after losing %s while retaining readable feedback status', async restriction => {
    await db('groups').where('id', 3).update({
      permissions: JSON.stringify(['read:pages', 'write:pages', 'read:comments']),
      pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages', 'read:comments'], locales: [] }])
    })
    await db('settings').insert({ key: 'features', value: JSON.stringify({ featurePageComments: true }) })
    await db('commentProviders').insert({ key: 'default', isEnabled: true }).onConflict('key').merge()
    await db('comments').insert({ id: 501, pageId: 42, authorId: 8, name: 'Other', content: 'Status explanation', replyTo: 0, isHidden: false })
    const { eventId } = await feedbackEvent(false, 501)
    await outbox.publishOutboxEvents(db)
    await invokeGoverned()
    const initial = await notifications.listPageWatchNotifications(requester, undefined, 'browser')
    const entry = initial.items[0]
    if (!entry) throw new Error('Expected native comment-linked feedback entry')
    expect(entry).toMatchObject({ category: 'feedbackStatus', commentId: 501 })
    for (const mode of ['off', 'existing-consented-channels'] as const) {
      await setCeiling('feedbackStatus', mode)
      expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).items)
        .toEqual([expect.objectContaining({ id: entry.id, commentId: 501 })])
    }
    if (restriction === 'hidden comment') await db('comments').where('id', 501).update({ isHidden: true })
    else await db('groups').where('id', 3).update({
      permissions: JSON.stringify(['read:pages', 'write:pages']),
      pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages'], locales: [] }])
    })
    await notifications.markPageWatchNotificationRead(requester, entry.id, 'browser')
    expect((await db('pageWatchNotifications').where('eventId', eventId).first()).readAt).not.toBeNull()
    expect((await notifications.listPageWatchNotifications(requester, undefined, 'browser')).items)
      .toEqual([expect.objectContaining({ id: entry.id, commentId: null })])
    expect((await governed.listOwnGovernedNotificationReceipts({ knex: db, requester, sessionId: 'browser' })).items)
      .toEqual([expect.objectContaining({ channel: 'in-app', status: 'delivered' })])
    expect(mailCalls).toBe(0)
  })
  it('retains unknown status mail with an unreadable optional comment and permits only its owner to explicitly resend', async () => {
    await db('settings').insert({ key: 'features', value: JSON.stringify({ featurePageComments: true }) })
    await db('commentProviders').insert({ key: 'default', isEnabled: true }).onConflict('key').merge()
    await db('comments').insert({ id: 501, pageId: 42, authorId: 8, name: 'Other', content: 'Private discussion detail', replyTo: 0, isHidden: false })
    const { eventId } = await feedbackEvent(true, 501)
    await outbox.publishOutboxEvents(db)
    ambiguousMail = true
    const jobs = await invokeGoverned()
    const email = await db('governedNotificationReceipts').where({ eventId, channel: 'email' }).first()
    expect(email).toMatchObject({ status: 'unknown', attempt: 0 })
    expect(mailCalls).toBe(1)
    for (const job of jobs) await governed.createGovernedNotificationHandler()(job, { knex: db, signal: new AbortController().signal })
    expect(mailCalls).toBe(1)
    await expect(governed.resendOwnGovernedNotification({ knex: db, requester: { id: 8, authVersion: 0 } as Express.User, sessionId: 'other', id: email.id, acknowledged: true })).rejects.toMatchObject({ status: 404 })
    const visible = await governed.listOwnGovernedNotificationReceipts({ knex: db, requester, sessionId: 'browser' })
    expect(visible.items.find(row => row.id === email.id)).toMatchObject({ status: 'unknown', canResend: true })
    await governed.resendOwnGovernedNotification({ knex: db, requester, sessionId: 'browser', id: email.id, acknowledged: true })
    for (const old of jobs) await governed.createGovernedNotificationHandler()(old, { knex: db, signal: new AbortController().signal })
    expect((await db('governedNotificationReceipts').where('id', email.id).first()).status).toBe('pending')
    expect(mailCalls).toBe(1)
    ambiguousMail = false
    await invokeGoverned()
    expect(mailCalls).toBe(2)
    expect(await db('governedNotificationEmailAttempts').where('receiptId', email.id).orderBy('attempt')).toEqual([
      expect.objectContaining({ attempt: 0, status: 'unknown', duplicateAcknowledged: false }),
      expect.objectContaining({ attempt: 1, status: 'sent', duplicateAcknowledged: true })
    ])
    expect((await db('governedNotificationReceipts').where('id', email.id).first()).status).toBe('sent')
  })
  it('retries only affirmative prehandoff failures and records failed after the native attempt bound without sending email', async () => {
    const { eventId } = await feedbackEvent(true)
    await outbox.publishOutboxEvents(db)
    const receipt = await db('governedNotificationReceipts').where({ eventId, channel: 'email' }).first()
    const jobs = await new DurableJobStore(db).claim({ workerId: 'governed-preflight', supportedIdentities: ['notify-governed@1'], limit: 10 })
    const job = jobs.find(candidate => candidate.payload.receiptId === receipt.id)
    if (!job) throw new Error('Expected native email delivery job')
    failBeforeHandoff = true
    const handler = governed.createGovernedNotificationHandler(), context = { knex: db, signal: new AbortController().signal }
    await expect(handler(job, context)).rejects.toThrow('bounded retry admitted')
    expect((await db('governedNotificationReceipts').where('id', receipt.id).first()).status).toBe('pending')
    await db('durableJobs').where('id', job.id).update({ attempts: job.maxAttempts })
    await handler({ ...job, attempts: job.maxAttempts }, context)
    expect((await db('governedNotificationReceipts').where('id', receipt.id).first()).status).toBe('failed')
    expect((await db('governedNotificationEmailAttempts').where('receiptId', receipt.id).first()).status).toBe('failed')
    expect(mailCalls).toBe(0)
  })
  it('keeps a live old sending marker and terminalizes only an expired orphan before a replacement worker can replay it', async () => {
    const { eventId } = await feedbackEvent(true)
    await outbox.publishOutboxEvents(db)
    const receipt = await db('governedNotificationReceipts').where({ eventId, channel: 'email' }).first()
    const jobs = await new DurableJobStore(db).claim({ workerId: 'interrupted-owner', supportedIdentities: ['notify-governed@1'], limit: 10 })
    const job = jobs.find(candidate => candidate.payload.receiptId === receipt.id)
    if (!job) throw new Error('Expected actual leased email job')
    await db.transaction(async tx => {
      const old = tx.raw("clock_timestamp() - interval '60 seconds'")
      await tx('governedNotificationReceipts').where('id', receipt.id).update({ status: 'sending', messageId: '<interrupted@example.test>', updatedAt: old })
      await tx('governedNotificationEmailAttempts').insert({ receiptId: receipt.id, attempt: 0, status: 'sending', messageId: '<interrupted@example.test>', duplicateAcknowledged: false, createdAt: old, updatedAt: old })
    })
    await governed.recoverGovernedNotificationHandoffs(db)
    expect((await db('governedNotificationReceipts').where('id', receipt.id).first()).status).toBe('sending')
    await db('durableJobs').where('id', job.id).update({ leaseExpiresAt: db.raw("clock_timestamp() - interval '1 millisecond'") })
    await governed.recoverGovernedNotificationHandoffs(db)
    expect((await db('governedNotificationReceipts').where('id', receipt.id).first()).status).toBe('unknown')
    expect((await db('governedNotificationEmailAttempts').where('receiptId', receipt.id).first()).status).toBe('unknown')
    const replacement = await new DurableJobStore(db).claim({ workerId: 'replacement-owner', supportedIdentities: ['notify-governed@1'], limit: 10 })
    for (const next of replacement) await governed.createGovernedNotificationHandler()(next, { knex: db, signal: new AbortController().signal })
    expect(mailCalls).toBe(0)
  })
})
