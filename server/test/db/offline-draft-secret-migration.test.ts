import createKnex, { type Knex } from 'knex'
import { OFFLINE_KEY_VERSION, type DraftKeyContext } from '../../../shared/offline.ts'
import { down, up } from '../../db/migrations/tsepistle-000053-offline-draft-secret.ts'
import { deriveOfflineDraftKey } from '../../helpers/offline-draft-keys.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

interface SettingRow {
  key: string
  value: string | null
  updatedAt: string
}

const updatedAt = '2026-01-02T03:04:05.000Z'
const legacySecret = 'configured-session-secret'
const legacyKey = '63098f7357e0fe53824c85ccfc51a58e97ee2c4db1cfc16efb07af2e38986829'
const context: DraftKeyContext = {
  canonicalOrigin: 'https://wiki.example.test',
  siteId: 'site-fixture',
  accountId: 7,
  authVersion: 3,
  keyVersion: OFFLINE_KEY_VERSION
}
const corruptValues: Array<[string, string | null]> = [
  ['invalid JSON', 'not-json'],
  ['SQL null', null],
  ['JSON null', 'null'],
  ['array', '[]'],
  ['missing wrapper', '{}'],
  ['unwrapped string', JSON.stringify('unwrapped-secret')],
  ['null secret', JSON.stringify({ v: null })],
  ['numeric secret', JSON.stringify({ v: 42 })],
  ['object secret', JSON.stringify({ v: {} })],
  ['empty secret', JSON.stringify({ v: '' })]
]

const setting = (key: string, value: unknown): SettingRow => ({ key, value: JSON.stringify(value), updatedAt })

const readRoot = async (db: Knex): Promise<SettingRow> => {
  const row = await db<SettingRow>('settings').where({ key: 'offlineDraftSecret' }).first()
  if (!row) throw new Error('Expected a persisted offline draft encryption root')
  return row
}

const derivePersistedKey = (row: SettingRow): string => {
  const root = JSON.parse(row.value!) as { v: string }
  return deriveOfflineDraftKey(context, root.v).toString('hex')
}

describe('independent offline draft encryption root migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.json('value')
      table.string('updatedAt').notNullable()
    })
  })

  afterEach(async () => await db.destroy())

  it('preserves the legacy draft key through session rotation without changing installation or provider data', async () => {
    await db<SettingRow>('settings').insert([
      setting('sessionSecret', { v: legacySecret }),
      setting('certs', { public: 'fixture-rsa-public', private: 'fixture-encrypted-rsa-private' }),
      setting('auth', { audience: 'fixture-audience' }),
      setting('title', { v: 'Fixture site' }),
      setting('providerConfiguration', { encryptedKey: 'fixture-provider-ciphertext', enabled: true })
    ])
    const originalSettings = await db<SettingRow>('settings').orderBy('key')

    await up(db)

    const root = await readRoot(db)
    expect(JSON.parse(root.value!)).toEqual({ v: legacySecret })
    expect(derivePersistedKey(root)).toBe(legacyKey)
    expect(await db<SettingRow>('settings').whereNot('key', 'offlineDraftSecret').orderBy('key')).toEqual(originalSettings)
    const migratedSettings = await db<SettingRow>('settings').orderBy('key')
    await up(db)
    expect(await db<SettingRow>('settings').orderBy('key')).toEqual(migratedSettings)

    const rotatedSecret = 'rotated-session-secret'
    await db('settings').where({ key: 'sessionSecret' }).update({ value: JSON.stringify({ v: rotatedSecret }) })
    await up(db)

    expect(await readRoot(db)).toEqual(root)
    expect(derivePersistedKey(await readRoot(db))).toBe(legacyKey)
    expect(deriveOfflineDraftKey(context, rotatedSecret).toString('hex')).not.toBe(legacyKey)
  })

  it('preserves an existing independent root exactly and refuses to discard it on rollback', async () => {
    await db<SettingRow>('settings').insert([
      setting('sessionSecret', { v: legacySecret }),
      setting('offlineDraftSecret', { v: 'already-independent-root', version: 7 })
    ])
    const originalSettings = await db<SettingRow>('settings').orderBy('key')

    await up(db)
    await up(db)
    await expect(down(db)).rejects.toThrow()

    expect(await db<SettingRow>('settings').orderBy('key')).toEqual(originalSettings)
  })

  it('does not expose encryption-root bindings or change settings when persistence fails', async () => {
    await db<SettingRow>('settings').insert(setting('sessionSecret', { v: legacySecret }))
    await db.raw(`
      CREATE TRIGGER reject_draft_root BEFORE INSERT ON settings
      WHEN NEW.key = 'offlineDraftSecret'
      BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END
    `)
    const originalSettings = await db<SettingRow>('settings').orderBy('key')

    const failure: unknown = await up(db).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(legacySecret)
    expect(await db<SettingRow>('settings').orderBy('key')).toEqual(originalSettings)
  })

  it('leaves an unset new installation untouched even after other migrations seed administrative settings', async () => {
    await up(db)
    expect(await db('settings')).toEqual([])
    await db<SettingRow>('settings').insert([
      setting('analyticsAdministration', {}),
      setting('mailAdministration', {}),
      setting('storageAdministration', {})
    ])
    const originalSettings = await db<SettingRow>('settings').orderBy('key')

    await up(db)
    await up(db)

    expect(await db<SettingRow>('settings').orderBy('key')).toEqual(originalSettings)
  })

  it.each(['auth', 'certs', 'offlineDraftSiteId', 'offlineDraftSecret', 'title'])(
    'fails closed when installation setting %s exists without sessionSecret',
    async key => {
      await db<SettingRow>('settings').insert(setting(key, key === 'offlineDraftSecret' ? { v: 'existing-root' } : {}))
      const originalSettings = await db<SettingRow>('settings').orderBy('key')

      await expect(up(db)).rejects.toThrow()

      expect(await db<SettingRow>('settings').orderBy('key')).toEqual(originalSettings)
    }
  )

  it.each(corruptValues)('fails closed for a corrupt sessionSecret: %s', async (_label, value) => {
    for (const existingRoot of [false, true]) {
      await db('settings').delete()
      await db<SettingRow>('settings').insert({ key: 'sessionSecret', value, updatedAt })
      if (existingRoot) await db<SettingRow>('settings').insert(setting('offlineDraftSecret', { v: 'existing-root' }))
      const originalSettings = await db<SettingRow>('settings').orderBy('key')

      await expect(up(db)).rejects.toThrow()

      expect(await db<SettingRow>('settings').orderBy('key')).toEqual(originalSettings)
    }
  })

  it.each(corruptValues)('never replaces a corrupt persisted offlineDraftSecret: %s', async (_label, value) => {
    await db<SettingRow>('settings').insert([
      setting('sessionSecret', { v: legacySecret }),
      { key: 'offlineDraftSecret', value, updatedAt }
    ])
    const originalSettings = await db<SettingRow>('settings').orderBy('key')

    await expect(up(db)).rejects.toThrow()

    expect(await db<SettingRow>('settings').orderBy('key')).toEqual(originalSettings)
  })
})
