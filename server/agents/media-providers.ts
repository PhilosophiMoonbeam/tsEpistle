import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  AgentMediaKindSchema,
  AgentMediaProviderConfigSchema,
  AgentMediaProviderWriteSchema,
  type AgentMediaBindings,
  type AgentMediaKind,
  type AgentMediaProviderActor,
  type AgentMediaProviderConfig,
  type AgentMediaProviderView,
  type AgentMediaProviderWrite
} from '../../shared/agents/media-providers.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { accountSessionIsCurrent, sessionVersion } from '../helpers/account-session.ts'
import { AgentRepositoryError } from './repository.ts'
import { environmentSecretValue, type AgentSecretRegistry } from './providers/secrets.ts'
import { lockSkillAdmissionPrincipal } from './skills/runtime.ts'

export type { AgentMediaProviderActor } from '../../shared/agents/media-providers.ts'
type Database = Knex | Knex.Transaction
interface ProviderRow {
  id: string
  displayName: string
  currentVersionId: string | null
  revision: number | string
  enabled: boolean | number
  isDefault: boolean | number
  exposureMode: 'all_agent_users' | 'groups'
  createdAt: Date | string | number
  updatedAt: Date | string | number
}
interface VersionRow {
  id: string
  providerId: string
  version: number | string
  config: string
  secretReference: string | null
}
interface BoundRow extends ProviderRow {
  profileVersionId: string
  config: string
  secretReference: string | null
}
const active = (value: unknown): boolean => value === true || value === 1
const disabled = (): never => {
  throw new AgentRepositoryError('AGENT_MEDIA_DISABLED', 'The requested media operation is unavailable', 403)
}
const changed = (): never => {
  throw new AgentRepositoryError('MEDIA_PROVIDER_CHANGED', 'The admitted media provider version is no longer current', 409)
}
const revision = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AgentRepositoryError('MEDIA_PROVIDER_CORRUPT', 'Stored media provider revision is invalid', 500)
  return parsed
}
const parseConfig = (value: unknown): AgentMediaProviderConfig => {
  try {
    return AgentMediaProviderConfigSchema.parse(typeof value === 'string' ? JSON.parse(value) : value)
  } catch {
    throw new AgentRepositoryError('MEDIA_PROVIDER_CORRUPT', 'Stored media provider configuration is invalid', 500)
  }
}
const permissions = (value: unknown): readonly string[] => {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed
  } catch {
    /* fail closed */
  }
  throw new AgentRepositoryError('AGENT_ACCESS_REVOKED', 'Current group authority is invalid', 403)
}
const withTransaction = <T>(db: Database, run: (transaction: Knex.Transaction) => Promise<T>): Promise<T> =>
  db.isTransaction ? run(db as Knex.Transaction) : Promise.resolve(db.transaction(run))

