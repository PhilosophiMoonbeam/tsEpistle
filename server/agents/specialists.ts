import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import { type RoutingComplexity, RoutingComplexitySchema, type RoutingTaskClass, RoutingTaskClassSchema } from '../../shared/agents/routing.ts'
import {
  type SpecialistContext,
  type SpecialistHistoryMessage,
  type SpecialistInvocationView,
  SpecialistInvocationViewSchema,
  type SpecialistProviderBinding
} from '../../shared/agents/specialists.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { type AgentRunClaim, acquireAgentCoordinatorAdvisoryLocks } from './coordinator.ts'
import { AgentRepositoryError } from './repository.ts'

const MAX_CONTEXT_BYTES = 262_144
const MAX_REPORT_BYTES = 65_536
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const BindingSchema = z.strictObject({
  profileId: z.uuid(),
  profileVersionId: z.uuid(),
  model: z.string().min(1).max(256),
  transportKind: z.string().min(1).max(128),
  capabilityRevision: z.string().min(1).max(256),
  profilePolicyVersion: z.number().int().positive(),
  ownerAuthVersion: z.number().int().nonnegative()
})
const HistorySchema = z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string() }))
const StateSchema = z.record(z.string(), z.unknown()).nullable()
const ContextSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.number().int().positive(),
  rootSessionId: z.uuid(),
  binding: BindingSchema,
  scopeSha256: HashSchema,
  taskClass: RoutingTaskClassSchema,
  complexity: RoutingComplexitySchema,
  version: z.number().int().positive(),
  turnCount: z.number().int().nonnegative(),
  history: HistorySchema,
  state: StateSchema,
  lastReport: z.string(),
  authoritySha256: HashSchema.nullable(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime()
})

