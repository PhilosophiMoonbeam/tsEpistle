import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createGeneralAdministrationStore, generalPolicyFromConfiguration, patchLegacyGeneralConfiguration } from '../../operations/general-administration.ts'
import { createDiscussionSettingsStore } from '../../operations/discussion-settings.ts'
import { generalPolicyDefaults, type GeneralPolicy } from '../../../shared/general-policy.ts'
const connection = getPostgresTestConnection('_general_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
suite('PostgreSQL reviewed General settings', () => {
  let db: Knex, store: ReturnType<typeof createGeneralAdministrationStore>
  const tables = ['userGroups', 'users', 'groups', 'commentProviders', 'settings']
  const read = () => store.inspect(admin)
  const write = async (patch: Partial<GeneralPolicy>, extra = {}) => {
    const w = await read()
    return store.save(admin, { policy: { ...w.policy, ...patch }, fingerprint: w.fingerprint, reason: 'Review workspace settings', ...extra })
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value')
      t.string('updatedAt').notNullable()
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
    await db.schema.createTable('commentProviders', t => {
      t.string('key').primary()
      t.boolean('isEnabled').notNullable()
      t.jsonb('config').notNullable()
    })
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('settings').insert(
      [
        { key: 'host', value: '{"v":"https://wiki.example.com"}' },
        { key: 'title', value: '{"v":"Original"}' },
        { key: 'seo', value: '{"description":"Description","robots":["index"],"analyticsId":"private-analytics-value"}' },
        { key: 'editShortcuts', value: '{"editFab":true,"futureShortcut":"retained"}' },
        { key: 'features', value: '{"featurePageComments":false}' },
        { key: 'auth', value: '{"audience":"unchanged"}' }
      ].map(row => ({ ...row, updatedAt: new Date().toISOString() }))
    )
    await db('groups').insert([
      { id: 1, permissions: '["manage:system"]' },
      { id: 2, permissions: '["manage:users"]' }
    ])
    await db('users').insert([{ id: 1 }, { id: 3 }])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 2 }
    ])
    await db('commentProviders').insert({ key: 'default', isEnabled: true, config: '{"minDelay":0}' })
    store = createGeneralAdministrationStore({ db, reviewKey: 'fixture-key', fallback: () => ({}), runtime: () => structuredClone(generalPolicyDefaults) })
  })
  it('projects owned settings without exposing unrelated settings or private analytics values', async () => {
    const w = await read()
    expect(w.policy.host).toBe('https://wiki.example.com')
    expect(w.policy.title).toBe('Original')
    expect(w.runtime.state).toBe('needs-attention')
    expect(JSON.stringify(w)).not.toContain('private-analytics-value')
    expect(w.history).toEqual([])
  })
  it('persists one atomic revision, preserves unowned values and distinguishes clearing from defaults', async () => {
    await db('settings').insert({ key: 'company', value: JSON.stringify({ v: 'Original company' }), updatedAt: new Date().toISOString() })
    await write({ title: 'Revised', company: '', robots: [], pageExtensions: [] })
    const w = await read()
    expect(w.policy).toMatchObject({ title: 'Revised', company: '', robots: [], pageExtensions: [] })
    expect(w.history).toHaveLength(1)
    expect(w.history[0]).toMatchObject({ actorId: 1, reason: 'Review workspace settings' })
    expect((await db('settings').where('key', 'seo').first()).value.analyticsId).toBe('private-analytics-value')
    expect((await db('settings').where('key', 'editShortcuts').first()).value.futureShortcut).toBe('retained')
    expect((await db('settings').where('key', 'features').first()).value).toEqual({ featurePageComments: false, featureGlossary: true })
    expect((await db('settings').where('key', 'auth').first()).value).toEqual({ audience: 'unchanged' })
  })
  it('durably toggles the actual nested glossary feature and retains unrelated feature values', async () => {
    const flags = { featurePageComments: false, featurePageRatings: true, futureFeature: { retained: true } }
    await db('settings')
      .where('key', 'features')
      .update({ value: JSON.stringify(flags) })
    expect((await read()).policy.featureGlossary).toBe(true)
    await write({ featureGlossary: false })
    expect((await read()).policy.featureGlossary).toBe(false)
    expect((await read()).history[0]?.fields).toEqual(['featureGlossary'])
    expect((await db('settings').where('key', 'features').first()).value).toEqual({ ...flags, featureGlossary: false })
    expect(await db('settings').where('key', 'featureGlossary')).toEqual([])
    await write({ featureGlossary: true })
    expect((await read()).policy.featureGlossary).toBe(true)
    expect((await db('settings').where('key', 'features').first()).value).toEqual({ ...flags, featureGlossary: true })
  })
  it.each([false, true])('preserves glossary and discussion choices when reviewed saves race (features row exists: %s)', async exists => {
    if (!exists) await db('settings').where('key', 'features').delete()
    const discussion = createDiscussionSettingsStore({
      db,
      definitions: () => [{ key: 'default', props: { minDelay: { type: 'number' } }, isAvailable: true }],
      fallbackFeatures: () => ({}),
      activate: async () => []
    })
    const generalReview = await read(),
      discussionReview = await discussion.read()
    const outcomes = await Promise.allSettled([
      store.save(admin, {
        policy: { ...generalReview.policy, featureGlossary: false },
        fingerprint: generalReview.fingerprint,
        reason: 'Disable glossary temporarily'
      }),
      discussion.write({ enabled: true, providers: discussionReview.providers }, discussionReview.fingerprint)
    ])
    const discussionOutcome = outcomes[1]!
    expect(discussionOutcome).toMatchObject({ status: 'fulfilled' })
    const generalOutcome = outcomes[0]!
    if (generalOutcome.status === 'rejected') {
      expect(generalOutcome.reason).toMatchObject({ status: 409 })
      await write({ featureGlossary: false })
    }
    expect((await db('settings').where('key', 'features').first()).value).toEqual({ featurePageComments: true, featureGlossary: false })
    expect((await discussion.read()).enabled).toBe(true)
    expect((await read()).policy.featureGlossary).toBe(false)
  })
  it('rejects stale concurrent reviews and prevents an ABA review from becoming current again', async () => {
    const before = await read(),
      payload = { policy: { ...before.policy, title: 'Next' }, fingerprint: before.fingerprint, reason: 'Concurrent reviewed write' }
    const results = await Promise.allSettled([store.save(admin, payload), store.save(admin, payload)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    await write({ title: 'Original' })
    await expect(store.save(admin, payload)).rejects.toMatchObject({ status: 409 })
  })
  it('rechecks account generation, membership and persisted system grants', async () => {
    await expect(store.inspect({ id: 3, permissions: ['manage:system'], authVersion: 0 } as never)).rejects.toMatchObject({ status: 403 })
    const w = await read()
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(store.save(admin, { policy: w.policy, fingerprint: w.fingerprint, reason: 'Stale account authority' })).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 0 })
    await db('groups').where('id', 1).update({ permissions: '[]' })
    await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('rejects invalid settings and live HTTPS downgrades before writing', async () => {
    const before = await db('settings').orderBy('key')
    await expect(write({ host: 'http://wiki.example.com' })).rejects.toMatchObject({ status: 409 })
    await expect(write({ robots: ['index', 'noindex'] })).rejects.toMatchObject({ status: 400 })
    await expect(write({ title: 'Next' }, { reason: '' })).rejects.toMatchObject({ status: 400 })
    await expect(write({ featureGlossary: 'false' as never })).rejects.toMatchObject({ status: 400 })
    expect(await db('settings').orderBy('key')).toEqual(before)
  })
  it('rolls back earlier row updates when a later settings write fails', async () => {
    await db.raw(`ALTER TABLE settings ADD CONSTRAINT reject_revision CHECK (key <> 'generalAdministration')`)
    const before = await db('settings').orderBy('key')
    try {
      await expect(write({ title: 'Cannot commit' })).rejects.toThrow()
      expect(await db('settings').orderBy('key')).toEqual(before)
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT reject_revision')
    }
  })
  it('keeps a committed save when runtime activation fails and allows a current retry', async () => {
    let failed = true,
      observed = structuredClone(generalPolicyDefaults)
    store = createGeneralAdministrationStore({
      db,
      reviewKey: 'fixture-key',
      fallback: () => ({}),
      runtime: () => observed,
      onCommitted: async () => {
        if (failed) throw new Error('Runtime unavailable')
        observed = (await read()).policy
        return true
      }
    })
    expect(await write({ title: 'Durable' })).toEqual({ activation: 'needs-attention' })
    const w = await read()
    expect(w.policy.title).toBe('Durable')
    failed = false
    expect(await store.initialize(admin, w.fingerprint)).toEqual({ activation: 'applied' })
    expect((await read()).runtime.state).toBe('applied')
    await expect(store.initialize(admin, 'stale')).rejects.toMatchObject({ status: 409 })
  })
  it('retains only the latest 50 administrative revisions', async () => {
    for (let index = 0; index < 52; index++) await write({ title: `Revision ${index}` }, { reason: `Reviewed revision ${index}` })
    const w = await read()
    expect(w.history).toHaveLength(50)
    expect(w.policy.title).toBe('Revision 51')
    expect(w.history.map(event => event.reason)).toEqual(Array.from({ length: 50 }, (_, index) => `Reviewed revision ${51 - index}`))
  })
  it('routes legacy General payloads through the same transaction without changing retained controls', async () => {
    const previous = globalThis.WIKI
    const config: Record<string, unknown> = { ...structuredClone(generalPolicyDefaults), sessionSecret: 'legacy-review-key' }
    let activations = 0
    const auth = {
      strategyHost: 'https://wiki.example.com',
      activateStrategies: async () => {
        auth.strategyHost = String(config.host)
        activations++
      }
    }
    globalThis.WIKI = {
      models: { knex: db },
      config,
      auth,
      configSvc: {
        loadFromDb: async () => {
          const rows = await db('settings')
          Object.assign(
            config,
            Object.fromEntries(rows.map(row => [row.key, row.value && typeof row.value === 'object' && 'v' in row.value ? row.value.v : row.value]))
          )
        }
      },
      events: { outbound: { emit: () => {} } },
      logger: { warn: () => {} }
    } as typeof globalThis.WIKI
    try {
      await patchLegacyGeneralConfiguration(admin, { title: 'Legacy updated', pageExtensions: 'TXT, md, txt', analyticsId: 'private-analytics-value' })
      expect((await read()).policy).toMatchObject({ title: 'Legacy updated', pageExtensions: ['md', 'txt'] })
      expect((await read()).history[0]).toMatchObject({ actorId: 1, fields: expect.arrayContaining(['title', 'pageExtensions']) })
      expect(config.title).toBe('Legacy updated')
      await patchLegacyGeneralConfiguration(admin, { host: 'https://next.example.com' })
      expect(auth.strategyHost).toBe('https://next.example.com')
      expect(activations).toBe(1)
      const before = await db('settings').orderBy('key')
      await expect(patchLegacyGeneralConfiguration(admin, { title: 'Cannot save', analyticsId: 'replace it' })).rejects.toMatchObject({ status: 400 })
      await expect(patchLegacyGeneralConfiguration(admin, { title: 'Cannot save', availableEditors: ['markdown'] })).rejects.toMatchObject({ status: 400 })
      await expect(patchLegacyGeneralConfiguration(admin, { title: 'Cannot save', pageExtensions: '../invalid' })).rejects.toMatchObject({ status: 400 })
      expect(await db('settings').orderBy('key')).toEqual(before)
    } finally {
      globalThis.WIKI = previous
    }
  })
})
describe('General settings reload projection', () => {
  it('reload projection honors persisted empty lists', () => {
    expect(generalPolicyFromConfiguration({ pageExtensions: [], seo: { robots: [] } })).toMatchObject({ pageExtensions: [], robots: [] })
  })
  it('defaults glossary availability to true and reads false only from the actual nested setting', () => {
    for (const configuration of [{}, { features: {} }, { featureGlossary: false }, { features: { featureGlossary: true } }])
      expect(generalPolicyFromConfiguration(configuration).featureGlossary).toBe(true)
    expect(generalPolicyFromConfiguration({ featureGlossary: true, features: { featureGlossary: false } }).featureGlossary).toBe(false)
  })
})