const authorizePrincipal = async (db: Knex.Transaction, id: number, actor?: AgentMediaProviderActor): Promise<void> => {
  if (!Number.isSafeInteger(id) || id < 1 || id === 2) {
    if (actor) throw new AgentRepositoryError('MEDIA_ADMIN_REQUIRED', 'Current system administration access is required', 403)
    throw new AgentRepositoryError('AGENT_ACCESS_REVOKED', 'Current account cannot use Wiki Agents', 403)
  }
  if (!(await db('users').where({ id }).first('id'))) {
    if (actor) throw new AgentRepositoryError('MEDIA_ADMIN_REQUIRED', 'Current system administration access is required', 403)
    throw new AgentRepositoryError('AGENT_ACCESS_REVOKED', 'Current account cannot use Wiki Agents', 403)
  }
  await lockSkillAdmissionPrincipal(db, id)
  const account = await db('users').where({ id }).first('id', 'isActive', 'authVersion')
  const groups = await db('groups').join('userGroups', 'groups.id', 'userGroups.groupId').where('userGroups.userId', id).select('groups.permissions')
  const authority = groups.flatMap((group: { permissions: unknown }) => permissions(group.permissions))
  if (actor) {
    if (!accountSessionIsCurrent(actor, account && { ...account, isActive: active(account.isActive) }) || !authority.includes('manage:system'))
      throw new AgentRepositoryError('MEDIA_ADMIN_REQUIRED', 'Current system administration access is required', 403)
  } else if (
    !account ||
    !active(account.isActive) ||
    sessionVersion(account.authVersion) === null ||
    (!authority.includes('use:agents') && !authority.includes('manage:system'))
  ) {
    throw new AgentRepositoryError('AGENT_ACCESS_REVOKED', 'Current account cannot use Wiki Agents', 403)
  }
}
const lockConfiguration = async (db: Knex.Transaction, exclusive: boolean): Promise<void> => {
  const query = db('agentMediaProviderConfiguration').where({ id: 1 })
  const row = await (exclusive ? query.forUpdate() : query.forShare()).first('revision')
  if (!row) throw new AgentRepositoryError('MEDIA_PROVIDER_CORRUPT', 'Media provider configuration lock is missing', 500)
  revision(row.revision)
}
const credentialReferenceReady = async (db: Database, reference: string | null): Promise<boolean> => {
  if (!reference) return false
  const environment = /^env:([A-Z][A-Z0-9_]{0,127})$/u.exec(reference)?.[1]
  if (environment) {
    try {
      return /^[\x21-\x7e]{1,65536}$/u.test(environmentSecretValue(environment) ?? '')
    } catch {
      return false
    }
  }
  const id = /^managed:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(reference)?.[1]
  if (!id) return false
  const row = await db('agentProviderSecrets').where({ id }).first('algorithm', 'nonce', 'authTag', 'ciphertext')
  return (
    row?.algorithm === 'aes-256-gcm' &&
    Buffer.from(row.nonce).byteLength === 12 &&
    Buffer.from(row.authTag).byteLength === 16 &&
    Buffer.from(row.ciphertext).byteLength > 0
  )
}

const listBindingsInTransaction = async (db: Knex.Transaction, ownerId: number): Promise<AgentMediaBindings> => {
  await authorizePrincipal(db, ownerId)
  await lockConfiguration(db, false)
  const rows = (await db('agentMediaProviders as providers')
    .join('agentMediaProviderVersions as versions', function () {
      this.on('versions.id', '=', 'providers.currentVersionId').andOn('versions.providerId', '=', 'providers.id')
    })
    .where('providers.enabled', true)
    .whereNull('providers.deletedAt')
    .whereNotNull('versions.secretReference')
    .andWhere(query =>
      query
        .where('providers.exposureMode', 'all_agent_users')
        .orWhereExists(
          db('agentMediaProviderGrants as grants')
            .join('userGroups', 'userGroups.groupId', 'grants.groupId')
            .whereRaw('"grants"."providerId" = "providers"."id"')
            .andWhere('userGroups.userId', ownerId)
            .select(db.raw('1'))
        )
    )
    .orderBy('providers.isDefault', 'desc')
    .orderBy('providers.displayName')
    .orderBy('providers.id')
    .select('providers.*', 'versions.id as profileVersionId', 'versions.config', 'versions.secretReference')) as BoundRow[]
  const bindings: Partial<Record<AgentMediaKind, string>> = {}
  for (const row of rows) {
    const config = parseConfig(row.config)
    if (!bindings[config.kind] && (await credentialReferenceReady(db, row.secretReference))) bindings[config.kind] = row.profileVersionId
  }
  return Object.freeze(bindings)
}
export const listAgentMediaBindings = (db: Database, ownerId: number): Promise<AgentMediaBindings> =>
  withTransaction(db, transaction => listBindingsInTransaction(transaction, ownerId))
export const resolveAgentMediaBindings = (db: Database, ownerId: number, kinds: readonly AgentMediaKind[]): Promise<AgentMediaBindings> =>
  withTransaction(db, async transaction => {
    const requested = z.array(AgentMediaKindSchema).max(4).parse(kinds)
    const available = await listBindingsInTransaction(transaction, ownerId)
    const bindings: Partial<Record<AgentMediaKind, string>> = {}
    for (const kind of requested) {
      const versionId = available[kind]
      if (!versionId) return disabled()
      bindings[kind] = versionId
    }
    return Object.freeze(bindings)
  })
