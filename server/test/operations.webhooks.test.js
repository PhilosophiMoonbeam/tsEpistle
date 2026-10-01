import createKnex from 'knex'
vi.mockModule('../core/webhooks.ts', import.meta.url, () => ({
  resolveWebhookUrl: vi.fn(async () => ({})),
  encryptWebhookSecret: () => 'encrypted-fixture',
  generateWebhookSecret: () => 'fixture-secret'
}))
const { up: upJobs } = await import('../db/migrations/2.5.130.ts')
const { up: upOutbox } = await import('../db/migrations/2.5.131.ts')
const runtime = { config: { sessionSecret: 'fixture' }, models: { knex: null } }
global.WIKI = runtime
const { default: operations } = await import('../operations/webhooks.ts')
beforeEach(async () => {
  runtime.models.knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { min: 1, max: 1 }, useNullAsDefault: true })
  await upJobs(runtime.models.knex); await upOutbox(runtime.models.knex)
})
afterEach(async () => { await runtime.models.knex.destroy() })
describe('webhook subscriptions', () => {
  it('persists actual hyphenated event subscriptions and never returns stored secrets', async () => {
    const created = await operations.create({ name: 'Receiver', url: 'https://example.test', events: ['page.visibility-changed'], isEnabled: false })
    const stored = await runtime.models.knex('webhooks').where('id', created.id).first()
    expect(JSON.parse(stored.events)).toEqual(['page.visibility-changed'])
    expect(Boolean(stored.isEnabled)).toBe(false)
    expect(stored.secretCiphertext).toBe('encrypted-fixture')
    await operations.update(created.id, { events: ['page.ownership-transferred', 'page.ownership-transferred'] })
    const hooks = await operations.list()
    expect(hooks).toHaveLength(1)
    expect(hooks[0]).toMatchObject({ events: ['page.ownership-transferred'], isEnabled: false })
    expect(JSON.stringify(hooks)).not.toContain('secret')
    expect(JSON.stringify(hooks)).not.toContain('encrypted-fixture')
  })
  it('rejects invalid enable flags and subscription names before persisting', async () => {
    await expect(operations.create({ name: 'Receiver', url: 'https://example.test', events: ['page.created'], isEnabled: 'false' })).rejects.toBeInstanceOf(TypeError)
    await expect(operations.create({ name: 'Receiver', url: 'https://example.test', events: ['page.*'] })).rejects.toBeInstanceOf(TypeError)
    expect(await runtime.models.knex('webhooks')).toHaveLength(0)
  })
})
