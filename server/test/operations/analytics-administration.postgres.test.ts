import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createReaderAnalytics } from '../../helpers/reader-analytics.ts'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { createAnalyticsAdministrationStore } from '../../operations/analytics-administration.ts'
import { recordAnalyticsResponse, pruneAnalyticsInsights, analyticsRetentionStart } from '../../repositories/analytics-insights.ts'
import { readAnalyticsSnapshot, compileAnalyticsSnapshot } from '../../repositories/analytics-runtime.ts'
import { up, down } from '../../db/migrations/tsepistle-000022-analytics-administration.ts'
import type { AnalyticsPolicy, AnalyticsRequestContext } from '../../../shared/analytics-policy.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_analytics_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
const request: AnalyticsRequestContext = {
  method: 'GET',
  reader: true,
  published: true,
  visibility: 'public',
  protected: false,
  path: 'guide',
  signedIn: false,
  administrator: false,
  privacySignal: false,
  prefetch: false,
  offline: false
}
const now = new Date('2026-09-06T12:00:00Z'),
  serverPath = path.resolve('server')
suite('PostgreSQL reviewed analytics and aggregate reader responses', () => {
  let db: Knex, store: ReturnType<typeof createAnalyticsAdministrationStore>, available: Set<string>
  const tables = ['analyticsDaily', 'pageAccessPasswords', 'pages', 'analytics', 'userGroups', 'users', 'groups', 'settings']
  const read = () => store.inspect(admin)
  const save = async (patch: Partial<AnalyticsPolicy> = {}, mutate?: (current: Awaited<ReturnType<typeof read>>) => void) => {
    const current = await read()
    mutate?.(current)
    return store.save(admin, {
      policy: { ...current.policy, ...patch },
      providers: current.providers.map(({ key, isEnabled, config }) => ({ key, isEnabled, config })),
      fingerprint: current.fingerprint,
      reason: 'Review analytics policy'
    })
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 12 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value')
      t.string('updatedAt')
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary()
      t.json('permissions')
      t.string('adminRevision').defaultTo('')
    })
    await db.schema.createTable('users', t => {
      t.integer('id').primary()
      t.boolean('isActive').defaultTo(true)
      t.integer('authVersion').defaultTo(0)
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId')
      t.integer('groupId')
      t.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('analytics', t => {
      t.string('key').primary()
      t.boolean('isEnabled')
      t.json('config')
    })
    await db.schema.createTable('pages', t => {
      t.integer('id').primary()
      t.string('path')
      t.string('title')
      t.string('localeCode', 35)
      t.string('visibility')
      t.boolean('isPublished')
      t.string('publishStartDate')
      t.string('publishEndDate')
    })
    await db.schema.createTable('pageAccessPasswords', t => {
      t.integer('pageId').primary().references('id').inTable('pages').onDelete('CASCADE')
    })
    await up(db)
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('settings').insert(['analyticsPolicy', 'analyticsAdministration'].map(key => ({ key, value: '{}', updatedAt: now.toISOString() })))
    await db('groups').insert([
      { id: 1, permissions: '["manage:system"]' },
      { id: 3, permissions: '["read:pages"]' }
    ])
    await db('users').insert([{ id: 1 }, { id: 3 }])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 3 }
    ])
    await db('analytics').insert([
      {
        key: 'plausible',
        isEnabled: false,
        config: '{"domain":"wiki.example.test","plausibleJsSrc":"https://stats.example.test/script.js","unowned":"retain"}'
      },
      { key: 'hotjar', isEnabled: false, config: '{"siteId":""}' }
    ])
    await db('pages').insert([
      { id: 1, path: 'guide', title: 'Guide', localeCode: 'en', visibility: 'public', isPublished: true, publishStartDate: '', publishEndDate: '' },
      { id: 2, path: 'personal', title: 'Private title', localeCode: 'en', visibility: 'private', isPublished: true },
      { id: 3, path: 'draft', title: 'Draft title', localeCode: 'en', visibility: 'public', isPublished: false }
    ])
    available = new Set(['plausible', 'hotjar'])
    store = createAnalyticsAdministrationStore({ db, reviewKey: 'review-secret', serverPath, available: () => available, fallback: () => ({}), now: () => now })
  })
  it('rolls back an unused schema without dropping existing page data', async () => {
    await down(db)
    expect(await db.schema.hasTable('analyticsDaily')).toBe(false)
    expect(await db('pages').count('* as count').first()).toMatchObject({ count: '3' })
    await up(db)
  })
  it('reports disabled and incomplete providers honestly without inventing traffic', async () => {
    const current = await read()
    expect(current.policy.localEnabled).toBe(false)
    expect(current.insights.totalResponses).toBe(0)
    expect(current.providers.find(row => row.key === 'hotjar')?.issues).toContain('Site ID is required.')
    expect(current.providers.find(row => row.key === 'plausible')?.destinations).toEqual(['stats.example.test'])
    expect(JSON.stringify(current)).not.toContain('Private title')
    expect(JSON.stringify(current)).not.toContain('unowned')
  })
  it('atomically publishes providers, collection and history while preserving unowned fields', async () => {
    const result = await save({ localEnabled: true, externalEnabled: true }, current => {
      current.providers.find(row => row.key === 'plausible')!.isEnabled = true
    })
    const current = await read()
    expect(current.revision).toBe(result.revision)
    expect(current.history[0]).toMatchObject({ reason: 'Review analytics policy', providers: ['plausible'], fields: ['localEnabled', 'externalEnabled'] })
    expect((await db('analytics').where('key', 'plausible').first()).config.unowned).toBe('retain')
    const snapshot = await readAnalyticsSnapshot(db),
      compiled = await compileAnalyticsSnapshot(snapshot, request, serverPath, available)
    expect(compiled.hasExternalCode).toBe(true)
    await save({ externalEnabled: false })
    expect((await compileAnalyticsSnapshot(await readAnalyticsSnapshot(db), request, serverPath, available)).hasExternalCode).toBe(false)
  })
  it('rolls every provider and policy back if the audit write fails', async () => {
    await db.raw("ALTER TABLE settings ADD CONSTRAINT reject_analytics_history CHECK (key <> 'analyticsAdministration' OR value='{}'::jsonb)")
    try {
      await expect(
        save({ localEnabled: true }, current => {
          current.providers[1]!.isEnabled = true
        })
      ).rejects.toThrow()
      expect((await read()).policy.localEnabled).toBe(false)
      expect((await db('analytics').where('key', 'plausible').first()).isEnabled).toBe(false)
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT reject_analytics_history')
    }
  })
  it('rejects stale/ABA reviews, duplicate inventories, current authority changes and unavailable providers', async () => {
    const original = await read()
    await save({ localEnabled: true })
    await save({ localEnabled: false })
    await expect(
      store.save(admin, {
        policy: original.policy,
        providers: original.providers.map(({ key, isEnabled, config }) => ({ key, isEnabled, config })),
        fingerprint: original.fingerprint,
        reason: 'Stale review'
      })
    ).rejects.toThrow('changed')
    await expect(
      save({}, current => {
        current.providers.push(current.providers[0]!)
      })
    ).rejects.toThrow('inventory')
    available.delete('plausible')
    await expect(
      save({}, current => {
        current.providers.find(row => row.key === 'plausible')!.isEnabled = true
      })
    ).rejects.toThrow('unavailable')
    await db('users').where('id', 1).update('authVersion', 1)
    await expect(read()).rejects.toThrow('session changed')
  })
  it('supports a current API system grant and rejects an ordinary reader', async () => {
    await expect(store.inspect({ id: 3, authVersion: 0 } as never)).rejects.toThrow('System administration')
    const api = { id: 1, ownershipUserId: null, groups: [1] } as never
    expect((await store.inspect(api)).providers).toHaveLength(2)
    await db('groups').where('id', 1).update('permissions', '["read:pages"]')
    await expect(store.inspect(api)).rejects.toThrow('System administration')
  })
  it('allows disabling an invalid legacy integration without executing or discarding its configuration', async () => {
    await db('analytics').where('key', 'hotjar').update({ isEnabled: true, config: '{"siteId":"bad identifier"}' })
    await save({}, current => {
      current.providers.find(row => row.key === 'hotjar')!.isEnabled = false
    })
    expect((await db('analytics').where('key', 'hotjar').first()).config.siteId).toBe('bad identifier')
    await expect(
      save({}, current => {
        current.providers.find(row => row.key === 'hotjar')!.isEnabled = true
      })
    ).rejects.toThrow('whole-number')
  })
  it('retains and disables an unrecognized saved integration even when its key is not a supported module name', async () => {
    await db('analytics').insert({ key: 'legacy.custom/provider', isEnabled: true, config: '{"retained":"opaque configuration"}' })
    expect((await read()).providers.find(row => row.key === 'legacy.custom/provider')?.isAvailable).toBe(false)
    await save({}, current => {
      current.providers.find(row => row.key === 'legacy.custom/provider')!.isEnabled = false
    })
    expect((await db('analytics').where('key', 'legacy.custom/provider').first()).config).toEqual({ retained: 'opaque configuration' })
  })
  it('increments concurrent response counters without retaining visitor attributes', async () => {
    await save({ localEnabled: true })
    const results = await Promise.all(Array.from({ length: 40 }, () => recordAnalyticsResponse(db, 1, request, now)))
    expect(results.every(Boolean)).toBe(true)
    const rows = await db('analyticsDaily')
    expect(rows).toHaveLength(1)
    expect(rows[0].responses).toBe('40')
    expect(Object.keys(rows[0]).sort()).toEqual(['day', 'pageId', 'responses'])
    const insights = (await read()).insights
    expect(insights.totalResponses).toBe(40)
    expect(insights.topPages[0]).toMatchObject({ id: 1, title: 'Guide', responses: 40 })
  })
  it('rechecks current policy and page state, and excludes private, protected, unpublished and out-of-window pages', async () => {
    expect(await recordAnalyticsResponse(db, 1, request, now)).toBe(false)
    await save({ localEnabled: true })
    for (const id of [2, 3, 999]) expect(await recordAnalyticsResponse(db, id, request, now)).toBe(false)
    await db('pageAccessPasswords').insert({ pageId: 1 })
    expect(await recordAnalyticsResponse(db, 1, request, now)).toBe(false)
    await db('pageAccessPasswords').delete()
    await db('pages').where('id', 1).update('publishStartDate', '2026-10-01T00:00:00Z')
    expect(await recordAnalyticsResponse(db, 1, request, now)).toBe(false)
    await db('pages').where('id', 1).update({ publishStartDate: '', publishEndDate: '2026-08-01T00:00:00Z' })
    expect(await recordAnalyticsResponse(db, 1, request, now)).toBe(false)
    await db('pages').where('id', 1).update('publishEndDate', '')
    expect(await recordAnalyticsResponse(db, 1, { ...request, privacySignal: true }, now)).toBe(false)
    await save({ localEnabled: false })
    expect(await recordAnalyticsResponse(db, 1, request, now)).toBe(false)
    expect(await db('analyticsDaily')).toHaveLength(0)
  })
  it('filters current private/protected pages from insight and cascades counters on deletion', async () => {
    await save({ localEnabled: true })
    await recordAnalyticsResponse(db, 1, request, now)
    await db('pages').where('id', 1).update('visibility', 'private')
    expect((await read()).insights.totalResponses).toBe(0)
    await db('pages').where('id', 1).update('visibility', 'public')
    await db('pageAccessPasswords').insert({ pageId: 1 })
    expect((await read()).insights.totalResponses).toBe(0)
    await db('pages').where('id', 1).delete()
    expect(await db('analyticsDaily')).toHaveLength(0)
  })
  it('compares publication offsets as timestamps when reporting recorded responses', async () => {
    await save({ localEnabled: true })
    await recordAnalyticsResponse(db, 1, request, now)
    await db('pages').where('id', 1).update({ publishStartDate: '2026-09-06T13:00:00+02:00', publishEndDate: '2026-09-06T08:00:00-05:00' })
    expect((await read()).insights.totalResponses).toBe(1)
  })
  it('changes the reporting window without changing policy or review identity and caps it to retention', async () => {
    await save({ retentionDays: 30 })
    await db('analyticsDaily').insert([
      { day: '2026-08-09', pageId: 1, responses: 10 },
      { day: '2026-09-06', pageId: 1, responses: 2 }
    ])
    const current = await read(),
      week = await store.inspect(admin, 7),
      year = await store.inspect(admin, 365)
    expect(week.insights).toMatchObject({ from: '2026-08-31', totalResponses: 2 })
    expect(week.fingerprint).toBe(current.fingerprint)
    expect(year.insights).toMatchObject({ from: '2026-08-08', totalResponses: 12 })
    expect(week.policy.retentionDays).toBe(30)
    await expect(store.inspect(admin, NaN)).rejects.toThrow('reporting window')
  })
  it('enforces UTC retention even while collection is paused and preserves the inclusive boundary', async () => {
    await save({ retentionDays: 30 })
    const cutoff = analyticsRetentionStart(now, 30)
    expect(cutoff).toBe('2026-08-08')
    await db('analyticsDaily').insert([
      { day: '2026-08-07', pageId: 1, responses: 9 },
      { day: cutoff, pageId: 1, responses: 3 },
      { day: '2026-09-06', pageId: 1, responses: 2 }
    ])
    expect((await read()).insights.totalResponses).toBe(5)
    expect(await pruneAnalyticsInsights(db, now)).toBe(1)
    expect(await db('analyticsDaily')).toHaveLength(2)
  })
  it('counts only successful completed reader responses and forces a document boundary for external scripts', async () => {
    await save({ localEnabled: true, externalEnabled: true }, current => {
      current.providers.find(row => row.key === 'plausible')!.isEnabled = true
    })
    let recordDone: Promise<unknown> = Promise.resolve()
    const prepare = createReaderAnalytics({
      db,
      serverPath,
      available: () => available,
      fallback: () => ({}),
      isAdministrator: () => false,
      warn: () => {},
      record: (...args) => {
        const work = recordAnalyticsResponse(args[0], args[1], args[2], now)
        recordDone = work
        return work
      }
    })
    const req = (headers: Record<string, string> = {}) => ({ method: 'GET', user: { id: 2 }, get: (name: string) => headers[name] }) as never
    const response = (statusCode = 200) => Object.assign(new EventEmitter(), { locals: {} as Record<string, unknown>, statusCode, writableFinished: true })
    const page = { id: 1, path: 'guide', visibility: 'public' as const }
    const res = response()
    expect(await prepare(req(), res as never, page, true, false, true)).toBe(false)
    expect(JSON.stringify(res.locals.analyticsCode)).toContain('stats.example.test')
    expect((await read()).insights.totalResponses).toBe(0)
    res.emit('finish')
    await recordDone
    res.emit('finish')
    await recordDone
    expect((await read()).insights.totalResponses).toBe(1)
    for (const [headers, status] of [
      [{}, 500],
      [{ 'X-Wiki-Navigation': '1' }, 200],
      [{ DNT: '1' }, 200],
      [{ 'Sec-GPC': '1' }, 200],
      [{ Purpose: 'prefetch' }, 200]
    ] as Array<[Record<string, string>, number]>) {
      const skipped = response(status)
      await prepare(req(headers), skipped as never, page, true, false, true)
      skipped.emit('finish')
      await recordDone
    }
    expect((await read()).insights.totalResponses).toBe(1)
    const privateResponse = response()
    expect(await prepare(req(), privateResponse as never, { ...page, visibility: 'private' }, true, false, true)).toBe(true)
    expect(JSON.stringify(privateResponse.locals.analyticsCode)).not.toContain('stats.example.test')
    await save({ externalEnabled: false })
    const spaResponse = response()
    expect(await prepare(req({ 'X-Wiki-Navigation': '1' }), spaResponse as never, page, true, false, true)).toBe(true)
    spaResponse.emit('finish')
    await recordDone
    expect((await read()).insights.totalResponses).toBe(2)
  })
  it('requires reviewed attributed erasure, retains its receipt and refuses a lossy migration rollback', async () => {
    await save({ localEnabled: true })
    await recordAnalyticsResponse(db, 1, request, now)
    await expect(down(db)).rejects.toThrow('Cannot discard')
    const current = await read()
    await expect(store.erase(admin, { fingerprint: current.fingerprint, reason: 'Reviewed removal', confirmation: 'erase' })).rejects.toThrow('confirmation')
    const result = await store.erase(admin, { fingerprint: current.fingerprint, reason: 'Reviewed local counter erasure', confirmation: 'ERASE LOCAL COUNTS' })
    expect(result.erasedRows).toBe(1)
    expect((await read()).history[0]).toMatchObject({ kind: 'erase', erasedRows: 1 })
    expect((await read()).policy.localEnabled).toBe(true)
    await expect(down(db)).rejects.toThrow('Cannot discard')
  })
})