export const assertAgentMediaBinding = (
  db: Database,
  ownerId: number,
  kind: AgentMediaKind,
  profileVersionId: string
): Promise<{
  providerId: string
  profileVersionId: string
  config: AgentMediaProviderConfig
  secretReference: string
}> =>
  withTransaction(db, async transaction => {
    if (!AgentMediaKindSchema.safeParse(kind).success || !z.uuid().safeParse(profileVersionId).success) return changed()
    await authorizePrincipal(transaction, ownerId)
    await lockConfiguration(transaction, false)
    const version = await transaction<VersionRow>('agentMediaProviderVersions').where({ id: profileVersionId }).first()
    if (!version) return changed()
    const profile = await transaction<ProviderRow>('agentMediaProviders').where({ id: version.providerId }).whereNull('deletedAt').first()
    if (!profile || !active(profile.enabled)) return disabled()
    if (profile.currentVersionId !== version.id) return changed()
    const allowed =
      profile.exposureMode === 'all_agent_users' ||
      (profile.exposureMode === 'groups' &&
        Boolean(
          await transaction('agentMediaProviderGrants')
            .join('userGroups', 'userGroups.groupId', 'agentMediaProviderGrants.groupId')
            .where('agentMediaProviderGrants.providerId', profile.id)
            .andWhere('userGroups.userId', ownerId)
            .first('agentMediaProviderGrants.providerId')
        ))
    if (!allowed || version.secretReference === null || !(await credentialReferenceReady(transaction, version.secretReference))) return disabled()
    const config = parseConfig(version.config)
    if (config.kind !== kind) return changed()
    return { providerId: profile.id, profileVersionId: version.id, config, secretReference: version.secretReference }
  })

export class AgentMediaProviderRegistry {
  readonly #db: Knex
  readonly #secrets: AgentSecretRegistry
  constructor(db: Knex, secrets: AgentSecretRegistry) {
    this.#db = db
    this.#secrets = secrets
  }

