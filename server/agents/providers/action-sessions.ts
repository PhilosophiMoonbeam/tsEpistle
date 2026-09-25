import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { AgentActionName, AgentFeatureFlags, RequestAuthContext } from '../../../shared/agents/contracts.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { ActionKernel, type ActionAdmissionSnapshot, type ActionAuthority } from '../actions/kernel.ts'
import type { AgentEngineRequest } from '../runtime.ts'
import { markAgentRunSideEffectsStarted } from '../coordinator.ts'
import { AgentRepositoryError } from '../repository.ts'
import { AxSessionHarness, type AxActionSession } from './session-harness.ts'
import type { AgentActionSessionProvider } from './engine.ts'

interface RuntimeSnapshotRow {
  runtimeStateCiphertext: Uint8Array | null
}

export interface KernelActionSessionDependencies {
  readonly knex: Knex
  readonly kernel: ActionKernel
  readonly resolveAdmission: (request: AgentEngineRequest) => Promise<ActionAdmissionSnapshot>
  readonly refreshAdmission: (request: AgentEngineRequest) => Promise<ActionAdmissionSnapshot>
  readonly validatePageEvidence?: (
    request: AgentEngineRequest,
    authority: ActionAuthority,
    actionName: AgentActionName,
    output: unknown,
    signal: AbortSignal
  ) => Promise<boolean>
  readonly timeoutMilliseconds?: number
}
const isAdmissionRejection = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const status = Reflect.get(error, 'status')
  return Number.isInteger(status) && Number(status) >= 400 && Number(status) < 500
}

const decodeSnapshot = (value: Uint8Array | null): Readonly<Record<string, unknown>> | undefined => {
  if (value === null) return undefined
  if (value.byteLength > 256 * 1_024) throw new AgentRepositoryError('RUNTIME_SNAPSHOT_CORRUPT', 'Stored runtime snapshot is too large', 500)
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid snapshot')
    return parsed as Readonly<Record<string, unknown>>
  } catch {
    throw new AgentRepositoryError('RUNTIME_SNAPSHOT_CORRUPT', 'Stored runtime snapshot is invalid', 500)
  }
}

const authFor = (request: AgentEngineRequest): RequestAuthContext => ({
  kind: 'user',
  userId: request.run.ownerId,
  ownershipUserId: request.run.ownerId,
  principal: { id: request.run.ownerId }
})

export class KernelActionSessionProvider implements AgentActionSessionProvider {
  readonly #dependencies: KernelActionSessionDependencies

  constructor(dependencies: KernelActionSessionDependencies) {
    this.#dependencies = dependencies
  }

