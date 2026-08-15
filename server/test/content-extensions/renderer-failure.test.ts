import createKnex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { serializeContentExtensionFence } from '../../../shared/content-extensions.ts'

const failingRenderer = vi.hoisted(() => vi.fn().mockRejectedValue(new Error('renderer unavailable')))
vi.mock('../../content-extensions/qr.ts', () => ({ renderQrContentExtension: failingRenderer }))

import { prepareContentExtensionFences } from '../../content-extensions/renderer.ts'
const source = serializeContentExtensionFence({
  key: 'qr',
  version: 1,
  props: { value: '<preserved>', size: 256, errorCorrection: 'M' }
})
let db: Knex

describe('content extension renderer failure', () => {
  beforeAll(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('contentExtensions', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.integer('version').notNullable()
    })
    await db('contentExtensions').insert({ key: 'qr', isEnabled: true, version: 1 })
    Reflect.set(globalThis, 'WIKI', { models: { knex: db } })
  })

  afterAll(async () => { await db.destroy() })

  it('leaves the canonical source unprepared when its renderer fails', async () => {
    failingRenderer.mockRejectedValueOnce(new Error('renderer unavailable'))
    const original = source
    const body = `${source.split('\n')[1] ?? ''}\n`
    const prepared = await prepareContentExtensionFences([{ type: 'fence', info: 'wiki-extension', content: body }])

    expect(failingRenderer).toHaveBeenCalledTimes(1)
    expect(prepared.size).toBe(0)
    expect(source).toBe(original)
  })
})
