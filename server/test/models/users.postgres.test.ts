import knexModule from 'knex'
import type { Knex } from 'knex'
import tfa from 'node-2fa'
import bcrypt from 'bcryptjs-then'
import { generateKeyPairSync } from 'node:crypto'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as personalMcpUp } from '../../db/migrations/tsepistle-000062-personal-mcp-keys.ts'
import { up as groupAdministrationUp } from '../../db/migrations/tsepistle-000018-group-administration.ts'
import { up as groupMfaUp } from '../../db/migrations/tsepistle-000079-group-form-mfa.ts'
import { createGroupAdministrationStore } from '../../operations/group-administration.ts'

const connection = getPostgresTestConnection('_user_tfa_test', import.meta.path)
const suite = connection ? describe : describe.skip

const authErrors = {
  AuthTFAFailed: class extends Error {},
  AuthTFAInvalid: class extends Error {},
  AuthValidationTokenInvalid: class extends Error {},
  AuthAccountBanned: class extends Error {},
  UserNotFound: class extends Error {},
  AuthGenericError: class extends Error {},
  AuthLoginFailed: class extends Error {},
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
  models: {} as Record<string, unknown>,
  auth: { reloadApiKeys: async () => {}, revokeUserTokens: () => {} },
  events: { outbound: { emit: () => {} } },
  logger: { warn: () => {} }
}
;(globalThis as typeof globalThis & { WIKI: typeof wikiRuntime }).WIKI = wikiRuntime
// Models and self-service operations capture WIKI at evaluation; static imports would precede the isolated runtime installation.

