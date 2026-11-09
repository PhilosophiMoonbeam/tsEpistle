import express from 'express'
import session from 'express-session'
import createKnex, { type Knex } from 'knex'
import { EventEmitter, once } from 'node:events'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import { governanceBodyParserError, governancePreBodyPrivacy } from '../../controllers/api/governance-http.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import { agentCsrfToken } from '../../agents/csrf.ts'
import { up as notesUp } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import { up as importUp } from '../../db/migrations/tsepistle-000072-hedgedoc-import.ts'
import { up as feedbackUp } from '../../db/migrations/tsepistle-000073-page-feedback.ts'
import { up as reviewUp } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as lifecycleUp } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as governedNotificationsUp } from '../../db/migrations/tsepistle-000076-governed-notifications.ts'
import { up as commentProvidersUp } from '../../db/migrations/2.4.14.ts'
import { up as jobsUp } from '../../db/migrations/2.5.130.ts'
import { up as outboxUp } from '../../db/migrations/2.5.131.ts'
import { up as pageWatchersUp } from '../../db/migrations/2.5.132.ts'
import { up as leaseUp } from '../../db/migrations/2.5.158.ts'
import { up as notificationPreferencesUp } from '../../db/migrations/tsepistle-000058-discussion-notifications.ts'
import type { FeedbackBoard, FeedbackList, FeedbackTransitionResult } from '../../../shared/page-feedback.ts'
import type { PageReviewView } from '../../../shared/page-review-routing.ts'
import type { PageLifecyclePreview } from '../../../shared/page-lifecycle.ts'
import type { HedgeDocInput, HedgeDocReview, HedgeDocReceipt } from '../../../shared/hedgedoc-import.ts'

const connection = getPostgresTestConnection('_governance_http_test', import.meta.path)
const suite = connection ? describe : describe.skip
const csrf = 'owned-governance-http-csrf'
const permissions = ['read:pages', 'write:pages', 'manage:pages', 'write:notes']
const ruleDefinition = { version: 1, selector: { kind: 'ids', pageIds: [11] }, condition: { kind: 'interval', anchorAt: '2026-11-01T00:00:00.000Z', days: 1 }, effects: [{ kind: 'set-notice', text: 'A literal automated notice.' }], terminalPolicy: 'keep' }
const snapshot = (): HedgeDocInput => ({ snapshot: { format: 'hedgedoc-content-v1', namespace: 'owned-http-export', notes: [{ id: 'source-note', markdown: 'Private original source.', author: 'Untrusted source author', timestamp: '2020-01-01T00:00:00Z', history: [], historyComplete: false, assets: [] }] }, choices: [{ sourceId: 'source-note', ownerId: 7, target: { kind: 'create', key: 'owned-http-import' }, assets: [] }] })

