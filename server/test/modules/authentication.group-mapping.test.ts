import createKnex, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { generateKeyPairSync } from 'node:crypto'
import { SAML, ValidateInResponseTo as SamlValidation, type Profile } from '@node-saml/node-saml'
import { SignedXml } from 'xml-crypto'

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
vi.mockModule('passport-oauth2', import.meta.url, () => ({ default: { Strategy: PassportStrategy } }))
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
  user = { id: 3, authVersion: 1, adminRevision: 'initial', groups: [{ id: 4, name: 'Writers' }] }
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

const run = async (
  kind: string,
  names: unknown,
  callback: ReturnType<typeof vi.fn>,
  config: Record<string, unknown> = {},
  claims: Record<string, unknown> = {}
): Promise<void> => {
  const { default: plugin } = (await vi.importFresh(`../../modules/authentication/${kind}/authentication.ts`, import.meta.url)) as {
    default: { init(registry: { use(key: string, strategy: unknown): void }, config: Record<string, unknown>): void | Promise<void> }
  }
  await plugin.init({ use: vi.fn() }, { ...configuration(kind), ...config })
  const request = { params: { strategy: 'organization' } }
  if (kind === 'oidc') {
    await verify(
      request,
      'issuer',
      { _json: { ...(names === undefined ? {} : { groups: names }), email: 'person@example.invalid', ...claims } },
      {},
      null,
      null,
      null,
      null,
      null,
      callback
    )
  } else if (kind === 'azure') {
    await verify(request, { claims: () => ({ ...(names === undefined ? {} : { groups: names }), email: 'person@example.invalid', sub: 'subject' }) }, callback)
  } else if (kind === 'oauth2') {
    await verify(
      request,
      'access-token',
      'refresh-token',
      { id: 'subject', email: 'person@example.invalid', ...(names === undefined ? {} : { groups: names }), ...claims },
      callback
    )
  } else if (kind === 'saml') {
    await verify(
      request,
      { uid: 'subject', email: 'person@example.invalid', name: 'Person', attributes: names === undefined ? {} : { memberOf: names }, ...claims },
      callback
    )
  } else {
    const groups = Array.isArray(names) ? names.map(cn => ({ cn })) : names
    await verify(
      request,
      { uid: 'subject', email: 'person@example.invalid', name: 'Person', ...(groups === undefined ? {} : { _groups: groups }), ...claims },
      callback
    )
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

const expectUnchangedMembership = async (): Promise<void> => {
  expect(await membershipNames()).toEqual(['Writers'])
  expect(await database('users').where({ id: 3 }).first()).toMatchObject({
    authVersion: 1,
    adminRevision: 'initial',
    sessionsRevokedAt: null
  })
  expect(await database('userAdministrationEvents').select()).toEqual([])
  expect(await database('groupAdministrationEvents').select()).toEqual([])
  expect(revokeUserTokens).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
  expect(user).toEqual({ id: 3, authVersion: 1, adminRevision: 'initial', groups: [{ id: 4, name: 'Writers' }] })
}

const expectCommittedMembership = async (added: number[], removed: number[]): Promise<void> => {
  const persisted = await database('users').where({ id: 3 }).first()
  expect(persisted?.authVersion).toBe(2)
  expect(persisted?.adminRevision).not.toBe('initial')
  expect(persisted?.sessionsRevokedAt).not.toBeNull()
  expect(user.authVersion).toBe(2)
  expect(user.adminRevision).toBe(persisted?.adminRevision)
  expect(Object.hasOwn(user, 'groups')).toBe(false)
  const events = await database('userAdministrationEvents').select()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ userId: 3, actorId: null, action: 'directory-groups-synchronized' })
  expect(JSON.parse(events[0].details)).toEqual({
    providerKey: 'organization',
    groupsAdded: added,
    groupsRemoved: removed,
    sessionsEnded: true
  })
  expect(await database('groupAdministrationEvents').orderBy('groupId').select('groupId', 'action')).toEqual(
    [...added.map(groupId => ({ groupId, action: 'members-added' })), ...removed.map(groupId => ({ groupId, action: 'members-removed' }))].sort(
      (left, right) => left.groupId - right.groupId
    )
  )
  expect(revokeUserTokens).toHaveBeenCalledTimes(1)
  expect(revokeUserTokens).toHaveBeenCalledWith({ id: 3, kind: 'u' })
  expect(emit).toHaveBeenCalledTimes(1)
  expect(emit).toHaveBeenCalledWith('addAuthRevoke', { id: 3, kind: 'u' })
}

