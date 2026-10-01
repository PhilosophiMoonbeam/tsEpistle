import navigationOperations from '../../operations/navigation.ts'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createNavigationAdministrationStore } from '../../operations/navigation-administration.ts'
import { type NavigationPolicy } from '../../../shared/navigation-policy.ts'
const link = { id: 'guide', kind: 'link', label: 'Guide', icon: 'mdi-book-open-outline', targetType: 'page', target: '/en/guide', visibilityMode: 'all', visibilityGroups: [] } as const
const item = () => ({ ...link, visibilityGroups: [] as number[] })
const connection = getPostgresTestConnection('_navigation_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
suite('PostgreSQL reviewed Navigation settings', () => {
  let db: Knex, store: ReturnType<typeof createNavigationAdministrationStore>
  const tables = ['userGroups', 'users', 'groups', 'navigation', 'locales', 'settings']
  const read = () => store.inspect(admin)
  const write = async (patch: Partial<NavigationPolicy>, extra = {}) => {
    const w = await read()
    return store.save(admin, { policy: { ...w.policy, ...patch }, fingerprint: w.fingerprint, reason: 'Review workspace settings', ...extra })
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('navigation', t => { t.string('key').primary(); t.json('config') })
    await db.schema.createTable('locales', t => { t.string('code').primary(); t.string('name'); t.string('nativeName') })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value')
      t.string('updatedAt').notNullable()
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary()
      t.string('name').notNullable()
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
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('settings').insert([
      { key: 'nav', value: JSON.stringify({ mode: 'MIXED', expandParent: true, retained: 'future-option' }) },
      { key: 'lang', value: JSON.stringify({ code: 'en', namespacing: true, namespaces: ['en', 'fr'] }) }
    ].map(row => ({ ...row, updatedAt: new Date().toISOString() })))
    await db('navigation').insert({ key: 'site', config: JSON.stringify([{ locale: 'en', items: [] }]) })
    await db('locales').insert([{ code: 'en', name: 'English', nativeName: 'English' }, { code: 'fr', name: 'French', nativeName: 'Français' }])
    await db('groups').insert([
      { id: 1, name: 'Administrators', permissions: '["manage:system"]' },
      { id: 2, name: 'Guests', permissions: '["read:pages"]' },
      { id: 3, name: 'Members', permissions: '["manage:users"]' }
    ])
    await db('users').insert([{ id: 1 }, { id: 2 }, { id: 3 }])
    await db('userGroups').insert([{ userId: 1, groupId: 1 }, { userId: 2, groupId: 2 }, { userId: 3, groupId: 3 }])
    store = createNavigationAdministrationStore({ db, reviewKey: 'fixture-key', fallback: () => ({}), runtime: () => ({ mode: 'MIXED', expandParent: true, revision: undefined }) })
  })
  it('returns locale and audience options without exposing group permissions or unrelated settings', async () => {
    const w = await read()
    expect(w.locales).toEqual([{ code: 'en', name: 'English', nativeName: 'English', enabled: true }, { code: 'fr', name: 'French', nativeName: 'Français', enabled: true }])
    expect(w.guestGroups).toEqual([2]); expect(w.runtime.state).toBe('applied')
    expect(w.groups).toHaveLength(3); expect(JSON.stringify(w)).not.toContain('manage:system'); expect(JSON.stringify(w)).not.toContain('future-option')
  })
  it('atomically publishes structure and mode with a new revision, preserving unowned settings', async () => {
    await write({ mode: 'STATIC', tree: [{ locale: 'en', items: [item()] }, { locale: 'fr', items: [{ ...item(), target: '/fr/guide' }] }] })
    const w = await read(), nav = (await db('settings').where('key', 'nav').first()).value
    expect(w.policy.mode).toBe('STATIC'); expect(w.policy.tree).toHaveLength(2)
    expect(nav.revision).toBe(w.history[0].id); expect(nav.retained).toBe('future-option')
    expect(w.history[0].fields).toEqual(['mode', 'locale:en', 'locale:fr'])
    expect((await db('settings').where('key', 'lang').first()).value.namespaces).toEqual(['en', 'fr'])
    await write({ tree: [] }); expect((await read()).policy.tree).toEqual([])
  })
  it('rejects concurrent reviews and does not revive ABA fingerprints', async () => {
    const before = await read(), payload = { policy: { ...before.policy, mode: 'STATIC' }, fingerprint: before.fingerprint, reason: 'Concurrent navigation review' }
    const results = await Promise.allSettled([store.save(admin, payload), store.save(admin, payload)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    await write({ mode: 'MIXED' }); await expect(store.save(admin, payload)).rejects.toMatchObject({ status: 409 })
  })
  it('invalidates review when the structure, language context or audience changes', async () => {
    for (const change of [
      () => db('navigation').where('key', 'site').update({ config: JSON.stringify([{ locale: 'fr', items: [] }]) }),
      () => db('settings').where('key', 'lang').update({ value: JSON.stringify({ code: 'fr' }) }),
      () => db('userGroups').where('userId', 2).update({ groupId: 3 })
    ]) {
      const before = await read(); await change()
      await expect(store.save(admin, { policy: { ...before.policy, mode: 'NONE' }, fingerprint: before.fingerprint, reason: 'Review with changed context' })).rejects.toMatchObject({ status: 409 })
    }
  })
  it('rechecks persisted permissions, current accounts and delegated navigation grants', async () => {
    await expect(store.inspect({ id: 3, authVersion: 0, permissions: ['manage:navigation'] } as never)).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 3).update({ permissions: '["manage:navigation"]' })
    expect((await store.inspect({ id: 3, authVersion: 0 } as never)).policy.mode).toBe('MIXED')
    await db('users').where('id', 1).update({ authVersion: 1 }); await expect(read()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 0, isActive: false }); await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('validates current API group grants and principal shape', async () => {
    expect((await store.inspect({ id: 1, ownershipUserId: null, groups: [1] } as never)).policy.mode).toBe('MIXED')
    await expect(store.inspect({ id: 1, ownershipUserId: null, groups: [3] } as never)).rejects.toMatchObject({ status: 403 })
    await expect(store.inspect({ id: 1, ownershipUserId: null, groups: [1, 3] } as never)).rejects.toMatchObject({ status: 403 })
  })
  it('rejects invalid destinations, duplicate items, unknown locales and missing audience groups', async () => {
    const before = await db('navigation').first()
    await expect(write({ tree: [{ locale: 'en', items: [{ ...item(), targetType: 'external', target: 'javascript:alert(1)' }] }] })).rejects.toMatchObject({ status: 400 })
    await expect(write({ tree: [{ locale: 'en', items: [item(), item()] }] })).rejects.toMatchObject({ status: 400 })
    await expect(write({ tree: [{ locale: 'de', items: [item()] }] })).rejects.toMatchObject({ status: 400 })
    await expect(write({ tree: [{ locale: 'en', items: [{ ...item(), visibilityMode: 'restricted', visibilityGroups: [999] }] }] })).rejects.toMatchObject({ status: 400 })
    expect(await db('navigation').first()).toEqual(before)
  })
  it('retains existing inactive locale structures while allowing their removal', async () => {
    await db('navigation').where('key', 'site').update({ config: JSON.stringify([{ locale: 'de', items: [item()] }]) })
    await write({ mode: 'NONE' }); expect((await read()).policy.tree[0].locale).toBe('de')
    await write({ tree: [] }); expect((await read()).policy.tree).toEqual([])
  })
  it('rolls back structure and settings if recording publication fails', async () => {
    await db.raw(`ALTER TABLE settings ADD CONSTRAINT reject_revision CHECK (key <> 'navigationAdministration')`)
    const before = await db('navigation').first(), settings = await db('settings').orderBy('key')
    try { await expect(write({ mode: 'STATIC', tree: [{ locale: 'en', items: [item()] }] })).rejects.toThrow(); expect(await db('navigation').first()).toEqual(before); expect(await db('settings').orderBy('key')).toEqual(settings) }
    finally { await db.raw('ALTER TABLE settings DROP CONSTRAINT reject_revision') }
  })
  it('retains a committed publication when activation fails and supports a current retry', async () => {
    let failed = true, observed = { mode: 'MIXED', expandParent: true, revision: undefined as string | undefined }
    store = createNavigationAdministrationStore({ db, reviewKey: 'fixture-key', fallback: () => ({}), runtime: () => observed, onCommitted: async () => { if (failed) throw new Error('Unavailable'); observed = (await db('settings').where('key', 'nav').first()).value; return true } })
    expect(await write({ mode: 'STATIC' })).toEqual({ activation: 'needs-attention' }); expect((await read()).policy.mode).toBe('STATIC')
    failed = false; expect(await store.initialize(admin, (await read()).fingerprint)).toEqual({ activation: 'applied' }); expect((await read()).runtime.state).toBe('applied')
    await expect(store.initialize(admin, 'stale')).rejects.toMatchObject({ status: 409 })
  })
  it('routes compatibility writes through the same authority and persistence boundary', async () => {
    const previous = globalThis.WIKI, config: Record<string, unknown> = { nav: { mode: 'MIXED', expandParent: true }, sessionSecret: 'fixture-key' }
    globalThis.WIKI = { models: { knex: db }, config, configSvc: { loadFromDb: async () => { const rows = await db('settings'); Object.assign(config, Object.fromEntries(rows.map(row => [row.key, row.value]))) } }, events: { outbound: { emit: () => {} } }, logger: { warn: () => {} } } as typeof globalThis.WIKI
    try {
      await navigationOperations.update({ mode: 'STATIC', expandParent: false, tree: [{ locale: 'en', items: [item(), { ...item(), id: 'home', targetType: 'home' }] }] }, admin)
      const result = await navigationOperations.get(admin); expect(result.config).toEqual({ mode: 'STATIC', expandParent: false }); expect(result.tree[0].items).toHaveLength(1)
      expect((await read()).history[0].reason).toContain('compatibility')
      await expect(navigationOperations.update({ mode: 'NONE', expandParent: true, tree: [{}] }, admin)).rejects.toMatchObject({ status: 400 })
      await expect(navigationOperations.get({ id: 3, authVersion: 0 } as never)).rejects.toMatchObject({ status: 403 })
    } finally { globalThis.WIKI = previous }
  })
  it('retains the latest 50 publications without storing menu contents in the history', async () => {
    for (let index = 0; index < 52; index++) await write({ mode: index % 2 ? 'MIXED' : 'NONE' })
    const w = await read(); expect(w.history).toHaveLength(50); expect(w.history[0].fields).toEqual(['mode']); expect(JSON.stringify(w.history)).not.toContain('visibilityGroups')
  })

})
