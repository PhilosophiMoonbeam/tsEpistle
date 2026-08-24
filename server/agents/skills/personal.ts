import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'

import { encodeSkillResourceBundle } from './bundle.ts'
import { buildApprovedSkillBundle, serializeSkillFrontmatter, SkillValidationError } from './parser.ts'

const MAX_PERSONAL_SKILLS = 32
export const PersonalSkillNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64)
export const PersonalSkillMarkdownSchema = z.string().min(1).max(64 * 1024)
const OwnerIdSchema = z.number().int().positive().refine(value => value !== 2)
const SkillIdSchema = z.uuid()
const VersionIdSchema = z.uuid()

interface PersonalSkillRow {
  readonly id: string
  readonly name: string
  readonly currentVersionId: string
  readonly contentHash: string
  readonly skillMarkdown: string
  readonly frontmatter: string
  readonly createdAt: Date | string
  readonly updatedAt: Date | string
}

interface OwnedSkillRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: number
  readonly currentVersionId: string
}

export interface PersonalSkillDocument {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly versionId: string
  readonly contentHash: string
  readonly skillMarkdown: string
  readonly createdAt: string
  readonly updatedAt: string
}

const storedDescription = (value: string): string => {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new SkillValidationError('Personal skill metadata is corrupt') }
  const result = z.looseObject({ description: z.string().min(1).max(1_024) }).safeParse(parsed)
  if (!result.success) throw new SkillValidationError('Personal skill metadata is corrupt')
  return result.data.description
}

const iso = (value: Date | string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) throw new SkillValidationError('Personal skill timestamp is corrupt')
  return date.toISOString()
}

const documentFromRow = (row: PersonalSkillRow): PersonalSkillDocument => ({
  id: row.id,
  name: row.name,
  description: storedDescription(row.frontmatter),
  versionId: row.currentVersionId,
  contentHash: row.contentHash,
  skillMarkdown: row.skillMarkdown,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt)
})

const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const code = Reflect.get(error, 'code')
  return code === '23505' || code === 'SQLITE_CONSTRAINT' || code === 'SQLITE_CONSTRAINT_UNIQUE'
}

export class PersonalSkillRegistry {
  readonly #knex: Knex

  constructor(knex: Knex) {
    this.#knex = knex
  }

  async list(ownerIdValue: number): Promise<readonly PersonalSkillDocument[]> {
    const ownerId = OwnerIdSchema.parse(ownerIdValue)
    const rows = await this.#baseQuery(this.#knex, ownerId).orderBy('skills.name') as PersonalSkillRow[]
    return rows.map(documentFromRow)
  }

  async create(input: { readonly ownerId: number; readonly name: string; readonly skillMarkdown: string }): Promise<PersonalSkillDocument> {
    const ownerId = OwnerIdSchema.parse(input.ownerId)
    const name = PersonalSkillNameSchema.parse(input.name)
    const skillMarkdown = PersonalSkillMarkdownSchema.parse(input.skillMarkdown)
    const bundle = buildApprovedSkillBundle(Buffer.from(skillMarkdown, 'utf8'), name, [])
    const id = randomUUID()
    const versionId = randomUUID()
    const now = new Date()

    try {
      await this.#knex.transaction(async transaction => {
        const owner = await transaction('users').where({ id: ownerId }).forUpdate().first('id') as { id: number } | undefined
        if (!owner) throw new SkillValidationError('Personal skill owner is unavailable')
        const count = await transaction('agentSkills').where({ ownerUserId: ownerId }).whereNull('deletedAt').count<{ count: string }[]>({ count: '*' }).first()
        if (Number(count?.count ?? 0) >= MAX_PERSONAL_SKILLS) throw new SkillValidationError(`Personal skills are limited to ${MAX_PERSONAL_SKILLS} documents`)
        await transaction('agentSkills').insert({
          id,
          name,
          rootPageId: null,
          rootPath: `personal/${ownerId}/${name}`,
          assetFolderId: null,
          status: 'enabled',
          exposureMode: 'owner',
          currentVersionId: null,
          ownerUserId: ownerId,
          deletedAt: null,
          createdBy: ownerId,
          updatedBy: ownerId,
          createdAt: now,
          updatedAt: now
        })
        await this.#insertVersion(transaction, { id: versionId, skillId: id, ownerId, sourceRevision: 1, now, bundle })
        await transaction('agentSkills').where({ id, ownerUserId: ownerId }).update({ currentVersionId: versionId })
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new SkillValidationError('A personal skill with this name already exists')
      throw error
    }
    return this.get(ownerId, id)
  }

