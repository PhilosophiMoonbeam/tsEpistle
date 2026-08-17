import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Knex } from 'knex'
import { z } from 'zod'
import { AgentRepositoryError } from '../repository.ts'

const MAX_SECRET_BYTES = 64 * 1_024
const KEY_BYTES = 32
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const ENVIRONMENT_REFERENCE_PATTERN = /^env:([A-Z][A-Z0-9_]{0,127})$/
const MANAGED_REFERENCE_PATTERN = /^managed:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const KEYRING_SCHEMA = z.strictObject({ currentKeyId: z.string(), keys: z.record(z.string(), z.string()) })

export interface AgentProviderSecretKeys {
  readonly currentKeyId: string
  readonly keys: Readonly<Record<string, Uint8Array>>
}

export interface AgentSecretRegistry {
  has(reference: string): boolean | Promise<boolean>
  get(reference: string): string | null | Promise<string | null>
  store(value: string, actorId: number, transaction: Knex | Knex.Transaction): string | Promise<string>
}

interface SecretRow {
  readonly id: string
  readonly keyId: string
  readonly algorithm: string
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authTag: Uint8Array
}

export const environmentSecretValue = (name: string): string | null => {
  const inlineValue = process.env[name]
  if (inlineValue !== undefined && inlineValue.length > 0) return inlineValue
  const filePath = process.env[`${name}_FILE`]
  if (!filePath) return null
  const bytes = readFileSync(filePath)
  if (bytes.byteLength > MAX_SECRET_BYTES) throw new Error(`${name}_FILE exceeds the 64 KiB secret limit`)
  const fileValue = bytes.toString('utf8').trim()
  return fileValue.length > 0 ? fileValue : null
}

export const decodeAgentProviderSecretKeys = (encoded: string): AgentProviderSecretKeys => {
  let parsed: z.infer<typeof KEYRING_SCHEMA>
  try {
    parsed = KEYRING_SCHEMA.parse(JSON.parse(encoded))
  } catch {
    throw new Error('AGENT_PROVIDER_SECRET_KEYS must be a JSON keyring')
  }
  if (!KEY_ID_PATTERN.test(parsed.currentKeyId) || !Object.keys(parsed.keys).every(keyId => KEY_ID_PATTERN.test(keyId))) throw new Error('AGENT_PROVIDER_SECRET_KEYS contains an invalid key ID')
  const keys = Object.fromEntries(Object.entries(parsed.keys).map(([keyId, value]) => [keyId, Buffer.from(value, 'base64')]))
  if (!keys[parsed.currentKeyId] || Object.values(keys).some(key => key.byteLength !== KEY_BYTES)) throw new Error('Every AGENT_PROVIDER_SECRET_KEYS key must contain exactly 32 base64-encoded bytes and include currentKeyId')
  return { currentKeyId: parsed.currentKeyId, keys }
}

const aad = (id: string): Buffer => Buffer.from(`wiki-agent-provider-secret:v1:${id}`, 'utf8')
const managedId = (reference: string): string | null => MANAGED_REFERENCE_PATTERN.exec(reference)?.[1] ?? null

export class DatabaseAgentSecretRegistry implements AgentSecretRegistry {
  readonly #knex: Knex
  readonly #keys: AgentProviderSecretKeys

  constructor (knex: Knex, keys: AgentProviderSecretKeys) {
    this.#knex = knex
    this.#keys = keys
  }

  async has(reference: string): Promise<boolean> {
    const environmentName = ENVIRONMENT_REFERENCE_PATTERN.exec(reference)?.[1]
    if (environmentName) return environmentSecretValue(environmentName) !== null
    const id = managedId(reference)
    if (!id) return false
    const row = await this.#knex<SecretRow>('agentProviderSecrets').where({ id }).first('keyId', 'algorithm', 'nonce', 'authTag')
    return row?.algorithm === 'aes-256-gcm' && this.#keys.keys[row.keyId] !== undefined && Buffer.from(row.nonce).byteLength === NONCE_BYTES && Buffer.from(row.authTag).byteLength === AUTH_TAG_BYTES
  }

  async get(reference: string): Promise<string | null> {
    const environmentName = ENVIRONMENT_REFERENCE_PATTERN.exec(reference)?.[1]
    if (environmentName) return environmentSecretValue(environmentName)
    const id = managedId(reference)
    if (!id) return null
    const row = await this.#knex<SecretRow>('agentProviderSecrets').where({ id }).first()
    if (!row || row.algorithm !== 'aes-256-gcm') return null
    const key = this.#keys.keys[row.keyId]
    if (!key) throw new AgentRepositoryError('PROVIDER_SECRET_KEY_UNAVAILABLE', 'Provider credential encryption key is unavailable', 503)
    let plaintext: Buffer | undefined
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce, { authTagLength: AUTH_TAG_BYTES })
      decipher.setAAD(aad(id))
      decipher.setAuthTag(row.authTag)
      plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()])
      if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SECRET_BYTES) throw new Error('invalid plaintext length')
      return plaintext.toString('utf8')
    } catch {
      throw new AgentRepositoryError('PROVIDER_SECRET_DECRYPTION_FAILED', 'Provider credential could not be decrypted', 503)
    } finally {
      plaintext?.fill(0)
    }
  }

  async store(value: string, actorId: number, transaction: Knex | Knex.Transaction): Promise<string> {
    const plaintext = Buffer.from(value, 'utf8')
    if (value.trim() !== value || plaintext.byteLength === 0 || plaintext.byteLength > MAX_SECRET_BYTES || value.includes('\0')) {
      plaintext.fill(0)
      throw new AgentRepositoryError('INVALID_PROVIDER_SECRET', 'Provider credential must contain 1 to 65536 bytes without surrounding whitespace', 400)
    }
    try {
      const id = randomUUID()
      const keyId = this.#keys.currentKeyId
      const key = this.#keys.keys[keyId]
      if (!key) throw new AgentRepositoryError('PROVIDER_SECRET_KEY_UNAVAILABLE', 'Provider credential encryption key is unavailable', 503)
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES })
      cipher.setAAD(aad(id))
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const authTag = cipher.getAuthTag()
      await transaction('agentProviderSecrets').insert({ id, keyId, algorithm: 'aes-256-gcm', nonce, ciphertext, authTag, createdBy: actorId, createdAt: new Date() })
      return `managed:${id}`
    } finally {
      plaintext.fill(0)
    }
  }
}
