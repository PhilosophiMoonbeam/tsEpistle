import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createRenderingStore } from '../../operations/rendering-workspace.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_rendering_policy_test', import.meta.path)
const suite = connection ? describe : describe.skip
suite('PostgreSQL rendering configuration', () => {
  let db: Knex, store: ReturnType<typeof createRenderingStore>
  const definitions = [
    { key: 'htmlCore', title: 'HTML', input: 'html', output: 'html', props: { links: { type: 'boolean' } } },
    { key: 'markdownCore', title: 'Markdown', input: 'markdown', output: 'html', props: { quotes: { type: 'string', enum: ['English', 'French'] } } }
  ]
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value'); table.string('updatedAt') })
    await db.schema.createTable('renderers', table => { table.string('key').primary(); table.boolean('isEnabled'); table.jsonb('config') })
    store = createRenderingStore({ db, definitions: () => definitions })
  })
  beforeEach(async () => {
    await db('settings').delete(); await db('renderers').delete()
    await db('settings').insert({ key: 'title', value: JSON.stringify('Untouched'), updatedAt: 'old' })
    await db('renderers').insert([{ key: 'htmlCore', isEnabled: true, config: JSON.stringify({ links: false, deploymentExtension: 'preserve' }) }, { key: 'markdownCore', isEnabled: true, config: JSON.stringify({ quotes: 'English' }) }])
  })
  afterAll(async () => { if (db) { await db.schema.dropTableIfExists('renderers'); await db.schema.dropTableIfExists('settings'); await db.destroy() } })
  it('commits all requested rows, preserves undeclared stored options and leaves other settings alone', async () => {
    const initial = await store.read()
    const result = await store.write([{ key: 'htmlCore', isEnabled: true, config: { links: true } }, { key: 'markdownCore', isEnabled: true, config: { quotes: 'French' } }], initial.fingerprint)
    expect(result.modules[0]!.config).toEqual({ links: true, deploymentExtension: 'preserve' })
    expect(result.modules[1]!.config.quotes).toBe('French')
    expect((await db('settings').where('key', 'title').first()).value).toBe('Untouched')
    expect((await store.read()).fingerprint).toBe(result.fingerprint)
  })
  it('rolls back the first module and revision when a later module write fails', async () => {
    const initial = await store.read()
    await db.raw(`ALTER TABLE renderers ADD CONSTRAINT rendering_test_failure CHECK (config->>'quotes' IS DISTINCT FROM 'French')`)
    try { await expect(store.write([{ key: 'htmlCore', isEnabled: false, config: { links: true } }, { key: 'markdownCore', isEnabled: true, config: { quotes: 'French' } }], initial.fingerprint)).rejects.toThrow(); expect((await store.read()).fingerprint).toBe(initial.fingerprint); expect(await db('settings').where('key', 'renderingRevision')).toHaveLength(0) } finally { await db.raw('ALTER TABLE renderers DROP CONSTRAINT rendering_test_failure') }
  })
  it('serializes simultaneous reviews so only one save can use the baseline', async () => {
    const initial = await store.read(), input = [{ key: 'htmlCore', isEnabled: true, config: { links: true } }]
    const results = await Promise.allSettled([store.write(input, initial.fingerprint), store.write(input, initial.fingerprint)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
  })
  it('rejects old reviews after an intervening restoration and after a legacy write', async () => {
    const initial = await store.read()
    await store.write([{ key: 'htmlCore', isEnabled: true, config: { links: true } }])
    await store.write([{ key: 'htmlCore', isEnabled: true, config: { links: false } }])
    await expect(store.write([{ key: 'htmlCore', isEnabled: false, config: {} }], initial.fingerprint)).rejects.toMatchObject({ status: 409 })
  })
  it('rejects unknown modules/options, duplicate rows and invalid typed/enumerated settings before writing', async () => {
    const initial = await store.read()
    for (const input of [
      [{ key: 'missing', isEnabled: true, config: {} }],
      [{ key: 'htmlCore', isEnabled: true, config: { undeclared: false } }],
      [{ key: 'htmlCore', isEnabled: true, config: { links: 'yes' } }],
      [{ key: 'markdownCore', isEnabled: true, config: { quotes: 'Unknown' } }],
      [{ key: 'htmlCore', isEnabled: true, config: {} }, { key: 'htmlCore', isEnabled: false, config: {} }]
    ]) await expect(store.write(input, initial.fingerprint)).rejects.toMatchObject({ status: 400 })
    expect((await store.read()).fingerprint).toBe(initial.fingerprint)
  })
  it('invalidates a review if an installed definition changes', async () => {
    const initial = await store.read(), original = definitions[0]!.title
    definitions[0]!.title = 'Changed definition'
    try { await expect(store.write([{ key: 'htmlCore', isEnabled: true, config: {} }], initial.fingerprint)).rejects.toMatchObject({ status: 409 }) } finally { definitions[0]!.title = original }
  })
})
