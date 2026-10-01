import knexModule from 'knex'
import type { Knex } from 'knex'
import type { DiscussionPolicySnapshot, ModerationInspection, PageDiscussionPolicy } from '../../../shared/discussion-policy.ts'
import type { PagePrincipal } from '../../helpers/page-access.ts'
import * as discussionSettings from '../../operations/discussion-settings.ts'
import * as discussionModeration from '../../operations/discussion-moderation.ts'
import { up as addModeration } from '../../db/migrations/tsepistle-000016-discussion-moderation.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_controller_discussion_test', import.meta.path)
const { writeDiscussionWorkspace: realWriteDiscussionWorkspace, createDiscussionSettingsStore } = discussionSettings
const { createDiscussionModerationStore } = discussionModeration
const read = vi.fn(), write = vi.fn(), list = vi.fn(), inspect = vi.fn(), moderate = vi.fn(), policy = vi.fn(), setPolicy = vi.fn(), closedPages = vi.fn()
vi.mockModule('../../operations/discussion-settings.ts', import.meta.url, () => ({ readDiscussionWorkspace: read, writeDiscussionWorkspace: write }))
vi.mockModule('../../operations/discussion-moderation.ts', import.meta.url, () => ({ discussionModeration: () => ({ list, inspect, moderate, policy, setPolicy, closedPages }) }))
vi.mockModule('../../operations/comments.ts', import.meta.url, () => ({ default: {} }))
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({ assertPageUnlocked: vi.fn() }))
const router = { get: vi.fn(), put: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn(), use: vi.fn() }
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), set: vi.fn() })
type Handler = (request: unknown, response: unknown) => Promise<void>
const handlers = new Map<string, Handler>()
beforeAll(async () => { await vi.importFresh('../../controllers/api/comments.ts', import.meta.url); for (const method of ['get', 'put', 'patch'] as const) for (const [path, handler] of router[method].mock.calls) handlers.set(`${method} ${path}`, handler as Handler) })
beforeEach(() => { globalThis.WIKI = { logger: { warn: vi.fn() } } as never })
describe('discussion workspace transports', () => {
  it('returns actionable permission/conflict errors and conceals internal failure details', async () => {
    for (const status of [403, 409]) { read.mockRejectedValueOnce(Object.assign(new Error('Review required'), { status })); const res = response(); await handlers.get('get /workspace')!({ user: {} }, res); expect(res.status).toHaveBeenCalledWith(status); expect(res.json).toHaveBeenCalledWith({ error: 'Review required' }) }
    read.mockRejectedValueOnce(new Error('database credentials')); const res = response(); await handlers.get('get /workspace')!({ user: {} }, res); expect(res.status).toHaveBeenCalledWith(500); expect(JSON.stringify(res.json.mock.calls[0])).not.toContain('database credentials')
  })
})

