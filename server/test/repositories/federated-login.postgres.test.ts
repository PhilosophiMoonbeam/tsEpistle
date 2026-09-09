import createKnex, { type Knex } from 'knex'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'

import { up as migrateFederatedLogin } from '../../db/migrations/tsepistle-000030-federated-login-state.ts'
import { FederatedLoginStore } from '../../repositories/federated-login.ts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = databaseName.endsWith('_federated_login_test') && password
  ? {
      host: process.env.WIKI_TEST_POSTGRES_HOST ?? 'wiki-postgres',
      port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
      user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
      password,
      database: databaseName
    }
  : null
const directlyInvoked = process.env.npm_lifecycle_event !== 'test' && process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('federated-login.postgres.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'
if (databaseContractRequired && !connection) throw new Error('Explicit federated-login PostgreSQL execution requires a *_federated_login_test database and password.')
const suite = connection ? describe : describe.skip

suite('PostgreSQL federated login authority', () => {
  let db: Knex
  let second: Knex

  beforeAll(async () => {
    db = createKnex({ client: 'pg', connection: connection! })
    second = createKnex({ client: 'pg', connection: connection! })
    await db.schema.dropTableIfExists('federatedLoginAttempts')
    await db.schema.dropTableIfExists('sessions')
    await db.schema.dropTableIfExists('authentication')
    await db.schema.createTable('sessions', table => {
      table.string('sid').primary()
      table.text('sess').notNullable()
      table.dateTime('expired').notNullable()
    })
    await db('sessions').insert({ sid: 'session-a', sess: '{}', expired: new Date('2030-01-01T00:00:00.000Z') })
    await db.schema.createTable('authentication', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.string('adminRevision').notNullable()
    })
    await db('authentication').insert({ key: 'provider-a', isEnabled: true, adminRevision: 'revision-a' })
    await migrateFederatedLogin(db)
  })

  afterAll(async () => {
    await db.schema.dropTableIfExists('federatedLoginAttempts')
    await db.schema.dropTableIfExists('sessions')
    await db.schema.dropTableIfExists('authentication')
    await Promise.all([db.destroy(), second.destroy()])
  })

  it('allows exactly one consumer across separate database connections', async () => {
    const issued = await new FederatedLoginStore(db).issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: { codeVerifier: 'verifier-a' }
    })
    const input = {
      sessionId: 'session-a',
      providerKey: 'provider-a' as const,
      protocol: 'oauth2' as const,
      providerRevision: 'revision-a',
      state: issued.state
    }
    const results = await Promise.all([
      new FederatedLoginStore(db).consume(input),
      new FederatedLoginStore(second).consume(input)
    ])
    expect(results.filter(result => result !== null)).toHaveLength(1)
  })

  it('requires the enabled provider revision and originating session on PostgreSQL', async () => {
    await db('sessions').insert({ sid: 'session-b', sess: '{}', expired: new Date('2030-01-01T00:00:00.000Z') })
    const store = new FederatedLoginStore(db)
    const issued = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })

    expect(await store.consume({
      sessionId: 'session-b',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await db('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(1)

    await db('authentication').where({ key: 'provider-a' }).update({ isEnabled: false })
    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: issued.state
    })).toBeNull()
    expect(await db('federatedLoginAttempts').where({ id: issued.attemptId })).toHaveLength(0)

    await db('authentication').where({ key: 'provider-a' }).update({ isEnabled: true, adminRevision: 'revision-a' })
    const revised = await store.issue({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      payload: {}
    })
    await db('authentication').where({ key: 'provider-a' }).update({ adminRevision: 'revision-b' })
    expect(await store.consume({
      sessionId: 'session-a',
      providerKey: 'provider-a',
      protocol: 'oauth2',
      providerRevision: 'revision-a',
      state: revised.state
    })).toBeNull()
  })
})
