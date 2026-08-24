import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'

import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError } from './repository.ts'

export const AGENT_MEMORY_LIMITS = {
  agent: 2_200,
  user: 1_375
} as const

export type AgentMemoryTarget = keyof typeof AGENT_MEMORY_LIMITS

export interface AgentMemoryEntry {
  readonly id: string
  readonly target: AgentMemoryTarget
  readonly content: string
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AgentMemoryStoreView {
  readonly entries: readonly AgentMemoryEntry[]
  readonly characters: number
  readonly limit: number
}

export interface AgentMemoryView {
  readonly agent: AgentMemoryStoreView
  readonly user: AgentMemoryStoreView
}

export interface AgentMemorySnapshot {
  readonly agent: readonly string[]
  readonly user: readonly string[]
}

export interface AgentMemoryMutationResult {
  readonly changed: boolean
  readonly message: string
  readonly target: AgentMemoryTarget
  readonly entries: readonly string[]
  readonly characters: number
  readonly limit: number
}

interface MemoryRow {
  id: string
  ownerId: number
  target: string
  content: string
  contentSha256: string
  version: number
  createdAt: Date | string
  updatedAt: Date | string
}

const TargetSchema = z.enum(['agent', 'user'])
const SnapshotSchema = z.strictObject({
  agent: z.array(z.string().min(1).max(AGENT_MEMORY_LIMITS.agent)).max(64),
  user: z.array(z.string().min(1).max(AGENT_MEMORY_LIMITS.user)).max(64)
})
const ENTRY_SEPARATOR = '\n§\n'
const ROLE_FENCE = /<\/?\s*(?:system|developer|assistant|tool|memory-context)\b/iu
const OVERRIDE_LANGUAGE = /\b(?:ignore|disregard|override)\b.{0,80}\b(?:instructions?|system prompt|polic(?:y|ies))\b/isu
const EMBEDDED_SECRET = /\b(?:api[ _-]?key|password|secret|bearer token)\b\s*[:=]\s*\S+/iu

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const characterCount = (entries: readonly string[]): number => entries.length === 0 ? 0 : entries.join(ENTRY_SEPARATOR).length
const iso = (value: Date | string): string => new Date(value).toISOString()
const containsForbiddenUnicode = (value: string): boolean => [...value].some(character => {
  const code = character.codePointAt(0) ?? 0
  return code <= 8 ||
    code === 11 ||
    code === 12 ||
    (code >= 14 && code <= 31) ||
    code === 127 ||
    (code >= 0x200B && code <= 0x200F) ||
    (code >= 0x202A && code <= 0x202E) ||
    (code >= 0x2060 && code <= 0x206F) ||
    code === 0xFEFF
})

const normalizeContent = (target: AgentMemoryTarget, value: string): string => {
  const content = value.trim()
  if (!content) throw new AgentRepositoryError('INVALID_AGENT_MEMORY', 'Memory content cannot be empty', 400)
  if (content.length > AGENT_MEMORY_LIMITS[target]) throw new AgentRepositoryError('INVALID_AGENT_MEMORY', 'Memory entry exceeds its store capacity', 400)
  if (containsForbiddenUnicode(content) || ROLE_FENCE.test(content) || OVERRIDE_LANGUAGE.test(content) || EMBEDDED_SECRET.test(content)) {
    throw new AgentRepositoryError('UNSAFE_AGENT_MEMORY', 'Memory content contains instruction-like, invisible, or secret-bearing text and was not saved', 400)
  }
  return content
}

const target = (value: string): AgentMemoryTarget => TargetSchema.parse(value)
const record = (row: MemoryRow): AgentMemoryEntry => ({
  id: row.id,
  target: target(row.target),
  content: row.content,
  version: Number(row.version),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt)
})

const assertCapacity = (targetValue: AgentMemoryTarget, entries: readonly string[]): number => {
  const characters = characterCount(entries)
  const limit = AGENT_MEMORY_LIMITS[targetValue]
  if (characters > limit) {
    throw new AgentRepositoryError('AGENT_MEMORY_FULL', `Memory is at ${characters.toLocaleString()}/${limit.toLocaleString()} characters. Consolidate or remove an entry before saving.`, 409)
  }
  return characters
}

