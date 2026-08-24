import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'

import { encodeSkillResourceBundle } from './bundle.ts'
import type { ApprovedSkillBundle } from './parser.ts'
import { serializeSkillFrontmatter, SkillValidationError } from './parser.ts'
import { resolvePageNativeSkillSource, type ResolvedPageNativeSkillSource, type SkillSourceMapping } from './wiki-source.ts'
import { validateSkillVirtualPath } from './virtual-path.ts'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SkillIdSchema = z.uuid()
const ActorIdSchema = z.number().int().positive().refine(value => value !== 2, 'Guest cannot administer skills')
const GroupIdsSchema = z.array(z.number().int().positive()).max(256).transform(values => [...new Set(values)].sort((left, right) => left - right))
export const SkillExposureModeSchema = z.enum(['all_agent_users', 'groups'])

export const CreateSkillSchema = z.object({
  name: z.string().regex(SKILL_NAME).max(64),
  rootPageId: z.number().int().positive(),
  rootPath: z.string().min(1).max(512),
  assetFolderId: z.number().int().positive().nullable(),
  exposureMode: SkillExposureModeSchema,
  groupIds: GroupIdsSchema,
  actorId: ActorIdSchema
}).strict()

export const UpdateSkillPolicySchema = z.object({
  skillId: SkillIdSchema,
  assetFolderId: z.number().int().positive().nullable(),
  exposureMode: SkillExposureModeSchema,
  groupIds: GroupIdsSchema,
  actorId: ActorIdSchema
}).strict()

export interface SkillApprovalPreview {
  readonly skillId: string
  readonly name: string
  readonly contentHash: string
  readonly sourceRevision: string
  readonly sourceUpdatedAt: string
  readonly frontmatter: ApprovedSkillBundle['entry']['frontmatter']
  readonly manifestJson: string
  readonly totalBytes: number
  readonly skillMarkdown: string
  readonly previousSkillMarkdown: string | null
}

export interface SkillRegistryListItem {
  readonly id: string
  readonly name: string
  readonly rootPageId: number
  readonly rootPath: string
  readonly assetFolderId: number | null
  readonly status: 'enabled' | 'disabled'
  readonly exposureMode: 'all_agent_users' | 'groups'
  readonly currentVersionId: string | null
  readonly currentContentHash: string | null
  readonly approvedSourceRevision: string | null
  readonly liveSourceRevision: string
  readonly drifted: boolean
  readonly groupIds: readonly number[]
}

export interface SkillSourceResolver {
  (db: Knex, mapping: SkillSourceMapping, requester: Express.User): Promise<ResolvedPageNativeSkillSource>
}

interface SkillRow {
  readonly id: string
  readonly name: string
  readonly rootPageId: number
  readonly rootPath: string
  readonly assetFolderId: number | null
  readonly status: 'enabled' | 'disabled'
  readonly exposureMode: 'all_agent_users' | 'groups'
  readonly currentVersionId: string | null
}


export class SkillRegistry {
  private readonly knex: Knex
  private readonly namespace: string
  private readonly sourceResolver: SkillSourceResolver

  constructor(knex: Knex, namespace: string, sourceResolver: SkillSourceResolver = resolvePageNativeSkillSource) {
    this.knex = knex
    this.namespace = namespace
    this.sourceResolver = sourceResolver
  }

  async create(input: z.input<typeof CreateSkillSchema>): Promise<string> {
    const value = CreateSkillSchema.parse(input)
    const rootPath = validateSkillVirtualPath(value.rootPath)
    if (!rootPath.startsWith(`${this.namespace}/`) || rootPath.slice(this.namespace.length + 1).includes('/')) {
      throw new SkillValidationError('Skill root must be a direct child of the configured namespace')
    }
    if (rootPath.split('/').at(-1) !== value.name) throw new SkillValidationError('Skill name must match its root page path')
    if (value.exposureMode === 'groups' && value.groupIds.length === 0) throw new SkillValidationError('Group-restricted skills require at least one group')
    if (value.exposureMode === 'all_agent_users' && value.groupIds.length > 0) throw new SkillValidationError('Global skill exposure cannot include group grants')

    const id = randomUUID()
    await this.knex.transaction(async transaction => {
      const page = await transaction('pages').select('id', 'path').where({ id: value.rootPageId, path: rootPath }).first()
      if (!page) throw new SkillValidationError('Skill root page does not exist at the selected path')
      await transaction('agentSkills').insert({
        id,
        name: value.name,
        rootPageId: value.rootPageId,
        rootPath,
        assetFolderId: value.assetFolderId,
        status: 'disabled',
        exposureMode: value.exposureMode,
        currentVersionId: null,
        createdBy: value.actorId,
        updatedBy: value.actorId
      })
      if (value.groupIds.length > 0) await transaction('agentSkillGrants').insert(value.groupIds.map(groupId => ({ skillId: id, groupId })))
    })
    return id
  }