describe('directory mapping protocol adapters', () => {
  for (const kind of ['ldap', 'oidc', 'saml', 'azure', 'oauth2']) {
    it(`${kind} persists the provider claim as current memberships`, async () => {
      const callback = vi.fn()
      await run(kind, ['Readers'], callback)

      expect(await membershipNames()).toEqual(['Readers'])
      await expectCommittedMembership([3], [4])
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0]?.[0]).toBeNull()
      expect(callback.mock.calls[0]?.[1]).toMatchObject({ id: 3, authVersion: 2 })
    })

    it(`${kind} leaves persisted memberships unchanged when the claim is absent`, async () => {
      const callback = vi.fn()
      await run(kind, undefined, callback)

      await expectUnchangedMembership()
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0]?.[0]).toBeNull()
    })

    it(`${kind} preserves versions, cached groups and sessions when the authoritative claim is unchanged`, async () => {
      const callback = vi.fn()
      await run(kind, ['Writers'], callback)

      await expectUnchangedMembership()
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0]?.[0]).toBeNull()
      expect(callback.mock.calls[0]?.[1]).toEqual(user)
    })

    for (const malformed of [
      { name: 'mixed non-string members', value: ['Readers', 7] },
      { name: 'null collection', value: null }
    ]) {
      it(`${kind} rejects ${malformed.name} without changing membership, revisions, events or sessions`, async () => {
        const callback = vi.fn()
        await run(kind, malformed.value, callback)

        expect(callback).toHaveBeenCalledTimes(1)
        expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error)
        expect(callback.mock.calls[0]?.[1] ?? null).toBeNull()
        if (kind !== 'ldap') expect(processProfile).not.toHaveBeenCalled()
        await expectUnchangedMembership()
      })
    }

    if (kind !== 'saml') {
      it(`${kind} rejects a scalar group claim instead of treating it as absent`, async () => {
        const callback = vi.fn()
        await run(kind, 'Readers', callback)

        expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error)
        expect(callback.mock.calls[0]?.[1] ?? null).toBeNull()
        if (kind !== 'ldap') expect(processProfile).not.toHaveBeenCalled()
        await expectUnchangedMembership()
      })
    }

    it(`${kind} clears persisted memberships for an explicitly empty claim`, async () => {
      const callback = vi.fn()
      await run(kind, [], callback)

      expect(await membershipNames()).toEqual([])
      await expectCommittedMembership([], [4])
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0]?.[0]).toBeNull()
    })

    it(`${kind} rejects sign-in and rolls back membership changes when synchronization fails`, async () => {
      await database.raw(`CREATE TRIGGER reject_membership_event BEFORE INSERT ON userAdministrationEvents
        BEGIN SELECT RAISE(ABORT, 'membership mapping failure'); END`)
      try {
        const callback = vi.fn()
        await run(kind, ['Readers'], callback)

        const failure = callback.mock.calls[0]?.[0]
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain('membership mapping failure')
        expect(callback).toHaveBeenCalledTimes(1)
        expect(callback.mock.calls[0]?.[1] ?? null).toBeNull()
        await expectUnchangedMembership()
      } finally {
        await database.raw('DROP TRIGGER reject_membership_event')
      }
    })
  }

  it('SAML accepts a scalar string as an authoritative membership claim', async () => {
    const callback = vi.fn()
    await run('saml', 'Readers', callback)

    expect(await membershipNames()).toEqual(['Readers'])
    await expectCommittedMembership([3], [4])
    expect(callback.mock.calls[0]?.[0]).toBeNull()
    expect(callback.mock.calls[0]?.[1]).toMatchObject({ id: 3, authVersion: 2 })
  })

  for (const fixture of [
    { name: 'a missing configured cn', groups: [{}] },
    { name: 'a missing cn among valid entries', groups: [{ cn: 'Readers' }, {}] },
    { name: 'a null entry', groups: [{ cn: 'Readers' }, null] }
  ]) {
    it(`LDAP rejects ${fixture.name} rather than dropping the entry`, async () => {
      const callback = vi.fn()
      await run('ldap', undefined, callback, {}, { _groups: fixture.groups })

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error)
      expect(callback.mock.calls[0]?.[1] ?? null).toBeNull()
      await expectUnchangedMembership()
    })
  }

  for (const fixture of [
    { name: 'a disabled provider', table: 'authentication', values: { isEnabled: false } },
    { name: 'an inactive account', table: 'users', values: { isActive: false } },
    { name: 'a system account', table: 'users', values: { isSystem: true } },
    { name: 'an account belonging to another provider', table: 'users', values: { providerKey: 'other-provider' } }
  ]) {
    it(`OAuth2 refuses ${fixture.name} without membership or session side effects`, async () => {
      await database(fixture.table).update(fixture.values)
      const callback = vi.fn()
      await run('oauth2', ['Readers'], callback)

      expect(callback).toHaveBeenCalledTimes(1)
      const failure = callback.mock.calls[0]?.[0]
      expect(failure).toBeInstanceOf(Error)
      if (!(failure instanceof Error)) throw new Error('Expected OAuth2 sign-in to fail with an Error')
      expect(failure.message).toContain('account or provider is unavailable')
      expect(callback.mock.calls[0]?.[1] ?? null).toBeNull()
      await expectUnchangedMembership()
    })
  }

  it('OAuth2 honors disabled mapping in the current persisted provider configuration', async () => {
    await database('authentication').update({ config: JSON.stringify({ mapGroups: false }) })
    const callback = vi.fn()
    await run('oauth2', ['Readers'], callback)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback.mock.calls[0]?.[0]).toBeNull()
    expect(callback.mock.calls[0]?.[1]).toEqual(user)
    await expectUnchangedMembership()
  })
})