const lockOwner = async (transaction: Knex.Transaction, ownerId: number): Promise<void> => {
  const owner = await transaction('users').where({ id: ownerId }).forUpdate().first('id')
  if (!owner) throw new AgentRepositoryError('AUTHENTICATION_REQUIRED', 'Agent user is unavailable', 401)
}

const rowsFor = (knex: Knex | Knex.Transaction, ownerId: number): Promise<MemoryRow[]> => knex<MemoryRow>('agentMemories')
  .where({ ownerId })
  .orderBy('target')
  .orderBy('createdAt')
  .orderBy('id')

const storeView = (entries: readonly AgentMemoryEntry[], targetValue: AgentMemoryTarget): AgentMemoryStoreView => {
  const filtered = entries.filter(entry => entry.target === targetValue)
  return { entries: filtered, characters: characterCount(filtered.map(entry => entry.content)), limit: AGENT_MEMORY_LIMITS[targetValue] }
}

const mutationResult = (view: AgentMemoryView, targetValue: AgentMemoryTarget, changed: boolean, message: string): AgentMemoryMutationResult => {
  const store = view[targetValue]
  return { changed, message, target: targetValue, entries: store.entries.map(entry => entry.content), characters: store.characters, limit: store.limit }
}

export const emptyAgentMemorySnapshot = (): AgentMemorySnapshot => ({ agent: [], user: [] })

export const encodeAgentMemorySnapshot = (snapshot: AgentMemorySnapshot): string => canonicalJson(SnapshotSchema.parse(snapshot))

export const decodeAgentMemorySnapshot = (value: string): AgentMemorySnapshot => {
  if (Buffer.byteLength(value, 'utf8') > 16 * 1_024) throw new AgentRepositoryError('AGENT_MEMORY_SNAPSHOT_CORRUPT', 'Stored memory snapshot is too large', 500)
  try {
    const parsed = SnapshotSchema.parse(JSON.parse(value))
    assertCapacity('agent', parsed.agent)
    assertCapacity('user', parsed.user)
    return parsed
  } catch (error) {
    if (error instanceof AgentRepositoryError) throw error
    throw new AgentRepositoryError('AGENT_MEMORY_SNAPSHOT_CORRUPT', 'Stored memory snapshot is invalid', 500)
  }
}

export class AgentMemoryRepository {
  readonly #knex: Knex

  constructor (knex: Knex) {
    this.#knex = knex
  }

  async list (ownerId: number): Promise<AgentMemoryView> {
    const entries = (await rowsFor(this.#knex, ownerId)).map(record)
    return { agent: storeView(entries, 'agent'), user: storeView(entries, 'user') }
  }

  async snapshot (ownerId: number): Promise<AgentMemorySnapshot> {
    const view = await this.list(ownerId)
    return {
      agent: view.agent.entries.map(entry => entry.content),
      user: view.user.entries.map(entry => entry.content)
    }
  }

  async add (ownerId: number, targetValue: AgentMemoryTarget, rawContent: string): Promise<AgentMemoryMutationResult> {
    const content = normalizeContent(targetValue, rawContent)
    let changed = false
    await this.#knex.transaction(async transaction => {
      await lockOwner(transaction, ownerId)
      const rows = await rowsFor(transaction, ownerId)
      const duplicate = rows.find(row => row.target === targetValue && row.contentSha256 === sha256(content))
      if (duplicate) return
      assertCapacity(targetValue, [...rows.filter(row => row.target === targetValue).map(row => row.content), content])
      const now = new Date()
      await transaction('agentMemories').insert({ id: randomUUID(), ownerId, target: targetValue, content, contentSha256: sha256(content), version: 1, createdAt: now, updatedAt: now })
      changed = true
    })
    return mutationResult(await this.list(ownerId), targetValue, changed, changed ? 'Memory saved for new conversations.' : 'Memory already exists; no duplicate was added.')
  }