if (connection) describe('PostgreSQL discussion workspace transport outcomes', () => {
  let db: Knex
  let settings: { read(): Promise<DiscussionPolicySnapshot> }
  let moderation: {
    inspect(requester: PagePrincipal, id: number): Promise<ModerationInspection>
    policy(requester: PagePrincipal, id: number): Promise<PageDiscussionPolicy>
    moderate(requester: PagePrincipal, id: number, body: Record<string, unknown>): Promise<ModerationInspection>
    setPolicy(requester: PagePrincipal, id: number, body: Record<string, unknown>): Promise<PageDiscussionPolicy>
  }
  const admin = { id: 1, permissions: ['manage:system'] }
  const definitions = [{ key: 'default', title: 'Default', isAvailable: true, props: { minDelay: { type: 'number' as const } } }]
  const tables = ['discussionModerationHistory', 'pageDiscussionPolicy', 'comments', 'pages', 'commentProviders', 'settings']
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value'); table.string('updatedAt').notNullable() })
    await db.schema.createTable('commentProviders', table => { table.string('key').primary(); table.boolean('isEnabled'); table.jsonb('config') })
    await db.schema.createTable('pages', table => { table.integer('id').primary(); table.string('title'); table.string('path'); table.string('localeCode'); table.string('visibility') })
    await db.schema.createTable('comments', table => { table.integer('id').primary(); table.integer('pageId').references('pages.id'); table.integer('authorId'); table.text('content'); table.text('render'); table.string('name'); table.string('email'); table.string('ip'); table.integer('replyTo').defaultTo(0); table.string('createdAt'); table.string('updatedAt') })
    await addModeration(db)
    settings = createDiscussionSettingsStore({ db, definitions: () => definitions, fallbackFeatures: () => ({ featurePageComments: true }), activate: async () => [] })
    moderation = createDiscussionModerationStore(db)
  })
  afterAll(async () => { if (db) { for (const table of tables) await db.schema.dropTableIfExists(table); await db.destroy() } })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('commentProviders').insert({ key: 'default', isEnabled: true, config: JSON.stringify({ minDelay: 30 }) })
    await db('pages').insert([{ id: 7, title: 'Guide', path: 'guide', localeCode: 'en', visibility: 'public' }, { id: 8, title: 'Other', path: 'other', localeCode: 'en', visibility: 'public' }])
    await db('comments').insert([{ id: 42, pageId: 7 }, { id: 43, pageId: 8 }].map(row => ({ ...row, authorId: 9, content: 'Retained contribution', render: '<p>Retained contribution</p>', name: 'Reader', email: 'reader@example.invalid', ip: '192.0.2.1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })))
    globalThis.WIKI = {
      auth: { checkAccess: (user: typeof admin | undefined) => user?.id === admin.id && user.permissions.includes('manage:system') },
      config: { features: { featurePageComments: true } }, data: { commentProviders: definitions },
      models: { knex: db, commentProviders: { initProvider: async () => { throw new Error('provider activation unavailable') } } },
      events: { outbound: { emit: () => {} } }, logger: { warn: vi.fn() }
    } as never
    write.mockReset().mockImplementation(realWriteDiscussionWorkspace)
    moderate.mockReset().mockImplementation(moderation.moderate)
    setPolicy.mockReset().mockImplementation(moderation.setPolicy)
  })
  it('commits reviewed availability, ratings and provider configuration, returning warnings and fencing stale or unauthorized writes', async () => {
    const initial = await settings.read()
    const body = { enabled: false, pageRatingsEnabled: true, pageRatingsMode: 'stars', providers: [{ key: 'default', isEnabled: true, config: { minDelay: 45 } }], fingerprint: initial.fingerprint }
    const res = response()
    await handlers.get('put /workspace')!({ user: admin, body }, res)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
    const saved = res.json.mock.calls[0]![0]
    expect(saved).toMatchObject({ enabled: false, pageRatingsEnabled: true, pageRatingsMode: 'stars' })
    expect(saved.providers.find((row: { key: string }) => row.key === 'default').config.minDelay).toBe(45)
    expect(saved.warnings).toEqual([expect.any(String)])
    const persisted = await settings.read()
    expect(persisted.fingerprint).toBe(saved.fingerprint)
    expect(persisted).toMatchObject({ enabled: false, pageRatingsEnabled: true, pageRatingsMode: 'stars' })
    expect((await db('commentProviders').where('key', 'default').first()).config.minDelay).toBe(45)
    const before = await db('settings').orderBy('key')
    const stale = response()
    await handlers.get('put /workspace')!({ user: admin, body: { ...body, enabled: true } }, stale)
    expect(stale.status).toHaveBeenCalledWith(409)
    expect(await db('settings').orderBy('key')).toEqual(before)
    expect((await settings.read()).fingerprint).toBe(persisted.fingerprint)
    const denied = response()
    await handlers.get('put /workspace')!({ user: { id: 9, permissions: [] }, body: { ...body, enabled: true, fingerprint: persisted.fingerprint } }, denied)
    expect(denied.status).toHaveBeenCalledWith(403)
    expect(await settings.read()).toEqual(persisted)
  })
  it('hides only the reviewed comment and closes only the reviewed page, preserving content and actor/reason history', async () => {
    const initial = await moderation.inspect(admin as never, 42)
    const body = { hidden: true, reason: 'Needs a source reference', fingerprint: initial.fingerprint }
    const hiddenResponse = response()
    await handlers.get('patch /moderation/:id')!({ user: admin, params: { id: '42' }, body }, hiddenResponse)
    expect(hiddenResponse.json).toHaveBeenCalledTimes(1)
    const hidden = hiddenResponse.json.mock.calls[0]![0]
    expect(hidden).toMatchObject({ id: 42, isHidden: true, content: 'Retained contribution', updatedAt: initial.updatedAt, moderatedBy: 1 })
    expect(hidden.history[0]).toMatchObject({ action: 'hide', actorId: 1, reason: body.reason })
    expect(await moderation.inspect(admin as never, 42)).toEqual(hidden)
    expect((await moderation.inspect(admin as never, 43)).isHidden).toBe(false)
    const staleComment = response()
    await handlers.get('patch /moderation/:id')!({ user: admin, params: { id: '42' }, body: { ...body, hidden: false } }, staleComment)
    expect(staleComment.status).toHaveBeenCalledWith(409)
    expect(await moderation.inspect(admin as never, 42)).toEqual(hidden)
    const initialPage = await moderation.policy(admin as never, 7)
    const pageBody = { closed: true, reason: 'Question resolved', fingerprint: initialPage.fingerprint }
    const closedResponse = response()
    await handlers.get('patch /page-policy/:id')!({ user: admin, params: { id: '7' }, body: pageBody }, closedResponse)
    expect(closedResponse.json).toHaveBeenCalledTimes(1)
    const closed = closedResponse.json.mock.calls[0]![0]
    expect(closed).toMatchObject({ closed: true, updatedBy: 1, page: { id: 7 } })
    expect(closed.history[0]).toMatchObject({ action: 'close', actorId: 1, reason: pageBody.reason })
    expect(await moderation.policy(admin as never, 7)).toEqual(closed)
    expect((await moderation.policy(admin as never, 8)).closed).toBe(false)
    expect((await db('comments').where('id', 42).first()).content).toBe('Retained contribution')
    const stalePage = response()
    await handlers.get('patch /page-policy/:id')!({ user: admin, params: { id: '7' }, body: { ...pageBody, closed: false } }, stalePage)
    expect(stalePage.status).toHaveBeenCalledWith(409)
    expect(await moderation.policy(admin as never, 7)).toEqual(closed)
    for (const [route, id, currentBody] of [
      ['patch /moderation/:id', '42', { ...body, hidden: false, fingerprint: hidden.fingerprint }],
      ['patch /page-policy/:id', '7', { ...pageBody, closed: false, fingerprint: closed.fingerprint }]
    ] as const) {
      const denied = response()
      await handlers.get(route)!({ user: { id: 9, permissions: [] }, params: { id }, body: currentBody }, denied)
      expect(denied.status).toHaveBeenCalledWith(403)
    }
    expect(await moderation.inspect(admin as never, 42)).toEqual(hidden)
    expect(await moderation.policy(admin as never, 7)).toEqual(closed)
  })
})
