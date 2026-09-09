import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/tsepistle-000029-oauth-state-required.ts'

type Config = Record<string, unknown>

type AuthenticationRow = {
  readonly key: string
  readonly strategyKey: string
  readonly config: string | Config
}

const parseConfig = (config: AuthenticationRow['config']): Config =>
  typeof config === 'string' ? JSON.parse(config) as Config : config

describe('OAuth state requirement migration', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  const createDatabase = async (): Promise<Knex> => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await db.schema.createTable('authentication', table => {
      table.string('key').primary()
      table.string('strategyKey').notNullable()
      table.json('config').notNullable()
    })
    return db
  }

  it('removes only the generic OAuth2 opt-out and preserves secrets, other config, and unrelated providers', async () => {
    const db = await createDatabase()
    const oauthConfig = {
      clientId: 'client-id',
      clientSecret: 'keep-this-secret',
      authorizationURL: 'https://provider.example.com/authorize',
      enableCSRFProtection: false,
      nested: { preserve: true }
    }
    const untouchedConfig = {
      clientSecret: 'unrelated-secret',
      enableCSRFProtection: false,
      providerOption: 'preserve'
    }
    await db('authentication').insert([
      { key: 'oauth2:tenant', strategyKey: 'oauth2', config: JSON.stringify(oauthConfig) },
      { key: 'google', strategyKey: 'google', config: JSON.stringify(untouchedConfig) },
      { key: 'oauth2:already-safe', strategyKey: 'oauth2', config: JSON.stringify({ clientId: 'safe-client' }) }
    ])

    await up(db)

    const rows = await db<AuthenticationRow>('authentication')
    const configsByKey = new Map(
      rows.map(row => [row.key, parseConfig(row.config)] as const)
    )
    expect(configsByKey.get('google')).toEqual(untouchedConfig)
    expect(configsByKey.get('oauth2:already-safe')).toEqual({ clientId: 'safe-client' })
    expect(configsByKey.get('oauth2:tenant')).toEqual({
      clientId: 'client-id',
      clientSecret: 'keep-this-secret',
      authorizationURL: 'https://provider.example.com/authorize',
      nested: { preserve: true }
    })
  })

  it('does not recreate the insecure opt-out on rollback', async () => {
    await expect(down()).rejects.toThrow()
  })
})