  #input(input: AgentMediaProviderWrite): z.output<typeof AgentMediaProviderWriteSchema> {
    const parsed = AgentMediaProviderWriteSchema.safeParse(input)
    if (!parsed.success) throw new AgentRepositoryError('INVALID_MEDIA_PROVIDER_CONFIG', 'Media provider settings are invalid', 400)
    return parsed.data
  }
  async #begin(db: Knex.Transaction, actor: AgentMediaProviderActor): Promise<void> {
    await authorizePrincipal(db, actor.id, actor)
    await lockConfiguration(db, true)
  }
  async #row(db: Database, id: string, fence?: { expectedRevision: number }): Promise<ProviderRow> {
    if (!z.uuid().safeParse(id).success) throw new AgentRepositoryError('MEDIA_PROVIDER_NOT_FOUND', 'Media provider was not found', 404)
    const row = await db<ProviderRow>('agentMediaProviders').where({ id }).whereNull('deletedAt').first()
    if (!row) throw new AgentRepositoryError('MEDIA_PROVIDER_NOT_FOUND', 'Media provider was not found', 404)
    if (fence && (!Number.isSafeInteger(fence.expectedRevision) || fence.expectedRevision < 1 || revision(row.revision) !== fence.expectedRevision))
      throw new AgentRepositoryError('MEDIA_PROVIDER_REVISION_CHANGED', 'Media provider revision changed', 409)
    return row
  }
  async #version(db: Database, row: ProviderRow): Promise<VersionRow> {
    const version = row.currentVersionId && (await db<VersionRow>('agentMediaProviderVersions').where({ id: row.currentVersionId, providerId: row.id }).first())
    if (!version) throw new AgentRepositoryError('MEDIA_PROVIDER_CORRUPT', 'Current media provider version is missing', 500)
    return version
  }
  async #view(db: Database, row: ProviderRow): Promise<AgentMediaProviderView> {
    const version = await this.#version(db, row)
    const grants = await db('agentMediaProviderGrants').where({ providerId: row.id }).orderBy('groupId').select('groupId')
    return {
      id: row.id,
      profileVersionId: version.id,
      revision: revision(row.revision),
      displayName: row.displayName,
      config: parseConfig(version.config),
      enabled: active(row.enabled),
      isDefault: active(row.isDefault),
      exposureMode: row.exposureMode,
      groupIds: grants.map((grant: { groupId: number | string }) => Number(grant.groupId)),
      secretConfigured: version.secretReference !== null && (await this.#secrets.has(version.secretReference, db)),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString()
    }
  }
  async #groups(db: Database, value: z.output<typeof AgentMediaProviderWriteSchema>): Promise<number[]> {
    const ids = [...new Set(value.groupIds ?? [])].sort((left, right) => left - right)
    if (ids.length && (await db('groups').whereIn('id', ids).select('id')).length !== ids.length)
      throw new AgentRepositoryError('INVALID_MEDIA_PROVIDER_GRANTS', 'Every media grant must reference a current group', 400)
    return ids
  }
  async #credential(
    db: Knex.Transaction,
    value: z.output<typeof AgentMediaProviderWriteSchema>,
    actor: AgentMediaProviderActor,
    previous: string | null
  ): Promise<string | null> {
    if (value.secretValue !== undefined) return value.secretValue === null ? null : this.#secrets.store(value.secretValue, actor.id, db)
    return value.secretReference === undefined ? previous : value.secretReference
  }
  async #touch(db: Knex.Transaction): Promise<void> {
    await db('agentMediaProviderConfiguration').where({ id: 1 }).increment('revision', 1)
  }
  async list(actor: AgentMediaProviderActor): Promise<AgentMediaProviderView[]> {
    return this.#db.transaction(async db => {
      await authorizePrincipal(db, actor.id, actor)
      await lockConfiguration(db, false)
      const rows = await db<ProviderRow>('agentMediaProviders').whereNull('deletedAt').orderBy('displayName').orderBy('id')
      return Promise.all(rows.map(row => this.#view(db, row)))
    })
  }
  async create(input: AgentMediaProviderWrite, actor: AgentMediaProviderActor): Promise<AgentMediaProviderView> {
    const value = this.#input(input)
    return this.#db.transaction(async db => {
      await this.#begin(db, actor)
      const groupIds = await this.#groups(db, value)
      const id = randomUUID(),
        profileVersionId = randomUUID(),
        now = new Date()
      const secretReference = await this.#credential(db, value, actor, null)
      await db('agentMediaProviders').insert({
        id,
        displayName: value.displayName,
        currentVersionId: null,
        revision: 1,
        enabled: false,
        isDefault: false,
        exposureMode: value.exposureMode,
        createdBy: actor.id,
        updatedBy: actor.id,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      })
      await db('agentMediaProviderVersions').insert({
        id: profileVersionId,
        providerId: id,
        version: 1,
        config: canonicalJson(value.config),
        secretReference,
        createdAt: now
      })
      await db('agentMediaProviders').where({ id }).update({ currentVersionId: profileVersionId })
      if (groupIds.length) await db('agentMediaProviderGrants').insert(groupIds.map(groupId => ({ providerId: id, groupId })))
      await this.#touch(db)
      return this.#view(db, await this.#row(db, id))
    })
  }
  async update(id: string, input: AgentMediaProviderWrite, expectedRevision: number, actor: AgentMediaProviderActor): Promise<AgentMediaProviderView> {
    const value = this.#input(input)
    return this.#db.transaction(async db => {
      await this.#begin(db, actor)
      const row = await this.#row(db, id, { expectedRevision }),
        previous = await this.#version(db, row)
      const previousConfig = parseConfig(previous.config)
      if (
        previous.secretReference !== null &&
        new URL(previousConfig.baseUrl).origin !== new URL(value.config.baseUrl).origin &&
        value.secretValue === undefined &&
        (value.secretReference === undefined || value.secretReference === previous.secretReference)
      )
        throw new AgentRepositoryError(
          'INVALID_MEDIA_PROVIDER_CONFIG',
          'Changing the media API origin requires an explicit replacement credential, a different environment reference, or clearing the credential',
          400
        )
      const groupIds = await this.#groups(db, value)
      const secretReference = await this.#credential(db, value, actor, previous.secretReference)
      const ready = secretReference !== null && (await this.#secrets.has(secretReference, db))
      const profileVersionId = randomUUID(),
        now = new Date()
      await db('agentMediaProviderVersions').insert({
        id: profileVersionId,
        providerId: id,
        version: revision(previous.version) + 1,
        config: canonicalJson(value.config),
        secretReference,
        createdAt: now
      })
      await db('agentMediaProviders')
        .where({ id })
        .update({
          displayName: value.displayName,
          currentVersionId: profileVersionId,
          revision: revision(row.revision) + 1,
          enabled: active(row.enabled) && ready,
          isDefault: active(row.isDefault) && ready && previousConfig.kind === value.config.kind,
          exposureMode: value.exposureMode,
          updatedBy: actor.id,
          updatedAt: now
        })
      await db('agentMediaProviderGrants').where({ providerId: id }).delete()
      if (groupIds.length) await db('agentMediaProviderGrants').insert(groupIds.map(groupId => ({ providerId: id, groupId })))
      // Previous versions, references and encrypted credentials are immutable.
      await this.#touch(db)
      return this.#view(db, await this.#row(db, id))
    })
  }
  async remove(id: string, expectedRevision: number, actor: AgentMediaProviderActor): Promise<void> {
    await this.#db.transaction(async db => {
      await this.#begin(db, actor)
      const row = await this.#row(db, id, { expectedRevision }),
        now = new Date()
      await db('agentMediaProviders')
        .where({ id })
        .update({ enabled: false, isDefault: false, revision: revision(row.revision) + 1, deletedAt: now, updatedAt: now, updatedBy: actor.id })
      await this.#touch(db)
    })
  }
  async setEnabled(id: string, enabled: boolean, expectedRevision: number, actor: AgentMediaProviderActor): Promise<AgentMediaProviderView> {
    if (typeof enabled !== 'boolean') throw new AgentRepositoryError('INVALID_MEDIA_PROVIDER_CONFIG', 'Enabled state must be boolean', 400)
    return this.#db.transaction(async db => {
      await this.#begin(db, actor)
      const row = await this.#row(db, id, { expectedRevision }),
        version = await this.#version(db, row)
      parseConfig(version.config)
      if (enabled && (!version.secretReference || !(await this.#secrets.has(version.secretReference, db))))
        throw new AgentRepositoryError('MEDIA_PROVIDER_NOT_READY', 'Enabled media requires an available credential', 409)
      await db('agentMediaProviders')
        .where({ id })
        .update({ enabled, ...(enabled ? {} : { isDefault: false }), revision: revision(row.revision) + 1, updatedBy: actor.id, updatedAt: new Date() })
      await this.#touch(db)
      return this.#view(db, await this.#row(db, id))
    })
  }
  async setDefault(id: string, expectedRevision: number, actor: AgentMediaProviderActor): Promise<AgentMediaProviderView> {
    return this.#db.transaction(async db => {
      await this.#begin(db, actor)
      const row = await this.#row(db, id, { expectedRevision }),
        version = await this.#version(db, row),
        config = parseConfig(version.config)
      if (!active(row.enabled) || !version.secretReference || !(await this.#secrets.has(version.secretReference, db)))
        throw new AgentRepositoryError('MEDIA_PROVIDER_NOT_READY', 'Default media requires an enabled provider with an available credential', 409)
      const defaults = await db<ProviderRow>('agentMediaProviders').where({ isDefault: true }).whereNull('deletedAt').whereNot({ id })
      const now = new Date()
      for (const other of defaults) {
        if (parseConfig((await this.#version(db, other)).config).kind === config.kind)
          await db('agentMediaProviders')
            .where({ id: other.id })
            .update({ isDefault: false, revision: revision(other.revision) + 1, updatedBy: actor.id, updatedAt: now })
      }
      await db('agentMediaProviders')
        .where({ id })
        .update({ isDefault: true, revision: revision(row.revision) + 1, updatedBy: actor.id, updatedAt: now })
      await this.#touch(db)
      return this.#view(db, await this.#row(db, id))
    })
  }
}