const { default: User } = await import('../../models/users.ts')
const { default: UserKey } = await import('../../models/userKeys.ts')
const { default: userOperations } = await import('../../operations/users.ts')

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
      table.string('location')
      table.string('jobTitle')
      table.string('pictureUrl')
      table.string('password')
      for (const name of ['handle', 'timezone', 'dateFormat', 'timeFormat', 'appearance', 'localeCode', 'defaultEditor', 'fontFamily', 'contentTextSize', 'communicationLocale', 'lastLoginAt'])
        table.string(name)
      table.boolean('reduceMotion').notNullable().defaultTo(false)
      table.boolean('underlineLinks').notNullable().defaultTo(false)
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
    await db.schema.createTable('userAvatars', table => {
      table.integer('id').primary().references('id').inTable('users').onDelete('CASCADE')
      table.binary('data')
      table.string('origin')
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
    await db.schema.createTable('apiKeys', table => {
      table.increments('id')
      table.string('name')
      table.text('key')
      table.string('expiration')
      table.boolean('isRevoked').notNullable()
      table.string('createdAt')
      table.string('updatedAt')
    })
    await personalMcpUp(db)
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.string('name')
      table.string('redirectOnLogin').defaultTo('/')
      table.jsonb('permissions').notNullable().defaultTo('[]')
      table.jsonb('pageRules').notNullable().defaultTo('[]')
      table.boolean('isSystem').notNullable().defaultTo(false)
      table.string('createdAt')
      table.string('updatedAt')
    })
    await groupAdministrationUp(db)
    await groupMfaUp(db)
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').references('users.id').onDelete('CASCADE')
      table.integer('groupId').references('groups.id').onDelete('CASCADE')
      table.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('userAdministrationEvents', table => {
      table.increments('id')
      table.integer('userId')
      table.integer('actorId')
      table.string('action')
      table.string('reason')
      table.jsonb('details')
      table.timestamp('createdAt')
    })
    await db.schema.createTable('authentication', table => { table.jsonb('autoEnrollGroups') })
    await db.schema.createTable('navigation', table => { table.jsonb('config') })
    for (const name of ['agentProviderGrants', 'agentSkillGrants'])
      await db.schema.createTable(name, table => { table.integer('groupId') })
  })

  beforeEach(async () => {
    for (const name of ['groupAdministrationEvents', 'userAdministrationEvents', 'userGroups', 'groups']) await db(name).delete()
    wikiRuntime.config.auth.enforce2FA = false
    await db('apiKeys').delete()
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
    await db('groups').insert([
      { id: 1, name: 'Administrators', permissions: JSON.stringify(['manage:system']) },
      { id: 3, name: 'Members', permissions: JSON.stringify(['read:pages']) }
    ])
    await db('userGroups').insert({ userId: 10, groupId: 3 })
    await db('apiKeys').insert([
      { id: 1, personalOwnerId: 10, personalAccess: 'read-only', key: 'retained-personal-key', isRevoked: false, expiration: '2099-01-01T00:00:00Z' },
      { id: 2, key: 'retained-service-key', isRevoked: false, expiration: '2099-01-01T00:00:00Z' }
    ])
  })

  afterAll(async () => {
    if (db) {
      for (const name of ['groupAdministrationEvents', 'userAdministrationEvents', 'userGroups', 'groups', 'authentication', 'navigation', 'agentProviderGrants', 'agentSkillGrants']) await db.schema.dropTableIfExists(name)
      await db.schema.dropTableIfExists('apiKeys')
      await db.schema.dropTableIfExists('settings')
      await db.schema.dropTableIfExists('userAvatars')
      await db.schema.dropTableIfExists('userKeys')
      await db.schema.dropTableIfExists('users')
      await db.destroy()
    }
    if (previousWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else (globalThis as typeof globalThis & { WIKI: unknown }).WIKI = previousWiki
  })

  it('preserves unmapped profile values and local avatar overrides while clearing mapped empty text', async () => {
    await db('users').where({ id: 10 }).update({ location: 'Local', jobTitle: 'Editor', pictureUrl: 'internal' })
    await db('userAvatars').insert({ id: 10, origin: 'upload', data: Buffer.from('local-avatar') })
    await User.updateProviderProfile({
      userId: 10,
      email: 'tfa@example.test',
      name: 'Provider Name',
      picture: 'https://provider.invalid/avatar',
      pictureData: undefined,
      providerProfile: { jobTitle: '' }
    })
    expect(await db('users').where({ id: 10 }).first()).toMatchObject({
      location: 'Local',
      jobTitle: '',
      pictureUrl: 'internal',
      name: 'Provider Name'
    })
    await User.updateProviderProfile({ userId: 10, email: 'tfa@example.test', name: 'Provider Name', picture: undefined, pictureData: undefined })
    expect(await db('users').where({ id: 10 }).first()).toMatchObject({ location: 'Local', jobTitle: '', pictureUrl: 'internal' })
    expect((await db('userAvatars').where({ id: 10 }).first()).data).toEqual(Buffer.from('local-avatar'))
  })

  it.each([
    { isActive: false, isSystem: false },
    { isActive: true, isSystem: true }
  ])('does not link or update a protected provider account: %j', async flags => {
    await db('users')
      .where({ id: 10 })
      .update({ ...flags, providerId: null, location: 'Local' })
    await expect(
      User.updateProviderProfile({
        userId: 10,
        email: 'changed@example.test',
        name: 'Changed',
        picture: undefined,
        pictureData: undefined,
        providerId: 'provider-subject',
        providerProfile: { location: '' }
      })
    ).rejects.toThrow()
    expect(await db('users').where({ id: 10 }).first()).toMatchObject({ providerId: null, email: 'tfa@example.test', name: 'TFA User', location: 'Local' })
  })

  it.each(['profile', 'preferences', 'avatar upload', 'avatar removal', 'password'] as const)(
    'does not replace a retired session after an in-flight %s mutation and reviewed MFA toggle',
    async kind => {
      const users = wikiRuntime.models.users as typeof User
      wikiRuntime.config.certs.private = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: wikiRuntime.config.sessionSecret }
      }).privateKey
      wikiRuntime.models.authentication = { getStrategy: async () => ({ isEnabled: true }) }
      await db('users').where('id', 10).update({ password: await bcrypt.hash('old-password-123!', 4) })
      const requester = { id: 10, ownershipUserId: 10, authVersion: 0 } as Express.User
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#224466' } }).png().toBuffer()
      const response = {
        cookies: [] as string[],
        cookie(_name: string, value: string) { this.cookies.push(value) },
        set() {}
      }
      const run = () => {
        const identity = { requester, expectedAccountId: 10, response: response as never }
        if (kind === 'profile') return userOperations.updateProfile({
          ...identity, input: { name: 'Changed', location: '', jobTitle: '', timezone: 'UTC', dateFormat: '', appearance: 'light' }
        })
        if (kind === 'preferences') return userOperations.updateProfilePreferences({ ...identity, input: { appearance: 'dark' } })
        if (kind === 'avatar upload') return userOperations.updateAvatar({ ...identity, data: png })
        if (kind === 'avatar removal') return userOperations.clearAvatar(identity)
        return userOperations.changePassword({ ...identity, current: 'old-password-123!', newPassword: 'new-password-123!' })
      }
      // A genuine signed replacement is possible with these fixtures before retirement.
      await run()
      expect(response.cookies).toHaveLength(1)
      if (kind === 'password') {
        requester.authVersion = 1
        await db('users').where('id', 10).update({ password: await bcrypt.hash('old-password-123!', 4) })
      }
      response.cookies = []
      const originalUpdate = users.updateUser, originalAvatar = users.replaceUserAvatarData
      const groups = createGroupAdministrationStore({ db }), actor = { id: 1, ownershipUserId: null, groups: [1] } as never
      const retire = async () => {
        const saved = await groups.inspect(actor, 3)
        await groups.savePolicy(actor, 3, {
          fingerprint: saved.fingerprint, reason: 'Require MFA during in-flight self-service mutation',
          policy: { ...saved, formMfaRequired: true }
        })
      }
      users.updateUser = async input => { const changed = await originalUpdate.call(users, input); await retire(); return changed }
      users.replaceUserAvatarData = async (id, data) => { await originalAvatar.call(users, id, data); await retire() }
      try {
        await expect(run()).rejects.toBeInstanceOf(authErrors.AuthLoginFailed)
        expect(response.cookies).toHaveLength(0)
        expect(await db('users').where('id', 10).first()).toMatchObject({ authVersion: kind === 'password' ? 3 : 1 })
      } finally {
        users.updateUser = originalUpdate
        users.replaceUserAvatarData = originalAvatar
      }
    }
  )
  it.each([
    { workspace: true, account: false, group: false },
    { workspace: false, account: true, group: false },
    { workspace: false, account: false, group: true },
    { workspace: false, account: false, group: false }
  ])('combines form MFA requirements without imposing TOTP on provider-managed continuation: %j', async policy => {
    const users = wikiRuntime.models.users as typeof User
    wikiRuntime.config.auth.enforce2FA = policy.workspace
    await db('users').where('id', 10).update({ mustChangePwd: true, tfaIsActive: policy.account, tfaSecret: null })
    await db('groups').where('id', 3).update({ formMfaRequired: policy.group })
    const user = await users.query().findById(10)
    if (!user) throw new Error('Missing fixture account')
    const context = { req: { body: {}, params: {}, login: () => {}, logIn: () => {} }, res: {} } as never
    const result = await User.afterLoginChecks(user, context)
    expect('mustSetupTFA' in result).toBe(policy.workspace || policy.account || policy.group)
    const before = await db('users').where('id', 10).first()
    const provider = await User.afterLoginChecks(user, context, { skipTFA: true })
    expect(provider).toMatchObject({ mustChangePwd: true })
    expect((await db('users').where('id', 10).first()).tfaSecret).toBe(before.tfaSecret)
  })
  it('does not promote a password continuation to a newer group-policy generation during session issuance', async () => {
    const users = wikiRuntime.models.users as typeof User
    await db('users').where('id', 10).update({ mustChangePwd: true })
    const user = await users.query().findById(10)
    if (!user) throw new Error('Missing fixture account')
    const continuation = await User.afterLoginChecks(user, { req: {}, res: {} } as never)
    if (!('mustChangePwd' in continuation)) throw new Error('Expected password continuation')
    wikiRuntime.models.authentication = { getStrategy: async () => ({ isEnabled: true }) }
    const actor = { id: 1, ownershipUserId: null, groups: [1] } as never, groups = createGroupAdministrationStore({ db })
    await expect(User.loginChangePassword({ continuationToken: continuation.continuationToken, newPassword: 'new-password-123!' }, {
      req: {
        logIn: (_user: unknown, _options: unknown, callback: (error?: unknown) => void) => {
          void (async () => {
            const saved = await groups.inspect(actor, 3)
            await groups.savePolicy(actor, 3, {
              fingerprint: saved.fingerprint, reason: 'Require MFA before concurrent session issuance',
              policy: { ...saved, formMfaRequired: true }
            })
            callback()
          })().catch(callback)
        }
      }
    } as never)).rejects.toBeInstanceOf(authErrors.AuthLoginFailed)
    expect(await db('users').where('id', 10).first()).toMatchObject({ authVersion: 2 })
  })
  it('enforces group enrollment and challenges while reviewed changes retire pending continuations without revoking keys', async () => {
    const users = wikiRuntime.models.users as typeof User
    users.afterLoginChecks = User.afterLoginChecks
    await db('users').where('id', 10).update({ mustChangePwd: true, tfaSecret: null })
    const context = { req: { body: {}, params: {}, login: () => {}, logIn: () => {} }, res: {} } as never
    const load = async () => {
      const user = await users.query().findById(10)
      if (!user) throw new Error('Missing fixture account')
      return user
    }
    const actor = { id: 1, ownershipUserId: null, groups: [1] } as never
    const groups = createGroupAdministrationStore({ db })
    const change = async (required: boolean) => {
      const current = await groups.inspect(actor, 3)
      return groups.savePolicy(actor, 3, {
        fingerprint: current.fingerprint, reason: 'Reviewed group form-MFA transition',
        policy: { ...current, formMfaRequired: required }
      })
    }
    const keys = await db('apiKeys').orderBy('id')
    const password = await User.afterLoginChecks(await load(), context)
    expect(password).toMatchObject({ mustChangePwd: true })
    if (!('mustChangePwd' in password)) throw new Error('Expected password continuation')
    await change(true)
    await expect(UserKey.validateToken({ kind: 'changePwd', token: password.continuationToken! })).rejects.toBeInstanceOf(authErrors.AuthValidationTokenInvalid)
    const retiredEnrollment = await User.afterLoginChecks(await load(), context)
    if (!('mustSetupTFA' in retiredEnrollment)) throw new Error('Expected authenticator enrollment')
    const retiredCode = tfa.generateToken(retiredEnrollment.tfaSecret)
    if (!retiredCode) throw new Error('Unable to generate retired enrollment code')
    await change(false)
    await expect(User.loginTFA({ securityCode: retiredCode.token, continuationToken: retiredEnrollment.continuationToken, setup: true }, context)).rejects.toBeInstanceOf(authErrors.AuthValidationTokenInvalid)
    await change(true)
    const enrollment = await User.afterLoginChecks(await load(), context)
    expect(enrollment).toMatchObject({ mustSetupTFA: true })
    if (!('mustSetupTFA' in enrollment)) throw new Error('Expected authenticator enrollment')
    expect(enrollment.tfaQRImage).toContain('<svg')
    const code = tfa.generateToken(enrollment.tfaSecret!)
    if (!code) throw new Error('Unable to generate enrollment code')
    const next = await User.loginTFA({ securityCode: code.token, continuationToken: enrollment.continuationToken!, setup: true }, context)
    expect(next).toMatchObject({ mustChangePwd: true })
    expect(await db('users').where('id', 10).first()).toMatchObject({ tfaIsActive: true, authVersion: 3 })
    const challenge = await User.afterLoginChecks(await load(), context)
    expect(challenge).toMatchObject({ mustProvideTFA: true })
    if (!('mustProvideTFA' in challenge)) throw new Error('Expected authenticator challenge')
    await change(false)
    await expect(User.loginTFA({ securityCode: code.token, continuationToken: challenge.continuationToken!, setup: false }, context)).rejects.toBeInstanceOf(authErrors.AuthValidationTokenInvalid)
    const retained = await User.afterLoginChecks(await load(), context)
    expect(retained).toMatchObject({ mustProvideTFA: true })
    expect(await db('apiKeys').orderBy('id')).toEqual(keys)
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

    await expect(User.loginTFA({ securityCode: generated.token, continuationToken: setupToken, setup: true }, context)).rejects.toBeInstanceOf(
      authErrors.AuthValidationTokenInvalid
    )
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
    await db('users')
      .where('id', 10)
      .update({
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
        await User.loginChangePassword({ continuationToken: setupToken, newPassword }, {
          req: { logIn: (_user: unknown, _options: unknown, callback: () => void) => callback() }
        } as never)
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
    expect(await db('apiKeys').where('id', 1).first()).toMatchObject({ key: 'retained-personal-key', isRevoked: true, personalAccess: 'read-only', personalOwnerId: 10 })
    expect(await db('apiKeys').where('id', 2).first()).toMatchObject({ key: 'retained-service-key', isRevoked: false, personalAccess: null })
    expect(observations.transactionCompletions).toBe(1)
    expect(observations.afterLoginCalls).toBe(0)
  })
})
