import { afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { decryptWebhookSecret, encryptWebhookSecret } from '../../core/webhooks.ts'
import { DateTime } from 'luxon'

const originalWiki = globalThis.WIKI
const load = async () => await vi.importFresh('../../core/auth.ts', import.meta.url)
interface AuthUtilities {
  activateStrategies(strict?: boolean): Promise<void>
  regenerateCertificates(): Promise<{ revokedApiKeys: number }>
  reloadApiKeys(): Promise<void>
}

afterAll(() => {
  globalThis.WIKI = originalWiki
})

describe('authentication certificate rotation', () => {
  interface SettingsRow {
    key: string
    value: Record<string, unknown>
    updatedAt: string
  }
  interface ApiKeyRow {
    id: number
    isRevoked: boolean
    updatedAt: string
  }
  let settingsRows: SettingsRow[]
  let apiKeys: ApiKeyRow[]
  let settingsInsertKey: string | undefined
  let settingsConflictColumn: keyof SettingsRow | undefined
  let activate: ((strict?: boolean) => Promise<void>) & { mock?: unknown }
  let reloadApiKeys: (() => Promise<void>) & { mock?: unknown }
  let auth: AuthUtilities
  const encryptionRoot = 'preserved-encryption-root'

  beforeEach(async () => {
    settingsRows = [{ key: 'certs', value: { public: 'old-public', private: 'old-private' }, updatedAt: 'before-rotation' }]
    apiKeys = [
      { id: 7, isRevoked: false, updatedAt: 'before-rotation' },
      { id: 8, isRevoked: false, updatedAt: 'before-rotation' },
      { id: 9, isRevoked: true, updatedAt: 'already-revoked' }
    ]
    settingsInsertKey = undefined
    settingsConflictColumn = undefined
    activate = vi.fn(async () => undefined)
    reloadApiKeys = vi.fn(async () => undefined)
    globalThis.WIKI = {
      config: {
        api: { isEnabled: true },
        auth: { audience: 'urn:test', tokenExpiration: '30m', tokenRenewal: '15m' },
        certs: { public: 'old-public', private: 'old-private' },
        features: { featurePageComments: false },
        host: 'https://wiki.example.invalid',
        sessionSecret: encryptionRoot
      },
      startedAt: DateTime.utc(),
      configSvc: { saveToDb: vi.fn(async () => false) },
      events: { inbound: { on: vi.fn() }, outbound: { emit: vi.fn() } },
      lang: { t: vi.fn() },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      models: {
        knex: {
          transaction: async (work: (tx: (table: string) => unknown) => Promise<unknown>) =>
            await work((table: string) => {
              if (table === 'settings') {
                return {
                  insert: (inserted: SettingsRow) => {
                    settingsInsertKey = inserted.key
                    return {
                      onConflict: (column: keyof SettingsRow) => {
                        settingsConflictColumn = column
                        return {
                          merge: async (changes: Partial<SettingsRow>) => {
                            const existing = settingsRows.find(row => row[column] === inserted[column])
                            if (existing) Object.assign(existing, structuredClone(changes))
                            else settingsRows.push(structuredClone(inserted))
                          }
                        }
                      }
                    }
                  }
                }
              }
              if (table === 'apiKeys') {
                return {
                  where: (column: keyof ApiKeyRow, value: ApiKeyRow[keyof ApiKeyRow]) => ({
                    update: async (changes: Partial<ApiKeyRow>, returning: (keyof ApiKeyRow)[]) => {
                      const affected = apiKeys.filter(row => row[column] === value)
                      for (const row of affected) Object.assign(row, changes)
                      return affected.map(row => Object.fromEntries(returning.map(key => [key, row[key]])))
                    }
                  })
                }
              }
              throw new Error(`Unexpected table ${table}`)
            })
        }
      }
    } as never
    auth = (await load()).default
    auth.activateStrategies = activate as never
    auth.reloadApiKeys = reloadApiKeys as never
  })

  it('rotates only signing material, revokes all affected keys, and does not rely on the non-transactional settings writer', async () => {
    const encrypted = encryptWebhookSecret('fixture-webhook-secret', encryptionRoot)

    const result = await auth.regenerateCertificates()

    expect(result).toEqual({ revokedApiKeys: 2 })
    expect(apiKeys.filter(row => row.id === 7 || row.id === 8).map(row => ({ id: row.id, isRevoked: row.isRevoked }))).toEqual([
      { id: 7, isRevoked: true },
      { id: 8, isRevoked: true }
    ])
    expect(apiKeys.find(row => row.id === 9)).toEqual({ id: 9, isRevoked: true, updatedAt: 'already-revoked' })
    expect(settingsInsertKey).toBe('certs')
    expect(settingsConflictColumn).toBe('key')
    const savedCertificates = settingsRows.find(row => row.key === 'certs')?.value
    expect(globalThis.WIKI.config.sessionSecret).toBe(encryptionRoot)
    expect(decryptWebhookSecret(encrypted, globalThis.WIKI.config.sessionSecret)).toBe('fixture-webhook-secret')
    expect(savedCertificates).toMatchObject({
      public: expect.stringContaining('BEGIN RSA PUBLIC KEY'),
      private: expect.stringContaining('BEGIN RSA PRIVATE KEY')
    })
    expect(globalThis.WIKI.config.certs).toEqual(savedCertificates)
    expect(globalThis.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledWith(true)
    expect(reloadApiKeys).toHaveBeenCalledOnce()
  })

  it('does not publish generated signing material or activate it when the durable transaction fails', async () => {
    const previous = globalThis.WIKI.config.certs
    globalThis.WIKI.models.knex.transaction = async () => {
      throw new Error('settings write failed')
    }

    await expect(auth.regenerateCertificates()).rejects.toThrow('settings write failed')

    expect(globalThis.WIKI.config.certs).toBe(previous)
    expect(activate).not.toHaveBeenCalled()
    expect(reloadApiKeys).not.toHaveBeenCalled()
  })
})