  async updatePolicy(input: z.input<typeof UpdateSkillPolicySchema>): Promise<void> {
    const value = UpdateSkillPolicySchema.parse(input)
    if (value.exposureMode === 'groups' && value.groupIds.length === 0) throw new SkillValidationError('Group-restricted skills require at least one group')
    if (value.exposureMode === 'all_agent_users' && value.groupIds.length > 0) throw new SkillValidationError('Global skill exposure cannot include group grants')

    await this.knex.transaction(async transaction => {
      const updated = await transaction('agentSkills').where({ id: value.skillId }).whereNull('ownerUserId').update({
        assetFolderId: value.assetFolderId,
        exposureMode: value.exposureMode,
        updatedBy: value.actorId,
        updatedAt: transaction.fn.now()
      })
      if (updated !== 1) throw new SkillValidationError('Skill mapping does not exist')
      await transaction('agentSkillGrants').where({ skillId: value.skillId }).delete()
      if (value.groupIds.length > 0) await transaction('agentSkillGrants').insert(value.groupIds.map(groupId => ({ skillId: value.skillId, groupId })))
    })
  }

  async preview(skillId: string, requester: Express.User): Promise<SkillApprovalPreview> {
    SkillIdSchema.parse(skillId)
    return this.knex.transaction(async transaction => {
      const skill = await this.getSkillForUpdate(transaction, skillId)
      const source = await this.sourceResolver(transaction, skill, requester)
      const previous = skill.currentVersionId === null
        ? null
        : await transaction('agentSkillVersions').select('skillMarkdown').where({ id: skill.currentVersionId }).first() as { skillMarkdown: string } | undefined
      return this.toPreview(skill, source, previous?.skillMarkdown ?? null)
    })
  }

  async approve(input: { readonly skillId: string; readonly actorId: number; readonly requester: Express.User; readonly expectedContentHash: string; readonly expectedSourceRevision: string }): Promise<string> {
    const skillId = SkillIdSchema.parse(input.skillId)
    const actorId = ActorIdSchema.parse(input.actorId)
    if (input.requester.id !== actorId) throw new SkillValidationError('Skill review actor does not match the authenticated user')
    const expectedContentHash = z.string().regex(/^[a-f0-9]{64}$/).parse(input.expectedContentHash)
    const expectedSourceRevision = z.string().min(1).max(64).parse(input.expectedSourceRevision)

    return this.knex.transaction(async transaction => {
      const skill = await this.getSkillForUpdate(transaction, skillId)
      const source = await this.sourceResolver(transaction, skill, input.requester)
      if (source.bundle.contentHash !== expectedContentHash || source.sourceRevision !== expectedSourceRevision) {
        throw new SkillValidationError('Skill source changed after approval preview')
      }
      const versionId = await this.persistReview(transaction, skill, source, actorId, 'approved')
      await transaction('agentSkills').where({ id: skill.id }).whereNull('ownerUserId').update({ currentVersionId: versionId, updatedBy: actorId, updatedAt: transaction.fn.now() })
      return versionId
    })
  }

  async reject(input: { readonly skillId: string; readonly actorId: number; readonly requester: Express.User; readonly expectedContentHash: string; readonly expectedSourceRevision: string }): Promise<string> {
    const skillId = SkillIdSchema.parse(input.skillId)
    const actorId = ActorIdSchema.parse(input.actorId)
    if (input.requester.id !== actorId) throw new SkillValidationError('Skill review actor does not match the authenticated user')
    const expectedContentHash = z.string().regex(/^[a-f0-9]{64}$/).parse(input.expectedContentHash)
    const expectedSourceRevision = z.string().min(1).max(64).parse(input.expectedSourceRevision)
    return this.knex.transaction(async transaction => {
      const skill = await this.getSkillForUpdate(transaction, skillId)
      const source = await this.sourceResolver(transaction, skill, input.requester)
      if (source.bundle.contentHash !== expectedContentHash || source.sourceRevision !== expectedSourceRevision) {
        throw new SkillValidationError('Skill source changed after approval preview')
      }
      return this.persistReview(transaction, skill, source, actorId, 'rejected')
    })
  }

