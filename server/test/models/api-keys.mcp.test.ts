import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { JwtPayload } from 'jsonwebtoken'
import type ApiKeyModel from '../../models/apiKeys.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const createCredentials = (passphrase: string) => ({
  ...generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
  }),
  passphrase
})

// Generate once per process; neither credentials nor a JWT come from a signing mock.
const staleCredentials = createCredentials('stale-test-passphrase')
const currentCredentials = createCredentials('current-test-passphrase')

describe('service API-key issuance', () => {
  let previousWiki: PropertyDescriptor | undefined

  beforeEach(() => {
    previousWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
  })

  afterEach(() => {
    if (previousWiki) Object.defineProperty(globalThis, 'WIKI', previousWiki)
    else Reflect.deleteProperty(globalThis, 'WIKI')
  })

  it.each([
    { fullAccess: false, expectedGroup: 3 },
    { fullAccess: true, expectedGroup: 1 }
  ])('issues only the service grant with fullAccess=$fullAccess from the current runtime', async ({ fullAccess, expectedGroup }) => {
    type PendingKey = { name: string; key: string; expiration: string; isRevoked: boolean }
    type Write = { kind: 'insert'; row: PendingKey } | { kind: 'activate'; id: number; changes: { key: string; isRevoked: boolean } }
    const writes: Write[] = []
    const query = vi.fn(() => ({
      insert: async (row: PendingKey) => {
        writes.push({ kind: 'insert', row: { ...row } })
        return { id: 17 }
      },
      findById: (id: number) => ({
        patch: async (changes: { key: string; isRevoked: boolean }) => {
          writes.push({ kind: 'activate', id, changes: { ...changes } })
        }
      })
    }))
    // Both runtimes expose the same persistence boundary so a captured runtime
    // fails on its real signing credentials/audience, not an unrelated mock.
    Reflect.set(globalThis, 'WIKI', {
      config: {
        agents: { mcp: { enabled: false } },
        auth: { audience: 'urn:wiki:stale' },
        certs: { private: staleCredentials.privateKey },
        host: 'https://stale.example.test',
        sessionSecret: staleCredentials.passphrase
      },
      models: { apiKeys: { query } }
    })
    const ApiKey = (await vi.importFresh<{ default: typeof ApiKeyModel }>('../../models/apiKeys.ts', import.meta.url)).default
    Reflect.set(globalThis, 'WIKI', {
      config: {
        agents: { mcp: { enabled: true } },
        auth: { audience: 'urn:wiki:test' },
        certs: { private: currentCredentials.privateKey },
        host: 'https://docs.example.co.uk',
        sessionSecret: currentCredentials.passphrase
      },
      models: { apiKeys: { query } }
    })

    const startedAt = Date.now()
    const key = await ApiKey.createNewKey({ name: 'Service', expiration: '1h', fullAccess, group: 3 })
    const finishedAt = Date.now()
    const verified = jwt.verify(key, currentCredentials.publicKey, {
      algorithms: ['RS256'],
      audience: 'urn:wiki:test',
      issuer: 'urn:wiki.js',
      clockTimestamp: Math.floor(finishedAt / 1000),
      complete: true
    })
    expect(verified.header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(verified.payload).toEqual({
      api: 17,
      grp: expectedGroup,
      aud: 'urn:wiki:test',
      iss: 'urn:wiki.js',
      iat: expect.any(Number),
      exp: expect.any(Number)
    })
    // Exact claims above exclude personalMcp, personalOwnerId, personalAccess,
    // mcpResource and mcpResourceVersion, even for the full-access service group.
    const claims = verified.payload as JwtPayload
    expect(claims.iat).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000))
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(finishedAt / 1000))
    expect(claims.exp).toBe(claims.iat! + 3600)
    expect(() =>
      jwt.verify(key, currentCredentials.publicKey, {
        algorithms: ['RS256'],
        audience: 'urn:wiki:test',
        issuer: 'urn:wiki.js',
        clockTimestamp: claims.exp
      })
    ).toThrow(jwt.TokenExpiredError)

    expect(writes).toEqual([
      {
        kind: 'insert',
        row: { name: 'Service', key: 'pending', expiration: expect.any(String), isRevoked: true }
      },
      { kind: 'activate', id: 17, changes: { key, isRevoked: false } }
    ])
    const pending = writes[0]
    if (pending?.kind !== 'insert') throw new Error('Missing pending service credential')
    expect(Date.parse(pending.row.expiration)).toBeGreaterThanOrEqual(startedAt + 3_600_000)
    expect(Date.parse(pending.row.expiration)).toBeLessThanOrEqual(finishedAt + 3_600_000)
  })
})