interface ContextRow {
  readonly id: string
  readonly ownerId: number
  readonly rootSessionId: string
  readonly data: string
  readonly dataSha256: string
  readonly scopeSha256: string
  readonly version: number
  readonly turnCount: number
  readonly expiresAt: Date | string
  readonly lastUsedAt: Date | string
  readonly scrubbedAt: Date | string | null
}
interface InvocationRow {
  readonly id: string
  readonly ownerId: number
  readonly rootSessionId: string
  readonly rootRunId: string
  readonly contextId: string
  readonly contextVersion: number
  readonly status: SpecialistInvocationView['status']
  readonly data: string
  readonly dataSha256: string
  readonly beginSha256: string
  readonly completionSha256: string | null
  readonly rootAttempt: number
  readonly rootLeaseOwner: string
  readonly rootLeaseToken: string
  readonly maximumContextBytes: number
  readonly expiresAt: Date | string
  readonly startedAt: Date | string
  readonly completedAt: Date | string | null
  readonly scrubbedAt: Date | string | null
}
export interface BeginSpecialistInvocationInput {
  readonly contextId: string | null
  readonly contextVersion: number | null
  readonly binding: SpecialistProviderBinding
  readonly scopeSha256: string
  readonly taskClass: RoutingTaskClass
  readonly complexity: RoutingComplexity
  readonly maximumContexts: number
  readonly maximumContextBytes: number
  readonly expiresAt: string
}
export interface CompleteSpecialistInvocationInput {
  readonly history: readonly SpecialistHistoryMessage[]
  readonly state: Readonly<Record<string, unknown>> | null
  readonly report: string
  readonly authoritySha256: string | null
  readonly maximumContextBytes: number
  readonly maximumReportBytes: number
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const iso = (value: Date | string): string => new Date(value).toISOString()
const error = (code: string, message: string, status = 409): never => {
  throw new AgentRepositoryError(code, message, status)
}
const corrupt = (): never => error('AGENT_SPECIALIST_CORRUPT', 'Stored specialist data failed integrity validation', 500)
const integerBound = (value: number, minimum: number, maximum: number): void => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) error('INVALID_SPECIALIST_INPUT', 'Specialist persistence bound is invalid', 400)
}
const encoded = (value: unknown, maximumBytes: number): string => {
  let data: string
  try {
    data = canonicalJson(value)
  } catch {
    return error('INVALID_SPECIALIST_INPUT', 'Specialist state must be canonical JSON', 400)
  }
  if (Buffer.byteLength(data, 'utf8') > maximumBytes) error('AGENT_SPECIALIST_CONTEXT_TOO_LARGE', 'Specialist context exceeds its persistence limit')
  return data
}
const decodeContext = (row: ContextRow): SpecialistContext => {
  try {
    if (Buffer.byteLength(row.data, 'utf8') > MAX_CONTEXT_BYTES || sha256(row.data) !== row.dataSha256) return corrupt()
    const value = ContextSchema.parse(JSON.parse(row.data))
    if (
      canonicalJson(value) !== row.data ||
      value.id !== row.id ||
      value.ownerId !== row.ownerId ||
      value.rootSessionId !== row.rootSessionId ||
      value.scopeSha256 !== row.scopeSha256 ||
      value.version !== row.version ||
      value.turnCount !== row.turnCount ||
      value.expiresAt !== iso(row.expiresAt) ||
      value.lastUsedAt !== iso(row.lastUsedAt)
    )
      return corrupt()
    return value
  } catch {
    return corrupt()
  }
}
const decodeInvocation = (row: InvocationRow): SpecialistInvocationView => {
  try {
    if (Buffer.byteLength(row.data, 'utf8') > MAX_REPORT_BYTES + 4_096 || sha256(row.data) !== row.dataSha256) return corrupt()
    const value = SpecialistInvocationViewSchema.parse(JSON.parse(row.data))
    if (
      canonicalJson(value) !== row.data ||
      value.id !== row.id ||
      value.contextId !== row.contextId ||
      value.rootRunId !== row.rootRunId ||
      value.contextVersion !== row.contextVersion ||
      value.status !== row.status ||
      value.startedAt !== iso(row.startedAt) ||
      value.completedAt !== (row.completedAt === null ? null : iso(row.completedAt)) ||
      (value.status === 'running' && (value.completedAt !== null || value.report !== null || value.errorCode !== null)) ||
      (value.status === 'completed' && (value.completedAt === null || value.errorCode !== null || (row.scrubbedAt === null && value.report === null))) ||
      (value.status === 'failed' && (value.completedAt === null || value.report !== null || value.errorCode === null))
    )
      return corrupt()
    return value
  } catch {
    return corrupt()
  }
}
const contextPatch = (context: SpecialistContext, maximumBytes: number) => {
  const data = encoded(context, maximumBytes)
  return {
    data,
    dataSha256: sha256(data),
    version: context.version,
    turnCount: context.turnCount,
    expiresAt: new Date(context.expiresAt),
    lastUsedAt: new Date(context.lastUsedAt)
  }
}
const invocationPatch = (invocation: SpecialistInvocationView) => {
  const data = canonicalJson(invocation)
  return {
    data,
    dataSha256: sha256(data),
    status: invocation.status,
    contextVersion: invocation.contextVersion,
    completedAt: invocation.completedAt === null ? null : new Date(invocation.completedAt)
  }
}
const beginHash = (input: BeginSpecialistInvocationInput): string =>
  sha256(
    canonicalJson({
      contextId: input.contextId,
      contextVersion: input.contextVersion,
      binding: input.binding,
      scopeSha256: input.scopeSha256,
      taskClass: input.taskClass,
      complexity: input.complexity
    })
  )
const completionHash = (input: CompleteSpecialistInvocationInput): string =>
  sha256(
    encoded(
      {
        history: input.history,
        state: input.state,
        report: input.report,
        authoritySha256: input.authoritySha256
      },
      Math.min(input.maximumContextBytes, MAX_CONTEXT_BYTES)
    )
  )
