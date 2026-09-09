import createKnex, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

type Verify = (...args: unknown[]) => Promise<void>
let verify: Verify = async () => {}

class PassportStrategy {
  constructor(...args: unknown[]) {
    verify = args.find(value => typeof value === 'function') as Verify
  }
}

class OpenIDClientStrategy {
  constructor(...args: unknown[]) {
    verify = args.find(value => typeof value === 'function') as Verify
  }
}

const ValidateInResponseTo = { always: 'always' }
const processProfile = vi.fn()
const revokeUserTokens = vi.fn()
const emit = vi.fn()
const wiki = {
  models: {
    knex: undefined as unknown as Knex,
    users: { processProfile }
  },
  config: { flags: { ldapdebug: false } },
  logger: { warn: vi.fn() },
  auth: { revokeUserTokens },
  events: { outbound: { emit } }
}
const originalWiki = Reflect.get(globalThis, 'WIKI')

vi.mockModule('../../modules/types.ts', import.meta.url, () => ({
  wiki,
  asError: (value: unknown) => (value instanceof Error ? value : new Error(String(value)))
}))
vi.mockModule('passport-openidconnect', import.meta.url, () => ({ default: { Strategy: PassportStrategy } }))
vi.mockModule('@node-saml/passport-saml', import.meta.url, () => ({ MultiSamlStrategy: PassportStrategy, ValidateInResponseTo }))
vi.mockModule('openid-client', import.meta.url, () => ({ discovery: async () => ({}) }))
vi.mockModule('../../modules/authentication/openid-client-strategy.ts', import.meta.url, () => ({ OpenIDClientStrategy }))
vi.mockModule('../../modules/authentication/ldap/ldap-strategy.ts', import.meta.url, () => ({ LdapStrategy: PassportStrategy }))

let database: Knex
let user: Record<string, unknown>

const postProcessResponse = (result: unknown): unknown => {
  const parse = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(parse)
    if (typeof value !== 'object' || value === null) return value
    const row = value as Record<string, unknown>
    if (typeof row.config === 'string') {
      try {
        row.config = JSON.parse(row.config)
      } catch {
        // Leave malformed fixture data for the production validator to reject.
      }
    }
    return row
  }
  return parse(result)
}

beforeAll(async () => {
  database = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    postProcessResponse
  })
  await database.schema.createTable('authentication', table => {
    table.string('key').primary()
    table.boolean('isEnabled').notNullable()
    table.string('adminRevision').notNullable()
    table.json('config').notNullable()
  })
  await database.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.string('name').notNullable()
  })
  await database.schema.createTable('users', table => {
    table.integer('id').primary()
    table.string('providerKey').notNullable()
    table.boolean('isActive').notNullable()
    table.boolean('isSystem').notNullable()
    table.integer('authVersion').notNullable()
    table.string('adminRevision').notNullable()
    table.dateTime('sessionsRevokedAt')
  })
  await database.schema.createTable('userGroups', table => {
    table.integer('userId').notNullable()
    table.integer('groupId').notNullable()
    table.primary(['userId', 'groupId'])
  })
  await database.schema.createTable('userAdministrationEvents', table => {
    table.increments('id').primary()
    table.integer('userId')
    table.integer('actorId')
    table.string('action')
    table.text('reason')
    table.text('details')
    table.dateTime('createdAt')
  })
  await database.schema.createTable('groupAdministrationEvents', table => {
    table.increments('id').primary()
    table.integer('groupId')
    table.integer('actorId')
    table.string('action')
    table.text('reason')
    table.text('details')
    table.dateTime('createdAt')
  })
  wiki.models.knex = database
  Reflect.set(globalThis, 'WIKI', wiki)
})

afterAll(async () => {
  await database.destroy()
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
})

const resetDatabase = async (): Promise<void> => {
  for (const table of ['groupAdministrationEvents', 'userAdministrationEvents', 'userGroups', 'users', 'groups', 'authentication']) {
    await database(table).delete()
  }
  await database('authentication').insert({
    key: 'organization',
    isEnabled: true,
    adminRevision: 'revision-a',
    config: { mapGroups: true }
  })
  await database('groups').insert([
    { id: 2, name: 'Guests' },
    { id: 3, name: 'Readers' },
    { id: 4, name: 'Writers' }
  ])
  await database('users').insert({
    id: 3,
    providerKey: 'organization',
    isActive: true,
    isSystem: false,
    authVersion: 1,
    adminRevision: 'initial'
  })
  await database('userGroups').insert({ userId: 3, groupId: 4 })
}

beforeEach(async () => {
  user = { id: 3, authVersion: 1, adminRevision: 'initial' }
  processProfile.mockReset().mockResolvedValue(user)
  revokeUserTokens.mockReset()
  emit.mockReset()
  await resetDatabase()
})

