import themingOperations from '../../operations/theming.ts'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { createThemeAdministrationStore } from '../../operations/theme-administration.ts'
import { themePolicyFromConfiguration, type ThemePolicy } from '../../../shared/theme-policy.ts'
const themePolicyDefaults = themePolicyFromConfiguration({})
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '',
  password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_theme_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
suite('PostgreSQL reviewed Theme settings', () => {
  let db: Knex, store: ReturnType<typeof createThemeAdministrationStore>
  const tables = ['userGroups', 'users', 'groups', 'settings']
  const read = () => store.inspect(admin)
  const write = async (patch: Partial<ThemePolicy>, extra = {}) => {
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
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('settings').insert([{ key: 'theming', value: JSON.stringify({ ...themePolicyDefaults, retained: 'future-option' }), updatedAt: new Date().toISOString() }])
    await db('groups').insert([
      { id: 1, permissions: '["manage:system"]' },
      { id: 2, permissions: '["manage:users"]' }
    ])
    await db('users').insert([{ id: 1 }, { id: 3 }])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 2 }
    ])
    store = createThemeAdministrationStore({ db, reviewKey: 'fixture-key', fallback: () => ({}), runtime: () => structuredClone(themePolicyDefaults) })
  })
  it('projects owned theme settings and preserves exact source', async () => {
    const css = '/* reader rules */\n.contents { color: #112233; }\n'
    await write({ injectCSS: css })
    const w = await read()
    expect(w.policy.injectCSS).toBe(css)
    expect(JSON.stringify(w)).not.toContain('future-option')
    expect((await db('settings').where('key', 'theming').first()).value.retained).toBe('future-option')
    expect(w.history[0]).toMatchObject({ actorId: 1, fields: ['injectCSS'] })
  })
  it('persists published palette colors, reading settings and complete deletion without resurrection', async () => {
    const policy = (await read()).policy
    const second = { ...structuredClone(policy.palettes[0]), id: 'second', name: 'Second palette' }
    second.colors.dark.primary = '#123456'
    await write({ palettes: [...policy.palettes, second], activePaletteId: second.id, reading: { textSize: 19, lineHeight: 1.8, copyWidth: 68 } })
    expect((await db('settings').where('key', 'theming').first()).value.colors.dark.primary).toBe('#123456')
    await write({ palettes: [second] })
    expect((await read()).policy.palettes).toHaveLength(1)
    expect((await read()).policy.reading).toEqual({ textSize: 19, lineHeight: 1.8, copyWidth: 68 })
  })
  it('rejects concurrent and ABA reviews', async () => {
    const before = await read(), payload = { policy: { ...before.policy, tocPosition: 'right' }, fingerprint: before.fingerprint, reason: 'Concurrent review' }
    const results = await Promise.allSettled([store.save(admin, payload), store.save(admin, payload)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    await write({ tocPosition: 'left' })
    await expect(store.save(admin, payload)).rejects.toMatchObject({ status: 409 })
  })
  it('rechecks current account and group authority, including delegated theme administrators', async () => {
    await expect(store.inspect({ id: 3, authVersion: 0, permissions: ['manage:theme'] } as never)).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 2).update({ permissions: '["manage:theme"]' })
    expect((await store.inspect({ id: 3, authVersion: 0 } as never)).policy.theme).toBe('default')
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(read()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 0, isActive: false })
    await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('allows delegated appearance saves while rejecting every custom source change atomically', async () => {
    await db('groups').where('id', 2).update({ permissions: '["manage:theme"]' })
    const delegated = { id: 3, authVersion: 0 } as never
    await write({
      injectCSS: '/* trusted */\n.contents { color: red; }\n',
      injectHead: '<meta name="trusted" content="head">',
      injectBody: '<div data-trusted="body"></div>'
    })
    const beforeAppearance = await store.inspect(delegated)
    expect(beforeAppearance.capabilities).toEqual({ editCustomCode: false })
    await store.save(delegated, {
      policy: { ...beforeAppearance.policy, tocPosition: 'right' },
      fingerprint: beforeAppearance.fingerprint,
      reason: 'Publish a delegated appearance change'
    })
    const afterAppearance = await store.inspect(delegated)
    expect(afterAppearance.policy.tocPosition).toBe('right')
    const settingsBefore = await db('settings').orderBy('key')
    for (const field of ['injectCSS', 'injectHead', 'injectBody'] as const) {
      const review = await store.inspect(delegated)
      await expect(store.save(delegated, {
        policy: { ...review.policy, [field]: '' },
        fingerprint: review.fingerprint,
        reason: `Clear ${field} without system authority`
      })).rejects.toMatchObject({ status: 403 })
      const after = await store.inspect(delegated)
      expect(after.policy[field]).toBe(review.policy[field])
      expect(after.history).toEqual(review.history)
      expect(after.runtime.state).toBe(review.runtime.state)
      expect(await db('settings').orderBy('key')).toEqual(settingsBefore)
    }
    const stale = await store.inspect(delegated)
    await db('groups').where('id', 2).update({ permissions: '["manage:users"]' })
    await expect(store.save(delegated, {
      policy: { ...stale.policy, tocPosition: 'left' },
      fingerprint: stale.fingerprint,
      reason: 'Publish after delegated authority was removed'
    })).rejects.toMatchObject({ status: 403 })
  })
  it('checks API group grants and rejects malformed principals', async () => {
    expect((await store.inspect({ id: 1, ownershipUserId: null, groups: [1] } as never)).policy.theme).toBe('default')
    await expect(store.inspect({ id: 1, ownershipUserId: null, groups: [2] } as never)).rejects.toMatchObject({ status: 403 })
    await expect(store.inspect({ id: 1, ownershipUserId: null, groups: [1, 2] } as never)).rejects.toMatchObject({ status: 403 })
  })
  it('rejects missing palettes, invalid layout and oversized source before writing', async () => {
    const before = await db('settings').orderBy('key')
    await expect(write({ activePaletteId: 'missing' })).rejects.toMatchObject({ status: 400 })
    await expect(write({ palettes: [] })).rejects.toMatchObject({ status: 400 })
    await expect(write({ reading: { textSize: 2, lineHeight: 1.8, copyWidth: 68 } })).rejects.toMatchObject({ status: 400 })
    await expect(write({ injectHead: 'x'.repeat(65537) })).rejects.toMatchObject({ status: 400 })
    await expect(write({ tocPosition: 'right' }, { reason: '' })).rejects.toMatchObject({ status: 400 })
    expect(await db('settings').orderBy('key')).toEqual(before)
  })
  it('rejects malformed CSS and retains modern CSS and imports without loading them', async () => {
    const before = await db('settings').orderBy('key')
    await expect(write({ injectCSS: '.contents { color: red;' })).rejects.toMatchObject({ status: 400 })
    await expect(write({ injectCSS: '.contents { color red; }' })).rejects.toMatchObject({ status: 400 })
    expect(await db('settings').orderBy('key')).toEqual(before)
    const css = '@import url(https://example.invalid/reader.css);\n.contents { color: color-mix(in srgb, red 25%, blue); & > p { margin: 1rem; } }'
    await write({ injectCSS: css })
    expect((await read()).policy.injectCSS).toBe(css)
  })
  it('rolls back settings when the history write fails', async () => {
    await db.raw(`ALTER TABLE settings ADD CONSTRAINT reject_revision CHECK (key <> 'themeAdministration')`)
    const before = await db('settings').orderBy('key')
    try { await expect(write({ tocPosition: 'off' })).rejects.toThrow(); expect(await db('settings').orderBy('key')).toEqual(before) }
    finally { await db.raw('ALTER TABLE settings DROP CONSTRAINT reject_revision') }
  })
  it('retains committed settings on activation failure and permits a current retry', async () => {
    let failed = true, observed = structuredClone(themePolicyDefaults)
    store = createThemeAdministrationStore({ db, reviewKey: 'fixture-key', fallback: () => ({}), runtime: () => observed,
      onCommitted: async () => { if (failed) throw new Error('Runtime unavailable'); observed = (await read()).policy; return true } })
    expect(await write({ tocPosition: 'off' })).toEqual({ activation: 'needs-attention' })
    expect((await read()).policy.tocPosition).toBe('off')
    failed = false
    expect(await store.initialize(admin, (await read()).fingerprint)).toEqual({ activation: 'applied' })
    expect((await read()).runtime.state).toBe('applied')
    await expect(store.initialize(admin, 'stale')).rejects.toMatchObject({ status: 409 })
  })
  it('caps history at 50 changes without retaining custom source', async () => {
    for (let i = 0; i < 52; i++) await write({ injectBody: `<span data-revision="${i}"></span>` })
    const w = await read()
    expect(w.history).toHaveLength(50)
    expect(JSON.stringify(w.history)).not.toContain('data-revision')
  })
  it('routes compatibility writes through durable reviews and preserves legacy color edits', async () => {
    const previous = globalThis.WIKI
    const config: Record<string, unknown> = { theming: structuredClone(themePolicyDefaults), sessionSecret: 'legacy-review-key' }
    globalThis.WIKI = {
      models: { knex: db }, config,
      configSvc: { loadFromDb: async () => { const rows = await db('settings'); Object.assign(config, Object.fromEntries(rows.map(row => [row.key, row.value]))) } },
      events: { outbound: { emit: () => {} } }, logger: { warn: () => {} }
    } as typeof globalThis.WIKI
    try {
      const colors = structuredClone(themePolicyDefaults.palettes[0].colors); colors.light.primary = '#123456'
      await themingOperations.updateConfig({ theme: 'default', iconset: 'mdi', darkMode: false, colors, injectCSS: '/* intact */\n.contents { color: red; }\n' }, admin)
      expect((await read()).policy.palettes[0].colors.light.primary).toBe('#123456')
      expect(themingOperations.getConfig().injectCSS).toBe('/* intact */\n.contents { color: red; }\n')
      expect((await read()).history[0].reason).toContain('compatibility')
      await expect(themingOperations.updateConfig({ activePaletteId: 'missing' }, admin)).rejects.toMatchObject({ status: 400 })
      await expect(themingOperations.updateConfig({ title: 'not owned' }, admin)).rejects.toMatchObject({ status: 400 })
      await expect(themingOperations.updateConfig({ tocPosition: 'right' }, { id: 3, authVersion: 0 } as never)).rejects.toMatchObject({ status: 403 })
    } finally { globalThis.WIKI = previous }
  })

})
