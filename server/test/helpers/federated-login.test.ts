import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { up as migrateFederatedLogin } from '../../db/migrations/tsepistle-000030-federated-login-state.ts'
import {
  FEDERATED_LOGIN_TTL_MS,
  FederatedLoginStore
} from '../../repositories/federated-login.ts'

const createDatabase = async (): Promise<Knex> => {
  const database = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await migrateFederatedLogin(database)
  await database.schema.createTable('sessions', table => {
    table.string('sid').primary()
    table.text('sess').notNullable()
    table.dateTime('expired').notNullable()
  })
  await database.schema.createTable('authentication', table => {
    table.string('key').primary()
    table.boolean('isEnabled').notNullable()
    table.string('adminRevision').notNullable()
  })
  return database
}

const createSession = async (database: Knex, sid: string, expired: Date): Promise<void> => {
  await database('sessions').insert({ sid, sess: '{}', expired })
}
const createLiveSession = async (database: Knex, sid: string): Promise<void> => {
  await createSession(database, sid, new Date('2030-01-01T00:00:00.000Z'))
}
const createProvider = async (database: Knex, key: string, revision: string): Promise<void> => {
  await database('authentication').insert({ key, isEnabled: true, adminRevision: revision })
}

describe('federated login durable authority', () => {
  const databases: Knex[] = []

  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  it('consumes a provider/session-bound state at most once and stores no plaintext state', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: { codeVerifier: 'verifier-a', nonce: 'nonce-a' }
    })

    await createLiveSession(database, 'session-a')
    const row = await database('federatedLoginAttempts').first()
    expect(row?.payload).not.toContain(issued.state)
    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toMatchObject({ attemptId: issued.attemptId, payload: { codeVerifier: 'verifier-a' } })
    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
  })

  it('isolates providers and preserves state for a mismatched provider callback', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })
    await createLiveSession(database, 'session-a')

    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-b',
      protocol: 'oauth2',
      state: issued.state,
      providerRevision: 'revision-b',
    })).toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(1)
    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).not.toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(0)
  })

  it('fails closed when the provider is disabled after initiation', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })
    await createLiveSession(database, 'session-a')
    await database('authentication').where({ key: 'provider-a' }).update({ isEnabled: false })

    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(0)
  })

  it('fails closed when the provider revision changes after initiation', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })
    await createLiveSession(database, 'session-a')
    await database('authentication').where({ key: 'provider-a' }).update({ adminRevision: 'revision-b' })

    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(0)
  })

  it('fails closed when the provider row is deleted after initiation', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })
    await createLiveSession(database, 'session-a')
    await database('authentication').where({ key: 'provider-a' }).delete()

    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(0)
  })

  it('rejects a wrong-session callback without consuming the valid attempt', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })
    await createLiveSession(database, 'session-a')
    await createLiveSession(database, 'session-b')

    expect(await store.consume({
      sessionId: 'session-b',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(1)
    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).not.toBeNull()
  })

  it('rejects a callback when the originating browser session is missing', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })

    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(0)
  })

  it('rejects a callback when the originating browser session is expired', async () => {
    const database = await createDatabase()
    databases.push(database)
    const now = new Date('2026-01-01T00:00:00.000Z')
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })
    await createSession(database, 'session-a', new Date('2025-12-31T23:59:59.999Z'))

    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await database('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(0)
  })

  it('allows a pre-boundary callback but rejects one at exactly ten minutes', async () => {
    const database = await createDatabase()
    databases.push(database)
    const issuedAt = new Date('2026-01-01T00:00:00.000Z')
    let now = issuedAt
    await createProvider(database, 'provider-a', 'revision-a')
    const store = new FederatedLoginStore(database, { now: () => now })
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {},
      issuedAt
    })
    await createLiveSession(database, 'session-a')
    now = new Date(issuedAt.getTime() + FEDERATED_LOGIN_TTL_MS - 1)
    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).not.toBeNull()

    const boundaryIssued = await store.issue({
      sessionId: 'session-b',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {},
      issuedAt
    })
    await createLiveSession(database, 'session-b')
    now = new Date(issuedAt.getTime() + FEDERATED_LOGIN_TTL_MS)
    expect(await store.consume({
      sessionId: 'session-b',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: boundaryIssued.state
    })).toBeNull()
  })
})