  async update (ownerId: number, id: string, expectedVersion: number, targetValue: AgentMemoryTarget, rawContent: string): Promise<AgentMemoryMutationResult> {
    const content = normalizeContent(targetValue, rawContent)
    let changed = false
    await this.#knex.transaction(async transaction => {
      await lockOwner(transaction, ownerId)
      const rows = await rowsFor(transaction, ownerId)
      const current = rows.find(row => row.id === id && row.ownerId === ownerId)
      if (!current) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Memory entry was not found', 404)
      if (Number(current.version) !== expectedVersion) throw new AgentRepositoryError('AGENT_MEMORY_VERSION_CHANGED', 'Memory entry changed concurrently', 409)
      const duplicate = rows.find(row => row.id !== id && row.target === targetValue && row.contentSha256 === sha256(content))
      if (duplicate) throw new AgentRepositoryError('AGENT_MEMORY_DUPLICATE', 'An identical memory entry already exists', 409)
      const nextContents = rows.filter(row => row.target === targetValue && row.id !== id).map(row => row.content)
      nextContents.push(content)
      assertCapacity(targetValue, nextContents)
      if (current.target === targetValue && current.content === content) return
      const updated = await transaction('agentMemories').where({ id, ownerId, version: expectedVersion }).update({ target: targetValue, content, contentSha256: sha256(content), version: expectedVersion + 1, updatedAt: new Date() })
      if (updated !== 1) throw new AgentRepositoryError('AGENT_MEMORY_VERSION_CHANGED', 'Memory entry changed concurrently', 409)
      changed = true
    })
    return mutationResult(await this.list(ownerId), targetValue, changed, changed ? 'Memory updated for new conversations.' : 'Memory was already up to date.')
  }

  async remove (ownerId: number, id: string, expectedVersion: number): Promise<AgentMemoryMutationResult> {
    let removedTarget: AgentMemoryTarget = 'agent'
    await this.#knex.transaction(async transaction => {
      await lockOwner(transaction, ownerId)
      const current = await transaction<MemoryRow>('agentMemories').where({ id, ownerId }).forUpdate().first()
      if (!current) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Memory entry was not found', 404)
      if (Number(current.version) !== expectedVersion) throw new AgentRepositoryError('AGENT_MEMORY_VERSION_CHANGED', 'Memory entry changed concurrently', 409)
      removedTarget = target(current.target)
      const removed = await transaction('agentMemories').where({ id, ownerId, version: expectedVersion }).delete()
      if (removed !== 1) throw new AgentRepositoryError('AGENT_MEMORY_VERSION_CHANGED', 'Memory entry changed concurrently', 409)
    })
    return mutationResult(await this.list(ownerId), removedTarget, true, 'Memory removed from new conversations.')
  }

  async clear (ownerId: number): Promise<number> {
    return this.#knex.transaction(async transaction => {
      await lockOwner(transaction, ownerId)
      const removed = await transaction('agentMemories').where({ ownerId }).delete()
      return removed
    })
  }

  async manage (ownerId: number, input: { readonly target: AgentMemoryTarget, readonly action: 'add' | 'replace' | 'remove', readonly content?: string, readonly oldText?: string }): Promise<AgentMemoryMutationResult> {
    if (input.action === 'add') return this.add(ownerId, input.target, input.content ?? '')
    const oldText = (input.oldText ?? '').trim()
    if (!oldText) throw new AgentRepositoryError('INVALID_AGENT_MEMORY', 'oldText is required for replace and remove', 400)
    const view = await this.list(ownerId)
    const matches = view[input.target].entries.filter(entry => entry.content.includes(oldText))
    if (matches.length === 0) throw new AgentRepositoryError('AGENT_MEMORY_MATCH_NOT_FOUND', 'No memory entry matched oldText', 409)
    if (matches.length > 1) throw new AgentRepositoryError('AGENT_MEMORY_MATCH_AMBIGUOUS', 'Multiple memory entries matched oldText; use a more specific substring', 409)
    const match = matches[0]!
    return input.action === 'remove'
      ? this.remove(ownerId, match.id, match.version)
      : this.update(ownerId, match.id, match.version, input.target, input.content ?? '')
  }
}
