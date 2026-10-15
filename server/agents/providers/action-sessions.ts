import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import type { AgentActionName, AgentFeatureFlags, RequestAuthContext } from '../../../shared/agents/contracts.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { ACTION_CATALOG, type ActionCapability, type ActionCapabilityOutputKind, type ActionProviderPresentationFamily } from '../actions/catalog.ts'
import { type ActionAdmissionSnapshot, type ActionAuthority, ActionKernel } from '../actions/kernel.ts'
import { markAgentRunSideEffectsStarted } from '../coordinator.ts'
import { SUBAGENT_READ_ACTIONS } from '../orchestration.ts'
import { AgentRepositoryError } from '../repository.ts'
import { getOwnedProposal } from '../proposals/repository.ts'
import type { AgentEngineRequest } from '../runtime.ts'
import type { AgentActionSessionProvider } from './engine.ts'
import { type AxActionSession, AxSessionHarness } from './session-harness.ts'
import { readSpecialistContinuation, specialistContextSha256 } from './specialist-continuation.ts'

interface RuntimeSnapshotRow {
  runtimeStateCiphertext: Uint8Array | null
}

export interface KernelActionSessionDependencies {
  readonly knex: Knex
  readonly kernel: ActionKernel
  readonly resolveAdmission: (request: AgentEngineRequest) => Promise<ActionAdmissionSnapshot>
  readonly refreshAdmission: (request: AgentEngineRequest) => Promise<ActionAdmissionSnapshot>
  readonly validateObservation?: (
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

const WIKI_PAGE_SOURCE_CAPABILITIES: Readonly<
  Partial<Record<AgentActionName, { readonly providerPresentationFamily: ActionProviderPresentationFamily; readonly outputKind: ActionCapabilityOutputKind }>>
> = {
  'pages.get': { providerPresentationFamily: 'wiki.page', outputKind: 'verified-source' },
  'pages.getOkf': { providerPresentationFamily: 'wiki.okf', outputKind: 'verified-source' },
  'pages.readForPatch': { providerPresentationFamily: 'wiki.patch-snapshot', outputKind: 'verified-source' },
  'pages.listRecent': { providerPresentationFamily: 'wiki.recent-source', outputKind: 'verified-source' },
  'pages.listHistory': { providerPresentationFamily: 'wiki.history', outputKind: 'candidate-lead' },
  'pages.getVersion': { providerPresentationFamily: 'wiki.historical-page', outputKind: 'verified-source' }
}

const hasRecentPageSourceEvidenceRow = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const citation = row.citation
  if (typeof citation !== 'object' || citation === null || Array.isArray(citation)) return false
  const citationRow = citation as Record<string, unknown>
  return (
    typeof row.id === 'number' &&
    Number.isSafeInteger(row.id) &&
    row.id > 0 &&
    typeof row.locale === 'string' &&
    row.locale.length > 0 &&
    typeof row.path === 'string' &&
    row.path.length > 0 &&
    typeof row.contentType === 'string' &&
    row.contentType === 'markdown' &&
    typeof row.sourceRevision === 'string' &&
    row.sourceRevision.length > 0 &&
    typeof row.updatedAt === 'string' &&
    Number.isFinite(Date.parse(row.updatedAt)) &&
    typeof row.content === 'string' &&
    typeof row.sourceContentCharacters === 'number' &&
    Number.isSafeInteger(row.sourceContentCharacters) &&
    row.sourceContentCharacters >= row.content.length &&
    typeof row.contentTruncated === 'boolean' &&
    row.contentTruncated === row.content.length < row.sourceContentCharacters &&
    typeof citationRow.evidenceId === 'string' &&
    citationRow.evidenceId === `page:${row.id}:revision:${row.sourceRevision}` &&
    typeof citationRow.label === 'string' &&
    citationRow.label.length > 0 &&
    typeof citationRow.href === 'string' &&
    citationRow.href.length > 0
  )
}

const hasWikiPageSourceCapability = (actionName: AgentActionName, capability: ActionCapability | undefined): boolean => {
  const expected = WIKI_PAGE_SOURCE_CAPABILITIES[actionName]
  return (
    capability !== undefined &&
    expected !== undefined &&
    capability.providerPresentationFamily === expected.providerPresentationFamily &&
    capability.outputKinds.length === 1 &&
    capability.outputKinds[0] === expected.outputKind
  )
}

const hasWikiPageSourceOutput = (actionName: AgentActionName, output: unknown): boolean => {
  if (actionName === 'pages.listHistory') return false
  if (actionName !== 'pages.listRecent') return true
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return false
  if (Reflect.get(output, 'kind') !== 'recent-page-evidence') return false
  const rows = Reflect.get(output, 'pages')
  return Array.isArray(rows) && rows.some(hasRecentPageSourceEvidenceRow)
}

const hasWikiApplicationCapability = (actionName: AgentActionName, capability: ActionCapability | undefined): boolean =>
  actionName === 'pages.applyProposal' &&
  capability?.providerPresentationFamily === 'wiki.proposal' &&
  capability.operationRole === 'apply' &&
  capability.outputKinds.length === 1 &&
  capability.outputKinds[0] === 'operation-receipt'

const AppliedPageId = z.number().int().positive()
const AppliedResultIdentity = z.record(z.string(), z.unknown())
const ApplicationMetadata = z.object({
  kind: z.enum(['create', 'patch', 'move', 'restore', 'delete']),
  pageId: AppliedPageId.nullable(),
  resultIdentity: AppliedResultIdentity
})

const validateCommittedApplication = async (knex: Knex, authority: ActionAuthority, output: unknown): Promise<boolean> => {
  const receipt = ACTION_CATALOG['pages.applyProposal'].output.safeParse(output)
  if (!receipt.success || authority.requester.kind !== 'user' || authority.transport !== 'agent') return false
  const { proposal, approval } = await getOwnedProposal(knex, authority.requester.userId, receipt.data.proposalId)
  if (
    proposal.status !== 'applied' ||
    approval.status !== 'approved' ||
    approval.approvedByUserId !== authority.requester.userId ||
    approval.inputHash !== proposal.inputHash ||
    approval.authoritySha256 !== proposal.authoritySha256 ||
    approval.authorityVersion !== proposal.authorityVersion ||
    approval.patchSha256 !== (proposal.patchSha256 ?? null) ||
    approval.resultCanonicalSha256 !== (proposal.resultCanonicalSha256 ?? null) ||
    approval.diffSha256 !== (proposal.diffSha256 ?? null)
  )
    return false
  const execution = await knex('agentActionExecutions')
    .where({
      proposalId: proposal.id,
      runId: proposal.runId,
      actionName: proposal.actionName,
      requesterUserId: authority.requester.userId,
      requesterApiKeyId: null,
      approvedByUserId: approval.approvedByUserId,
      inputHash: proposal.inputHash,
      status: 'committed'
    })
    .first('result')
  if (
    typeof execution?.result !== 'string' ||
    execution.result !== proposal.applyResult ||
    createHash('sha256').update(execution.result).digest('hex') !== receipt.data.resultHash
  )
    return false
  const metadata = ApplicationMetadata.safeParse(JSON.parse(proposal.operation))
  if (!metadata.success) return false
  const committed = AppliedResultIdentity.safeParse(JSON.parse(execution.result))
  if (!committed.success) return false
  const stableId = AppliedPageId.safeParse(committed.data.pageId)
  const approvedResult = canonicalJson(metadata.data.resultIdentity)
  const dynamicCreate =
    metadata.data.kind === 'create' &&
    proposal.resultCanonicalSha256 === null &&
    stableId.success &&
    canonicalJson(committed.data) === canonicalJson({ ...metadata.data.resultIdentity, pageId: stableId.data })
  if (canonicalJson(committed.data) !== approvedResult && !dynamicCreate) return false
  const page = receipt.data.page
  // A null page discloses status only; it is not evidence of deletion.
  if (page === null) return true
  const pageId = metadata.data.kind === 'create' ? (stableId.success ? stableId.data : null) : metadata.data.pageId
  return metadata.data.kind !== 'delete' && pageId === page.id
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
    const continuation = readSpecialistContinuation(request)
    const admission = await this.#dependencies.resolveAdmission(request)
    const offered = this.#dependencies.kernel
      .offer(authFor(request), admission, request.run.id)
      .filter(
        action =>
          request.purpose !== 'subagent' ||
          (request.actionAllowlist!.includes(action.definition.descriptor.name) &&
            action.definition.descriptor.risk === 'read' &&
            (!request.specialist || SUBAGENT_READ_ACTIONS.includes(action.definition.descriptor.name as (typeof SUBAGENT_READ_ACTIONS)[number])))
      )
    if (offered.length === 0) {
      if (
        continuation &&
        (continuation.authoritySha256 !== specialistContextSha256([]) ||
          continuation.evidenceMessages.length > 0 ||
          Object.keys(continuation.actionSnapshot).length > 0)
      )
        throw new AgentRepositoryError('AGENT_SPECIALIST_CONTINUATION_INVALID', 'Specialist tool authority is no longer available', 409)
      return null
    }
    const row = (await this.#dependencies
      .knex('agentRuns')
      .where({ id: request.run.id, ownerId: request.run.ownerId, leaseOwner: request.run.leaseOwner, leaseToken: request.run.leaseToken })
      .first(request.purpose === 'subagent' ? 'id' : 'runtimeStateCiphertext')) as RuntimeSnapshotRow | undefined
    if (!row) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run lease was lost before opening its action session', 409)
    const revalidateObservation = this.#dependencies.validateObservation
      ? async (actionName: AgentActionName, output: unknown, signal: AbortSignal): Promise<boolean> => {
          const originalAction = offered.find(action => action.definition.descriptor.name === actionName)
          if (
            signal.aborted ||
            !originalAction ||
            !(
              hasWikiApplicationCapability(actionName, originalAction.definition.capability) ||
              (hasWikiPageSourceCapability(actionName, originalAction.definition.capability) && hasWikiPageSourceOutput(actionName, output))
            )
          )
            return false
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
            if (
              !currentAction ||
              signal.aborted ||
              !(
                hasWikiApplicationCapability(actionName, currentAction.definition.capability) ||
                hasWikiPageSourceCapability(actionName, currentAction.definition.capability)
              )
            )
              return false
            // Operation receipts are not source evidence. Authenticate the
            // committed result before checking current read authority below.
            if (actionName === 'pages.applyProposal' && !(await validateCommittedApplication(this.#dependencies.knex, currentAction.authority, output)))
              return false
            const valid = await this.#dependencies.validateObservation?.(request, currentAction.authority, actionName, output, signal)
            return valid === true && !signal.aborted
          } catch (error: unknown) {
            if (signal.aborted || isAdmissionRejection(error)) return false
            throw error
          }
        }
      : undefined
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
      ...(revalidateObservation
        ? {
            validateObservation: (actionName: AgentActionName, output: unknown, signal: AbortSignal) => revalidateObservation(actionName, output, signal)
          }
        : {})
    })
    const specialistAuthoritySha256 = createHash('sha256')
      .update(
        canonicalJson(
          offered
            .map(action => {
              const { requestId: _requestId, authoritySha256: _authoritySha256, ...authority } = action.authority
              return {
                authority,
                descriptor: action.definition.descriptor,
                parameters: z.toJSONSchema(action.definition.input),
                capability: action.definition.capability
              }
            })
            .sort((left, right) => left.descriptor.name.localeCompare(right.descriptor.name))
        )
      )
      .digest('hex')
    if (continuation) {
      if (continuation.authoritySha256 !== specialistAuthoritySha256 || !revalidateObservation)
        throw new AgentRepositoryError('AGENT_SPECIALIST_CONTINUATION_INVALID', 'Specialist tool authority cannot be safely restored', 409)
      for (const evidence of continuation.evidenceMessages) {
        for (const receipt of evidence.receipts ?? [evidence]) {
          if (!(await revalidateObservation(receipt.actionName, receipt.sourceOutput, request.signal)))
            throw new AgentRepositoryError('AGENT_SPECIALIST_CONTINUATION_INVALID', 'Specialist source evidence is stale or no longer authorized', 409)
        }
      }
    }
    const session = await harness.open(offered, request.purpose === 'subagent' ? continuation?.actionSnapshot : decodeSnapshot(row.runtimeStateCiphertext))
    const authoritySha256 = createHash('sha256')
      .update(
        canonicalJson(
          offered
            .map(action => ({ actionName: action.definition.descriptor.name, authoritySha256: action.authority.authoritySha256 }))
            .sort((left, right) => left.actionName.localeCompare(right.actionName))
        )
      )
      .digest('hex')
    return {
      ...session,
      authoritySha256,
      specialistAuthoritySha256,
      ...(admission.allowedActions === undefined ? {} : { allowedActions: admission.allowedActions }),
      authorizeSyntheticAction: async (name: AgentActionName, signal: AbortSignal): Promise<boolean> => {
        if (signal.aborted) return false
        let current: ActionAdmissionSnapshot
        try {
          current = await this.#dependencies.refreshAdmission(request)
        } catch (error: unknown) {
          if (signal.aborted || isAdmissionRejection(error)) return false
          throw error
        }
        return !signal.aborted && current.supportsTools && (current.allowedActions === undefined || current.allowedActions.includes(name))
      }
    }
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