suite('mounted governance API with native PostgreSQL operations', () => {
  let db: Knex, server: Server | undefined, origin: string, cookie: string, peerCookie: string, guestCookie: string
  let previousWiki: unknown, previousRuntime: object
  let restorePageBinding: (() => void) | undefined
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  const request = (path: string, body?: unknown, options: { cookie?: string; csrf?: string; sourceOrigin?: string; site?: string; method?: string; raw?: string; owner?: string } = {}) => fetch(`${origin}/_api${path}`, {
    method: options.method ?? (body === undefined && options.raw === undefined ? 'GET' : 'POST'),
    headers: { Cookie: options.cookie ?? cookie, Origin: options.sourceOrigin ?? origin, 'Sec-Fetch-Site': options.site ?? 'same-origin', 'x-wiki-csrf': options.csrf ?? csrf, ...(options.owner === undefined ? {} : { 'X-Wiki-Governance-Owner': options.owner }), ...(body === undefined && options.raw === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.raw !== undefined ? { body: options.raw } : body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const value = await response.json()
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    return value as T
  }
  const board = async (): Promise<FeedbackBoard> => json(await request('/page-feedback/boards', { boardPageId: 10, name: 'Explicit native board', enabled: true }))
  const login = async (id: number) => {
    const response = await fetch(`${origin}/fixture-session/${id}`)
    if (response.status !== 204) throw new Error('Fixture browser session could not be created')
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  beforeAll(async () => {
    previousWiki = Reflect.get(globalThis, 'WIKI'); previousRuntime = getTransportRuntime<object>()
    db = createKnex({ client: 'pg', connection: connection!, pool: { min: 0, max: 8 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL, "groupId" integer NOT NULL);
      CREATE TABLE pages (id integer PRIMARY KEY, title text NOT NULL, path text NOT NULL, "localeCode" text NOT NULL, visibility text NOT NULL, "ownerId" integer, "sourceRevision" bigint NOT NULL DEFAULT 1, content text NOT NULL DEFAULT 'Original canonical content', "contentType" text NOT NULL DEFAULT 'markdown', "isPublished" boolean NOT NULL DEFAULT true, "publishStartDate" text NOT NULL DEFAULT '', "publishEndDate" text NOT NULL DEFAULT '', "authorId" integer, "creatorId" integer);
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false);
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, version integer NOT NULL);
      CREATE TABLE "pageUnlockGrants" (id text PRIMARY KEY, "pageId" integer NOT NULL, "sessionId" text NOT NULL, "userId" integer NOT NULL, "passwordVersion" integer NOT NULL, "expiresAt" timestamptz NOT NULL);
      CREATE TABLE "pageAccuracyAttestations" (id uuid PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL, "verifiedAt" timestamptz NOT NULL);
      CREATE TABLE settings (key varchar(255) PRIMARY KEY, value json, "updatedAt" varchar(255) NOT NULL);
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean, mode text, "syncInterval" text, config jsonb);
      CREATE TABLE assets (id serial PRIMARY KEY, filename text, "folderId" integer);
    `)
    await commentProvidersUp(db); await jobsUp(db); await outboxUp(db); await pageWatchersUp(db); await leaseUp(db); await notificationPreferencesUp(db)
    await notesUp(db); await importUp(db); await feedbackUp(db); await reviewUp(db); await lifecycleUp(db); await governedNotificationsUp(db)
    const runtime = { models: { knex: db }, config: { host: '', db: { type: 'postgres' }, lang: { code: 'en', namespacing: false }, sessionSecret: 'owned-governance-http-only-secret', uploads: { maxFileSize: 1024 * 1024, maxFiles: 20 } }, configSvc: {}, lang: {}, startedAt: {}, events: { inbound: new EventEmitter(), outbound: new EventEmitter() }, auth: { loadPageRuleAuthority, checkPageAccess: auth.checkPageAccess, checkAccess: auth.checkAccess }, logger }
    Reflect.set(globalThis, 'WIKI', runtime); configureTransportRuntime(runtime)
    const Page = (await import('../../models/pages.ts')).default
    const previousPageBinding = Page.knex()
    Page.knex(db)
    restorePageBinding = () => { Page.knex(previousPageBinding) }
    // Native operation modules capture WIKI at evaluation, so this fixture must install its runtime before loading the router.
    const { default: router } = await import('../../controllers/api/index.ts')
    const app = express()
    app.use(governancePreBodyPrivacy)
    app.use(session({ secret: 'owned-governance-browser-secret', resave: false, saveUninitialized: false }))
    // Authentication seam only: native operations reload the actual account,
    // authVersion, group policy, page ACL and unlock rows for every request.
    app.get('/fixture-session/:id', (req, res) => { Reflect.set(req.session, 'fixtureOwnerId', Number(req.params.id)); Reflect.set(req.session, 'agentCsrfToken', csrf); res.sendStatus(204) })
    app.post('/fixture-csrf', (req, res) => {
      Reflect.deleteProperty(req.session, 'agentCsrfToken')
      res.json({ token: agentCsrfToken(req) })
    })
    app.use((req, _res, next) => {
      if (req.get('Cookie') === 'fixture-api') { Reflect.set(req, 'user', createApiPrincipal(99, 3, ['manage:system'])); Reflect.set(req, 'authContext', { kind: 'apiKey', apiKeyId: 99, groupId: 3 }); next(); return }
      const id = Reflect.get(req.session, 'fixtureOwnerId')
      if (typeof id === 'number') { Reflect.set(req, 'user', { id, authVersion: 0, permissions: [] }); Reflect.set(req, 'authContext', id === 2 ? { kind: 'guest' } : { kind: 'user', userId: id }) }
      next()
    })
    app.use('/_api', express.json({ limit: '5mb' }), router)
    app.use(governanceBodyParserError)
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned governance HTTP server did not bind')
    origin = `http://127.0.0.1:${address.port}`; runtime.config.host = origin
    cookie = await login(7); peerCookie = await login(8); guestCookie = await login(2)
  })
  beforeEach(async () => {
    await db.raw('TRUNCATE users, groups, pages, "userGroups", "pageTags", "pageAccessPasswords", "pageUnlockGrants", "outboxEvents", "userNotificationPreferences", settings, "commentProviders", "pageAccuracyAttestations", "durableJobs", "feedbackBoards" RESTART IDENTITY CASCADE')
    await db('users').insert([2, 7, 8].map(id => ({ id, name: `Native account ${id}`, email: `native${id}@example.invalid` })))
    await db('groups').insert([{ id: 3, name: 'Current native writers', permissions: JSON.stringify(permissions), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: permissions }]) }, { id: 4, name: 'Native readers', permissions: JSON.stringify(['read:pages']), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages'] }]) }])
    await db('userGroups').insert([{ userId: 7, groupId: 3 }, { userId: 8, groupId: 3 }, { userId: 2, groupId: 4 }])
    await db('pages').insert([{ id: 10, title: 'Feedback anchor', path: 'feedback', localeCode: 'en', visibility: 'public', authorId: 7, creatorId: 7 }, { id: 11, title: 'Independent canonical idea', path: 'ideas/native', localeCode: 'en', visibility: 'public', authorId: 7, creatorId: 7 }, { id: 12, title: 'Secret canonical idea', path: 'ideas/private', localeCode: 'en', visibility: 'private', ownerId: 7, authorId: 7, creatorId: 7 }])
    logger.error.mockClear(); logger.warn.mockClear()
  })
  afterAll(async () => {
    if (server?.listening) {
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      server.closeAllConnections()
      await closed.promise
    }
    restorePageBinding?.()
    if (db) await db.destroy()
    Reflect.set(globalThis, 'WIKI', previousWiki); configureTransportRuntime(previousRuntime)
  })

  it('rejects supplied old-account and anonymous intent before reads or writes under a replaced browser session', async () => {
    expect(await json(await request('/page-feedback/boards', undefined, { owner: '7:0' }))).toEqual([])
    expect(await json(await request('/page-feedback/boards', undefined, { cookie: guestCookie, owner: 'anonymous' }))).toEqual([])
    await json(await request('/page-feedback/boards', undefined, { cookie: guestCookie, owner: '7:0' }), 409)
    for (const owner of ['8:0', '7:1', 'anonymous', '07:0']) {
      for (const path of ['/page-feedback/boards', '/pages/11/review-routing', '/page-lifecycle/rules', '/hedgedoc-import/provenance/owned-http-import', '/governed-notifications']) {
        const refusal = await json<{ code: string }>(await request(path, undefined, { owner }), 409)
        expect(refusal.code).toBe('GOVERNANCE_OWNER_CHANGED')
      }
    }
    for (const path of ['/page-feedback/boards', '/pages/11/review-routing/preview', '/page-lifecycle/preview', '/hedgedoc-import/review', `/governed-notifications/${randomUUID()}/resend`]) {
      await json(await request(path, {}, { owner: '8:0' }), 409)
    }
    expect(await db('feedbackBoards')).toEqual([])
    expect(await db('pageReviewRouting')).toEqual([])
    expect(await db('pageLifecyclePreviews')).toEqual([])
    expect(await db('liveNotes')).toEqual([])
  })

  it('lists only the current recipient and requires deliberate valid resend admission', async () => {
    expect(await json(await request('/governed-notifications'))).toEqual({ ownerId: 7, items: [] })
    expect(await json(await request('/governed-notifications', undefined, { cookie: peerCookie }))).toEqual({ ownerId: 8, items: [] })
    await json(await request('/governed-notifications?userId=8'), 400)
    const receiptId = randomUUID()
    await json(await request(`/governed-notifications/${receiptId}/resend`, { acknowledged: false }), 400)
    await json(await request(`/governed-notifications/${receiptId}/resend`, { acknowledged: true, requester: 8 }), 400)
    await json(await request(`/governed-notifications/${receiptId}/resend`, { acknowledged: true }), 404)
    expect(await db('governedNotificationReceipts')).toEqual([])
    expect(await db('durableJobs')).toEqual([])
    await db('users').where('id', 7).update({ authVersion: 1 })
    await json(await request('/governed-notifications'), 401)
  })

  it('mounts browser authority, origin and CSRF boundaries before any real feature mutation', async () => {
    for (const path of ['/page-feedback/boards', '/pages/11/review-routing/preview', '/page-lifecycle/preview', '/hedgedoc-import/review', `/governed-notifications/${randomUUID()}/resend`]) {
      await json(await request(path, {}, { cookie: 'fixture-api' }), 401)
      await json(await request(path, {}, { cookie: guestCookie }), 401)
      await json(await request(path, {}, { csrf: 'old-token' }), 403)
      await json(await request(path, {}, { sourceOrigin: 'https://outside.example.invalid' }), 403)
      await json(await request(path, {}, { site: 'cross-site' }), 403)
    }
    expect(await db('feedbackBoards')).toEqual([]); expect(await db('pageReviewRouting')).toEqual([]); expect(await db('pageLifecyclePreviews')).toEqual([]); expect(await db('liveNotes')).toEqual([])
  })
  it('admits native client mutations and explicit resend only with the current session CSRF token', async () => {
    const dom: unknown = Reflect.get(globalThis, '__wikiTestJsdom')
    if (!(dom instanceof JSDOM)) throw new Error('The native browser test document is required')
    const previousUrl = dom.window.location.href, previousFetch = window.fetch
    const previousConfig = [globalThis, window].map(target => ({ target, descriptor: Object.getOwnPropertyDescriptor(target, 'siteConfig') }))
    const config = { product: { name: 'tsEpistle', version: '0.1.0-test' }, agentCsrfToken: csrf }
    for (const { target } of previousConfig) Object.defineProperty(target, 'siteConfig', { configurable: true, writable: true, value: config })
    dom.reconfigure({ url: origin })
    // Static client imports would evaluate the store before its document-injected configuration exists.
    const { wikiStore } = await import('../../../client/store/index.ts')
    const { governanceApi } = await import('../../../client/helpers/page-governance-api.ts')
    const { resendGovernedNotification } = await import('../../../client/helpers/site-notifications-api.ts')
    const previousUser = { ...wikiStore.user }
    const previousAuth = { authRefreshSettled: wikiStore.authRefreshSettled, authRefreshPending: wikiStore.authRefreshPending, authRefreshOutcome: wikiStore.authRefreshOutcome }
    const nativeFetch = globalThis.fetch
    let browserCookie = await login(7), omitCsrf = false
    // Supply only browser-managed transport metadata. Native clients must supply their own CSRF and owner headers.
    window.fetch = (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Cookie', browserCookie); headers.set('Origin', origin); headers.set('Sec-Fetch-Site', 'same-origin')
      if (omitCsrf) headers.delete('X-Wiki-Csrf')
      return nativeFetch(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, origin), { ...init, headers })
    }
    Object.assign(wikiStore.user, { id: 7, authVersion: 0, authenticated: true, permissions })
    Object.assign(wikiStore, { authRefreshSettled: true, authRefreshPending: false, authRefreshOutcome: 'authenticated' })
    try {
      const value = await governanceApi.configureBoard({ boardPageId: 10, name: 'Client-owned native board', enabled: true })
      const idea = await governanceApi.attach({ boardId: value.id, pageId: 11, expectedBoardRevision: value.boardRevision, expectedSourceRevision: '1', acknowledged: true })
      await governanceApi.vote({ boardId: value.id, ideaId: idea.ideaId, expectedIdeaRevision: idea.ideaRevision, voted: true })
      expect(await db('feedbackVotes').where({ ideaId: idea.ideaId, userId: 7, voted: true })).toHaveLength(1)
      const routed = await governanceApi.updateReview(11, { command: 'route', expectedSourceRevision: '1', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [8] } })
      expect(routed.mode).toBe('users')
      await db('pageWatchers').insert({ pageId: 11, userId: 8, emailEnabled: true, inAppEnabled: false, createdAt: new Date() })
      await db('userNotificationPreferences').insert({ userId: 8, category: 'feedbackStatus', emailEnabled: true, inAppEnabled: false, updatedAt: new Date() })
      const changed = await governanceApi.transition({ boardId: value.id, ideaId: idea.ideaId, requestId: randomUUID(), expectedBoardRevision: value.boardRevision, expectedIdeaRevision: idea.ideaRevision, expectedSourceRevision: '1', targetState: 'planned', explanation: 'A deliberate browser status change.' })
      // The native publisher captures WIKI during module evaluation, after this suite installs its real runtime.
      const { publishOutboxEvents } = await import('../../core/outbox.ts')
      await publishOutboxEvents(db)
      const receipt = await db<{ id: string }>('governedNotificationReceipts').where({ eventId: changed.rootTransitionEventId, userId: 8, channel: 'email' }).first()
      if (!receipt) throw new Error('The native status event did not admit the consenting recipient')
      await db('governedNotificationReceipts').where('id', receipt.id).update({ status: 'unknown' })
      await db('governedNotificationEmailAttempts').insert({ receiptId: receipt.id, attempt: 0, status: 'unknown', duplicateAcknowledged: false, createdAt: new Date(), updatedAt: new Date() })
      browserCookie = await login(8)
      Object.assign(wikiStore.user, { id: 8 })
      const rotated = await nativeFetch(`${origin}/fixture-csrf`, { method: 'POST', headers: { Cookie: browserCookie } })
      const token: unknown = await rotated.json()
      if (rotated.status !== 200 || typeof token !== 'object' || token === null || !('token' in token) || typeof token.token !== 'string') throw new Error('Native session CSRF rotation failed')
      for (const invalid of [{ token: '', absent: true }, { token: 'incorrect-native-token', absent: false }, { token: csrf, absent: false }]) {
        config.agentCsrfToken = invalid.token; omitCsrf = invalid.absent
        await expect(governanceApi.subscribe({ boardId: value.id, ideaId: idea.ideaId, subscribed: true })).rejects.toMatchObject({ status: 403, code: 'ORIGIN_REQUIRED' })
        await expect(resendGovernedNotification(8, receipt.id)).rejects.toMatchObject({ status: 403, code: 'ORIGIN_REQUIRED' })
        expect(await db('feedbackSubscriptions')).toEqual([])
        expect(await db('governedNotificationReceipts').where('id', receipt.id).first()).toMatchObject({ status: 'unknown', attempt: 0 })
      }
      config.agentCsrfToken = token.token; omitCsrf = false
      await governanceApi.subscribe({ boardId: value.id, ideaId: idea.ideaId, subscribed: true })
      await resendGovernedNotification(8, receipt.id)
      expect(await db('feedbackSubscriptions').where({ ideaId: idea.ideaId, userId: 8 })).toHaveLength(1)
      expect(await db('governedNotificationReceipts').where('id', receipt.id).first()).toMatchObject({ status: 'pending', attempt: 1 })
      expect(await db('durableJobs').where({ type: 'notify-governed', deduplicationKey: `governed:${changed.rootTransitionEventId}:8:email:1` })).toHaveLength(1)
      expect(await db('governedNotificationEmailAttempts').where({ receiptId: receipt.id, attempt: 0 }).first()).toMatchObject({ status: 'unknown', duplicateAcknowledged: false })
    } finally {
      Object.assign(wikiStore.user, previousUser); Object.assign(wikiStore, previousAuth)
      window.fetch = previousFetch; dom.reconfigure({ url: previousUrl })
      for (const { target, descriptor } of previousConfig) {
        if (descriptor) Object.defineProperty(target, 'siteConfig', descriptor)
        else Reflect.deleteProperty(target, 'siteConfig')
      }
    }
  })
  it('sanitizes malformed and oversized private JSON without echoing source bytes or logging parser bodies', async () => {
    const secret = 'PRIVATE-SNAPSHOT-SENTINEL'
    for (const path of ['/hedgedoc-import/review', '/page-feedback/transition', '/page-lifecycle/preview', '/pages/11/review-routing', '/governed-notifications/not-a-uuid/resend']) {
      const result = await json<{ error: string; code: string }>(await request(path, undefined, { raw: `{"snapshot":"${secret}",` }), 400)
      expect(result).toEqual({ error: 'Invalid JSON request body.', code: 'INVALID_INPUT' })
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    await json(await request('/hedgedoc-import/review', undefined, { raw: JSON.stringify({ snapshot: secret.repeat(400000) }) }), 413)
    expect(logger.error).not.toHaveBeenCalled(); expect(logger.warn).not.toHaveBeenCalled()
  })
  it('rejects extra, malformed and impersonating DTOs rather than projecting them to valid writes', async () => {
    const value = await board()
    await json(await request('/page-feedback/vote', { boardId: value.id, ideaId: randomUUID(), voted: true, expectedIdeaRevision: '1', requester: { id: 8 } }), 400)
    await json(await request('/page-feedback/boards?unknown=1'), 400)
    await json(await request(`/page-feedback/boards/${value.id}?sort=top&sort=newest`), 400)
    await json(await request('/pages/11/review-routing', { command: 'reset', mode: 'contacts', expectedSourceRevision: '1', expectedRoutingRevision: '0', ownerId: 8 }, { method: 'PUT' }), 400)
    await json(await request('/page-lifecycle/preview', { definition: ruleDefinition, requester: { id: 8 } }), 400)
    await json(await request('/hedgedoc-import/review', { ...snapshot(), aliases: ['unsafe-address'] }), 400)
    await json(await request('/pages', { feedbackSubmission: { boardId: value.id, expectedBoardRevision: '1', acknowledged: true, requester: 8 } }), 400)
    await json(await request('/pages/11/move', { expectedSourceRevision: '1', destinationLocale: 'en', destinationPath: 'archive/native', lifecycleProposalId: '../invalid' }), 400)
    expect(await db('feedbackIdeas')).toEqual([]); expect(await db('pageReviewRouting')).toEqual([]); expect(await db('pageLifecyclePreviews')).toEqual([]); expect(await db('liveNotes')).toEqual([])
  })
  it('submits and votes through native feedback, independently filters private ideas, and returns stale authority without retry', async () => {
    const value = await board()
    const submitted = await json<{ ideaId: string }>(await request('/page-feedback/submit', { boardId: value.id, pageId: 11, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true }), 201)
    await json(await request('/page-feedback/submit', { boardId: value.id, pageId: 12, expectedBoardRevision: '1', expectedSourceRevision: '1', acknowledged: true }), 201)
    const publicList = await json<FeedbackList>(await request(`/page-feedback/boards/${value.id}`, undefined, { cookie: guestCookie }))
    expect(publicList.items.map(item => item.pageId)).toEqual([11]); expect(publicList.total).toBe(1)
    await json(await request('/page-feedback/vote', { boardId: value.id, ideaId: submitted.ideaId, voted: true, expectedIdeaRevision: '1' }))
    expect(await db('feedbackVotes').where({ userId: 7, voted: true })).toHaveLength(1); expect(await db('feedbackSubscriptions')).toEqual([])
    await db('pageWatchers').insert({ pageId: 11, userId: 8, emailEnabled: false, inAppEnabled: true, createdAt: new Date() })
    await db('userNotificationPreferences').insert({ userId: 8, category: 'feedbackStatus', emailEnabled: false, inAppEnabled: true, updatedAt: new Date() })
    const requestId = randomUUID()
    const changed = await json<FeedbackTransitionResult>(await request('/page-feedback/transition', { boardId: value.id, ideaId: submitted.ideaId, requestId, expectedBoardRevision: '1', expectedIdeaRevision: '1', expectedSourceRevision: '1', targetState: 'planned', explanation: 'An explicit native status decision.' }))
    expect(changed.state).toBe('planned')
    const root = await db('outboxEvents').where('id', changed.rootTransitionEventId).first()
    expect(root).toMatchObject({ type: 'feedback.status-changed', aggregateType: 'feedback-idea', aggregateId: submitted.ideaId, publishedAt: null })
    expect(JSON.parse(root.payload)).toEqual({ boardId: value.id, ideaId: submitted.ideaId, pageId: 11, actorId: 7, rootTransitionEventId: changed.rootTransitionEventId, commentId: null, recipientChannels: [{ userId: 8, emailEnabled: false, inAppEnabled: true }] })
    expect(await json(await request(`/page-feedback/receipts/${requestId}?boardId=${value.id}&ideaId=${submitted.ideaId}`))).toEqual(changed)
    const detail = await json<{ history: Array<{ toState: string }> }>(await request(`/page-feedback/boards/${value.id}/ideas/${submitted.ideaId}`))
    expect(detail.history.some(entry => entry.toState === 'planned')).toBe(true)
    await db('pages').where('id', 11).update({ sourceRevision: '2' })
    await json(await request('/page-feedback/transition', { boardId: value.id, ideaId: submitted.ideaId, requestId: randomUUID(), expectedBoardRevision: '1', expectedIdeaRevision: changed.ideaRevision, expectedSourceRevision: '1', targetState: 'completed', explanation: 'Stale source must not commit.' }), 409)
    expect((await db('feedbackIdeas').where('id', submitted.ideaId).first()).state).toBe('planned')
    expect(await db('outboxEvents')).toHaveLength(1)
    expect(await db('feedbackRequestReceipts')).toHaveLength(1)
    expect(await db('feedbackTransitions').where({ ideaId: submitted.ideaId, kind: 'status' })).toHaveLength(1)
    await db('users').where('id', 7).update({ authVersion: 1 })
    await json(await request(`/page-feedback/boards/${value.id}`), 401)
  })
  it('reads, previews, updates and resets real routing while preserving canonical source and accuracy', async () => {
    const before = await db('pages').where('id', 11).first()
    const initial = await json<PageReviewView>(await request('/pages/11/review-routing'))
    expect(initial.routingRevision).toBe('0'); expect(initial.enabled).toBe(false)
    const preview = await json<PageReviewView>(await request('/pages/11/review-routing/preview', { expectedSourceRevision: '1', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [8] } }))
    expect(preview.members.map(member => member.id)).toEqual([8]); expect(await db('pageReviewRouting')).toEqual([])
    const saved = await json<PageReviewView>(await request('/pages/11/review-routing', { command: 'route', expectedSourceRevision: '1', expectedRoutingRevision: '0', route: { mode: 'users', userIds: [8] } }, { method: 'PUT' }))
    await json(await request('/pages/11/review-routing', { command: 'reset', mode: 'contacts', expectedSourceRevision: '1', expectedRoutingRevision: '0' }, { method: 'PUT' }), 409)
    const reset = await json<PageReviewView>(await request('/pages/11/review-routing', { command: 'reset', mode: 'contacts', expectedSourceRevision: '1', expectedRoutingRevision: saved.routingRevision }, { method: 'PUT' }))
    expect(reset.mode).toBe('contacts'); expect(await db('pageReviewRoutingUsers')).toEqual([])
    expect(await db('pages').where('id', 11).first()).toEqual(before); expect(await db('pageAccuracyAttestations')).toEqual([])
  })
  it('binds lifecycle preview/save/status to current page revisions and has no bypass enable command', async () => {
    const preview = await json<PageLifecyclePreview>(await request('/page-lifecycle/preview', { definition: ruleDefinition }))
    expect(preview.pages.map(page => page.pageId)).toEqual([11]); expect(await db('pageLifecycleRules')).toEqual([])
    await db('pages').where('id', 11).update({ sourceRevision: '2' })
    await json(await request('/page-lifecycle/rules', { definition: ruleDefinition, previewToken: preview.previewToken, unattendedConsent: true, enabled: true }), 409)
    const fresh = await json<PageLifecyclePreview>(await request('/page-lifecycle/preview', { definition: ruleDefinition }))
    const saved = await json<{ ruleId: string; revision: number }>(await request('/page-lifecycle/rules', { definition: ruleDefinition, previewToken: fresh.previewToken, unattendedConsent: true, enabled: true }))
    await json(await request(`/page-lifecycle/rules/${saved.ruleId}/status`, { expectedRevision: saved.revision, action: 'enable' }), 400)
    await json(await request(`/page-lifecycle/rules/${saved.ruleId}/status`, { expectedRevision: saved.revision, action: 'disable' }))
    await json(await request(`/page-lifecycle/rules/${saved.ruleId}/status`, { expectedRevision: saved.revision, action: 'cancel' }), 409)
    expect((await db('pageLifecycleRules').where('id', saved.ruleId).first()).status).toBe('disabled')
  })
  it('reviews and executes private per-owner imports, keeps provenance private, and refuses owner impersonation and drift', async () => {
    const input = snapshot()
    await json(await request('/hedgedoc-import/review', { ...input, choices: [{ ...input.choices[0], ownerId: 8 }] }), 403)
    const review = await json<HedgeDocReview>(await request('/hedgedoc-import/review', input))
    expect(await db('liveNotes')).toEqual([])
    await json(await request('/hedgedoc-import/execute', { ...input, reviewDigest: '0'.repeat(64) }), 409)
    const receipt = await json<HedgeDocReceipt>(await request('/hedgedoc-import/execute', { ...input, reviewDigest: review.items[0]!.reviewDigest }))
    expect(receipt.status).toBe('imported'); expect((await db('liveNotes').first()).ownerId).toBe(7)
    const provenance = await json<{ untrusted: boolean; source: { markdown: string } }>(await request(`/hedgedoc-import/provenance/${receipt.key}`))
    expect(provenance.untrusted).toBe(true); expect(provenance.source.markdown).toBe(input.snapshot.notes[0]!.markdown)
    await json(await request(`/hedgedoc-import/provenance/${receipt.key}`, undefined, { cookie: peerCookie }), 404)
    await db('users').where('id', 7).update({ isActive: false })
    await json(await request('/hedgedoc-import/review', input), 401)
    expect(await db('hedgedocImports')).toHaveLength(1); expect(await db('liveNoteRevisions')).toHaveLength(1)
  })
})
