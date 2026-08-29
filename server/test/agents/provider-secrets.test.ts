import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import { DatabaseAgentSecretRegistry, decodeAgentProviderSecretKeys } from '../../agents/providers/secrets.ts'

const keyring = { currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 11) } }

describe('encrypted provider secret vault', () => {
  let db: Knex
  let vault: DatabaseAgentSecretRegistry

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentProviderSecrets', table => {
      table.string('id').primary()
      table.string('keyId').notNullable()
      table.string('algorithm').notNullable()
      table.binary('nonce').notNullable()
      table.binary('ciphertext').notNullable()
      table.binary('authTag').notNullable()
      table.integer('createdBy').notNullable()
      table.dateTime('createdAt').notNullable()
    })
    vault = new DatabaseAgentSecretRegistry(db, keyring)
  })

  afterEach(async () => db.destroy())

  it('encrypts credentials with unique nonces and authenticated record identity', async () => {
    const first = await db.transaction(transaction => vault.store('same-provider-key', 7, transaction))
    const second = await db.transaction(transaction => vault.store('same-provider-key', 7, transaction))
    const rows = await db('agentProviderSecrets').orderBy('createdAt').select('id', 'keyId', 'algorithm', 'nonce', 'ciphertext', 'authTag') as Array<Record<string, Buffer | string>>

    expect(first).toMatch(/^managed:/)
    expect(second).toMatch(/^managed:/)
    expect(first).not.toBe(second)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.keyId).toBe('primary')
    expect(rows[0]?.algorithm).toBe('aes-256-gcm')
    expect(Buffer.from(rows[0]?.nonce ?? '')).not.toEqual(Buffer.from(rows[1]?.nonce ?? ''))
    expect(Buffer.from(rows[0]?.ciphertext ?? '').toString('utf8')).not.toContain('same-provider-key')
    expect(await vault.get(first)).toBe('same-provider-key')
    expect(await vault.get(second)).toBe('same-provider-key')
  })

  it('fails closed for tampering, missing keys, invalid references, and rolled-back writes', async () => {
    const reference = await db.transaction(transaction => vault.store('provider-key', 7, transaction))
    const id = reference.slice('managed:'.length)
    await db('agentProviderSecrets').where({ id }).update({ authTag: Buffer.alloc(16, 1) })
    await expect(Promise.resolve(vault.get(reference))).rejects.toMatchObject({ code: 'PROVIDER_SECRET_DECRYPTION_FAILED', status: 503 })

    const missingKeyVault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'replacement', keys: { replacement: Buffer.alloc(32, 12) } })
    await expect(Promise.resolve(missingKeyVault.get(reference))).rejects.toMatchObject({ code: 'PROVIDER_SECRET_KEY_UNAVAILABLE', status: 503 })
    expect(await vault.get('managed:not-a-uuid')).toBeNull()

    await expect(Promise.resolve(db.transaction(async transaction => {
      await vault.store('rolled-back-key', 7, transaction)
      throw new Error('rollback')
    }))).rejects.toThrow('rollback')
    expect(await db('agentProviderSecrets').count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 1 })
  })

  it('requires a valid current 256-bit encryption key', () => {
    const encoded = JSON.stringify({ currentKeyId: 'primary', keys: { primary: Buffer.alloc(32, 3).toString('base64') } })
    expect(decodeAgentProviderSecretKeys(encoded)).toMatchObject({ currentKeyId: 'primary' })
    expect(() => decodeAgentProviderSecretKeys(JSON.stringify({ currentKeyId: 'primary', keys: { primary: Buffer.alloc(31).toString('base64') } }))).toThrow(/exactly 32/)
    expect(() => decodeAgentProviderSecretKeys(JSON.stringify({ currentKeyId: 'missing', keys: { primary: Buffer.alloc(32).toString('base64') } }))).toThrow(/currentKeyId/)
  })
})
