import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { AGENT_ACTION_BY_TOOL_NAME, type AgentToolName } from '../../../shared/agents/contracts.ts'
import { decodeSkillResourceBundle } from './bundle.ts'
import { intersectAllowedTools, SkillValidationError } from './parser.ts'
import { validateSkillVirtualPath } from './virtual-path.ts'

const UuidSchema = z.uuid()
const UserIdSchema = z.number().int().positive().refine(value => value !== 2)
const GroupIdsSchema = z.array(z.number().int().positive()).max(256)
const SkillSelectionSchema = z.array(UuidSchema).max(8)
const StoredFrontmatterSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  license: z.string().nullable(),
  compatibility: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  'allowed-tools': z.array(z.string())
})

export interface SkillPrincipal {
  readonly userId: number
  readonly groupIds: readonly number[]
}

export interface ApiKeySkillPrincipal {
  readonly apiKeyId: number
  readonly groupIds: readonly number[]
}

export interface VisibleSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly versionId: string
  readonly contentHash: string
  readonly sourceRevision: string
  readonly exposureMode: 'all_agent_users' | 'groups' | 'owner'
  readonly isAgentDiscoverable: boolean
}

export interface AgentSkillPrompt {
  readonly name: string
  readonly versionId: string
  readonly contentHash: string
  readonly instructions: string
  readonly allowedTools: readonly string[]
}

export interface PreferredSkill {
  readonly id: string
  readonly name: string
  readonly versionId: string
  readonly contentHash: string
  readonly ordinal: number
}

export interface SkillResourceResult {
  readonly name: string
  readonly versionId: string
  readonly path: string
  readonly bytes: Buffer
  readonly mediaType: string
  readonly contentHash: string
  readonly sourceId: string
  readonly sourceRevision: string
}

interface SkillVersionRow {
  readonly skillId: string
  readonly name: string
  readonly exposureMode: 'all_agent_users' | 'groups' | 'owner'
  readonly versionId: string
  readonly contentHash: string
  readonly sourceRevision: string | number
  readonly skillMarkdown: string
  readonly frontmatter: string
  readonly resourceBundle: Buffer
}

const parseFrontmatter = (value: string): z.infer<typeof StoredFrontmatterSchema> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new SkillValidationError('Approved skill frontmatter is corrupt')
  }
  const result = StoredFrontmatterSchema.safeParse(parsed)
  if (!result.success) throw new SkillValidationError('Approved skill frontmatter is corrupt')
  return result.data
}

const normalizePrincipal = (principal: SkillPrincipal): SkillPrincipal => ({
  userId: UserIdSchema.parse(principal.userId),
  groupIds: [...new Set(GroupIdsSchema.parse(principal.groupIds))]
})

const normalizeApiKeyPrincipal = (principal: ApiKeySkillPrincipal): ApiKeySkillPrincipal => ({
  apiKeyId: UserIdSchema.parse(principal.apiKeyId),
  groupIds: [...new Set(GroupIdsSchema.parse(principal.groupIds))]
})

const skillResourceResult = (row: SkillVersionRow & { readonly skillId: string }, path: string, unavailableMessage: string): SkillResourceResult => {
  if (path === 'SKILL.md') {
    const bytes = Buffer.from(row.skillMarkdown, 'utf8')
    return {
      name: row.name,
      versionId: row.versionId,
      path,
      bytes,
      mediaType: 'text/markdown',
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      sourceId: `skill:${row.skillId}`,
      sourceRevision: String(row.sourceRevision)
    }
  }
  const resource = decodeSkillResourceBundle(row.resourceBundle).find(entry => entry.path === path)
  if (!resource) throw new SkillValidationError(unavailableMessage)
  return {
    name: row.name,
    versionId: row.versionId,
    path,
    bytes: resource.bytes,
    mediaType: resource.mediaType,
    contentHash: resource.sha256,
    sourceId: resource.sourceId,
    sourceRevision: resource.sourceRevision
  }
}

interface SkillVisibilityPrincipal {
  readonly userId?: number
  readonly groupIds: readonly number[]
}

const applySystemSkillVisibility = (query: Knex.QueryBuilder, db: Knex, groupIds: readonly number[]): void => {
  query.whereNull('skills.ownerUserId').andWhere(exposure => {
    exposure.where('skills.exposureMode', 'all_agent_users')
    if (groupIds.length > 0) {
      exposure.orWhereExists(function groupGrant() {
        this.select(db.raw('1'))
          .from('agentSkillGrants as grants')
          .whereRaw('grants."skillId" = skills.id')
          .whereIn('grants.groupId', groupIds)
      })
    }
  })
}