describe('federated profile claim admission', () => {
  for (const kind of ['oidc', 'saml']) {
    it(`${kind} refuses unverified identities before account processing or membership writes`, async () => {
      for (const value of [undefined, false, 'false', 0, [], [true, false], [true, true]]) {
        processProfile.mockClear()
        const callback = vi.fn()
        await run(kind, ['Readers'], callback, { requireVerifiedEmail: true }, { email_verified: value })
        expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error)
        expect(processProfile).not.toHaveBeenCalled()
        expect(await membershipNames()).toEqual(['Writers'])
      }
    })

    it(`${kind} admits the exact supported verified-email representation`, async () => {
      const values = kind === 'oidc' ? [true] : [true, ' TRUE ', '1', ['true']]
      for (const value of values) {
        processProfile.mockClear()
        const callback = vi.fn()
        await run(
          kind,
          undefined,
          callback,
          { requireVerifiedEmail: true, [kind === 'oidc' ? 'verifiedEmailClaim' : 'mappingVerifiedEmail']: 'verified' },
          { verified: value }
        )
        expect(callback.mock.calls[0]?.[0]).toBeNull()
        expect(processProfile).toHaveBeenCalledTimes(1)
      }
    })
  }

  it('OIDC refuses truthy strings and numbers rather than coercing them', async () => {
    for (const value of ['true', '1', 1, [true]]) {
      processProfile.mockClear()
      const callback = vi.fn()
      await run('oidc', undefined, callback, { requireVerifiedEmail: true }, { email_verified: value })
      expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error)
      expect(processProfile).not.toHaveBeenCalled()
    }
  })

  it('OIDC reads authenticated ID-token claims when UserInfo is skipped', async () => {
    await run('oidc', undefined, vi.fn(), { requireVerifiedEmail: true, locationClaim: 'place', skipUserProfile: true })
    processProfile.mockClear()
    const callback = vi.fn()
    const payload = Buffer.from(
      JSON.stringify({ sub: 'subject', email: 'person@example.invalid', email_verified: true, place: 'London', groups: ['Readers'] })
    ).toString('base64url')
    await verify(
      { params: { strategy: 'organization' } },
      'issuer',
      undefined,
      { id: 'subject' },
      null,
      `header.${payload}.signature`,
      null,
      null,
      null,
      callback
    )
    expect(callback.mock.calls[0]?.[0]).toBeNull()
    expect(processProfile.mock.calls[0]?.[0].profile).toMatchObject({ email: 'person@example.invalid', providerProfile: { location: 'London' } })
    expect(await membershipNames()).toEqual(['Readers'])
    await expectCommittedMembership([3], [4])
  })

  for (const kind of ['oidc', 'saml', 'ldap']) {
    it(`${kind} projects only configured bounded profile text`, async () => {
      const mappings = kind === 'oidc' ? { locationClaim: 'place', jobTitleClaim: 'title' } : { mappingLocation: 'place', mappingJobTitle: 'title' }
      await run(kind, undefined, vi.fn(), mappings, { title: '', isSystem: true })
      expect(processProfile.mock.calls[0]?.[0].profile.providerProfile).toEqual({
        ...(kind === 'ldap' ? { location: '' } : {}),
        jobTitle: ''
      })
      processProfile.mockClear()
      await run(kind, undefined, vi.fn(), mappings, { place: 'x'.repeat(300), title: ' Editor ', isSystem: true })
      expect(processProfile.mock.calls[0]?.[0].profile.providerProfile).toEqual({ location: 'x'.repeat(255), jobTitle: 'Editor' })
      processProfile.mockClear()
      await run(kind, undefined, vi.fn(), {}, { location: 'Ignored', jobTitle: 'Ignored' })
      expect(processProfile.mock.calls[0]?.[0].profile.providerProfile).toEqual({})
    })
  }
})

