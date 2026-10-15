import navigationOperations from '../../operations/navigation.ts'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createNavigationAdministrationStore } from '../../operations/navigation-administration.ts'
import { type NavigationPolicy } from '../../../shared/navigation-policy.ts'
import { loadPageRuleAuthority } from '../../core/auth.ts'
const link = {
  id: 'guide',
  kind: 'link',
  label: 'Guide',
  icon: 'mdi-book-open-outline',
  targetType: 'page',
  target: '/en/guide',
  visibilityMode: 'all',
  visibilityGroups: []
} as const
const item = () => ({ ...link, visibilityGroups: [] as number[] })
const connection = getPostgresTestConnection('_navigation_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
suite('PostgreSQL reviewed Navigation settings', () => {
  let db: Knex, store: ReturnType<typeof createNavigationAdministrationStore>
  const tables = [
    'pageHistoryTags',
    'pageTags',
    'pageAccessPasswords',
    'pageHistory',
    'pages',
    'tags',
    'userGroups',
    'users',
    'groups',
    'navigation',
    'locales',
    'settings'
  ]
  const originalWiki = globalThis.WIKI
  const read = () => store.inspect(admin)
  const write = async (patch: Partial<NavigationPolicy>, extra = {}) => {
    const w = await read()
    return store.save(admin, { policy: { ...w.policy, ...patch }, fingerprint: w.fingerprint, reason: 'Review workspace settings', ...extra })
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    Reflect.set(globalThis, 'WIKI', { config: {}, configSvc: {}, events: {}, lang: {}, logger: {}, models: { knex: db }, startedAt: {} })
    await db.schema.createTable('navigation', t => {
      t.string('key').primary()
      t.json('config')
    })
    await db.schema.createTable('locales', t => {
      t.string('code').primary()
      t.string('name')
      t.string('nativeName')
    })
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
      t.json('pageRules').defaultTo('[]')
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
    await db.schema.createTable('pages', t => {
      t.integer('id').primary()
      t.text('path')
      t.string('localeCode')
      t.string('visibility').defaultTo('public')
      t.integer('ownerId')
      t.bigInteger('sourceRevision')
      t.boolean('isPublished').defaultTo(true)
      t.text('publishStartDate').defaultTo('')
      t.text('publishEndDate').defaultTo('')
      t.text('content')
      t.text('title')
    })
    await db.schema.createTable('pageHistory', t => {
      t.integer('id').primary()
      t.integer('pageId')
      t.text('path')
      t.string('localeCode')
      t.string('visibility').defaultTo('public')
      t.integer('ownerId')
      t.bigInteger('sourceRevision')
      t.string('action')
      t.text('content')
    })
    await db.schema.createTable('tags', t => {
      t.integer('id').primary()
      t.string('tag')
      t.integer('redirectToId')
      t.boolean('isArchived').defaultTo(false)
    })
    for (const table of ['pageTags', 'pageHistoryTags'])
      await db.schema.createTable(table, t => {
        t.integer('pageId')
        t.integer('tagId')
      })
    await db.schema.createTable('pageAccessPasswords', t => {
      t.integer('pageId').primary()
      t.text('passwordHash')
    })
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
    Reflect.set(globalThis, 'WIKI', originalWiki)
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('settings').insert(
      [
        { key: 'nav', value: JSON.stringify({ mode: 'MIXED', expandParent: true, retained: 'future-option' }) },
        { key: 'lang', value: JSON.stringify({ code: 'en', namespacing: true, namespaces: ['en', 'fr'] }) }
      ].map(row => ({ ...row, updatedAt: new Date().toISOString() }))
    )
    await db('navigation').insert({ key: 'site', config: JSON.stringify([{ locale: 'en', items: [] }]) })
    await db('locales').insert([
      { code: 'en', name: 'English', nativeName: 'English' },
      { code: 'fr', name: 'French', nativeName: 'Français' }
    ])
    await db('groups').insert([
      { id: 1, name: 'Administrators', permissions: '["manage:system"]' },
      { id: 2, name: 'Guests', permissions: '["read:pages"]' },
      { id: 3, name: 'Members', permissions: '["manage:users"]' }
    ])
    await db('users').insert([{ id: 1 }, { id: 2 }, { id: 3 }])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 2, groupId: 2 },
      { userId: 3, groupId: 3 }
    ])
    store = createNavigationAdministrationStore({
      db,
      reviewKey: 'fixture-key',
      fallback: () => ({}),
      runtime: () => ({ mode: 'MIXED', expandParent: true, revision: undefined }),
      loadPageAuthority: loadPageRuleAuthority
    })
  })
  it('returns locale and audience options without exposing group permissions or unrelated settings', async () => {
    const w = await read()
    expect(w.locales).toEqual([
      { code: 'en', name: 'English', nativeName: 'English', enabled: true },
      { code: 'fr', name: 'French', nativeName: 'Français', enabled: true }
    ])
    expect(w.guestGroups).toEqual([2])
    expect(w.runtime.state).toBe('applied')
    expect(w.groups).toHaveLength(3)
    expect(JSON.stringify(w)).not.toContain('manage:system')
    expect(JSON.stringify(w)).not.toContain('future-option')
  })
  it('atomically publishes structure and mode with a new revision, preserving unowned settings', async () => {
    await write({
      mode: 'STATIC',
      tree: [
        { locale: 'en', items: [item()] },
        { locale: 'fr', items: [{ ...item(), target: '/fr/guide' }] }
      ]
    })
    const w = await read(),
      nav = (await db('settings').where('key', 'nav').first()).value
    expect(w.policy.mode).toBe('STATIC')
    expect(w.policy.tree).toHaveLength(2)
    expect(nav.revision).toBe(w.history[0].id)
    expect(nav.retained).toBe('future-option')
    expect(w.history[0].fields).toEqual(['mode', 'locale:en', 'locale:fr'])
    expect((await db('settings').where('key', 'lang').first()).value.namespaces).toEqual(['en', 'fr'])
    await write({ tree: [] })
    expect((await read()).policy.tree).toEqual([])
  })
  it('rejects concurrent reviews and does not revive ABA fingerprints', async () => {
    const before = await read(),
      payload = { policy: { ...before.policy, mode: 'STATIC' }, fingerprint: before.fingerprint, reason: 'Concurrent navigation review' }
    const results = await Promise.allSettled([store.save(admin, payload), store.save(admin, payload)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    await write({ mode: 'MIXED' })
    await expect(store.save(admin, payload)).rejects.toMatchObject({ status: 409 })
  })
  it('invalidates review when the structure, language context or audience changes', async () => {
    for (const change of [
      () =>
        db('navigation')
          .where('key', 'site')
          .update({ config: JSON.stringify([{ locale: 'fr', items: [] }]) }),
      () =>
        db('settings')
          .where('key', 'lang')
          .update({ value: JSON.stringify({ code: 'fr' }) }),
      () => db('userGroups').where('userId', 2).update({ groupId: 3 })
    ]) {
      const before = await read()
      await change()
      await expect(
        store.save(admin, { policy: { ...before.policy, mode: 'NONE' }, fingerprint: before.fingerprint, reason: 'Review with changed context' })
      ).rejects.toMatchObject({ status: 409 })
    }
  })
  it('rechecks persisted permissions, current accounts and delegated navigation grants', async () => {
    await expect(store.inspect({ id: 3, authVersion: 0, permissions: ['manage:navigation'] } as never)).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 3).update({ permissions: '["manage:navigation"]' })
    expect((await store.inspect({ id: 3, authVersion: 0 } as never)).policy.mode).toBe('MIXED')
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(read()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 0, isActive: false })
    await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('validates current API group grants and principal shape', async () => {
    expect((await store.inspect({ id: 1, ownershipUserId: null, groups: [1] } as never)).policy.mode).toBe('MIXED')
    await expect(store.inspect({ id: 1, ownershipUserId: null, groups: [3] } as never)).rejects.toMatchObject({ status: 403 })
    await expect(store.inspect({ id: 1, ownershipUserId: null, groups: [1, 3] } as never)).rejects.toMatchObject({ status: 403 })
  })
  it('rejects invalid destinations, duplicate items, unknown locales and missing audience groups', async () => {
    const before = await db('navigation').first()
    await expect(write({ tree: [{ locale: 'en', items: [{ ...item(), targetType: 'external', target: 'javascript:alert(1)' }] }] })).rejects.toMatchObject({
      status: 400
    })
    await expect(write({ tree: [{ locale: 'en', items: [item(), item()] }] })).rejects.toMatchObject({ status: 400 })
    await expect(write({ tree: [{ locale: 'de', items: [item()] }] })).rejects.toMatchObject({ status: 400 })
    await expect(write({ tree: [{ locale: 'en', items: [{ ...item(), visibilityMode: 'restricted', visibilityGroups: [999] }] }] })).rejects.toMatchObject({
      status: 400
    })
    expect(await db('navigation').first()).toEqual(before)
  })
  it('retains existing inactive locale structures while allowing their removal', async () => {
    await db('navigation')
      .where('key', 'site')
      .update({ config: JSON.stringify([{ locale: 'de', items: [item()] }]) })
    await write({ mode: 'NONE' })
    expect((await read()).policy.tree[0].locale).toBe('de')
    await write({ tree: [] })
    expect((await read()).policy.tree).toEqual([])
  })
  it('rolls back structure and settings if recording publication fails', async () => {
    await db.raw(`ALTER TABLE settings ADD CONSTRAINT reject_revision CHECK (key <> 'navigationAdministration')`)
    const before = await db('navigation').first(),
      settings = await db('settings').orderBy('key')
    try {
      await expect(write({ mode: 'STATIC', tree: [{ locale: 'en', items: [item()] }] })).rejects.toThrow()
      expect(await db('navigation').first()).toEqual(before)
      expect(await db('settings').orderBy('key')).toEqual(settings)
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT reject_revision')
    }
  })
  it('retains a committed publication when activation fails and supports a current retry', async () => {
    let failed = true,
      observed = { mode: 'MIXED', expandParent: true, revision: undefined as string | undefined }
    store = createNavigationAdministrationStore({
      db,
      reviewKey: 'fixture-key',
      fallback: () => ({}),
      runtime: () => observed,
      onCommitted: async () => {
        if (failed) throw new Error('Unavailable')
        observed = (await db('settings').where('key', 'nav').first()).value
        return true
      }
    })
    expect(await write({ mode: 'STATIC' })).toEqual({ activation: 'needs-attention' })
    expect((await read()).policy.mode).toBe('STATIC')
    failed = false
    expect(await store.initialize(admin, (await read()).fingerprint)).toEqual({ activation: 'applied' })
    expect((await read()).runtime.state).toBe('applied')
    await expect(store.initialize(admin, 'stale')).rejects.toMatchObject({ status: 409 })
  })
  it('routes compatibility writes through the same authority and persistence boundary', async () => {
    const previous = globalThis.WIKI,
      config: Record<string, unknown> = { nav: { mode: 'MIXED', expandParent: true }, sessionSecret: 'fixture-key' }
    globalThis.WIKI = {
      models: { knex: db },
      config,
      configSvc: {
        loadFromDb: async () => {
          const rows = await db('settings')
          Object.assign(config, Object.fromEntries(rows.map(row => [row.key, row.value])))
        }
      },
      events: { outbound: { emit: () => {} } },
      logger: { warn: () => {} }
    } as typeof globalThis.WIKI
    try {
      await navigationOperations.update(
        { mode: 'STATIC', expandParent: false, tree: [{ locale: 'en', items: [item(), { ...item(), id: 'home', targetType: 'home' }] }] },
        admin
      )
      const result = await navigationOperations.get(admin)
      expect(result.config).toEqual({ mode: 'STATIC', expandParent: false })
      expect(result.tree[0].items).toHaveLength(1)
      expect((await read()).history[0].reason).toContain('compatibility')
      await expect(navigationOperations.update({ mode: 'NONE', expandParent: true, tree: [{}] }, admin)).rejects.toMatchObject({ status: 400 })
      await expect(navigationOperations.get({ id: 3, authVersion: 0 } as never)).rejects.toMatchObject({ status: 403 })
    } finally {
      globalThis.WIKI = previous
    }
  })
  it('retains the latest 50 publications without storing menu contents in the history', async () => {
    for (let index = 0; index < 52; index++) await write({ mode: index % 2 ? 'MIXED' : 'NONE' })
    const w = await read()
    expect(w.history).toHaveLength(50)
    expect(w.history[0].fields).toEqual(['mode'])
    expect(JSON.stringify(w.history)).not.toContain('visibilityGroups')
  })
  const seedMovedPage = async () => {
    await db('pages').insert({
      id: 10,
      path: 'new/été',
      localeCode: 'fr',
      sourceRevision: 8,
      content: 'Do not repair /en/old in page content',
      title: 'Current title must not be returned'
    })
    await db('pageHistory').insert([
      { id: 100, pageId: 10, path: 'earlier', localeCode: 'en', sourceRevision: 2, action: 'moved', content: 'Secret historical source' },
      { id: 101, pageId: 10, path: 'old', localeCode: 'en', sourceRevision: 7, action: 'moved', content: 'Secret historical source' }
    ])
    const targets = [
      '/en/old?mode=one%20two#part%2Fone',
      '/%65n/%6Fld#other',
      '/en/older',
      '/en/old/child',
      '/en/old%2Fchild',
      '/en/a/../old',
      '/old',
      '/_private/en/old',
      '/fr/old',
      'https://elsewhere.test/en/old'
    ]
    await write({
      tree: [
        {
          locale: 'en',
          items: targets.map((target, i) => ({
            ...item(),
            id: `target-${i}`,
            label: `Keep label ${i}`,
            icon: 'mdi-lock',
            target,
            targetType: i === 9 ? 'external' : 'page',
            visibilityMode: 'restricted',
            visibilityGroups: i === 0 ? [] : [3]
          }))
        },
        { locale: 'fr', items: [{ ...item(), id: 'other-menu', target: '/en/old' }] }
      ]
    })
  }
  const inspectMove = () => store.inspectMovedPage(admin, { pageId: 10, menuLocale: 'en' })
  it('reviews actual latest native move identities without writes, content or protected metadata', async () => {
    await seedMovedPage()
    const navigation = await db('navigation').first(),
      settings = await db('settings').orderBy('key'),
      pages = await db('pages')
    const review = await inspectMove()
    expect(review.oldIdentity).toEqual({ locale: 'en', path: 'old' })
    expect(review.newIdentity).toEqual({ locale: 'fr', path: 'new/été' })
    expect(review.historyId).toBe(101)
    expect(review.sourceRevision).toBe('8')
    expect(review.items).toEqual([
      { locale: 'en', itemId: 'target-0', oldTarget: '/en/old?mode=one%20two#part%2Fone', newTarget: '/fr/new/%C3%A9t%C3%A9?mode=one%20two#part%2Fone' },
      { locale: 'en', itemId: 'target-1', oldTarget: '/%65n/%6Fld#other', newTarget: '/fr/new/%C3%A9t%C3%A9#other' }
    ])
    expect(JSON.stringify(review)).not.toContain('Secret')
    expect(JSON.stringify(review)).not.toContain('title')
    expect(JSON.stringify(review)).not.toContain('visibilityGroups')
    // Cancelling a review has no server write, revision or history side effect.
    expect(await db('navigation').first()).toEqual(navigation)
    expect(await db('settings').orderBy('key')).toEqual(settings)
    expect(await db('pages')).toEqual(pages)
    await expect(store.inspectMovedPage(admin, { pageId: 10, menuLocale: 'en', oldIdentity: { locale: 'en', path: 'invented' } })).rejects.toMatchObject({
      status: 400
    })
  })
  it('publishes only selected targets through native reason/history/revision activation while retaining all metadata', async () => {
    await seedMovedPage()
    const before = await read(),
      review = await inspectMove(),
      pages = await db('pages'),
      history = await db('pageHistory').orderBy('id')
    const result = await store.repairMovedPage(admin, { review, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Repair reviewed public move' })
    expect(result.activation).toBe('needs-attention')
    const after = await read(),
      expected = structuredClone(before.policy)
    expected.tree[0].items[0].target = '/fr/new/%C3%A9t%C3%A9?mode=one%20two#part%2Fone'
    expect(after.policy).toEqual(expected)
    expect(after.policy.tree[0].items[0].visibilityGroups).toEqual([])
    expect(after.history[0].reason).toBe('Repair reviewed public move')
    expect(after.history[0].fields).toEqual(['locale:en'])
    expect((await db('settings').where('key', 'nav').first()).value.revision).toBe(after.history[0].id)
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(await db('pages')).toEqual(pages)
    expect(await db('pageHistory').orderBy('id')).toEqual(history)
    await expect(store.repairMovedPage(admin, { review, selected: [{ locale: 'en', itemId: 'target-1' }], reason: 'Replay old review' })).rejects.toMatchObject(
      { status: 409 }
    )
  })
  it('activates repaired navigation with the persisted native revision before reporting publication', async () => {
    await seedMovedPage()
    let observed = { mode: 'MIXED', expandParent: true, revision: undefined as string | undefined },
      activations = 0
    store = createNavigationAdministrationStore({
      db,
      reviewKey: 'fixture-key',
      fallback: () => ({}),
      runtime: () => observed,
      loadPageAuthority: loadPageRuleAuthority,
      onCommitted: async () => {
        observed = (await db('settings').where('key', 'nav').first()).value
        activations++
        return true
      }
    })
    const review = await inspectMove()
    expect(await store.repairMovedPage(admin, { review, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Activate reviewed link repair' })).toEqual({
      activation: 'applied'
    })
    const after = await read()
    expect(activations).toBe(1)
    expect(observed.revision).toBe(after.history[0].id)
    expect(after.runtime.state).toBe('applied')
    expect(after.policy.tree[0].items[0].target).toBe('/fr/new/%C3%A9t%C3%A9?mode=one%20two#part%2Fone')
  })
  it('requires independent current navigation authority and a current account on inspect and commit', async () => {
    await seedMovedPage()
    const mover = { id: 3, authVersion: 0, permissions: ['manage:system'] } as never
    await expect(store.inspectMovedPage(mover, { pageId: 10, menuLocale: 'en' })).rejects.toMatchObject({ status: 403 })
    const review = await inspectMove(),
      payload = { review, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Current permission review' }
    await expect(store.repairMovedPage(mover, payload)).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 1).update({ permissions: '["read:pages"]' })
    await expect(store.repairMovedPage(admin, payload)).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 1).update({ permissions: '["manage:system"]' })
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(store.repairMovedPage(admin, payload)).rejects.toMatchObject({ status: 403 })
    await expect(store.inspectMovedPage(admin, { pageId: 10, menuLocale: 'en' })).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 0, isActive: false })
    await expect(store.repairMovedPage(admin, payload)).rejects.toMatchObject({ status: 403 })
  })
  it('invalidates a review on source-only revisions and menu removal, including a different currently authorized actor', async () => {
    await seedMovedPage()
    let review = await inspectMove()
    const payload = { selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Review current revision and actor' }
    await db('groups').where('id', 3).update({ permissions: '["manage:system"]' })
    await expect(store.repairMovedPage({ id: 3, authVersion: 0 } as never, { ...payload, review })).rejects.toMatchObject({ status: 409 })
    review = await inspectMove()
    await db('pages').where('id', 10).update({ sourceRevision: 9, content: 'Concurrent body edit is not overwritten' })
    await expect(store.repairMovedPage(admin, { ...payload, review })).rejects.toMatchObject({ status: 409 })
    review = await inspectMove()
    await write({ tree: [{ locale: 'fr', items: [] }] })
    await expect(store.repairMovedPage(admin, { ...payload, review })).rejects.toMatchObject({ status: 409 })
    expect((await db('pages').where('id', 10).first()).content).toBe('Concurrent body edit is not overwritten')
    expect((await read()).policy.tree).toEqual([{ locale: 'fr', items: [] }])
  })
  it('does not disclose recorded move metadata without independent current and historical native history authority, even with no matching links', async () => {
    await seedMovedPage()
    await write({ tree: [{ locale: 'en', items: [] }] })
    const requester = { id: 3, authVersion: 0 } as never
    const readPagesRule = { match: 'START', path: '', deny: false, roles: ['read:pages'] }
    const readHistoryRule = { match: 'START', path: '', deny: false, roles: ['read:history'] }
    for (const authority of [
      { permissions: ['manage:navigation', 'read:pages'], rules: [readPagesRule] },
      {
        permissions: ['manage:navigation', 'read:pages', 'read:history'],
        rules: [readPagesRule, readHistoryRule, { match: 'EXACT', path: 'new/été', deny: true, roles: ['read:history'], locales: ['fr'] }]
      },
      {
        permissions: ['manage:navigation', 'read:pages', 'read:history'],
        rules: [readPagesRule, readHistoryRule, { match: 'EXACT', path: 'old', deny: true, roles: ['read:history'], locales: ['en'] }]
      }
    ]) {
      await db('groups')
        .where('id', 3)
        .update({ permissions: JSON.stringify(authority.permissions), pageRules: JSON.stringify(authority.rules) })
      await expect(store.inspectMovedPage(requester, { pageId: 10, menuLocale: 'en' })).rejects.toMatchObject({ status: 400 })
    }
    await db('groups')
      .where('id', 3)
      .update({ permissions: '["manage:navigation","read:pages","read:history"]', pageRules: JSON.stringify([readPagesRule, readHistoryRule]) })
    const authorized = await store.inspectMovedPage(requester, { pageId: 10, menuLocale: 'en' })
    expect(authorized.oldIdentity).toEqual({ locale: 'en', path: 'old' })
    expect(authorized.historyId).toBe(101)
    expect(authorized.items).toEqual([])
  })
  it('rechecks historical history-only tag denials at commit without substituting current page-read permission', async () => {
    await seedMovedPage()
    const requester = { id: 3, authVersion: 0 } as never
    await db('tags').insert({ id: 30, tag: 'history-restricted' })
    await db('groups')
      .where('id', 3)
      .update({
        permissions: '["manage:navigation","read:pages","read:history"]',
        pageRules: JSON.stringify([
          { match: 'START', path: '', deny: false, roles: ['read:pages', 'read:history'] },
          { match: 'TAG', path: 'history-restricted', deny: true, roles: ['read:history'] }
        ])
      })
    const review = await store.inspectMovedPage(requester, { pageId: 10, menuLocale: 'en' })
    const navigation = await db('navigation').first(),
      settings = await db('settings').orderBy('key')
    await db('pageHistoryTags').insert({ pageId: 101, tagId: 30 })
    await expect(
      store.repairMovedPage(requester, { review, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'History access revoked during review' })
    ).rejects.toMatchObject({ status: 409 })
    expect(await db('navigation').first()).toEqual(navigation)
    expect(await db('settings').orderBy('key')).toEqual(settings)
  })
  it('never proposes or commits targets that authoritative native routing interprets as private aliases', async () => {
    await seedMovedPage()
    await db('pages').where('id', 10).update({ localeCode: 'en', path: '_private/en/notes' })
    const before = await db('navigation').first(),
      settings = await db('settings').orderBy('key')
    const destinationAlias = await inspectMove()
    expect(destinationAlias.items).toEqual([])
    await expect(
      store.repairMovedPage(admin, { review: destinationAlias, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Cannot target private aliases' })
    ).rejects.toMatchObject({ status: 400 })
    expect(await db('navigation').first()).toEqual(before)
    expect(await db('settings').orderBy('key')).toEqual(settings)
    await db('pages').where('id', 10).update({ path: 'ordinary-public-target' })
    await db('pageHistory').where('id', 101).update({ path: '_private/en/notes' })
    await write({
      tree: [
        {
          locale: 'en',
          items: [
            { ...item(), target: '/en/_private/en/notes' },
            { ...item(), id: 'encoded-private-alias', target: '/en/%5Fprivate/en/notes' }
          ]
        }
      ]
    })
    expect((await inspectMove()).items).toEqual([])
  })
  it('rechecks page read rules, current public publication, passwords and historical public identity', async () => {
    await seedMovedPage()
    const requester = { id: 3, authVersion: 0 } as never
    await db('groups')
      .where('id', 3)
      .update({
        permissions: '["manage:navigation","read:pages","read:history"]',
        pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages', 'read:history'] }])
      })
    expect((await store.inspectMovedPage(requester, { pageId: 10, menuLocale: 'en' })).items).toHaveLength(2)
    await db('tags').insert({ id: 20, tag: 'sensitive' })
    await db('pageTags').insert({ pageId: 10, tagId: 20 })
    await db('groups')
      .where('id', 3)
      .update({
        pageRules: JSON.stringify([
          { match: 'START', path: '', deny: false, roles: ['read:pages', 'read:history'] },
          { match: 'TAG', path: 'sensitive', deny: true, roles: ['read:pages'] }
        ])
      })
    await expect(store.inspectMovedPage(requester, { pageId: 10, menuLocale: 'en' })).rejects.toMatchObject({ status: 400 })
    for (const patch of [
      { visibility: 'private', ownerId: 1 },
      { isPublished: false },
      { publishStartDate: '2999-01-01T00:00:00.000Z' },
      { publishEndDate: '2000-01-01T00:00:00.000Z' }
    ]) {
      await db('pages').where('id', 10).update(patch)
      await expect(inspectMove()).rejects.toMatchObject({ status: 400 })
      await db('pages').where('id', 10).update({ visibility: 'public', ownerId: null, isPublished: true, publishStartDate: '', publishEndDate: '' })
    }
    const review = await inspectMove()
    await db('pageAccessPasswords').insert({ pageId: 10, passwordHash: 'NEVER_RETURN_HASH' })
    await expect(inspectMove()).rejects.toMatchObject({ status: 400 })
    await expect(
      store.repairMovedPage(admin, { review, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Protected after review' })
    ).rejects.toMatchObject({ status: 409 })
    await db('pageAccessPasswords').delete()
    await db('pageHistory').where('id', 101).update({ visibility: 'private', ownerId: 1 })
    await expect(inspectMove()).rejects.toMatchObject({ status: 400 })
  })
  it('rejects changed navigation, page revision and subsequent moves without losing concurrent updates', async () => {
    await seedMovedPage()
    let review = await inspectMove()
    await write({ expandParent: false })
    await expect(
      store.repairMovedPage(admin, { review, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Stale navigation review' })
    ).rejects.toMatchObject({ status: 409 })
    review = await inspectMove()
    const transaction = await db.transaction()
    await transaction('pages').where('id', 10).forUpdate().first()
    await transaction('pageHistory').insert({ id: 102, pageId: 10, path: 'new/été', localeCode: 'fr', sourceRevision: 8, action: 'moved' })
    await transaction('pages').where('id', 10).update({ sourceRevision: 9, path: 'later' })
    const repair = store.repairMovedPage(admin, { review, selected: [{ locale: 'en', itemId: 'target-0' }], reason: 'Race another actual move' })
    await transaction.commit()
    await expect(repair).rejects.toMatchObject({ status: 409 })
    expect((await db('pages').where('id', 10).first()).path).toBe('later')
    expect((await read()).policy.expandParent).toBe(false)
    expect((await read()).policy.tree[0].items[0].target).toBe('/en/old?mode=one%20two#part%2Fone')
  })
  it('serializes competing selected repairs so exactly one review can publish', async () => {
    await seedMovedPage()
    const review = await inspectMove()
    const results = await Promise.allSettled(
      [0, 1].map(index =>
        store.repairMovedPage(admin, { review, selected: [{ locale: 'en', itemId: `target-${index}` }], reason: 'Concurrent reviewed repair' })
      )
    )
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    const items = (await read()).policy.tree[0].items
    expect(items.filter(link => link.target.startsWith('/fr/new/'))).toHaveLength(1)
  })
  it('binds review details and selected targets, rejects empty/duplicate/unreviewed selections and rolls back history failures', async () => {
    await seedMovedPage()
    const review = await inspectMove(),
      selected = [{ locale: 'en', itemId: 'target-0' }],
      before = await read()
    for (const selection of [[], [selected[0], selected[0]], [{ locale: 'fr', itemId: 'other-menu' }], [{ locale: 'en', itemId: 'target-2' }]]) {
      await expect(store.repairMovedPage(admin, { review, selected: selection, reason: 'Invalid selected target' })).rejects.toMatchObject({ status: 400 })
    }
    await expect(
      store.repairMovedPage(admin, { review: { ...review, sourceRevision: '6' }, selected, reason: 'Tampered page revision' })
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      store.repairMovedPage(admin, {
        review: { ...review, items: review.items.map(item => ({ ...item, newTarget: '/en/forged' })) },
        selected,
        reason: 'Tampered destination'
      })
    ).rejects.toMatchObject({ status: 409 })
    await expect(store.repairMovedPage(admin, { review, selected, reason: '   ' })).rejects.toMatchObject({ status: 400 })
    await db.raw(
      `ALTER TABLE settings ADD CONSTRAINT reject_repair_revision CHECK (key <> 'navigationAdministration' OR value->>'revision' = '${before.history[0].id}')`
    )
    try {
      await expect(store.repairMovedPage(admin, { review, selected, reason: 'Atomic reviewed target repair' })).rejects.toThrow()
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT reject_repair_revision')
    }
    expect((await read()).policy).toEqual(before.policy)
    expect((await read()).history).toEqual(before.history)
  })
  it('bounds a menu review to its 200 items and does not invent moves from arbitrary history', async () => {
    await seedMovedPage()
    await write({ tree: [{ locale: 'en', items: Array.from({ length: 200 }, (_, i) => ({ ...item(), id: `bounded-${i}`, target: '/en/old' })) }] })
    expect((await inspectMove()).items).toHaveLength(200)
    await db('pageHistory').where('pageId', 10).update({ action: 'updated' })
    await expect(inspectMove()).rejects.toMatchObject({ status: 400 })
    await db('pageHistory').where('id', 101).update({ action: 'moved', path: 'new/été', localeCode: 'fr' })
    await expect(inspectMove()).rejects.toMatchObject({ status: 400 })
  })
})