const skillVisibility = (db: Knex, principal: SkillVisibilityPrincipal) => (query: Knex.QueryBuilder): void => {
  if (principal.userId === undefined) {
    applySystemSkillVisibility(query, db, principal.groupIds)
    return
  }
  query.where('skills.ownerUserId', principal.userId).orWhere(system => applySystemSkillVisibility(system, db, principal.groupIds))
}

const agentDiscoveryVisibility = (query: Knex.QueryBuilder): void => {
  query.whereNull('skills.ownerUserId').orWhere('skills.isAgentDiscoverable', true)
}

const visibleSkillQuery = (db: Knex, principal: SkillVisibilityPrincipal) =>
  db('agentSkills as skills')
    .innerJoin('agentSkillVersions as versions', 'versions.id', 'skills.currentVersionId')
    .where('skills.status', 'enabled')
    .where('versions.approvalStatus', 'approved')
    .whereNotNull('skills.currentVersionId')
    .whereNull('skills.deletedAt')
    .where(skillVisibility(db, principal))

export class SkillRuntime {
  private readonly knex: Knex

  constructor(knex: Knex) {
    this.knex = knex
  }

  async listVisible(principalValue: SkillPrincipal): Promise<readonly VisibleSkill[]> {
    const principal = normalizePrincipal(principalValue)
    const rows = await visibleSkillQuery(this.knex, principal)
      .select(
        'skills.id', 'skills.name', 'skills.exposureMode', 'skills.isAgentDiscoverable', 'versions.id as versionId',
        'versions.contentHash', 'versions.sourceRevision', 'versions.frontmatter'
      )
      .orderBy('skills.name') as Array<Omit<VisibleSkill, 'description' | 'sourceRevision'> & { frontmatter: string; sourceRevision: string | number }>
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: parseFrontmatter(row.frontmatter).description,
      versionId: row.versionId,
      contentHash: row.contentHash,
      sourceRevision: String(row.sourceRevision),
      exposureMode: row.exposureMode,
      isAgentDiscoverable: Boolean(row.isAgentDiscoverable)
    }))
  }

  async assertVisibleVersions(skillVersionIdsValue: readonly string[], principalValue: SkillPrincipal): Promise<readonly string[]> {
    const skillVersionIds = SkillSelectionSchema.parse([...skillVersionIdsValue])
    if (new Set(skillVersionIds).size !== skillVersionIds.length) throw new SkillValidationError('Skill selection contains duplicates')
    if (skillVersionIds.length === 0) return []
    const principal = normalizePrincipal(principalValue)
    const rows = await visibleSkillQuery(this.knex, principal)
      .select('versions.id')
      .whereIn('versions.id', skillVersionIds) as Array<{ id: string }>
    const visible = new Set(rows.map(row => row.id))
    if (skillVersionIds.some(id => !visible.has(id))) throw new SkillValidationError('Selected skill is unavailable')
    return skillVersionIds
  }

  async listVisibleForRun(input: {
    readonly runId: string
    readonly principal: SkillPrincipal
    readonly transportRequestId: string
  }): Promise<readonly VisibleSkill[]> {
    const runId = UuidSchema.parse(input.runId)
    const principal = normalizePrincipal(input.principal)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    return this.knex.transaction(async transaction => {
      const run = await transaction('agentRuns')
        .select('sessionId', 'ownerId')
        .where({ id: runId })
        .first() as { sessionId: string; ownerId: number } | undefined
      if (!run || run.ownerId !== principal.userId) throw new SkillValidationError('Agent run is unavailable')
      const rows = await visibleSkillQuery(transaction, principal)
        .where(agentDiscoveryVisibility)
        .whereNotExists(function excludeLoadedSkills() {
          this.select(transaction.raw('1'))
            .from('agentRunSkills as loaded_run_skills')
            .innerJoin('agentSkillVersions as loaded_versions', 'loaded_versions.id', 'loaded_run_skills.skillVersionId')
            .where('loaded_run_skills.runId', runId)
            .whereRaw('loaded_versions."skillId" = skills.id')
        })
        .whereNotExists(function excludeReadSkillInstructions() {
          this.select(transaction.raw('1'))
            .from('agentSkillUses as loaded_skill_uses')
            .innerJoin('agentSkillVersions as loaded_versions', 'loaded_versions.id', 'loaded_skill_uses.skillVersionId')
            .where('loaded_skill_uses.runId', runId)
            .where('loaded_skill_uses.purpose', 'read')
            .where('loaded_skill_uses.resourcePath', 'SKILL.md')
            .whereRaw('loaded_versions."skillId" = skills.id')
        })
        .select(
          'skills.id', 'skills.name', 'skills.exposureMode', 'skills.isAgentDiscoverable', 'versions.id as versionId',
          'versions.contentHash', 'versions.sourceRevision', 'versions.frontmatter'
        )
        .orderBy('skills.name') as Array<Omit<VisibleSkill, 'description' | 'sourceRevision'> & { frontmatter: string; sourceRevision: string | number }>
      if (rows.length > 0) {
        await transaction('agentSkillUses').insert(rows.map(row => ({
          id: randomUUID(),
          skillVersionId: row.versionId,
          runId,
          sessionId: run.sessionId,
          requesterUserId: principal.userId,
          requesterApiKeyId: null,
          transportRequestId,
          externalSessionSha256: null,
          resourcePath: null,
          purpose: 'listed',
          contentHash: row.contentHash
        })))
      }
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        description: parseFrontmatter(row.frontmatter).description,
        versionId: row.versionId,
        contentHash: row.contentHash,
        sourceRevision: String(row.sourceRevision),
        exposureMode: row.exposureMode,
        isAgentDiscoverable: Boolean(row.isAgentDiscoverable)
      }))
    })
  }

  async listVisibleForApiKey(input: {
    readonly principal: ApiKeySkillPrincipal
    readonly transportRequestId: string
  }): Promise<readonly VisibleSkill[]> {
    const principal = normalizeApiKeyPrincipal(input.principal)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    return this.knex.transaction(async transaction => {
      const rows = await visibleSkillQuery(transaction, { groupIds: principal.groupIds })
        .select(
          'skills.id', 'skills.name', 'skills.exposureMode', 'skills.isAgentDiscoverable', 'versions.id as versionId',
          'versions.contentHash', 'versions.sourceRevision', 'versions.frontmatter'
        )
        .orderBy('skills.name') as Array<Omit<VisibleSkill, 'description' | 'sourceRevision'> & { frontmatter: string; sourceRevision: string | number }>
      if (rows.length > 0) {
        await transaction('agentSkillUses').insert(rows.map(row => ({
          id: randomUUID(),
          skillVersionId: row.versionId,
          runId: null,
          sessionId: null,
          requesterUserId: null,
          requesterApiKeyId: principal.apiKeyId,
          transportRequestId,
          externalSessionSha256: null,
          resourcePath: null,
          purpose: 'listed',
          contentHash: row.contentHash
        })))
      }
      return rows.map(row => ({
        id: row.id,
        name: row.name,
        description: parseFrontmatter(row.frontmatter).description,
        versionId: row.versionId,
        contentHash: row.contentHash,
        sourceRevision: String(row.sourceRevision),
        exposureMode: row.exposureMode,
        isAgentDiscoverable: Boolean(row.isAgentDiscoverable)
      }))
    })
  }

  async readVisibleResourceForRun(input: {
    readonly runId: string
    readonly skillName: string
    readonly versionId: string
    readonly path: string
    readonly principal: SkillPrincipal
    readonly transportRequestId: string
  }): Promise<SkillResourceResult> {
    const runId = UuidSchema.parse(input.runId)
    const versionId = UuidSchema.parse(input.versionId)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    const path = validateSkillVirtualPath(input.path)
    const principal = normalizePrincipal(input.principal)
    return this.knex.transaction(async transaction => {
      const run = await transaction('agentRuns')
        .select('sessionId', 'ownerId')
        .where({ id: runId })
        .first() as { sessionId: string; ownerId: number } | undefined
      if (!run || run.ownerId !== principal.userId) throw new SkillValidationError('Agent run is unavailable')
      const row = await transaction('agentSkillVersions as versions')
        .innerJoin('agentSkills as skills', 'skills.id', 'versions.skillId')
        .select(
          'skills.id as skillId', 'skills.name', 'skills.exposureMode', 'versions.id as versionId',
          'versions.contentHash', 'versions.sourceRevision', 'versions.skillMarkdown', 'versions.resourceBundle'
        )
        .where({
          'versions.id': versionId,
          'versions.approvalStatus': 'approved',
          'skills.name': input.skillName,
          'skills.status': 'enabled'
        })
        .whereNull('skills.deletedAt')
        .where(skillVisibility(transaction, principal))
        .first() as (SkillVersionRow & { skillId: string }) | undefined
      if (!row) throw new SkillValidationError('Approved skill resource is unavailable')
      if (path === 'SKILL.md') {
        const loaded = await transaction('agentRunSkills as loadedRunSkills')
          .innerJoin('agentSkillVersions as loadedVersions', 'loadedVersions.id', 'loadedRunSkills.skillVersionId')
          .where('loadedRunSkills.runId', runId)
          .where('loadedVersions.skillId', row.skillId)
          .first('loadedRunSkills.skillVersionId')
        if (loaded) throw new SkillValidationError('Skill instructions are already loaded for this run')
        const previouslyRead = await transaction('agentSkillUses as loadedSkillUses')
          .innerJoin('agentSkillVersions as loadedVersions', 'loadedVersions.id', 'loadedSkillUses.skillVersionId')
          .where('loadedSkillUses.runId', runId)
          .where('loadedSkillUses.purpose', 'read')
          .where('loadedSkillUses.resourcePath', 'SKILL.md')
          .where('loadedVersions.skillId', row.skillId)
          .first('loadedSkillUses.skillVersionId')
        if (previouslyRead) throw new SkillValidationError('Skill instructions are already loaded for this run')
      }
      const result = skillResourceResult(row, path, 'Approved skill resource is unavailable')
      await transaction('agentSkillUses').insert({
        id: randomUUID(),
        skillVersionId: row.versionId,
        runId,
        sessionId: run.sessionId,
        requesterUserId: principal.userId,
        requesterApiKeyId: null,
        transportRequestId,
        externalSessionSha256: null,
        resourcePath: path,
        purpose: 'read',
        contentHash: result.contentHash
      })
      return result
    })
  }

  async readVisibleResourceForApiKey(input: {
    readonly skillName: string
    readonly versionId: string
    readonly path: string
    readonly principal: ApiKeySkillPrincipal
    readonly transportRequestId: string
    readonly externalSessionId?: string
  }): Promise<SkillResourceResult> {
    const versionId = UuidSchema.parse(input.versionId)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    const path = validateSkillVirtualPath(input.path)
    const principal = normalizeApiKeyPrincipal(input.principal)
    return this.knex.transaction(async transaction => {
      const row = await transaction('agentSkillVersions as versions')
        .innerJoin('agentSkills as skills', 'skills.id', 'versions.skillId')
        .select(
          'skills.id as skillId', 'skills.name', 'skills.exposureMode', 'versions.id as versionId',
          'versions.contentHash', 'versions.sourceRevision', 'versions.skillMarkdown', 'versions.resourceBundle'
        )
        .where({
          'versions.id': versionId,
          'versions.approvalStatus': 'approved',
          'skills.name': input.skillName,
          'skills.status': 'enabled'
        })
        .whereNull('skills.deletedAt')
        .where(skillVisibility(transaction, { groupIds: principal.groupIds }))
        .first() as (SkillVersionRow & { skillId: string }) | undefined
      if (!row) throw new SkillValidationError('Approved skill resource is unavailable')
      const result = skillResourceResult(row, path, 'Approved skill resource is unavailable')
      await transaction('agentSkillUses').insert({
        id: randomUUID(),
        skillVersionId: row.versionId,
        runId: null,
        sessionId: null,
        requesterUserId: null,
        requesterApiKeyId: principal.apiKeyId,
        transportRequestId,
        externalSessionSha256: input.externalSessionId
          ? createHash('sha256').update(input.externalSessionId).digest('hex')
          : null,
        resourcePath: path,
        purpose: 'read',
        contentHash: result.contentHash
      })
      return result
    })
  }

  async setUserSkillPreferences(input: {
    readonly skillIds: readonly string[]
    readonly transportRequestId: string
    readonly principal: SkillPrincipal
  }): Promise<readonly string[]> {
    const skillIds = SkillSelectionSchema.parse(input.skillIds)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    if (new Set(skillIds).size !== skillIds.length) throw new SkillValidationError('Skill preferences contain duplicates')
    const principal = normalizePrincipal(input.principal)

    return this.knex.transaction(async transaction => {
      const visible = skillIds.length === 0
        ? []
        : await visibleSkillQuery(transaction, principal)
          .select('skills.id', 'versions.id as versionId', 'versions.contentHash')
          .whereIn('skills.id', skillIds) as Array<{ id: string, versionId: string, contentHash: string }>
      if (visible.length !== skillIds.length) throw new SkillValidationError('One or more preferred skills are unavailable')
      const versionBySkillId = new Map(visible.map(row => [row.id, row]))
      await transaction('agentUserSkillPreferences').where({ ownerId: principal.userId }).delete()
      if (skillIds.length > 0) {
        await transaction('agentUserSkillPreferences').insert(skillIds.map((skillId, ordinal) => ({
          ownerId: principal.userId,
          skillId,
          ordinal
        })))
        await transaction('agentSkillUses').insert(skillIds.map(skillId => ({
          id: randomUUID(),
          skillVersionId: versionBySkillId.get(skillId)!.versionId,
          runId: null,
          sessionId: null,
          requesterUserId: principal.userId,
          requesterApiKeyId: null,
          transportRequestId,
          externalSessionSha256: null,
          resourcePath: null,
          purpose: 'selected',
          contentHash: versionBySkillId.get(skillId)!.contentHash
        })))
      }
      return skillIds
    })
  }
  async listUserSkillPreferences(principalValue: SkillPrincipal): Promise<readonly PreferredSkill[]> {
    const principal = normalizePrincipal(principalValue)
    return visibleSkillQuery(this.knex, principal)
      .innerJoin('agentUserSkillPreferences as preferences', 'preferences.skillId', 'skills.id')
      .select('skills.id', 'skills.name', 'versions.id as versionId', 'versions.contentHash', 'preferences.ordinal')
      .where('preferences.ownerId', principal.userId)
      .orderBy('preferences.ordinal') as Promise<PreferredSkill[]>
  }

  async resolvePreferredVersionIdsForUser(userIdValue: number): Promise<readonly string[]> {
    const userId = UserIdSchema.parse(userIdValue)
    const groupIds = await this.knex('userGroups').where({ userId }).pluck('groupId') as number[]
    return visibleSkillQuery(this.knex, { userId, groupIds })
      .innerJoin('agentUserSkillPreferences as preferences', 'preferences.skillId', 'skills.id')
      .where('preferences.ownerId', userId)
      .orderBy('preferences.ordinal')
      .pluck('versions.id') as Promise<string[]>
  }



  async getRunPrompts(input: {
    readonly runId: string
    readonly principal: SkillPrincipal
    readonly transportRequestId: string
    readonly availableTools: readonly string[]
  }): Promise<readonly AgentSkillPrompt[]> {
    const runId = UuidSchema.parse(input.runId)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    const principal = normalizePrincipal(input.principal)
    return this.knex.transaction(async transaction => {
      const run = await transaction('agentRuns').select('sessionId', 'ownerId').where({ id: runId }).first() as { sessionId: string; ownerId: number } | undefined
      if (!run || run.ownerId !== principal.userId) throw new SkillValidationError('Agent run is unavailable')
      const rows = await transaction('agentRunSkills as pins')
        .innerJoin('agentSkillVersions as versions', 'versions.id', 'pins.skillVersionId')
        .innerJoin('agentSkills as skills', 'skills.id', 'versions.skillId')
        .select(
          'skills.name', 'versions.id as versionId', 'versions.contentHash', 'versions.skillMarkdown',
          'versions.frontmatter', 'pins.ordinal'
        )
        .where('pins.runId', runId)
        .orderBy('pins.ordinal') as Array<{ name: string; versionId: string; contentHash: string; skillMarkdown: string; frontmatter: string; ordinal: number }>
      if (rows.length > 0) {
        await transaction('agentSkillUses').insert(rows.map(row => ({
          id: randomUUID(),
          skillVersionId: row.versionId,
          runId,
          sessionId: run.sessionId,
          requesterUserId: principal.userId,
          requesterApiKeyId: null,
          transportRequestId,
          externalSessionSha256: null,
          resourcePath: 'SKILL.md',
          purpose: 'injected',
          contentHash: createHash('sha256').update(row.skillMarkdown).digest('hex')
        })))
      }
      return rows.map(row => {
        const frontmatter = parseFrontmatter(row.frontmatter)
        return {
          name: row.name,
          versionId: row.versionId,
          contentHash: row.contentHash,
          instructions: row.skillMarkdown,
          allowedTools: intersectAllowedTools(
            input.availableTools,
            frontmatter['allowed-tools'].map(toolName => AGENT_ACTION_BY_TOOL_NAME[toolName as AgentToolName] ?? toolName)
          )
        }
      })
    })
  }

}
