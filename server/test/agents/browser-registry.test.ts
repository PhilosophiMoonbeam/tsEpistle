import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserTargetRegistry } from '../../agents/browser/registry.ts'

describe('browser target registry', () => {
  let db: Knex
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentBrowserTargets', table => { table.uuid('id').primary(); table.text('canonicalUrl').notNullable().unique(); table.boolean('enabled').notNullable(); table.string('policySha256').notNullable(); table.integer('createdBy'); table.integer('updatedBy'); table.dateTime('createdAt').notNullable(); table.dateTime('updatedAt').notNullable() })
  })
  afterEach(async () => db.destroy())

  it('stores only exact canonical HTTPS targets and immutable policy evidence', async () => {
    const registry = new BrowserTargetRegistry(db)
    const created = await registry.create({ canonicalUrl: 'https://example.com/docs', enabled: false, actorId: 7 })
    expect(created).toMatchObject({ canonicalUrl: 'https://example.com/docs', enabled: false, createdBy: 7, updatedBy: 7 })
    expect(created.policySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await registry.setEnabled({ id: created.id, enabled: true, actorId: 8 })).toMatchObject({ enabled: true, createdBy: 7, updatedBy: 8, policySha256: created.policySha256 })
    await expect(registry.create({ canonicalUrl: 'http://example.com/', enabled: true, actorId: 7 })).rejects.toMatchObject({ code: 'BROWSER_HTTPS_REQUIRED' })
    await expect(registry.create({ canonicalUrl: 'https://EXAMPLE.com/docs', enabled: true, actorId: 7 })).rejects.toMatchObject({ code: 'INVALID_BROWSER_TARGET' })
    await expect(registry.create({ canonicalUrl: 'https://example.com/docs', enabled: true, actorId: 7 })).rejects.toMatchObject({ code: 'BROWSER_TARGET_EXISTS' })
  })
})
