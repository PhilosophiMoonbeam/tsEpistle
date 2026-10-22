import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createLocaleAdministrationStore } from '../../operations/locale-administration.ts'
import { DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { publishLocaleSynchronization } from '../../operations/locale-synchronization.ts'
import { createLocalePackageHandler } from '../../jobs/locale-package.ts'
import { up as createJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'
import type { LocalePolicy } from '../../../shared/locale-policy.ts'
const connection = getPostgresTestConnection('_locale_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, ownershipUserId: 1, authVersion: 0 } as never
const en = { code: 'en', name: 'English', nativeName: 'English', isRTL: false, availability: 100 },
  fr = { code: 'fr', name: 'French', nativeName: 'Français', isRTL: false, availability: 95 }
suite('PostgreSQL reviewed Locale administration', () => {
  let db: Knex, store: ReturnType<typeof createLocaleAdministrationStore>, activated: boolean
  const tables = [
    'durableJobs',
    'userGroups',
    'glossaryTermRelations',
    'glossaryNames',
    'glossaryTerms',
    'customLocaleReferences',
    'assets',
    'pageTree',
    'pageHistory',
    'pageLinks',
    'navigation',
    'pages',
    'users',
    'groups',
    'locales',
    'settings'
  ]
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
      t.jsonb('pageRules').defaultTo('[]')
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
    await db.schema.alterTable('users', t => {
      t.string('localeCode', 35).references('code').inTable('locales')
      t.string('communicationLocale', 35).references('code').inTable('locales').onDelete('SET NULL')
    })
    for (const table of ['pageTree', 'pageHistory', 'assets', 'pageLinks']) {
      await db.schema.createTable(table, t => {
        t.integer('id').primary()
        t.string('localeCode', 35)
        if (table !== 'pageLinks') t.foreign('localeCode').references('code').inTable('locales')
      })
    }
    for (const table of ['glossaryTerms', 'glossaryNames', 'glossaryTermRelations']) {
      await db.schema.createTable(table, t => {
        t.integer('id').primary()
        t.string('locale', 35)
      })
    }
    await db.schema.createTable('customLocaleReferences', t => {
      t.integer('id').primary()
      t.string('language', 35).references('code').inTable('locales').onDelete('CASCADE')
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
    const initialSettings = await db('settings').orderBy('key')
    await expect(save({ locale: 'fr' })).rejects.toMatchObject({ status: 400 })
    expect(await db('settings').orderBy('key')).toEqual(initialSettings)
    const original = await read()
    await save({ autoUpdate: false })
    await save({ autoUpdate: true })
    await expect(
      store.save(admin, { policy: { ...original.policy, autoUpdate: false }, fingerprint: original.fingerprint, reason: 'Old review' })
    ).rejects.toMatchObject({ status: 409 })
    const currentSettings = await db('settings').orderBy('key')
    expect((await db('settings').where('key', 'lang').first()).value).toMatchObject({ code: 'en', autoUpdate: true })
    expect((await read()).history).toHaveLength(2)
    await expect(store.inspect({ id: 3, authVersion: 0 } as never)).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update('authVersion', 1)
    await expect(read()).rejects.toMatchObject({ status: 403 })
    expect(await db('settings').orderBy('key')).toEqual(currentSettings)
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
    const queuedJobs = await db('durableJobs').orderBy('id')
    await expect(enqueue('catalog')).rejects.toMatchObject({ status: 409 })
    expect(await db('durableJobs').orderBy('id')).toEqual(queuedJobs)
    expect((await read()).history).toEqual(current.history)
    activated = false
    expect(await save({ autoUpdate: false })).toEqual({ activation: 'needs-attention' })
    expect((await read()).policy.autoUpdate).toBe(false)
    activated = true
    expect(await store.initialize(admin, (await read()).fingerprint)).toEqual({ activation: 'applied' })
  })
  it('runs catalog and strings through the durable worker, atomically publishes and replays a completed operation without duplicate effects', async () => {
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
    const beforeReplay = { locale: await db('locales').where('code', 'fr').first(), settings: await db('settings').orderBy('key') }
    const replay = createLocalePackageHandler({
      store: () => store,
      fetch: (async () => {
        throw new Error('Completed locale operation must not refetch')
      }) as typeof fetch
    })
    await replay(job!, { knex: db, signal: new AbortController().signal })
    expect(await db('locales').where('code', 'fr').first()).toEqual(beforeReplay.locale)
    expect(await db('settings').orderBy('key')).toEqual(beforeReplay.settings)
    expect((await read()).history).toEqual(current.history)
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
    const beforePublication = {
      locales: await db('locales').orderBy('code'),
      administration: await db('settings').where('key', 'localeAdministration').first()
    }
    await expect(
      store.publishJob({ ...job, leaseToken: '00000000-0000-0000-0000-000000000000' }, [fr], { common: { greeting: 'Bonjour' } })
    ).rejects.toMatchObject({ status: 409 })
    await db('settings').insert({ key: 'offline', value: '{"v":true}', updatedAt: new Date().toISOString() })
    await expect(store.publishJob(job, [fr], {})).rejects.toMatchObject({ status: 409 })
    await db('settings').where('key', 'offline').delete()
    await db('durableJobs')
      .where('id', job.id)
      .update('leaseExpiresAt', new Date(Date.now() - 1000))
    await expect(store.publishJob(job, [fr], {})).rejects.toMatchObject({ status: 409 })
    await db('durableJobs')
      .where('id', job.id)
      .update('leaseExpiresAt', new Date(Date.now() + 60000))
    await db('settings').insert({ key: 'graphEndpoint', value: '{"v":"https://changed.example.test"}', updatedAt: new Date().toISOString() })
    await expect(store.jobContext(job)).rejects.toMatchObject({ status: 400 })
    await db('settings').where('key', 'graphEndpoint').delete()
    await db('userGroups').where('userId', 1).delete()
    await expect(store.publishJob(job, [fr], {})).rejects.toMatchObject({ status: 403 })
    expect(await db('locales').where('code', 'fr').first()).toBeUndefined()
    expect(await db('locales').orderBy('code')).toEqual(beforePublication.locales)
    expect(await db('settings').where('key', 'localeAdministration').first()).toEqual(beforePublication.administration)
  })
  it.each([false, true])('preserves the targeted package on malformed source and redacts worker errors (installed: %s)', async installed => {
    if (installed) {
      const now = new Date().toISOString()
      await db('locales').insert({ ...fr, strings: '{"common":{"greeting":"Original French"}}', createdAt: now, updatedAt: now })
    }
    const before = await db('locales').where('code', 'fr').first()
    const beforeEnglish = await db('locales').where('code', 'en').first()
    await enqueue()
    const fetchImpl = (async () => Response.json({ errors: [{ message: 'secret upstream details' }] })) as typeof fetch
    await runDurableJobBatch(db, {
      workerId: 'test-worker',
      handlers: { 'locale-package@1': createLocalePackageHandler({ store: () => store, fetch: fetchImpl }) }
    })
    const job = await db('durableJobs').first()
    expect(job.state).toBe('pending')
    expect(job.lastError).not.toContain('secret')
    if (installed) expect(await db('locales').where('code', 'fr').first()).toEqual(before)
    else expect(await db('locales').where('code', 'fr').first()).toBeUndefined()
    expect(await db('locales').where('code', 'en').first()).toEqual(beforeEnglish)
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
    expect(current.history[0]).toMatchObject({ actorId: null, kind: 'install', fields: ['package:en'], appliedAt: updated.updatedAt })
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
    const beforeOffline = { locale: await db('locales').where('code', 'en').first(), settings: await db('settings').orderBy('key') }
    await expect(publishLocaleSynchronization(db, input)).rejects.toThrow()
    expect(await db('locales').where('code', 'en').first()).toEqual(beforeOffline.locale)
    expect(await db('settings').orderBy('key')).toEqual(beforeOffline.settings)
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
      await expect(store.enqueueLocalFile(admin, { reviewId: reviewed.id })).rejects.toMatchObject({ status: 409 })
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
    await db('durableJobs')
      .where({ id: jobId })
      .update({ leaseExpiresAt: new Date(later + 60_000) })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      expect(await store.jobContext(job)).toEqual({ kind: 'local', alreadyApplied: false })
      const mismatchedPrincipal = { ...job, payload: { ...job.payload, requester: { id: 1, authVersion: 0 } } }
      await expect(store.publishJob(mismatchedPrincipal, [])).rejects.toMatchObject({ status: 403 })
      expect(await db('locales').where({ code: 'fr' }).first()).toBeUndefined()
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
    await expect(store.enqueueLocalFile(admin, { reviewId: reviewed.id })).rejects.toMatchObject({ status: 409 })
    const fresh = await store.reviewLocalFile(admin, { ...request, fingerprint: (await read()).fingerprint })
    expect(fresh.id).not.toBe(reviewed.id)
  })

  it('rejects competing reviews and retains only the latest 50 administrative receipts', async () => {
    const current = await read(),
      payload = { policy: { ...current.policy, autoUpdate: false }, fingerprint: current.fingerprint, reason: 'Concurrent policy review' }
    const results = await Promise.allSettled([store.save(admin, payload), store.save(admin, payload)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    for (let i = 0; i < 51; i++) {
      const before = await read()
      await store.save(admin, { policy: { ...before.policy, autoUpdate: i % 2 === 0 }, fingerprint: before.fingerprint, reason: `Reviewed policy ${i}` })
    }
    expect((await read()).history).toHaveLength(50)
    expect((await read()).history.map(event => event.reason)).toEqual(Array.from({ length: 50 }, (_, index) => `Reviewed policy ${50 - index}`))
  })

  const installFrench = async () => {
    const now = new Date().toISOString()
    await db('locales').insert({ ...fr, strings: '{"common":{"greeting":"Bonjour"}}', createdAt: now, updatedAt: now })
  }
  const reviewRemoval = async (code = 'fr') =>
    store.reviewUninstall(admin, {
      code,
      fingerprint: (await read()).fingerprint,
      reason: 'Retire unused interface package'
    })

  it('removes only unused installed bytes, retains remote catalog availability, and records the reason before activation', async () => {
    await installFrench()
    const content = Object.fromEntries(
        await Promise.all(['pages', 'navigation', 'users', 'assets', 'pageHistory'].map(async table => [table, await db(table).select()]))
      ),
      reviewed = await reviewRemoval()
    expect(reviewed).toMatchObject({ blockers: [], catalogRetained: true, reason: 'Retire unused interface package' })
    expect(JSON.stringify(reviewed)).not.toContain('Bonjour')
    expect(await store.uninstall(admin, { token: reviewed.token })).toEqual({ activation: 'applied' })
    expect(await db('locales').where({ code: 'fr' }).first()).toBeUndefined()
    for (const [table, rows] of Object.entries(content)) expect(await db(table).select()).toEqual(rows)
    const current = await read()
    expect(current.locales.find(row => row.code === 'fr')).toMatchObject({ isInstalled: false, availableRemotely: true, packageSource: 'unknown' })
    expect(current.history[0]).toMatchObject({
      kind: 'uninstall',
      actorId: 1,
      code: 'fr',
      reason: reviewed.reason,
      fields: ['package:fr'],
      appliedAt: expect.any(String)
    })
    expect((await db('settings').where({ key: 'lang' }).first()).value.revision).toBe(current.history[0].id)
    await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 409 })
  })

  it('refuses English, absent packages, invalid reasons, and unauthorized review/confirmation without mutation', async () => {
    await installFrench()
    const reviewed = await reviewRemoval(),
      before = await db('locales').orderBy('code')
    await expect(reviewRemoval('en')).rejects.toMatchObject({ status: 409 })
    await expect(reviewRemoval('de')).rejects.toMatchObject({ status: 409 })
    await expect(store.reviewUninstall(admin, { code: 'fr', fingerprint: (await read()).fingerprint, reason: '  ' })).rejects.toMatchObject({ status: 400 })
    await expect(
      store.reviewUninstall({ id: 3, authVersion: 0 } as never, { code: 'fr', fingerprint: (await read()).fingerprint, reason: 'Remove package' })
    ).rejects.toMatchObject({ status: 403 })
    await expect(store.uninstall({ id: 3, authVersion: 0 } as never, { token: reviewed.token })).rejects.toMatchObject({ status: 403 })
    await db('users').where({ id: 1 }).update({ authVersion: 1 })
    await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 403 })
    expect(await db('locales').orderBy('code')).toEqual(before)
    expect(await db('settings').where({ key: 'localeAdministration' }).first()).toBeUndefined()
  })

  it.each([
    ['public published pages', 'pages', { id: 10, localeCode: 'fr', visibility: 'public', isPublished: true }],
    ['private unpublished pages', 'pages', { id: 10, localeCode: 'fr', visibility: 'private', isPublished: false }],
    ['public unpublished pages', 'pages', { id: 10, localeCode: 'fr', visibility: 'public', isPublished: false }],
    ['page tree nodes', 'pageTree', { id: 10, localeCode: 'fr' }],
    ['page history', 'pageHistory', { id: 10, localeCode: 'fr' }],
    ['locale assets', 'assets', { id: 10, localeCode: 'fr' }],
    ['non-FK links', 'pageLinks', { id: 10, localeCode: 'fr' }],
    ['glossary terms', 'glossaryTerms', { id: 10, locale: 'fr' }],
    ['glossary names', 'glossaryNames', { id: 10, locale: 'fr' }],
    ['glossary relations', 'glossaryTermRelations', { id: 10, locale: 'fr' }],
    ['unanticipated cascading references', 'customLocaleReferences', { id: 10, language: 'fr' }]
  ] as [string, string, Record<string, unknown>][])('rechecks %s after a clear review and never cascades content', async (_label, table, row) => {
    await installFrench()
    const reviewed = await reviewRemoval()
    expect(reviewed.blockers).toEqual([])
    await db(String(table)).insert(row)
    const packageBefore = await db('locales').where({ code: 'fr' }).first(),
      rowsBefore = await db(String(table)).select()
    const blocked = await reviewRemoval()
    expect(blocked.blockers).toContainEqual({
      source: `${table}.${Object.hasOwn(row, 'locale') ? 'locale' : Object.hasOwn(row, 'language') ? 'language' : 'localeCode'}`,
      count: 1
    })
    await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 409 })
    expect(await db('locales').where({ code: 'fr' }).first()).toEqual(packageBefore)
    expect(await db(String(table)).select()).toEqual(rowsBefore)
  })

  it.each(['localeCode', 'communicationLocale'])('preserves user %s references rather than clearing them', async column => {
    await installFrench()
    const reviewed = await reviewRemoval()
    await db('users')
      .where({ id: 3 })
      .update({ [column]: 'fr' })
    expect((await reviewRemoval()).blockers).toContainEqual({ source: `users.${column}`, count: 1 })
    await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 409 })
    expect((await db('users').where({ id: 3 }).first())[column]).toBe('fr')
    expect(await db('locales').where({ code: 'fr' }).first()).toBeTruthy()
  })

  it('blocks the default, retained namespaces, empty navigation trees and group rules independently of public usage counts', async () => {
    await installFrench()
    await save({ locale: 'fr' })
    expect((await reviewRemoval()).blockers).toContainEqual({ source: 'Default reading language', count: 1 })
    await save({ locale: 'en', namespacing: false, namespaces: ['fr'] })
    expect((await reviewRemoval()).blockers).toContainEqual({ source: 'Configured reading namespaces', count: 1 })
    await save({ namespaces: [] })
    await db('navigation')
      .where({ key: 'site' })
      .update({ config: JSON.stringify([{ locale: 'fr', items: [] }]) })
    await db('groups')
      .where({ id: 3 })
      .update({ pageRules: JSON.stringify([{ locales: ['fr'], path: '*', roles: ['read:pages'] }]) })
    const reviewed = await reviewRemoval()
    expect(reviewed.blockers).toEqual(
      expect.arrayContaining([
        { source: 'Navigation language trees (including empty menus)', count: 1 },
        { source: 'Group page rules', count: 1 }
      ])
    )
    expect((await read()).locales.find(row => row.code === 'fr')!.pages).toBe(0)
    await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 409 })
  })

  it.each(['pending', 'running'])('refuses %s package jobs created after removal review', async state => {
    await installFrench()
    const reviewed = await reviewRemoval(),
      { jobId } = await enqueue()
    await db('durableJobs').where({ id: jobId }).update({ state })
    await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 409 })
    expect((await reviewRemoval()).blockers).toContainEqual({ source: 'Queued or running language package operations', count: 1 })
    expect(await db('locales').where({ code: 'fr' }).first()).toBeTruthy()
  })

  it('binds review to package bytes, workspace, administrator and deadline, rejecting tampering', async () => {
    await installFrench()
    const reviewed = await reviewRemoval()
    const [body, signature] = reviewed.token.split('.')
    const changed = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))
    changed.reason = 'Changed administrative intent'
    await expect(store.uninstall(admin, { token: `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}` })).rejects.toMatchObject({
      status: 409
    })
    await db('groups').where({ id: 3 }).update({ permissions: '["manage:system"]' })
    const otherReview = await reviewRemoval()
    await expect(store.uninstall({ id: 3, authVersion: 0 } as never, { token: otherReview.token })).rejects.toMatchObject({ status: 403 })
    await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 409 })
    await db('locales').where({ code: 'fr' }).update({ strings: '{"common":{"greeting":"Replaced bytes"}}' })
    await expect(store.uninstall(admin, { token: otherReview.token })).rejects.toMatchObject({ status: 409 })
    const expiring = await reviewRemoval(),
      clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiring.expiresAt) + 1)
    try {
      await expect(store.uninstall(admin, { token: expiring.token })).rejects.toMatchObject({ status: 409 })
    } finally {
      clock.mockRestore()
    }
    expect((await db('locales').where({ code: 'fr' }).first()).strings).toEqual({ common: { greeting: 'Replaced bytes' } })
  })

  it('serializes competing removals and refuses an uncommitted non-FK writer without deleting either record', async () => {
    await installFrench()
    const reviewed = await reviewRemoval(),
      writer = await db.transaction()
    try {
      await writer('glossaryTerms').insert({ id: 10, locale: 'fr' })
      await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toMatchObject({ status: 409 })
      expect(await db('locales').where({ code: 'fr' }).first()).toBeTruthy()
      await writer.commit()
    } finally {
      if (!writer.isCompleted()) await writer.rollback()
    }
    expect(await db('glossaryTerms').where({ id: 10 }).first()).toMatchObject({ locale: 'fr' })
    await db('glossaryTerms').delete()
    const results = await Promise.allSettled([store.uninstall(admin, { token: reviewed.token }), store.uninstall(admin, { token: reviewed.token })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect((await read()).history.filter(event => event.kind === 'uninstall')).toHaveLength(1)
  })

  it('does not reconstruct catalog provenance from an old publication and can remove an unreferenced local-only package offline', async () => {
    await installFrench()
    const old = '2020-01-01T00:00:00.000Z',
      now = new Date().toISOString()
    await db('settings').insert([
      { key: 'localeCatalog', value: '{"locales":[]}', updatedAt: now },
      { key: 'offline', value: '{"v":true}', updatedAt: now },
      {
        key: 'localeAdministration',
        updatedAt: now,
        value: JSON.stringify({
          history: [{ id: 'old', kind: 'install', code: 'fr', appliedAt: old, createdAt: old, actorId: 1, reason: 'Old publication', fields: ['package:fr'] }]
        })
      }
    ])
    expect((await read()).locales.find(row => row.code === 'fr')).toMatchObject({ packageSource: 'unknown', availableRemotely: false })
    const reviewed = await reviewRemoval()
    expect(reviewed.catalogRetained).toBe(false)
    activated = false
    expect(await store.uninstall(admin, { token: reviewed.token })).toEqual({ activation: 'needs-attention' })
    expect((await read()).locales.find(row => row.code === 'fr')).toBeUndefined()
    expect((await db('settings').where({ key: 'localeCatalog' }).first()).value).toEqual({ locales: [] })
    activated = true
    expect(await store.initialize(admin, (await read()).fingerprint)).toEqual({ activation: 'applied' })
  })

  it('rolls back removed bytes when the administrative receipt cannot be persisted', async () => {
    await installFrench()
    const reviewed = await reviewRemoval(),
      before = await db('locales').where({ code: 'fr' }).first()
    await db.raw("ALTER TABLE settings ADD CONSTRAINT locale_removal_audit_rejected CHECK (key <> 'localeAdministration')")
    try {
      await expect(store.uninstall(admin, { token: reviewed.token })).rejects.toThrow()
      expect(await db('locales').where({ code: 'fr' }).first()).toEqual(before)
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT locale_removal_audit_rejected')
    }
  })
})