  async setEnabled(skillIdValue: string, actorIdValue: number, enabled: boolean): Promise<void> {
    const skillId = SkillIdSchema.parse(skillIdValue)
    const actorId = ActorIdSchema.parse(actorIdValue)
    await this.knex.transaction(async transaction => {
      const skill = await this.getSkillForUpdate(transaction, skillId)
      if (enabled && skill.currentVersionId === null) throw new SkillValidationError('Skill has no approved version')
      await transaction('agentSkills').where({ id: skillId }).whereNull('ownerUserId').update({
        status: enabled ? 'enabled' : 'disabled',
        updatedBy: actorId,
        updatedAt: transaction.fn.now()
      })
    })
  }

  async list(): Promise<readonly SkillRegistryListItem[]> {
    const rows = await this.knex('agentSkills as skills')
      .innerJoin('pages as source', 'source.id', 'skills.rootPageId')
      .leftJoin('agentSkillVersions as versions', 'versions.id', 'skills.currentVersionId')
      .whereNull('skills.ownerUserId')
      .whereNull('skills.deletedAt')
      .select(
        'skills.id', 'skills.name', 'skills.rootPageId', 'skills.rootPath', 'skills.assetFolderId', 'skills.status',
        'skills.exposureMode', 'skills.currentVersionId', 'versions.contentHash as currentContentHash',
        'versions.sourceRevision as approvedSourceRevision', 'source.sourceRevision as liveSourceRevision', 'source.path as liveRootPath'
      )
      .orderBy('skills.name')
    const grants = await this.knex('agentSkillGrants').select('skillId', 'groupId').orderBy('groupId')
    const groupsBySkill = new Map<string, number[]>()
    for (const grant of grants as Array<{ skillId: string; groupId: number }>) {
      const groupIds = groupsBySkill.get(grant.skillId) ?? []
      groupIds.push(grant.groupId)
      groupsBySkill.set(grant.skillId, groupIds)
    }
    return (rows as Array<Omit<SkillRegistryListItem, 'groupIds' | 'drifted' | 'liveSourceRevision'> & { liveSourceRevision: string | number; liveRootPath: string }>).map(row => ({
      ...row,
      approvedSourceRevision: row.approvedSourceRevision === null ? null : String(row.approvedSourceRevision),
      liveSourceRevision: String(row.liveSourceRevision),
      drifted: row.currentVersionId !== null && (String(row.approvedSourceRevision) !== String(row.liveSourceRevision) || row.liveRootPath !== row.rootPath),
      groupIds: groupsBySkill.get(row.id) ?? []
    }))
  }

  private async getSkillForUpdate(transaction: Knex.Transaction, skillId: string): Promise<SkillRow> {
    const skill = await transaction<SkillRow>('agentSkills').select('*').where({ id: skillId }).whereNull('ownerUserId').whereNull('deletedAt').forUpdate().first()
    if (!skill) throw new SkillValidationError('Skill mapping does not exist')
    return skill
  }

  private toPreview(skill: SkillRow, source: ResolvedPageNativeSkillSource, previousSkillMarkdown: string | null): SkillApprovalPreview {
    return {
      skillId: skill.id,
      name: skill.name,
      contentHash: source.bundle.contentHash,
      sourceRevision: source.sourceRevision,
      sourceUpdatedAt: source.sourceUpdatedAt,
      frontmatter: source.bundle.entry.frontmatter,
      manifestJson: source.bundle.manifestJson,
      totalBytes: source.bundle.totalBytes,
      skillMarkdown: source.bundle.entry.text,
      previousSkillMarkdown
    }
  }

  private async persistReview(
    transaction: Knex.Transaction,
    skill: SkillRow,
    source: ResolvedPageNativeSkillSource,
    actorId: number,
    approvalStatus: 'approved' | 'rejected'
  ): Promise<string> {
    const existing = await transaction('agentSkillVersions')
      .select('id', 'approvalStatus')
      .where({ skillId: skill.id, contentHash: source.bundle.contentHash })
      .first() as { id: string; approvalStatus: string } | undefined
    if (existing) {
      if (existing.approvalStatus !== approvalStatus) throw new SkillValidationError('This exact skill revision already has a different terminal review')
      return existing.id
    }

    const versionId = randomUUID()
    await transaction('agentSkillVersions').insert({
      id: versionId,
      skillId: skill.id,
      sourceRevision: source.sourceRevision,
      sourceUpdatedAt: source.sourceUpdatedAt,
      sourceHistoryId: source.sourceHistoryId,
      skillMarkdown: source.bundle.entry.text,
      frontmatter: serializeSkillFrontmatter(source.bundle.entry.frontmatter),
      resourceBundle: encodeSkillResourceBundle(source.bundle.resources),
      resourceManifest: source.bundle.manifestJson,
      contentHash: source.bundle.contentHash,
      approvalStatus,
      approvedBy: actorId,
      approvedAt: transaction.fn.now()
    })
    return versionId
  }
}
