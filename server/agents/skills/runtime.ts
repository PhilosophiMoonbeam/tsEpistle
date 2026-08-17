import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'

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
  readonly exposureMode: 'all_agent_users' | 'groups'
}

export interface PinnedSkillPrompt {
  readonly name: string
  readonly versionId: string
  readonly contentHash: string
  readonly instructions: string
  readonly allowedTools: readonly string[]
}

export interface SelectedSkill {
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
  readonly exposureMode: 'all_agent_users' | 'groups'
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

const visibleSkillQuery = (db: Knex, groupIds: readonly number[]) => {
  const query = db('agentSkills as skills')
    .innerJoin('agentSkillVersions as versions', 'versions.id', 'skills.currentVersionId')
    .where('skills.status', 'enabled')
    .where('versions.approvalStatus', 'approved')
    .whereNotNull('skills.currentVersionId')
    .where(exposure => {
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
  return query
}

export class SkillRuntime {
  private readonly knex: Knex

  constructor(knex: Knex) {
    this.knex = knex
  }

  async listVisible(principalValue: SkillPrincipal): Promise<readonly VisibleSkill[]> {
    const principal = normalizePrincipal(principalValue)
    const rows = await visibleSkillQuery(this.knex, principal.groupIds)
      .select(
        'skills.id', 'skills.name', 'skills.exposureMode', 'versions.id as versionId',
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
      exposureMode: row.exposureMode
    }))
  }

  async listVisibleForApiKey(input: {
    readonly principal: ApiKeySkillPrincipal
    readonly transportRequestId: string
  }): Promise<readonly VisibleSkill[]> {
    const principal = normalizeApiKeyPrincipal(input.principal)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    return this.knex.transaction(async transaction => {
      const rows = await visibleSkillQuery(transaction, principal.groupIds)
        .select(
          'skills.id', 'skills.name', 'skills.exposureMode', 'versions.id as versionId',
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
        exposureMode: row.exposureMode
      }))
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
        .where(exposure => {
          exposure.where('skills.exposureMode', 'all_agent_users')
          if (principal.groupIds.length > 0) {
            exposure.orWhereExists(function groupGrant() {
              this.select(transaction.raw('1'))
                .from('agentSkillGrants as grants')
                .whereRaw('grants."skillId" = skills.id')
                .whereIn('grants.groupId', principal.groupIds)
            })
          }
        })
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

  async setSessionSkills(input: {
    readonly sessionId: string
    readonly expectedVersion: number
    readonly skillVersionIds: readonly string[]
    readonly transportRequestId: string
    readonly principal: SkillPrincipal
  }): Promise<number> {
    const sessionId = UuidSchema.parse(input.sessionId)
    const expectedVersion = z.number().int().positive().parse(input.expectedVersion)
    const skillVersionIds = SkillSelectionSchema.parse(input.skillVersionIds)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    if (new Set(skillVersionIds).size !== skillVersionIds.length) throw new SkillValidationError('Skill selection contains duplicates')
    const principal = normalizePrincipal(input.principal)

    return this.knex.transaction(async transaction => {
      const session = await transaction('agentSessions')
        .select('id', 'ownerId', 'version')
        .where({ id: sessionId })
        .forUpdate()
        .first() as { id: string; ownerId: number; version: number } | undefined
      if (!session || session.ownerId !== principal.userId) throw new SkillValidationError('Agent session is unavailable')
      if (session.version !== expectedVersion) throw new SkillValidationError('Agent session version changed')
      const activeRun = await transaction('agentRuns').select('id').where({ sessionId }).whereIn('status', ['queued', 'running', 'awaiting_approval']).first()
      if (activeRun) throw new SkillValidationError('Skills cannot change while a run is active')

      if (skillVersionIds.length > 0) {
        const visible = await visibleSkillQuery(transaction, principal.groupIds)
          .select('skills.id', 'versions.id as versionId', 'versions.contentHash')
          .whereIn('versions.id', skillVersionIds) as Array<{ id: string; versionId: string; contentHash: string }>
        if (visible.length !== skillVersionIds.length) throw new SkillValidationError('One or more selected skills are unavailable')
        const versionById = new Map(visible.map(row => [row.versionId, row]))
        await transaction('agentSessionSkills').where({ sessionId }).delete()
        await transaction('agentSessionSkills').insert(skillVersionIds.map((skillVersionId, ordinal) => ({
          sessionId,
          skillVersionId,
          ordinal,
          selectedBy: principal.userId
        })))
        await transaction('agentSkillUses').insert(skillVersionIds.map(skillVersionId => ({
          id: randomUUID(),
          skillVersionId,
          runId: null,
          sessionId,
          requesterUserId: principal.userId,
          requesterApiKeyId: null,
          transportRequestId,
          externalSessionSha256: null,
          resourcePath: null,
          purpose: 'selected',
          contentHash: versionById.get(skillVersionId)?.contentHash
        })))
      } else {
        await transaction('agentSessionSkills').where({ sessionId }).delete()
      }
      const nextVersion = expectedVersion + 1
      await transaction('agentSessions').where({ id: sessionId, version: expectedVersion }).update({ version: nextVersion, updatedAt: transaction.fn.now() })
      return nextVersion
    })
  }
  async listSessionSkills(sessionIdValue: string, principalValue: SkillPrincipal): Promise<readonly SelectedSkill[]> {
    const sessionId = UuidSchema.parse(sessionIdValue)
    const principal = normalizePrincipal(principalValue)
    return this.knex('agentSessionSkills as pins')
      .innerJoin('agentSessions as sessions', 'sessions.id', 'pins.sessionId')
      .innerJoin('agentSkillVersions as versions', 'versions.id', 'pins.skillVersionId')
      .innerJoin('agentSkills as skills', 'skills.id', 'versions.skillId')
      .select('skills.id', 'skills.name', 'versions.id as versionId', 'versions.contentHash', 'pins.ordinal')
      .where({ 'pins.sessionId': sessionId, 'sessions.ownerId': principal.userId })
      .orderBy('pins.ordinal') as Promise<SelectedSkill[]>
  }


  async pinRunSkills(runIdValue: string, sessionIdValue: string): Promise<void> {
    const runId = UuidSchema.parse(runIdValue)
    const sessionId = UuidSchema.parse(sessionIdValue)
    await this.knex.transaction(async transaction => {
      const run = await transaction('agentRuns').select('id').where({ id: runId, sessionId }).forUpdate().first()
      if (!run) throw new SkillValidationError('Agent run is unavailable')
      const existing = await transaction('agentRunSkills').select('runId').where({ runId }).first()
      if (existing) throw new SkillValidationError('Agent run skills are already pinned')
      const selected = await transaction('agentSessionSkills').select('skillVersionId', 'ordinal').where({ sessionId }).orderBy('ordinal')
      if (selected.length > 0) await transaction('agentRunSkills').insert(selected.map(row => ({ runId, skillVersionId: row.skillVersionId, ordinal: row.ordinal })))
    })
  }

  async getRunPrompts(input: {
    readonly runId: string
    readonly principal: SkillPrincipal
    readonly transportRequestId: string
    readonly availableTools: readonly string[]
  }): Promise<readonly PinnedSkillPrompt[]> {
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
          allowedTools: intersectAllowedTools(input.availableTools, frontmatter['allowed-tools'])
        }
      })
    })
  }

  async readSessionResource(input: {
    readonly sessionId: string
    readonly skillName: string
    readonly versionId: string
    readonly path: string
    readonly principal: SkillPrincipal
    readonly transportRequestId: string
  }): Promise<SkillResourceResult> {
    const sessionId = UuidSchema.parse(input.sessionId)
    const versionId = UuidSchema.parse(input.versionId)
    const transportRequestId = UuidSchema.parse(input.transportRequestId)
    const path = validateSkillVirtualPath(input.path)
    const principal = normalizePrincipal(input.principal)

    return this.knex.transaction(async transaction => {
      const row = await transaction('agentSessionSkills as pins')
        .innerJoin('agentSessions as sessions', 'sessions.id', 'pins.sessionId')
        .innerJoin('agentSkillVersions as versions', 'versions.id', 'pins.skillVersionId')
        .innerJoin('agentSkills as skills', 'skills.id', 'versions.skillId')
        .select(
          'skills.id as skillId', 'skills.name', 'versions.id as versionId', 'versions.contentHash',
          'versions.sourceRevision', 'versions.skillMarkdown', 'versions.resourceBundle'
        )
        .where({ 'pins.sessionId': sessionId, 'versions.id': versionId, 'skills.name': input.skillName, 'sessions.ownerId': principal.userId })
        .first() as SkillVersionRow | undefined
      if (!row) throw new SkillValidationError('Pinned skill resource is unavailable')

      const result = skillResourceResult(row as SkillVersionRow & { skillId: string }, path, 'Pinned skill resource is unavailable')
      await transaction('agentSkillUses').insert({
        id: randomUUID(),
        skillVersionId: row.versionId,
        runId: null,
        sessionId,
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
}
