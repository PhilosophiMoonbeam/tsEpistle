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

const run = async (
  kind: string,
  names: string[] | undefined,
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
    await verify(request, 'issuer', { _json: { groups: names, email: 'person@example.invalid', ...claims } }, {}, null, null, null, null, null, callback)
  } else if (kind === 'azure') {
    await verify(request, { claims: () => ({ groups: names, email: 'person@example.invalid', sub: 'subject' }) }, callback)
  } else if (kind === 'saml') {
    await verify(request, { uid: 'subject', email: 'person@example.invalid', name: 'Person', attributes: { memberOf: names }, ...claims }, callback)
  } else {
    await verify(request, { uid: 'subject', email: 'person@example.invalid', name: 'Person', _groups: names?.map(cn => ({ cn })), ...claims }, callback)
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

        const failure = callback.mock.calls[0]?.[0]
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain('membership mapping failure')
        expect(await membershipNames()).toEqual(['Writers'])
        expect(await database('users').where({ id: 3 }).first()).toMatchObject({ authVersion: 1, adminRevision: 'initial' })
      } finally {
        await database.raw('DROP TRIGGER reject_membership_event')
      }
    })
  }
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
    await run('oidc', undefined, vi.fn(), { requireVerifiedEmail: true, pronounsClaim: 'pronouns', skipUserProfile: true })
    processProfile.mockClear()
    const callback = vi.fn()
    const payload = Buffer.from(JSON.stringify({ sub: 'subject', email: 'person@example.invalid', email_verified: true, pronouns: 'they/them' })).toString(
      'base64url'
    )
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
    expect(processProfile.mock.calls[0]?.[0].profile).toMatchObject({ email: 'person@example.invalid', providerProfile: { pronouns: 'they/them' } })
  })

  for (const kind of ['oidc', 'saml', 'ldap']) {
    it(`${kind} projects only configured bounded profile text`, async () => {
      const mappings =
        kind === 'oidc'
          ? { locationClaim: 'place', jobTitleClaim: 'title', pronounsClaim: 'pronouns' }
          : { mappingLocation: 'place', mappingJobTitle: 'title', mappingPronouns: 'pronouns' }
      await run(kind, undefined, vi.fn(), mappings, { title: '', pronouns: 'x'.repeat(300), isSystem: true })
      expect(processProfile.mock.calls[0]?.[0].profile.providerProfile).toEqual({
        ...(kind === 'ldap' ? { location: '' } : {}),
        jobTitle: '',
        pronouns: 'x'.repeat(255)
      })
      processProfile.mockClear()
      await run(kind, undefined, vi.fn(), {}, { location: 'Ignored', jobTitle: 'Ignored', pronouns: 'Ignored' })
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
    mappingJobTitle: 'attributes.title',
    mappingPronouns: 'attributes["urn:example:pronouns"]'
  }
  const pronounsAttribute = (values: string): string => `<saml:Attribute Name="urn:example:pronouns">${values}</saml:Attribute>`

  it('projects only one authenticated empty text value while preserving absent or ambiguous fields and unrelated claims', async () => {
    const stable =
      '<saml:Attribute Name="place"><saml:AttributeValue>London</saml:AttributeValue></saml:Attribute><saml:Attribute Name="title"><saml:AttributeValue>Editor</saml:AttributeValue></saml:Attribute>'
    const empty = '<saml:AttributeValue xsi:type="xs:string"/>'
    const cases: { name: string; attribute: string; extra?: string; clears: boolean; present: boolean }[] = [
      { name: 'absent', attribute: '', clears: false, present: false },
      { name: 'single typed empty', attribute: pronounsAttribute(empty), clears: true, present: true },
      { name: 'single untyped empty', attribute: pronounsAttribute('<saml:AttributeValue/>'), clears: true, present: true },
      {
        name: 'single whitespace text',
        attribute: pronounsAttribute('<saml:AttributeValue xsi:type="xs:string"> </saml:AttributeValue>'),
        clears: true,
        present: true
      },
      { name: 'multiple values', attribute: pronounsAttribute(empty + empty), clears: false, present: true },
      { name: 'duplicate attributes', attribute: pronounsAttribute(empty) + pronounsAttribute(empty), clears: false, present: true },
      {
        name: 'duplicate statements',
        attribute: pronounsAttribute(empty),
        extra: `<saml:AttributeStatement>${pronounsAttribute(empty)}</saml:AttributeStatement>`,
        clears: false,
        present: true
      },
      { name: 'missing value', attribute: pronounsAttribute(''), clears: false, present: false },
      { name: 'nil', attribute: pronounsAttribute('<saml:AttributeValue xsi:nil="true" xsi:type="xs:string"/>'), clears: false, present: true },
      { name: 'nontext type', attribute: pronounsAttribute('<saml:AttributeValue xsi:type="xs:integer"/>'), clears: false, present: true },
      { name: 'structured value', attribute: pronounsAttribute('<saml:AttributeValue><saml:Other/></saml:AttributeValue>'), clears: false, present: true },
      {
        name: 'shadowed schema namespace',
        attribute: pronounsAttribute('<saml:AttributeValue xmlns:xs="urn:not-schema" xsi:type="xs:string"/>'),
        clears: false,
        present: true
      },
      {
        name: 'nil whitespace CDATA',
        attribute: pronounsAttribute('<saml:AttributeValue xsi:nil="true"><![CDATA[ ]]></saml:AttributeValue>'),
        clears: false,
        present: true
      }
    ]
    for (const fixture of cases) {
      processProfile.mockClear()
      const profile = await parseSignedProfile(signedResponse(stable + fixture.attribute, fixture.extra))
      expect(Object.hasOwn(profile.attributes as object, 'urn:example:pronouns'), fixture.name).toBe(fixture.present)
      if (fixture.name === 'single typed empty') {
        // This is the installed parser's actual lost-character-property representation.
        expect(Object.hasOwn(profile, 'urn:example:pronouns')).toBe(true)
        expect(profile['urn:example:pronouns']).toBeUndefined()
        const parsed = profile.getAssertion?.() as {
          Assertion: { AttributeStatement: { Attribute: { $: { Name: string }; AttributeValue: object[] }[] }[] }
        }
        const value = parsed.Assertion.AttributeStatement[0]?.Attribute.find(attribute => attribute.$.Name === 'urn:example:pronouns')?.AttributeValue[0]
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
          providerProfile: { location: 'London', jobTitle: 'Editor', ...(fixture.clears ? { pronouns: '' } : {}) }
        }
      })
      expect(await membershipNames()).toEqual(['Writers'])
    }
  })

  it('clears all three configured text columns and still rejects unverified or tampered assertions', async () => {
    const response = signedResponse(
      '<saml:Attribute Name="place"><saml:AttributeValue xsi:type="xs:string"/></saml:Attribute><saml:Attribute Name="title"><saml:AttributeValue xsi:type="xs:string"/></saml:Attribute>' +
        pronounsAttribute('<saml:AttributeValue xsi:type="xs:string"/>')
    )
    const profile = await parseSignedProfile(response)
    const callback = vi.fn()
    await run('saml', undefined, callback, mappings, profile)
    expect(callback.mock.calls[0]?.[0]).toBeNull()
    expect(processProfile.mock.calls[0]?.[0].profile.providerProfile).toEqual({ location: '', jobTitle: '', pronouns: '' })

    await expect(parseSignedProfile(response.replace('person@example.invalid', 'attacker@example.invalid'))).rejects.toThrow('Invalid signature')
    const unverifiedResponse = signedResponse(pronounsAttribute('<saml:AttributeValue/>'), '', 'false')
    processProfile.mockClear()
    const rejected = vi.fn()
    await run('saml', ['Readers'], rejected, mappings, await parseSignedProfile(unverifiedResponse))
    expect(rejected.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(processProfile).not.toHaveBeenCalled()
    expect(await membershipNames()).toEqual(['Writers'])
  })
})
