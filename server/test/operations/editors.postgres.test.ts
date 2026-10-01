import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createEditorPolicyStore } from '../../operations/editors.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_editor_policy_test', import.meta.path)
const suite = connection ? describe : describe.skip
suite('PostgreSQL editor policy persistence', () => {
  let db: Knex, store: ReturnType<typeof createEditorPolicyStore>, activations: unknown[] = [], failActivation = false
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value'); table.string('updatedAt') })
    store = createEditorPolicyStore({ db, fallback: () => ({ available: ['markdown', 'visual-markdown'], recommended: null, custom: 'preserved' }),
      async activate(value) { activations.push(value); if (failActivation) throw new Error('event bus unavailable'); return [] }
    })
  })
  beforeEach(async () => { await db('settings').delete(); activations = []; failActivation = false })
  afterAll(async () => { if (db) { await db.schema.dropTableIfExists('settings'); await db.destroy() } })
  it('reads defaults without writing and commits only the editor key before activating runtime state', async () => {
    await db('settings').insert({ key: 'title', value: JSON.stringify({ v: 'Workspace' }), updatedAt: 'old' })
    const initial = await store.read()
    expect(initial.available).toEqual(['markdown', 'visual-markdown'])
    expect(await db('settings').where('key', 'editors')).toHaveLength(0)
    const observer = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    let committedPolicy: unknown
    const observingStore = createEditorPolicyStore({
      db,
      fallback: () => ({ available: ['markdown', 'visual-markdown'], recommended: null, custom: 'preserved' }),
      async activate(value) {
        committedPolicy = (await observer('settings').where('key', 'editors').first())?.value
        activations.push(value)
        return []
      }
    })
    const saved = await (async () => {
      try {
        return await observingStore.write({ available: ['visual-markdown', 'markdown'], recommended: 'visual-markdown' }, initial.fingerprint)
      } finally {
        await observer.destroy()
      }
    })()
    expect(committedPolicy).toMatchObject({ available: ['markdown', 'visual-markdown'], recommended: 'visual-markdown', custom: 'preserved' })
    expect(saved.policy).toMatchObject({ available: ['markdown', 'visual-markdown'], recommended: 'visual-markdown' })
    expect((await db('settings').where('key', 'editors').first()).value).toMatchObject({ custom: 'preserved', recommended: 'visual-markdown' })
    expect((await db('settings').where('key', 'title').first()).value).toEqual({ v: 'Workspace' })
    expect(activations).toHaveLength(1)
    expect((await store.read()).fingerprint).toBe(saved.policy.fingerprint)
  })
  it('rejects a stale administrator and serializes simultaneous saves from the same baseline', async () => {
    const current = await store.read()
    const results = await Promise.allSettled([
      store.write({ available: ['markdown'], recommended: 'markdown' }, current.fingerprint),
      store.write({ available: ['code'], recommended: 'code' }, current.fingerprint)
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(activations).toHaveLength(1)
  })
  it('does not activate a policy when its database write fails', async () => {
    const current = await store.read()
    await db.raw(`ALTER TABLE settings ADD CONSTRAINT editors_test_failure CHECK (value->>'recommended' IS DISTINCT FROM 'code')`)
    try {
      await expect(store.write({ available: ['code'], recommended: 'code' }, current.fingerprint)).rejects.toThrow()
      expect(activations).toHaveLength(0)
      expect((await store.read()).fingerprint).toBe(current.fingerprint)
    } finally { await db.raw('ALTER TABLE settings DROP CONSTRAINT editors_test_failure') }
  })
  it('reports a committed policy with a warning when runtime notification fails', async () => {
    failActivation = true
    const current = await store.read(), saved = await store.write({ available: ['markdown'], recommended: null }, current.fingerprint)
    expect(saved.warnings).toHaveLength(1)
    expect((await store.read()).available).toEqual(['markdown'])
  })
  it('invalidates old reviews even when another administrator restores identical values', async () => {
    const first = await store.read()
    const changed = await store.write({ available: ['markdown'], recommended: null }, first.fingerprint)
    const restored = await store.write({ available: first.available, recommended: first.recommended }, changed.policy.fingerprint)
    expect(restored.policy.fingerprint).not.toBe(first.fingerprint)
    await expect(store.write({ available: ['code'], recommended: 'code' }, first.fingerprint)).rejects.toMatchObject({ status: 409 })
  })
  it('rejects invalid recommendations and empty policies without touching persistence', async () => {
    const current = await store.read()
    await expect(store.write({ available: ['markdown'], recommended: 'code' }, current.fingerprint)).rejects.toMatchObject({ status: 400 })
    await expect(store.write({ available: [], recommended: null }, current.fingerprint)).rejects.toMatchObject({ status: 400 })
    expect(await db('settings')).toHaveLength(0); expect(activations).toHaveLength(0)
  })
})
