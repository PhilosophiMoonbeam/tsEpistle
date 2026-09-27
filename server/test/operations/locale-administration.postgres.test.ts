import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from '../bun-test.mts'
import { createLocaleAdministrationStore } from '../../operations/locale-administration.ts'
import { DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { publishLocaleSynchronization } from '../../operations/locale-synchronization.ts'
import { createLocalePackageHandler } from '../../jobs/locale-package.ts'
import { up as createJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import type { LocalePolicy } from '../../../shared/locale-policy.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '',
  password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_locale_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
const en = { code: 'en', name: 'English', nativeName: 'English', isRTL: false, availability: 100 },
  fr = { code: 'fr', name: 'French', nativeName: 'Français', isRTL: false, availability: 95 }
suite('PostgreSQL reviewed Locale administration', () => {
  let db: Knex, store: ReturnType<typeof createLocaleAdministrationStore>, activated: boolean
  const tables = ['durableJobs', 'userGroups', 'users', 'groups', 'locales', 'navigation', 'pages', 'settings']
  const read = () => store.inspect(admin)
  const save = async (patch: Partial<LocalePolicy>) => {
    const current = await read()
    return store.save(admin, { policy: { ...current.policy, ...patch }, fingerprint: current.fingerprint, reason: 'Review reading languages' })
  }
  const enqueue = async (kind = 'install', code: string | undefined = 'fr') => {
    const current = await read()
    return store.enqueue(admin, { kind, code, fingerprint: current.fingerprint, reason: 'Review language operation' })
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
    await db.schema.createTable('locales', t => {
      t.string('code', 35).primary()
      t.string('name')
      t.string('nativeName')
      t.boolean('isRTL')
      t.integer('availability')
      t.json('strings')
      t.string('createdAt')
      t.string('updatedAt')
    })
    await db.schema.createTable('navigation', t => {
      t.string('key').primary()
      t.json('config')
    })
    await db.schema.createTable('pages', t => {
      t.integer('id').primary()
      t.string('localeCode', 35)
      t.boolean('isPublished')
      t.string('localeGroupId')
      t.string('visibility')
    })
    await createJobs(db)
    await addLeaseToken(db)
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    const lang = { code: 'en', autoUpdate: true, namespacing: false, namespaces: [], rtl: false, retained: 'future setting' },
      now = new Date().toISOString()
    await db('settings').insert([{ key: 'lang', value: JSON.stringify(lang), updatedAt: now }])
    await db('groups').insert([
      { id: 1, permissions: '["manage:system"]' },
      { id: 3, permissions: '["manage:navigation"]' }
    ])
    await db('users').insert([{ id: 1 }, { id: 3 }])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 3 }
    ])
    await db('locales').insert({ ...en, strings: '{"common":{"title":"Saved English"}}', createdAt: now, updatedAt: now })
    await db('navigation').insert({ key: 'site', config: '[{"locale":"en","items":[{"kind":"link"}]}]' })
    await db('pages').insert([
      { id: 1, localeCode: 'en', isPublished: true, localeGroupId: 'translations', visibility: 'public' },
      { id: 2, localeCode: 'en', isPublished: false, localeGroupId: null, visibility: 'public' },
      { id: 3, localeCode: 'en', isPublished: true, localeGroupId: null, visibility: 'private' }
    ])
    activated = true
    store = createLocaleAdministrationStore({
      db,
      reviewKey: 'review-key',
      fallback: () => ({ graphEndpoint: 'https://languages.example.test', offline: false }),
      cachedCatalog: async () => [fr],
      runtime: () => ({ locale: 'en', revision: undefined, configuration: lang }),
      onCommitted: async () => activated
    })
  })
  it('returns installed and catalog languages with honest public content and navigation coverage', async () => {
    const current = await read()
    expect(current.locales).toHaveLength(2)
    expect(current.runtime.state).toBe('applied')
    expect(current.locales.find(row => row.code === 'en')).toMatchObject({
      isInstalled: true,
      availableRemotely: false,
      pages: 2,
      publishedPages: 1,
      linkedTranslations: 1,
      menuItems: 1
    })
    expect(current.locales.find(row => row.code === 'fr')).toMatchObject({ isInstalled: false, availableRemotely: true, pages: 0 })
    expect(JSON.stringify(current)).not.toContain('Saved English')
    expect(JSON.stringify(current)).not.toContain('future setting')
  })
  it('recognizes applied runtime defaults absent from a legacy settings row', async () => {
    const row = await db('settings').where('key', 'lang').first()
    delete row.value.rtl
    await db('settings').where('key', 'lang').update('value', JSON.stringify(row.value))
    expect((await read()).runtime.state).toBe('applied')
  })
  it('saves policy, derived direction and history atomically while preserving unowned fields', async () => {
    const now = new Date().toISOString()
    await db('locales').insert({ ...fr, isRTL: true, strings: '{}', createdAt: now, updatedAt: now })
    await save({ locale: 'fr', namespacing: true, namespaces: ['en'] })
    const current = await read(),
      lang = (await db('settings').where('key', 'lang').first()).value
    expect(current.policy.namespaces).toEqual(['en', 'fr'])
    expect(lang.rtl).toBe(true)
    expect(lang.retained).toBe('future setting')
    expect(lang.revision).toBe(current.history[0].id)
    expect(current.history[0].fields).toContain('locale')
    await save({ namespacing: false })
    expect((await read()).policy.namespaces).toEqual(['en', 'fr'])
  })
  it('rejects unknown languages, stale/ABA reviews, current session revocation and delegated non-system access', async () => {
    await expect(save({ locale: 'fr' })).rejects.toThrow('Install fr')
    const original = await read()
    await save({ autoUpdate: false })
    await save({ autoUpdate: true })
    await expect(
      store.save(admin, { policy: { ...original.policy, autoUpdate: false }, fingerprint: original.fingerprint, reason: 'Old review' })
    ).rejects.toThrow('changed')
    await expect(store.inspect({ id: 3, authVersion: 0 } as never)).rejects.toThrow('System administration')
    await db('users').where('id', 1).update('authVersion', 1)
    await expect(read()).rejects.toThrow('session changed')
  })
  it('rolls policy back when audit persistence fails', async () => {
    const before = (await db('settings').where('key', 'lang').first()).value
    await db.raw("ALTER TABLE settings ADD CONSTRAINT locale_audit_rejected CHECK (key <> 'localeAdministration')")
    try {
      await expect(save({ autoUpdate: false })).rejects.toThrow()
      expect((await db('settings').where('key', 'lang').first()).value).toEqual(before)
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT locale_audit_rejected')
    }
  })
  it('persists one queued job and receipt, rejects parallel operations and preserves committed settings on activation failure', async () => {
    const { jobId } = await enqueue()
    const current = await read()
    expect(current.operations[0]).toMatchObject({ id: jobId, kind: 'install', code: 'fr', state: 'pending' })
    expect(current.history[0].jobId).toBe(jobId)
    await expect(enqueue('catalog')).rejects.toThrow('already queued')
    activated = false
    expect(await save({ autoUpdate: false })).toEqual({ activation: 'needs-attention' })
    expect((await read()).policy.autoUpdate).toBe(false)
    activated = true
    expect(await store.initialize(admin, (await read()).fingerprint)).toEqual({ activation: 'applied' })
  })
  it('runs catalog and strings through the durable worker, atomically publishes and is idempotent after acknowledgement loss', async () => {
    const { jobId } = await enqueue(),
      fetchImpl = (async (_url: unknown, options: RequestInit) => {
        const body = JSON.parse(String(options.body))
        return Response.json({ data: { localization: body.variables ? { strings: [{ key: 'common:greeting', value: 'Bonjour' }] } : { locales: [en, fr] } } })
      }) as typeof fetch
    await runDurableJobBatch(db, {
      workerId: 'test-worker',
      handlers: { 'locale-package@1': createLocalePackageHandler({ store: () => store, fetch: fetchImpl }) }
    })
    const current = await read()
    expect(current.operations[0]).toMatchObject({ id: jobId, state: 'succeeded' })
    expect(current.history[0].appliedAt).toBeTruthy()
    expect((await db('locales').where('code', 'fr').first()).strings).toEqual({ common: { greeting: 'Bonjour' } })
    const job = await new DurableJobStore(db).get(jobId)
    expect(job).toBeTruthy()
    expect((await store.jobContext(job!)).alreadyApplied).toBe(true)
    expect((await db('settings').where('key', 'lang').first()).value.revision).toBe(current.history[0].id)
    expect(current.catalog.observedAt).toBeTruthy()
  })
  it('installs a script-code package through the durable worker and enables its reader policy', async () => {
    const sr = { ...fr, code: 'sr-latn', name: 'Serbian (Latin)' }
    await db('settings').insert({
      key: 'localeCatalog',
      value: JSON.stringify({ locales: [en, sr], observedAt: new Date().toISOString() }),
      updatedAt: new Date().toISOString()
    })
    const { jobId } = await enqueue('install', sr.code)
    const fetchImpl = (async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(String(options.body))
      return Response.json({ data: { localization: body.variables ? { strings: [{ key: 'common:greeting', value: 'Zdravo' }] } : { locales: [en, sr] } } })
    }) as typeof fetch
    await runDurableJobBatch(db, {
      workerId: 'script-worker',
      handlers: { 'locale-package@1': createLocalePackageHandler({ store: () => store, fetch: fetchImpl }) }
    })
    expect((await read()).operations[0]).toMatchObject({ id: jobId, state: 'succeeded' })
    expect((await db('locales').where('code', sr.code).first()).strings).toEqual({ common: { greeting: 'Zdravo' } })
    await save({ locale: sr.code, namespacing: true, namespaces: ['en', sr.code] })
    expect((await read()).policy.locale).toBe(sr.code)
  })
  it('rejects a stale lease, source change and authority revocation at publication', async () => {
    await enqueue()
    const jobs = await new DurableJobStore(db).claim({ workerId: 'test-worker', supportedIdentities: ['locale-package@1'] }),
      job = jobs[0]!
    await expect(store.publishJob({ ...job, leaseToken: '00000000-0000-0000-0000-000000000000' }, [fr], { common: { greeting: 'Bonjour' } })).rejects.toThrow(
      'lease'
    )
    await db('settings').insert({ key: 'offline', value: '{"v":true}', updatedAt: new Date().toISOString() })
    await expect(store.publishJob(job, [fr], {})).rejects.toThrow('offline')
    await db('settings').where('key', 'offline').delete()
    await db('durableJobs')
      .where('id', job.id)
      .update('leaseExpiresAt', new Date(Date.now() - 1000))
    await expect(store.publishJob(job, [fr], {})).rejects.toThrow('lease')
    await db('durableJobs')
      .where('id', job.id)
      .update('leaseExpiresAt', new Date(Date.now() + 60000))
    await db('settings').insert({ key: 'graphEndpoint', value: '{"v":"https://changed.example.test"}', updatedAt: new Date().toISOString() })
    await expect(store.jobContext(job)).rejects.toThrow('source changed')
    await db('settings').where('key', 'graphEndpoint').delete()
    await db('userGroups').where('userId', 1).delete()
    await expect(store.publishJob(job, [fr], {})).rejects.toThrow('System administration')
    expect(await db('locales').where('code', 'fr').first()).toBeUndefined()
  })
  it('does not replace an installed package when the source is malformed, and redacts persisted worker errors', async () => {
    await enqueue()
    const fetchImpl = (async () => Response.json({ errors: [{ message: 'secret upstream details' }] })) as typeof fetch
    await runDurableJobBatch(db, {
      workerId: 'test-worker',
      handlers: { 'locale-package@1': createLocalePackageHandler({ store: () => store, fetch: fetchImpl }) }
    })
    const job = await db('durableJobs').first()
    expect(job.state).toBe('pending')
    expect(job.lastError).not.toContain('secret')
    expect((await db('locales').where('code', 'en').first()).strings).toEqual({ common: { title: 'Saved English' } })
    expect(await db('locales').where('code', 'fr').first()).toBeUndefined()
  })
  it('publishes changed automatic packages atomically with a revision and skips a concurrently refreshed package', async () => {
    const before = await db('locales').where('code', 'en').first(),
      endpoint = 'https://languages.example.test'
    const input = {
      endpoint,
      catalog: [en],
      updates: [{ locale: en, strings: { common: { title: 'Automatic English' } }, expectedUpdatedAt: before.updatedAt }],
      fallback: { graphEndpoint: endpoint, offline: false }
    }
    expect(await publishLocaleSynchronization(db, input)).toEqual({ changed: ['en'] })
    const updated = await db('locales').where('code', 'en').first(),
      current = await read()
    expect(updated.strings).toEqual({ common: { title: 'Automatic English' } })
    expect(current.history[0].reason).toBe('Automatic interface package synchronization')
    expect((await db('settings').where('key', 'lang').first()).value.revision).toBe(current.history[0].id)
    expect(await publishLocaleSynchronization(db, { ...input, updates: [{ ...input.updates[0]!, strings: { common: { title: 'Stale source' } } }] })).toEqual({
      changed: []
    })
    expect((await db('locales').where('code', 'en').first()).strings).toEqual(updated.strings)
  })
  it('rechecks automatic update policy and yields to a queued manual operation', async () => {
    const current = await db('locales').where('code', 'en').first(),
      endpoint = 'https://languages.example.test'
    const input = {
      endpoint,
      catalog: [en, fr],
      updates: [{ locale: en, strings: { common: { title: 'Updated' } }, expectedUpdatedAt: current.updatedAt }],
      fallback: { graphEndpoint: endpoint, offline: false }
    }
    await save({ autoUpdate: false })
    expect(await publishLocaleSynchronization(db, input)).toEqual({ changed: [] })
    await save({ autoUpdate: true })
    await enqueue()
    expect(await publishLocaleSynchronization(db, input)).toEqual({ changed: [] })
    expect((await db('locales').where('code', 'en').first()).strings).toEqual(current.strings)
    await db('settings').insert({ key: 'offline', value: '{"v":true}', updatedAt: new Date().toISOString() })
    await expect(publishLocaleSynchronization(db, input)).rejects.toThrow('offline')
  })

  it('supports a current API system grant without borrowing account ownership and invalidates changed grants', async () => {
    const api = { id: 1, ownershipUserId: null, groups: [1] } as never
    const current = await store.inspect(api)
    await store.save(api, { policy: { ...current.policy, autoUpdate: false }, fingerprint: current.fingerprint, reason: 'API-managed update policy' })
    expect((await read()).history[0].actorId).toBeNull()
    await expect(store.inspect({ id: 1, ownershipUserId: null, groups: [1, 3] } as never)).rejects.toThrow('principal')
    await db('groups').where('id', 1).update('permissions', '["manage:navigation"]')
    await expect(store.inspect(api)).rejects.toThrow('System administration')
  })
  it('rejects an uncommitted local review after its fifteen-minute deadline', async () => {
    const reviewed = await store.reviewLocalFile(admin, {
      code: 'fr',
      fingerprint: (await read()).fingerprint,
      reason: 'Review a French file',
      bytes: new TextEncoder().encode('{"common:greeting":"Bonjour"}')
    })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(reviewed.expiresAt) + 1)
    try {
      await expect(store.enqueueLocalFile(admin, { reviewId: reviewed.id })).rejects.toThrow('Review the file again')
      expect((await db('settings').where({ key: 'localeAdministration' }).first()).value.localFileReview).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
  })

  it('retains an accepted local file through an expired review deadline until its durable job publishes', async () => {
    const reviewed = await store.reviewLocalFile(admin, {
      code: 'fr',
      fingerprint: (await read()).fingerprint,
      reason: 'Install reviewed French copy',
      bytes: new TextEncoder().encode('{"common:greeting":"Bonjour après la file"}')
    })
    const { jobId } = await store.enqueueLocalFile(admin, { reviewId: reviewed.id })
    const job = (await new DurableJobStore(db).claim({ workerId: 'local-worker', supportedIdentities: ['locale-package@1'] }))[0]!
    const later = Date.now() + 16 * 60 * 1000
    await db('durableJobs').where({ id: jobId }).update({ leaseExpiresAt: new Date(later + 60_000) })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      expect(await store.jobContext(job)).toEqual({ kind: 'local', alreadyApplied: false })
      await store.publishJob(job, [])
    } finally {
      clock.mockRestore()
    }
    expect((await db('locales').where({ code: 'fr' }).first()).strings).toEqual({ common: { greeting: 'Bonjour après la file' } })
    expect((await read()).history[0].appliedAt).toBeTruthy()
    expect((await db('settings').where({ key: 'localeAdministration' }).first()).value.localFileReview).toBeUndefined()
  })

  it('reclaims a terminal local job review without reusing its failed upload', async () => {
    const request = {
      code: 'fr',
      fingerprint: (await read()).fingerprint,
      reason: 'Install reviewed French copy',
      bytes: new TextEncoder().encode('{"common:greeting":"Bonjour"}')
    }
    const reviewed = await store.reviewLocalFile(admin, request)
    const { jobId } = await store.enqueueLocalFile(admin, { reviewId: reviewed.id })
    await db('durableJobs').where({ id: jobId }).update({ state: 'failed' })
    await read()
    expect((await db('settings').where({ key: 'localeAdministration' }).first()).value.localFileReview).toBeUndefined()
    await expect(store.enqueueLocalFile(admin, { reviewId: reviewed.id })).rejects.toThrow('Review the file again')
    const fresh = await store.reviewLocalFile(admin, { ...request, fingerprint: (await read()).fingerprint })
    expect(fresh.id).not.toBe(reviewed.id)
  })

  it('rejects competing reviews and retains only the latest 50 administrative receipts', async () => {
    const current = await read(),
      payload = { policy: { ...current.policy, autoUpdate: false }, fingerprint: current.fingerprint, reason: 'Concurrent policy review' }
    const results = await Promise.allSettled([store.save(admin, payload), store.save(admin, payload)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    for (let i = 0; i < 51; i++) await save({ autoUpdate: i % 2 === 0 })
    expect((await read()).history).toHaveLength(50)
  })
})