  async update(input: { readonly ownerId: number; readonly skillId: string; readonly expectedVersionId: string; readonly skillMarkdown: string }): Promise<PersonalSkillDocument> {
    const ownerId = OwnerIdSchema.parse(input.ownerId)
    const skillId = SkillIdSchema.parse(input.skillId)
    const expectedVersionId = VersionIdSchema.parse(input.expectedVersionId)
    const skillMarkdown = PersonalSkillMarkdownSchema.parse(input.skillMarkdown)

    await this.#knex.transaction(async transaction => {
      const skill = await transaction<OwnedSkillRow>('agentSkills')
        .select('id', 'name', 'currentVersionId')
        .where({ id: skillId, ownerUserId: ownerId })
        .whereNull('deletedAt')
        .forUpdate()
        .first()
      if (!skill) throw new SkillValidationError('Personal skill is unavailable')
      if (skill.currentVersionId !== expectedVersionId) throw new SkillValidationError('Personal skill changed; reload it before saving')

      const bundle = buildApprovedSkillBundle(Buffer.from(skillMarkdown, 'utf8'), skill.name, [])
      const existing = await transaction('agentSkillVersions').select('id').where({ skillId, contentHash: bundle.contentHash }).first() as { id: string } | undefined
      const now = new Date()
      let versionId = existing?.id
      if (!versionId) {
        const latest = await transaction('agentSkillVersions').where({ skillId }).max<{ revision: string | number | null }[]>({ revision: 'sourceRevision' }).first()
        const sourceRevision = Number(latest?.revision ?? 0) + 1
        if (!Number.isSafeInteger(sourceRevision)) throw new SkillValidationError('Personal skill revision is invalid')
        versionId = randomUUID()
        await this.#insertVersion(transaction, { id: versionId, skillId, ownerId, sourceRevision, now, bundle })
      }
      await transaction('agentSkills').where({ id: skillId, ownerUserId: ownerId }).update({ currentVersionId: versionId, status: 'enabled', updatedBy: ownerId, updatedAt: now })
    })
    return this.get(ownerId, skillId)
  }

  async remove(input: { readonly ownerId: number; readonly skillId: string; readonly expectedVersionId: string }): Promise<void> {
    const ownerId = OwnerIdSchema.parse(input.ownerId)
    const skillId = SkillIdSchema.parse(input.skillId)
    const expectedVersionId = VersionIdSchema.parse(input.expectedVersionId)
    await this.#knex.transaction(async transaction => {
      const skill = await transaction<OwnedSkillRow>('agentSkills')
        .select('id', 'name', 'currentVersionId')
        .where({ id: skillId, ownerUserId: ownerId })
        .whereNull('deletedAt')
        .forUpdate()
        .first()
      if (!skill) throw new SkillValidationError('Personal skill is unavailable')
      if (skill.currentVersionId !== expectedVersionId) throw new SkillValidationError('Personal skill changed; reload it before removing')
      await transaction('agentSkills').where({ id: skillId, ownerUserId: ownerId }).update({ status: 'disabled', deletedAt: transaction.fn.now(), updatedBy: ownerId, updatedAt: transaction.fn.now() })
    })
  }

  async get(ownerIdValue: number, skillIdValue: string): Promise<PersonalSkillDocument> {
    const ownerId = OwnerIdSchema.parse(ownerIdValue)
    const skillId = SkillIdSchema.parse(skillIdValue)
    const row = await this.#baseQuery(this.#knex, ownerId).where('skills.id', skillId).first() as PersonalSkillRow | undefined
    if (!row) throw new SkillValidationError('Personal skill is unavailable')
    return documentFromRow(row)
  }

  #baseQuery(db: Knex | Knex.Transaction, ownerId: number): Knex.QueryBuilder {
    return db('agentSkills as skills')
      .innerJoin('agentSkillVersions as versions', 'versions.id', 'skills.currentVersionId')
      .where({ 'skills.ownerUserId': ownerId, 'skills.exposureMode': 'owner' })
      .whereNull('skills.deletedAt')
      .select(
        'skills.id', 'skills.name', 'skills.currentVersionId', 'skills.createdAt', 'skills.updatedAt',
        'versions.contentHash', 'versions.skillMarkdown', 'versions.frontmatter'
      )
  }

  async #insertVersion(transaction: Knex.Transaction, input: {
    readonly id: string
    readonly skillId: string
    readonly ownerId: number
    readonly sourceRevision: number
    readonly now: Date
    readonly bundle: ReturnType<typeof buildApprovedSkillBundle>
  }): Promise<void> {
    await transaction('agentSkillVersions').insert({
      id: input.id,
      skillId: input.skillId,
      sourceRevision: input.sourceRevision,
      sourceUpdatedAt: input.now,
      sourceHistoryId: null,
      skillMarkdown: input.bundle.entry.text,
      frontmatter: serializeSkillFrontmatter(input.bundle.entry.frontmatter),
      resourceBundle: encodeSkillResourceBundle(input.bundle.resources),
      resourceManifest: input.bundle.manifestJson,
      contentHash: input.bundle.contentHash,
      approvalStatus: 'approved',
      approvedBy: input.ownerId,
      approvedAt: input.now,
      createdAt: input.now
    })
  }
}