const configuration = (kind: string): Record<string, unknown> => ({
  key: 'organization',
  adminRevision: 'revision-a',
  mapGroups: true,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  callbackURL: 'https://wiki.example.invalid/login/organization/callback',
  authorizationURL: 'https://identity.example.invalid/oauth/authorize',
  tokenURL: 'https://identity.example.invalid/oauth/token',
  userInfoURL: 'https://identity.example.invalid/oauth/userinfo',
  issuer: 'https://identity.example.invalid',
  entryPoint: 'https://identity.example.invalid',
  cert: 'idp-certificate',
  privateKey: '',
  decryptionPvk: '',
  signatureAlgorithm: 'sha256',
  digestAlgorithm: 'sha256',
  identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  wantAssertionsSigned: true,
  acceptedClockSkewMs: 0,
  disableRequestedAuthnContext: false,
  authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  racComparison: 'exact',
  forceAuthn: false,
  passive: false,
  providerName: 'tsEpistle',
  skipRequestCompression: false,
  authnRequestBinding: 'HTTP-POST',
  mappingUID: 'uid',
  mappingEmail: 'email',
  mappingDisplayName: 'name',
  mappingPicture: 'picture',
  mappingGroups: kind === 'ldap' ? 'memberOf' : 'memberOf',
  groupsClaim: 'groups',
  emailClaim: 'email',
  displayNameClaim: 'name',
  pictureClaim: 'picture',
  url: 'ldaps://identity.example.invalid',
  bindDn: 'cn=reader',
  bindCredentials: 'password',
  searchBase: 'dc=example,dc=invalid',
  searchFilter: '(uid={{username}})',
  groupSearchBase: 'ou=groups,dc=example,dc=invalid',
  groupSearchFilter: '(member={{dn}})',
  groupSearchScope: 'sub',
  groupDnProperty: 'dn',
  groupNameField: 'cn',
  tlsEnabled: false,
  verifyTLSCertificate: false
})

const run = async (kind: string, names: string[] | undefined, callback: ReturnType<typeof vi.fn>): Promise<void> => {
  const { default: plugin } = await vi.importFresh(`../../modules/authentication/${kind}/authentication.ts`, import.meta.url) as {
    default: { init(registry: { use(key: string, strategy: unknown): void }, config: Record<string, unknown>): void | Promise<void> }
  }
  await plugin.init({ use: vi.fn() }, configuration(kind))
  const request = { params: { strategy: 'organization' } }
  if (kind === 'oidc') {
    await verify(request, 'issuer', { _json: { groups: names, email: 'person@example.invalid' } }, {}, null, null, null, null, null, callback)
  } else if (kind === 'azure') {
    await verify(request, { claims: () => ({ groups: names, email: 'person@example.invalid', sub: 'subject' }) }, callback)
  } else if (kind === 'saml') {
    await verify(request, { uid: 'subject', email: 'person@example.invalid', name: 'Person', attributes: { memberOf: names } }, callback)
  } else {
    await verify(request, { uid: 'subject', email: 'person@example.invalid', name: 'Person', _groups: names?.map(cn => ({ cn })) }, callback)
  }
}

const membershipNames = async (): Promise<string[]> => {
  const rows = await database('userGroups')
    .join('groups', 'groups.id', 'userGroups.groupId')
    .where('userGroups.userId', 3)
    .orderBy('groups.id')
    .select('groups.name')
  return rows.map(row => String(row.name))
}

describe('directory mapping protocol adapters', () => {
  for (const kind of ['ldap', 'oidc', 'saml', 'azure']) {
    it(`${kind} persists the provider claim as current memberships`, async () => {
      const callback = vi.fn()
      await run(kind, ['Readers'], callback)

      expect(await membershipNames()).toEqual(['Readers'])
      const persisted = await database('users').where({ id: 3 }).first()
      expect(persisted?.authVersion).toBe(2)
      expect(persisted?.adminRevision).not.toBe('initial')
      expect(callback.mock.calls[0]?.[0]).toBeNull()
      expect(callback.mock.calls[0]?.[1]).toMatchObject({ id: 3, authVersion: 2 })
    })

    it(`${kind} leaves persisted memberships unchanged when the claim is absent`, async () => {
      const callback = vi.fn()
      await run(kind, undefined, callback)

      expect(await membershipNames()).toEqual(['Writers'])
      expect(await database('users').where({ id: 3 }).first()).toMatchObject({ authVersion: 1, adminRevision: 'initial' })
      expect(callback.mock.calls[0]?.[0]).toBeNull()
    })

    it(`${kind} clears persisted memberships for an explicitly empty claim`, async () => {
      const callback = vi.fn()
      await run(kind, [], callback)

      expect(await membershipNames()).toEqual([])
      expect(await database('users').where({ id: 3 }).first()).toMatchObject({ authVersion: 2 })
      expect(callback.mock.calls[0]?.[0]).toBeNull()
    })

    it(`${kind} rejects sign-in and rolls back membership changes when synchronization fails`, async () => {
      await database.raw(`CREATE TRIGGER reject_membership_event BEFORE INSERT ON userAdministrationEvents
        BEGIN SELECT RAISE(ABORT, 'membership mapping failure'); END`)
      try {
        const callback = vi.fn()
        await run(kind, ['Readers'], callback)

        expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error)
        expect(await membershipNames()).toEqual(['Writers'])
        expect(await database('users').where({ id: 3 }).first()).toMatchObject({ authVersion: 1, adminRevision: 'initial' })
      } finally {
        await database.raw('DROP TRIGGER reject_membership_event')
      }
    })
  }
})
