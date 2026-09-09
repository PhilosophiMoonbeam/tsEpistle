import knexModule from 'knex'
import type { Knex } from 'knex'
import tfa from 'node-2fa'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_user_tfa_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        database: databaseName,
        password
      }
    : null
const suite = connection ? describe : describe.skip

const authErrors = {
  AuthTFAFailed: class extends Error {},
  AuthTFAInvalid: class extends Error {},
  AuthValidationTokenInvalid: class extends Error {}
}
const previousWiki = (globalThis as typeof globalThis & { WIKI?: unknown }).WIKI
const wikiRuntime = {
  Error: authErrors,
  config: {
    title: 'TFA test wiki',
    host: 'https://example.test',
    sessionSecret: 'test-secret',
    lang: { code: 'en' },
    certs: { private: 'private-key' },
    auth: { enforce2FA: false, audience: 'test', tokenExpiration: '1h' }
  },
  models: {} as Record<string, unknown>
}
;(globalThis as typeof globalThis & { WIKI: typeof wikiRuntime }).WIKI = wikiRuntime
// These models capture WIKI during module evaluation, so load them after installing the isolated test context.

const { default: User } = await import('../../models/users.ts')
const { default: UserKey } = await import('../../models/userKeys.ts')

suite('PostgreSQL setup TFA concurrency', () => {
  let db: Knex
  const observations = {
    afterLoginCalls: 0,
    afterLoginTransactionCompletions: [] as number[],
    transactionCompletions: 0
  }
  const setupToken = 'tfa-setup-concurrency-token'
  const secret = 'JBSWY3DPEHPK3PXP'

  const installModels = (): void => {
    const boundUser = User.bindKnex(db)
    const boundUserKey = UserKey.bindKnex(db)
    const transaction = async <Result>(operation: (trx: Knex.Transaction) => Promise<Result>): Promise<Result> => {
      const result = await db.transaction(operation)
      observations.transactionCompletions += 1
      return result
    }
    const users = Object.assign(boundUser, {
      afterLoginChecks: async () => {
        observations.afterLoginCalls += 1
        observations.afterLoginTransactionCompletions.push(observations.transactionCompletions)
        return { jwt: 'signed-jwt', redirect: '/' }
      }
    })
    wikiRuntime.models = {
      knex: { transaction },
      users,
      userKeys: boundUserKey
    }
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.increments('id')
      table.string('email').notNullable()
      table.string('name')
      table.string('providerId')
      table.string('providerKey')
      table.string('password')
      table.boolean('tfaIsActive').notNullable().defaultTo(false)
      table.string('tfaSecret')
      table.boolean('isActive').notNullable().defaultTo(true)
      table.boolean('isSystem').notNullable().defaultTo(false)
      table.boolean('isVerified').notNullable().defaultTo(true)
      table.boolean('mustChangePwd').notNullable().defaultTo(false)
      table.integer('authVersion').notNullable().defaultTo(0)
      table.string('adminRevision')
      table.string('createdAt')
      table.string('updatedAt')
    })
    await db.schema.createTable('userKeys', table => {
      table.increments('id')
      table.integer('userId').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('kind').notNullable()
      table.string('token').notNullable()
      table.integer('authVersion').notNullable()
      table.string('validUntil').notNullable()
      table.string('createdAt')
    })
  })

  beforeEach(async () => {
    await db('userKeys').delete()
    await db('users').delete()
    await db('users').insert({
      id: 10,
      email: 'tfa@example.test',
      name: 'TFA User',
      providerKey: 'local',
      isActive: true,
      isSystem: false,
      isVerified: true,
      tfaIsActive: false,
      tfaSecret: secret,
      authVersion: 0,
      mustChangePwd: false
    })
    await db('userKeys').insert({
      userId: 10,
      kind: 'tfaSetup',
      token: setupToken,
      authVersion: 0,
      validUntil: new Date(Date.now() + 86_400_000).toISOString()
    })
    observations.afterLoginCalls = 0
    observations.afterLoginTransactionCompletions = []
    observations.transactionCompletions = 0
    installModels()
  })

  afterAll(async () => {
    if (db) {
      await db.schema.dropTableIfExists('userKeys')
      await db.schema.dropTableIfExists('users')
      await db.destroy()
    }
    if (previousWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else (globalThis as typeof globalThis & { WIKI: unknown }).WIKI = previousWiki
  })

  it('lets only one concurrent valid setup completion consume and enable the account', async () => {
    const generated = tfa.generateToken(secret)
    if (!generated) throw new Error('Unable to generate a TFA test code')
    const context = {
      req: { body: {}, params: {}, login: () => {}, logIn: () => {} },
      res: {}
    } as never
    const results = await Promise.allSettled([
      User.loginTFA({ securityCode: generated.token, continuationToken: setupToken, setup: true }, context),
      User.loginTFA({ securityCode: generated.token, continuationToken: setupToken, setup: true }, context)
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await db('userKeys').where({ kind: 'tfaSetup', token: setupToken })).toHaveLength(0)
    expect(await db('users').where('id', 10).first()).toMatchObject({ tfaIsActive: true })
    expect(observations.afterLoginCalls).toBe(1)
    expect(observations.afterLoginTransactionCompletions).toEqual([1])
  })
})
