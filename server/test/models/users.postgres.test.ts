import knexModule from 'knex'
import type { Knex } from 'knex'
import tfa from 'node-2fa'
import bcrypt from 'bcryptjs-then'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_user_tfa_test', import.meta.path)
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

suite('PostgreSQL account security transactions', () => {
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
      knex: Object.assign((table: string) => db(table), { transaction, raw: db.raw.bind(db) }),
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
      table.string('sessionsRevokedAt')
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
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.json('value')
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
      await db.schema.dropTableIfExists('settings')
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

    await expect(User.loginTFA({ securityCode: generated.token, continuationToken: setupToken, setup: true }, context))
      .rejects.toBeInstanceOf(authErrors.AuthValidationTokenInvalid)
    expect(await db('userKeys').where({ kind: 'tfaSetup', token: setupToken })).toHaveLength(0)
    expect(await db('users').where('id', 10).first()).toMatchObject({ tfaIsActive: true })
    expect(observations.transactionCompletions).toBe(1)
    expect(observations.afterLoginCalls).toBe(1)
    expect(observations.afterLoginTransactionCompletions).toEqual([1])
  })

  it.each(['resetPwd', 'changePwd'] as const)('commits %s with the real account generation expression and one-use key', async kind => {
    const previousRevocation = '2000-01-01T00:00:00.000Z'
    const oldPassword = 'old-password-123!'
    const newPassword = 'new-password-123!'
    await db('users').where('id', 10).update({
      password: await bcrypt.hash(oldPassword, 4),
      authVersion: 7,
      sessionsRevokedAt: previousRevocation,
      mustChangePwd: true,
      isVerified: false
    })
    await db('userKeys').update({ kind, authVersion: 7 })

    if (kind === 'resetPwd') {
      await expect(User.resetPassword({ token: setupToken, newPassword })).resolves.toBe(10)
    } else {
      // Session issuance is downstream of the persistence contract exercised here.
      const usersModel = wikiRuntime.models.users as typeof User
      const previousRefreshToken = usersModel.refreshToken
      Object.assign(usersModel, { refreshToken: async () => ({ token: 'signed-jwt' }) })
      try {
        await User.loginChangePassword(
          { continuationToken: setupToken, newPassword },
          { req: { logIn: (_user: unknown, _options: unknown, callback: () => void) => callback() } } as never
        )
      } finally {
        usersModel.refreshToken = previousRefreshToken
      }
    }

    const account = await db('users').where('id', 10).first()
    expect(account).toMatchObject({ authVersion: 8, mustChangePwd: false, isVerified: kind === 'resetPwd' })
    expect(account.sessionsRevokedAt).not.toBe(previousRevocation)
    expect(new Date(account.sessionsRevokedAt).toISOString()).toBe(account.sessionsRevokedAt)
    expect(await bcrypt.compare(newPassword, account.password)).toBe(true)
    expect(await bcrypt.compare(oldPassword, account.password)).toBe(false)
    expect(await db('userKeys').where('userId', 10)).toHaveLength(0)
    expect(observations.transactionCompletions).toBe(1)
    expect(observations.afterLoginCalls).toBe(0)
  })
})