describe('authenticated SAML empty profile attributes', () => {
  let privateKey: string
  let publicKey: string
  beforeAll(() => {
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    privateKey = keys.privateKey
    publicKey = keys.publicKey
  })

  const signedResponse = (attributes: string, extraStatement = '', verifiedEmail = 'true'): string => {
    const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response" Version="2.0" InResponseTo="_request" IssueInstant="2026-01-01T00:00:00Z">
      <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" ID="_assertion" Version="2.0" IssueInstant="2026-01-01T00:00:00Z">
        <saml:Issuer>https://identity.example.invalid</saml:Issuer>
        <saml:Subject><saml:NameID>subject</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData InResponseTo="_request" NotOnOrAfter="2099-01-01T00:00:00Z"/>
        </saml:SubjectConfirmation></saml:Subject>
        <saml:Conditions NotBefore="2020-01-01T00:00:00Z" NotOnOrAfter="2099-01-01T00:00:00Z"><saml:AudienceRestriction><saml:Audience>https://wiki.example.invalid</saml:Audience></saml:AudienceRestriction></saml:Conditions>
        <saml:AttributeStatement>
          <saml:Attribute Name="uid"><saml:AttributeValue>subject</saml:AttributeValue></saml:Attribute>
          <saml:Attribute Name="email"><saml:AttributeValue>person@example.invalid</saml:AttributeValue></saml:Attribute>
          <saml:Attribute Name="name"><saml:AttributeValue>Person</saml:AttributeValue></saml:Attribute>
          <saml:Attribute Name="picture"><saml:AttributeValue>https://wiki.example.invalid/avatar.png</saml:AttributeValue></saml:Attribute>
          <saml:Attribute Name="email_verified"><saml:AttributeValue>${verifiedEmail}</saml:AttributeValue></saml:Attribute>
          ${attributes}
        </saml:AttributeStatement>${extraStatement}
      </saml:Assertion>
    </samlp:Response>`
    const signature = new SignedXml({
      privateKey,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#'
    })
    signature.addReference({
      xpath: "//*[local-name()='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      inclusiveNamespacesPrefixList: ['xs']
    })
    signature.computeSignature(response, { location: { reference: "//*[local-name()='Issuer']", action: 'after' } })
    return signature.getSignedXml()
  }

  const parseSignedProfile = async (response: string): Promise<Profile> => {
    const requests = new Map([['_request', new Date().toISOString()]])
    const saml = new SAML({
      callbackUrl: 'https://wiki.example.invalid/login/organization/callback',
      issuer: 'https://wiki.example.invalid',
      idpCert: publicKey,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: SamlValidation.always,
      cacheProvider: {
        async saveAsync(key, value) {
          requests.set(key, value)
          return { value, createdAt: Date.now() }
        },
        async getAsync(key) {
          return requests.get(key) ?? null
        },
        async removeAsync(key) {
          const value = key === null ? null : (requests.get(key) ?? null)
          if (key !== null) requests.delete(key)
          return value
        }
      }
    })
    const result = await saml.validatePostResponseAsync({ SAMLResponse: Buffer.from(response).toString('base64') })
    if (!result.profile) throw new Error('Expected authenticated assertion profile.')
    return result.profile
  }

  const mappings = {
    requireVerifiedEmail: true,
    mappingLocation: 'place',
    mappingJobTitle: 'attributes["urn:example:jobTitle"]'
  }
  const jobTitleAttribute = (values: string): string => `<saml:Attribute Name="urn:example:jobTitle">${values}</saml:Attribute>`

  it('projects only one authenticated empty text value while preserving absent or ambiguous fields and unrelated claims', async () => {
    const stable = '<saml:Attribute Name="place"><saml:AttributeValue>London</saml:AttributeValue></saml:Attribute>'
    const empty = '<saml:AttributeValue xsi:type="xs:string"/>'
    const cases: { name: string; attribute: string; extra?: string; clears: boolean; present: boolean }[] = [
      { name: 'absent', attribute: '', clears: false, present: false },
      { name: 'single typed empty', attribute: jobTitleAttribute(empty), clears: true, present: true },
      { name: 'single untyped empty', attribute: jobTitleAttribute('<saml:AttributeValue/>'), clears: true, present: true },
      {
        name: 'single whitespace text',
        attribute: jobTitleAttribute('<saml:AttributeValue xsi:type="xs:string"> </saml:AttributeValue>'),
        clears: true,
        present: true
      },
      { name: 'multiple values', attribute: jobTitleAttribute(empty + empty), clears: false, present: true },
      { name: 'duplicate attributes', attribute: jobTitleAttribute(empty) + jobTitleAttribute(empty), clears: false, present: true },
      {
        name: 'duplicate statements',
        attribute: jobTitleAttribute(empty),
        extra: `<saml:AttributeStatement>${jobTitleAttribute(empty)}</saml:AttributeStatement>`,
        clears: false,
        present: true
      },
      { name: 'missing value', attribute: jobTitleAttribute(''), clears: false, present: false },
      { name: 'nil', attribute: jobTitleAttribute('<saml:AttributeValue xsi:nil="true" xsi:type="xs:string"/>'), clears: false, present: true },
      { name: 'nontext type', attribute: jobTitleAttribute('<saml:AttributeValue xsi:type="xs:integer"/>'), clears: false, present: true },
      { name: 'structured value', attribute: jobTitleAttribute('<saml:AttributeValue><saml:Other/></saml:AttributeValue>'), clears: false, present: true },
      {
        name: 'shadowed schema namespace',
        attribute: jobTitleAttribute('<saml:AttributeValue xmlns:xs="urn:not-schema" xsi:type="xs:string"/>'),
        clears: false,
        present: true
      },
      {
        name: 'nil whitespace CDATA',
        attribute: jobTitleAttribute('<saml:AttributeValue xsi:nil="true"><![CDATA[ ]]></saml:AttributeValue>'),
        clears: false,
        present: true
      }
    ]
    for (const fixture of cases) {
      processProfile.mockClear()
      const profile = await parseSignedProfile(signedResponse(stable + fixture.attribute, fixture.extra))
      expect(Object.hasOwn(profile.attributes as object, 'urn:example:jobTitle'), fixture.name).toBe(fixture.present)
      if (fixture.name === 'single typed empty') {
        // This is the installed parser's actual lost-character-property representation.
        expect(Object.hasOwn(profile, 'urn:example:jobTitle')).toBe(true)
        expect(profile['urn:example:jobTitle']).toBeUndefined()
        const parsed = profile.getAssertion?.() as {
          Assertion: { AttributeStatement: { Attribute: { $: { Name: string }; AttributeValue: object[] }[] }[] }
        }
        const value = parsed.Assertion.AttributeStatement[0]?.Attribute.find(attribute => attribute.$.Name === 'urn:example:jobTitle')?.AttributeValue[0]
        if (!value) throw new Error('Expected the authenticated empty AttributeValue.')
        // Assert scalars only: nested asymmetric matchers can mutate Bun's
        // dependency-owned assertion tree before the production consumer runs.
        expect(Object.hasOwn(value, '_')).toBe(false)
        const metadata = Reflect.get(value, '$') as Record<string, string>
        expect(metadata['xsi:type']).toBe('xs:string')
      }
      const callback = vi.fn()
      await run('saml', undefined, callback, mappings, profile)
      expect(callback.mock.calls[0]?.[0], fixture.name).toBeNull()
      expect(processProfile.mock.calls[0]?.[0], fixture.name).toEqual({
        providerKey: 'organization',
        profile: {
          id: 'subject',
          email: 'person@example.invalid',
          displayName: 'Person',
          picture: 'https://wiki.example.invalid/avatar.png',
          providerProfile: { location: 'London', ...(fixture.clears ? { jobTitle: '' } : {}) }
        }
      })
      expect(await membershipNames()).toEqual(['Writers'])
    }
  })

  it('clears both configured text columns and still rejects unverified or tampered assertions', async () => {
    const response = signedResponse(
      '<saml:Attribute Name="place"><saml:AttributeValue xsi:type="xs:string"/></saml:Attribute>' +
        jobTitleAttribute('<saml:AttributeValue xsi:type="xs:string"/>')
    )
    const profile = await parseSignedProfile(response)
    const callback = vi.fn()
    await run('saml', undefined, callback, mappings, profile)
    expect(callback.mock.calls[0]?.[0]).toBeNull()
    expect(processProfile.mock.calls[0]?.[0].profile.providerProfile).toEqual({ location: '', jobTitle: '' })

    await expect(parseSignedProfile(response.replace('person@example.invalid', 'attacker@example.invalid'))).rejects.toThrow('Invalid signature')
    const unverifiedResponse = signedResponse(jobTitleAttribute('<saml:AttributeValue/>'), '', 'false')
    processProfile.mockClear()
    const rejected = vi.fn()
    await run('saml', ['Readers'], rejected, mappings, await parseSignedProfile(unverifiedResponse))
    expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(processProfile).not.toHaveBeenCalled()
    expect(await membershipNames()).toEqual(['Writers'])
  })
})