const liveRoot = (query: Knex.QueryBuilder, transaction: Knex.Transaction): void => {
  query.whereExists(function activeRoot() {
    this.select(transaction.raw('1'))
      .from('agentRuns')
      .where('agentRuns.id', transaction.ref('agentSpecialistInvocations.rootRunId'))
      .whereIn('agentRuns.status', ['queued', 'running', 'awaiting_approval'])
  })
}

export class AgentSpecialistStore {
  readonly #knex: Knex
  constructor(knex: Knex) {
    this.#knex = knex
  }

  async #session(transaction: Knex.Transaction, ownerId: number, rootSessionId: string, now: Date): Promise<{ expiresAt: Date | string | null }> {
    const session = await transaction('agentSessions').where({ id: rootSessionId, ownerId }).whereNull('deletedAt').forUpdate().first('expiresAt')
    if (!session) return error('AGENT_RESOURCE_NOT_FOUND', 'Agent session was not found', 404)
    if (session.expiresAt !== null && new Date(session.expiresAt).valueOf() <= now.valueOf())
      return error('AGENT_SPECIALIST_EXPIRED', 'Root session retention has expired')
    return session
  }

  async #claim(transaction: Knex.Transaction, claim: AgentRunClaim, now: Date, allowCancellation = false): Promise<{ expiresAt: Date | string | null }> {
    await acquireAgentCoordinatorAdvisoryLocks(transaction, [claim.ownerId])
    const session = await this.#session(transaction, claim.ownerId, claim.sessionId, now)
    const query = transaction('agentRuns')
      .where({
        id: claim.id,
        ownerId: claim.ownerId,
        sessionId: claim.sessionId,
        status: 'running',
        attempts: claim.attempts,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken
      })
      .where('leaseExpiresAt', '>', now)
    if (!allowCancellation) query.whereNull('cancelRequestedAt')
    const run = await query.forUpdate().first('leaseExpiresAt')
    if (!run || new Date(run.leaseExpiresAt).valueOf() <= Date.now()) return error('RUN_LEASE_LOST', 'Root run lease or cancellation fence changed')
    if (session.expiresAt !== null && new Date(session.expiresAt).valueOf() <= Date.now())
      return error('AGENT_SPECIALIST_EXPIRED', 'Root session retention has expired')
    return session
  }

  async #binding(transaction: Knex.Transaction, ownerId: number, binding: SpecialistProviderBinding): Promise<void> {
    const owner = await transaction('users').where({ id: ownerId, isActive: true, authVersion: binding.ownerAuthVersion }).forShare().first('id')
    const profile = await transaction('agentProviderProfiles')
      .where({
        id: binding.profileId,
        currentVersionId: binding.profileVersionId,
        policyVersion: binding.profilePolicyVersion,
        status: 'enabled',
        conformed: true
      })
      .whereNull('deletedAt')
      .forShare()
      .first('id', 'exposureMode')
    const version = await transaction('agentProviderProfileVersions')
      .where({
        id: binding.profileVersionId,
        profileId: binding.profileId,
        model: binding.model,
        transportKind: binding.transportKind,
        capabilityRevision: binding.capabilityRevision,
        conformed: true
      })
      .forShare()
      .first('id')
    if (!owner || !profile || !version) return error('AGENT_SPECIALIST_BINDING_CHANGED', 'Specialist provider or owner authority changed')
    if (
      profile.exposureMode !== 'all_agent_users' &&
      !(await transaction('agentProviderGrants')
        .join('userGroups', 'userGroups.groupId', 'agentProviderGrants.groupId')
        .where('agentProviderGrants.profileId', binding.profileId)
        .andWhere('userGroups.userId', ownerId)
        .first('agentProviderGrants.profileId'))
    )
      return error('AGENT_SPECIALIST_BINDING_CHANGED', 'Specialist provider access was revoked')
  }

  async list(input: {
    readonly ownerId: number
    readonly rootSessionId: string
    readonly scopeSha256: string
    readonly maximumContexts: number
    readonly now?: Date
  }): Promise<readonly SpecialistContext[]> {
    integerBound(input.maximumContexts, 1, 8)
    if (!HashSchema.safeParse(input.scopeSha256).success) return error('INVALID_SPECIALIST_INPUT', 'Specialist source scope is invalid', 400)
    const now = input.now ?? new Date()
    return this.#knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
      await this.#session(transaction, input.ownerId, input.rootSessionId, now)
      const rows = await transaction<ContextRow>('agentSpecialistContexts')
        .where({ ownerId: input.ownerId, rootSessionId: input.rootSessionId, scopeSha256: input.scopeSha256 })
        .whereNull('scrubbedAt')
        .where('expiresAt', '>', now)
        .whereNotExists(function activeInvocation() {
          this.select(transaction.raw('1'))
            .from('agentSpecialistInvocations')
            .where('agentSpecialistInvocations.contextId', transaction.ref('agentSpecialistContexts.id'))
            .andWhere('agentSpecialistInvocations.status', 'running')
        })
        .orderBy('lastUsedAt', 'desc')
        .orderBy('id')
        .limit(input.maximumContexts)
      return rows.map(decodeContext)
    })
  }

  async readInvocation(input: {
    readonly ownerId: number
    readonly rootSessionId: string
    readonly rootRunId: string
  }): Promise<SpecialistInvocationView | null> {
    const row = await this.#knex<InvocationRow>('agentSpecialistInvocations').where(input).first()
    if (!row) return null
    const invocation = decodeInvocation(row)
    return new Date(row.expiresAt).valueOf() <= Date.now() ? { ...invocation, report: null } : invocation
  }

  async begin(
    rootClaim: AgentRunClaim,
    input: BeginSpecialistInvocationInput
  ): Promise<{ readonly context: SpecialistContext; readonly invocation: SpecialistInvocationView; readonly replayed: boolean }> {
    integerBound(input.maximumContexts, 1, 8)
    integerBound(input.maximumContextBytes, 4_096, MAX_CONTEXT_BYTES)
    if (
      !BindingSchema.safeParse(input.binding).success ||
      !HashSchema.safeParse(input.scopeSha256).success ||
      !RoutingTaskClassSchema.safeParse(input.taskClass).success ||
      !RoutingComplexitySchema.safeParse(input.complexity).success ||
      (input.contextId === null
        ? input.contextVersion !== null
        : !z.uuid().safeParse(input.contextId).success || !Number.isSafeInteger(input.contextVersion) || (input.contextVersion ?? 0) < 1)
    )
      return error('INVALID_SPECIALIST_INPUT', 'Specialist binding or context selection is invalid', 400)
    const expiresAt = new Date(input.expiresAt)
    if (!Number.isFinite(expiresAt.valueOf())) return error('INVALID_SPECIALIST_INPUT', 'Specialist expiry is invalid', 400)
    return this.#knex.transaction(async transaction => {
      const now = new Date()
      const session = await this.#claim(transaction, rootClaim, now)
      await this.#binding(transaction, rootClaim.ownerId, input.binding)
      if (expiresAt.valueOf() <= now.valueOf() || (session.expiresAt !== null && expiresAt.valueOf() > new Date(session.expiresAt).valueOf()))
        return error('AGENT_SPECIALIST_EXPIRED', 'Specialist expiry must fit root retention and the host source expiry')
      const fingerprint = beginHash(input)
      const existing = await transaction<InvocationRow>('agentSpecialistInvocations').where({ rootRunId: rootClaim.id }).forUpdate().first()
      if (existing) {
        if (existing.ownerId !== rootClaim.ownerId || existing.rootSessionId !== rootClaim.sessionId || existing.beginSha256 !== fingerprint)
          return error('AGENT_SPECIALIST_INVOCATION_CONFLICT', 'Root run already has a different specialist invocation')
        const row = await transaction<ContextRow>('agentSpecialistContexts')
          .where({ id: existing.contextId, ownerId: rootClaim.ownerId, rootSessionId: rootClaim.sessionId })
          .forUpdate()
          .first()
        if (!row || row.scrubbedAt !== null || new Date(row.expiresAt).valueOf() <= now.valueOf() || new Date(existing.expiresAt).valueOf() <= now.valueOf())
          return error('AGENT_SPECIALIST_EXPIRED', 'Specialist receipt context has expired')
        const context = decodeContext(row)
        if (canonicalJson(context.binding) !== canonicalJson(input.binding) || context.scopeSha256 !== input.scopeSha256)
          return error('AGENT_SPECIALIST_BINDING_CHANGED', 'Specialist receipt binding changed')
        encoded(context, input.maximumContextBytes)
        await this.#claim(transaction, rootClaim, new Date())
        if (Math.min(expiresAt.valueOf(), new Date(context.expiresAt).valueOf(), new Date(existing.expiresAt).valueOf()) <= Date.now())
          return error('AGENT_SPECIALIST_EXPIRED', 'Specialist receipt context expired before replay')
        // Running or failed replay is a durable no-dispatch receipt, never a retry permission.
        return { context, invocation: decodeInvocation(existing), replayed: true }
      }
      let context: SpecialistContext
      if (input.contextId !== null) {
        const row = await transaction<ContextRow>('agentSpecialistContexts')
          .where({ id: input.contextId, ownerId: rootClaim.ownerId, rootSessionId: rootClaim.sessionId })
          .forUpdate()
          .first()
        if (!row) return error('AGENT_RESOURCE_NOT_FOUND', 'Specialist context was not found', 404)
        context = decodeContext(row)
        if (row.scrubbedAt !== null || new Date(context.expiresAt).valueOf() <= now.valueOf())
          return error('AGENT_SPECIALIST_EXPIRED', 'Specialist context has expired')
        if (context.version !== input.contextVersion) return error('AGENT_SPECIALIST_VERSION_CHANGED', 'Specialist context version changed')
        if (
          canonicalJson(context.binding) !== canonicalJson(input.binding) ||
          context.scopeSha256 !== input.scopeSha256 ||
          context.taskClass !== input.taskClass ||
          context.complexity !== input.complexity
        )
          return error('AGENT_SPECIALIST_BINDING_CHANGED', 'Specialist context has a different immutable binding or source scope')
        if (await transaction('agentSpecialistInvocations').where({ contextId: context.id, status: 'running' }).first('id'))
          return error('AGENT_SPECIALIST_CONTEXT_BUSY', 'Specialist context has an unresolved invocation')
        encoded(context, input.maximumContextBytes)
      } else {
        const retained = await transaction('agentSpecialistContexts')
          .where({ ownerId: rootClaim.ownerId, rootSessionId: rootClaim.sessionId })
          .where(query =>
            query.where('expiresAt', '>', now).orWhereExists(function activeContext() {
              this.select(transaction.raw('1'))
                .from('agentSpecialistInvocations')
                .where('agentSpecialistInvocations.contextId', transaction.ref('agentSpecialistContexts.id'))
                .andWhere('agentSpecialistInvocations.status', 'running')
                .modify(active => liveRoot(active, transaction))
            })
          )
          .count<{ count: number | string }[]>({ count: '*' })
        if (Number(retained[0]?.count ?? 0) >= input.maximumContexts)
          return error('AGENT_SPECIALIST_CONTEXT_LIMIT', 'Root conversation specialist context limit was reached')
        context = {
          id: randomUUID(),
          ownerId: rootClaim.ownerId,
          rootSessionId: rootClaim.sessionId,
          binding: input.binding,
          scopeSha256: input.scopeSha256,
          taskClass: input.taskClass,
          complexity: input.complexity,
          version: 1,
          turnCount: 0,
          history: [],
          state: null,
          lastReport: '',
          authoritySha256: null,
          expiresAt: expiresAt.toISOString(),
          lastUsedAt: now.toISOString()
        }
        await transaction('agentSpecialistContexts').insert({
          id: context.id,
          ownerId: context.ownerId,
          rootSessionId: context.rootSessionId,
          scopeSha256: context.scopeSha256,
          ...contextPatch(context, input.maximumContextBytes),
          scrubbedAt: null
        })
      }
      const invocation: SpecialistInvocationView = {
        id: randomUUID(),
        contextId: context.id,
        rootRunId: rootClaim.id,
        profileVersionId: input.binding.profileVersionId,
        model: input.binding.model,
        taskClass: input.taskClass,
        status: 'running',
        reused: input.contextId !== null,
        contextVersion: context.version,
        report: null,
        errorCode: null,
        startedAt: now.toISOString(),
        completedAt: null
      }
      await transaction('agentSpecialistInvocations').insert({
        id: invocation.id,
        ownerId: rootClaim.ownerId,
        rootSessionId: rootClaim.sessionId,
        rootRunId: rootClaim.id,
        contextId: context.id,
        ...invocationPatch(invocation),
        beginSha256: fingerprint,
        completionSha256: null,
        rootAttempt: rootClaim.attempts,
        rootLeaseOwner: rootClaim.leaseOwner,
        rootLeaseToken: rootClaim.leaseToken,
        maximumContextBytes: input.maximumContextBytes,
        expiresAt: new Date(Math.min(expiresAt.valueOf(), new Date(context.expiresAt).valueOf())),
        startedAt: now,
        scrubbedAt: null
      })
      await this.#claim(transaction, rootClaim, new Date())
      if (Math.min(expiresAt.valueOf(), new Date(context.expiresAt).valueOf()) <= Date.now())
        return error('AGENT_SPECIALIST_EXPIRED', 'Specialist context expired before dispatch')
      return { context, invocation, replayed: false }
    })
  }

  async complete(rootClaim: AgentRunClaim, invocationId: string, input: CompleteSpecialistInvocationInput): Promise<SpecialistInvocationView> {
    integerBound(input.maximumContextBytes, 4_096, MAX_CONTEXT_BYTES)
    integerBound(input.maximumReportBytes, 1, MAX_REPORT_BYTES)
    if (
      !HistorySchema.safeParse(input.history).success ||
      !StateSchema.safeParse(input.state).success ||
      typeof input.report !== 'string' ||
      !HashSchema.nullable().safeParse(input.authoritySha256).success
    )
      return error('INVALID_SPECIALIST_INPUT', 'Specialist completion is invalid', 400)
    if (Buffer.byteLength(input.report, 'utf8') > input.maximumReportBytes)
      return error('AGENT_SPECIALIST_REPORT_TOO_LARGE', 'Specialist report exceeds its persistence limit')
    const fingerprint = completionHash(input)
    return this.#knex.transaction(async transaction => {
      const now = new Date()
      const session = await this.#claim(transaction, rootClaim, now)
      const row = await transaction<InvocationRow>('agentSpecialistInvocations')
        .where({ id: invocationId, rootRunId: rootClaim.id, ownerId: rootClaim.ownerId, rootSessionId: rootClaim.sessionId })
        .forUpdate()
        .first()
      if (!row) return error('AGENT_RESOURCE_NOT_FOUND', 'Specialist invocation was not found', 404)
      const invocation = decodeInvocation(row)
      if (row.status === 'failed') return error('AGENT_SPECIALIST_INVOCATION_FAILED', 'Specialist invocation cannot be completed after failure')
      const contextRow = await transaction<ContextRow>('agentSpecialistContexts')
        .where({ id: row.contextId, ownerId: rootClaim.ownerId, rootSessionId: rootClaim.sessionId })
        .forUpdate()
        .first()
      if (
        !contextRow ||
        contextRow.scrubbedAt !== null ||
        new Date(row.expiresAt).valueOf() <= now.valueOf() ||
        new Date(contextRow.expiresAt).valueOf() <= now.valueOf()
      )
        return error('AGENT_SPECIALIST_EXPIRED', 'Specialist invocation context has expired')
      const context = decodeContext(contextRow)
      await this.#binding(transaction, rootClaim.ownerId, context.binding)
      if (row.status === 'completed') {
        if (row.completionSha256 !== fingerprint) return error('AGENT_SPECIALIST_INVOCATION_CONFLICT', 'Completed specialist receipt is immutable')
        await this.#claim(transaction, rootClaim, new Date())
        if (Math.min(new Date(row.expiresAt).valueOf(), new Date(context.expiresAt).valueOf()) <= Date.now())
          return error('AGENT_SPECIALIST_EXPIRED', 'Specialist receipt context expired before replay')
        return invocation
      }
      if (row.rootAttempt !== rootClaim.attempts || row.rootLeaseOwner !== rootClaim.leaseOwner || row.rootLeaseToken !== rootClaim.leaseToken)
        return error('RUN_LEASE_LOST', 'Specialist invocation belongs to a different root lease')
      if (context.version !== row.contextVersion) return error('AGENT_SPECIALIST_VERSION_CHANGED', 'Specialist context changed during invocation')
      if (context.turnCount > 0 && context.authoritySha256 !== input.authoritySha256)
        return error('AGENT_SPECIALIST_AUTHORITY_CHANGED', 'Specialist authority binding changed')
      if (
        input.history.length < context.history.length ||
        context.history.some((message, index) => message.role !== input.history[index]?.role || message.content !== input.history[index]?.content)
      )
        return error('AGENT_SPECIALIST_HISTORY_CHANGED', 'Specialist completion must preserve its retained history')
      const expiry = Math.min(
        new Date(context.expiresAt).valueOf(),
        new Date(row.expiresAt).valueOf(),
        session.expiresAt === null ? Infinity : new Date(session.expiresAt).valueOf()
      )
      const next: SpecialistContext = {
        ...context,
        version: context.version + 1,
        turnCount: context.turnCount + 1,
        history: input.history,
        state: input.state,
        lastReport: input.report,
        authoritySha256: input.authoritySha256,
        expiresAt: new Date(expiry).toISOString(),
        lastUsedAt: now.toISOString()
      }
      const changed = await transaction('agentSpecialistContexts')
        .where({ id: context.id, ownerId: rootClaim.ownerId, rootSessionId: rootClaim.sessionId, version: row.contextVersion })
        .whereNull('scrubbedAt')
        .update(contextPatch(next, Math.min(row.maximumContextBytes, input.maximumContextBytes)))
      if (changed !== 1) return error('AGENT_SPECIALIST_VERSION_CHANGED', 'Specialist context changed during commit')
      const completed: SpecialistInvocationView = {
        ...invocation,
        status: 'completed',
        contextVersion: next.version,
        report: input.report,
        completedAt: now.toISOString()
      }
      if (
        (await transaction('agentSpecialistInvocations')
          .where({ id: invocationId, status: 'running', rootLeaseToken: rootClaim.leaseToken })
          .update({ ...invocationPatch(completed), completionSha256: fingerprint })) !== 1
      )
        return error('AGENT_SPECIALIST_INVOCATION_CONFLICT', 'Specialist invocation changed during commit')
      await this.#claim(transaction, rootClaim, new Date())
      if (expiry <= Date.now()) return error('AGENT_SPECIALIST_EXPIRED', 'Specialist context expired before commit')
      return completed
    })
  }

  async fail(rootClaim: AgentRunClaim, invocationId: string, errorCode: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(errorCode)) return error('INVALID_SPECIALIST_INPUT', 'Specialist failure code is invalid', 400)
    await this.#knex.transaction(async transaction => {
      const now = new Date()
      await this.#claim(transaction, rootClaim, now, true)
      const row = await transaction<InvocationRow>('agentSpecialistInvocations')
        .where({ id: invocationId, rootRunId: rootClaim.id, ownerId: rootClaim.ownerId, rootSessionId: rootClaim.sessionId })
        .forUpdate()
        .first()
      if (!row) return error('AGENT_RESOURCE_NOT_FOUND', 'Specialist invocation was not found', 404)
      const invocation = decodeInvocation(row)
      if (row.status !== 'running') return
      if (row.rootAttempt !== rootClaim.attempts || row.rootLeaseOwner !== rootClaim.leaseOwner || row.rootLeaseToken !== rootClaim.leaseToken)
        return error('RUN_LEASE_LOST', 'Specialist invocation belongs to a different root lease')
      await transaction('agentSpecialistInvocations')
        .where({ id: invocationId, status: 'running', rootLeaseToken: rootClaim.leaseToken })
        .update(invocationPatch({ ...invocation, status: 'failed', errorCode, completedAt: now.toISOString() }))
      await this.#claim(transaction, rootClaim, new Date(), true)
    })
  }

  async listInvocations(ownerId: number, rootSessionId: string, rootRunIds?: readonly string[]): Promise<readonly SpecialistInvocationView[]> {
    if (rootRunIds !== undefined) {
      if (rootRunIds.length === 0) return []
      if (rootRunIds.length > 100 || rootRunIds.some(id => !z.uuid().safeParse(id).success))
        return error('INVALID_SPECIALIST_INPUT', 'Specialist receipt selection is invalid', 400)
    }
    const now = Date.now()
    const query = this.#knex<InvocationRow>('agentSpecialistInvocations').where({ ownerId, rootSessionId })
    if (rootRunIds !== undefined) query.whereIn('rootRunId', [...new Set(rootRunIds)])
    return (await query.orderBy('startedAt').orderBy('id')).map(row => {
      const invocation = decodeInvocation(row)
      return new Date(row.expiresAt).valueOf() <= now ? { ...invocation, report: null } : invocation
    })
  }

  /** Erase expired content, not durable no-dispatch receipts or accounting. Active contexts are never reclaimed. */
  async expire(now = new Date()): Promise<number> {
    return this.#knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction)
      const rows = await transaction<ContextRow>('agentSpecialistContexts')
        .whereNull('scrubbedAt')
        .where('expiresAt', '<=', now)
        .whereNotExists(function activeContext() {
          this.select(transaction.raw('1'))
            .from('agentSpecialistInvocations')
            .where('agentSpecialistInvocations.contextId', transaction.ref('agentSpecialistContexts.id'))
            .andWhere('agentSpecialistInvocations.status', 'running')
            .modify(query => liveRoot(query, transaction))
        })
        .orderBy('expiresAt')
        .orderBy('id')
        .limit(100)
        .forUpdate()
      for (const row of rows) {
        const context = decodeContext(row)
        await transaction('agentSpecialistContexts')
          .where({ id: row.id, version: row.version })
          .whereNull('scrubbedAt')
          .update({ ...contextPatch({ ...context, history: [], state: null, lastReport: '' }, MAX_CONTEXT_BYTES), scrubbedAt: now })
      }
      const receipts = await transaction<InvocationRow>('agentSpecialistInvocations')
        .whereNull('scrubbedAt')
        .where('expiresAt', '<=', now)
        .whereNot(query => query.where({ status: 'running' }).modify(active => liveRoot(active, transaction)))
        .orderBy('expiresAt')
        .orderBy('id')
        .limit(100)
        .forUpdate()
      for (const row of receipts) {
        const invocation = decodeInvocation(row)
        await transaction('agentSpecialistInvocations')
          .where({ id: row.id })
          .whereNull('scrubbedAt')
          .update({ ...invocationPatch({ ...invocation, report: null }), scrubbedAt: now })
      }
      return rows.length
    })
  }
}

export const expireAgentSpecialistContexts = async (knex: Knex, now = new Date()): Promise<number> => new AgentSpecialistStore(knex).expire(now)