  async open(request: AgentEngineRequest): Promise<AxActionSession | null> {
    if (request.purpose === 'subagent' && request.actionAllowlist === undefined)
      throw new AgentRepositoryError('INVALID_SUBAGENT_AUTHORITY', 'Subagent action authority must be explicitly bounded', 500)
    const admission = await this.#dependencies.resolveAdmission(request)
    const offered = this.#dependencies.kernel.offer(authFor(request), admission, request.run.id)
    if (offered.length === 0) return null
    const row = (await this.#dependencies
      .knex('agentRuns')
      .where({ id: request.run.id, ownerId: request.run.ownerId, leaseOwner: request.run.leaseOwner, leaseToken: request.run.leaseToken })
      .first('runtimeStateCiphertext')) as RuntimeSnapshotRow | undefined
    if (!row) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost before opening its action session', 409)
    const harness = new AxSessionHarness({
      ...(this.#dependencies.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: this.#dependencies.timeoutMilliseconds }),
      execute: (action, input, signal, actionCallId) =>
        this.#dependencies.kernel.execute({
          authority: action.authority,
          ...(request.knowledgeContext ? { knowledgeContext: request.knowledgeContext } : {}),
          actionCallId,
          input,
          signal,
          refreshAdmission: () => this.#dependencies.refreshAdmission(request),
          fenceSideEffect: () => markAgentRunSideEffectsStarted(this.#dependencies.knex, request.run)
        }),
      ...(this.#dependencies.validatePageEvidence
        ? {
            validatePageEvidence: async (actionName: AgentActionName, output: unknown, signal: AbortSignal): Promise<boolean> => {
              if (signal.aborted || !offered.some(action => action.definition.descriptor.name === actionName)) return false
              let currentAdmission: ActionAdmissionSnapshot
              try {
                currentAdmission = await this.#dependencies.refreshAdmission(request)
              } catch (error: unknown) {
                if (signal.aborted || isAdmissionRejection(error)) return false
                throw error
              }
              if (signal.aborted || currentAdmission.transport !== admission.transport) return false
              try {
                const currentAction = this.#dependencies.kernel
                  .offer(authFor(request), currentAdmission, request.run.id)
                  .find(action => action.definition.descriptor.name === actionName)
                if (!currentAction || signal.aborted) return false
                const valid = await this.#dependencies.validatePageEvidence?.(request, currentAction.authority, actionName, output, signal)
                return valid === true && !signal.aborted
              } catch (error: unknown) {
                if (signal.aborted || isAdmissionRejection(error)) return false
                throw error
              }
            }
          }
        : {})
    })
    const session = await harness.open(offered, request.purpose === 'subagent' ? undefined : decodeSnapshot(row.runtimeStateCiphertext))
    const authoritySha256 = createHash('sha256')
      .update(
        canonicalJson(
          offered
            .map(action => ({ actionName: action.definition.descriptor.name, authoritySha256: action.authority.authoritySha256 }))
            .sort((left, right) => left.actionName.localeCompare(right.actionName))
        )
      )
      .digest('hex')
    return { ...session, authoritySha256 }
  }

  async saveSnapshot(request: AgentEngineRequest, snapshot: Readonly<Record<string, unknown>>): Promise<void> {
    if (request.purpose === 'subagent') return
    const encoded = JSON.stringify(snapshot)
    if (Buffer.byteLength(encoded, 'utf8') > 256 * 1_024)
      throw new AgentRepositoryError('RUNTIME_SNAPSHOT_TOO_LARGE', 'Runtime snapshot exceeds its size limit', 500)
    const changed = await this.#dependencies
      .knex('agentRuns')
      .where({ id: request.run.id, ownerId: request.run.ownerId, leaseOwner: request.run.leaseOwner, leaseToken: request.run.leaseToken })
      .whereIn('status', ['running', 'awaiting_approval'])
      .whereNull('cancelRequestedAt')
      .update({ runtimeStateCiphertext: Buffer.from(encoded), updatedAt: new Date() })
    if (changed !== 1) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost while saving its runtime snapshot', 409)
  }
}

export const agentFeatureFlags = (value: Partial<AgentFeatureFlags>): AgentFeatureFlags => ({
  'agents.enabled': value['agents.enabled'] ?? false,
  'agents.provider.enabled': value['agents.provider.enabled'] ?? false,
  'agents.orchestration.enabled': value['agents.orchestration.enabled'] ?? false,
  'agents.skills.enabled': value['agents.skills.enabled'] ?? false,
  'agents.browser.enabled': value['agents.browser.enabled'] ?? false,
  'agents.proposals.enabled': value['agents.proposals.enabled'] ?? false,
  'agents.writes.enabled': value['agents.writes.enabled'] ?? false,
  'agents.writes.create.enabled': value['agents.writes.create.enabled'] ?? false,
  'agents.writes.patch.enabled': value['agents.writes.patch.enabled'] ?? false,
  'agents.writes.move.enabled': value['agents.writes.move.enabled'] ?? false,
  'agents.writes.restore.enabled': value['agents.writes.restore.enabled'] ?? false,
  'agents.writes.delete.enabled': value['agents.writes.delete.enabled'] ?? false,
  'agents.mcp.enabled': value['agents.mcp.enabled'] ?? false
})
