import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { fetch as undiciFetch } from 'undici/index.js'
import type { AxAIService, AxChatResponse } from '@ax-llm/ax'
import { acquireAgentCoordinatorAdvisoryLocks, admitAgentRunInTransaction, heartbeatAgentRun, terminalizeAgentRunInTransaction, type AgentRunClaim } from '../coordinator.ts'
import { AgentRepositoryError, appendAgentEvent, createAgentSession, getOwnedAgentSession } from '../repository.ts'
import { AgentProviderFactory, agentProviderCostMicros, type AgentProviderFetch } from './factory.ts'
import { AgentProviderRegistry } from './registry.ts'
import type { AgentReasoningEffort } from '../../../shared/agents/contracts.ts'
import type { AgentSecretRegistry } from './secrets.ts'
import { readAgentProviderUsage } from './usage.ts'

export interface WikiOfflineLimits {
  readonly maximumCalls: number
  readonly maximumTokens: number
  readonly maximumCostMicros: number
  readonly maximumOutputTokens: number
}

export interface WikiOfflineUsage {
  calls: number
  dispatchedCalls: number
  failedCalls: number
  providerMilliseconds: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costMicros: number
  unknownExposureTokens: number
  unknownExposureCostMicros: number
}

export interface WikiOfflineAllowance {
  calls: number
  tokens: number
  costMicros: number
  tail?: Promise<unknown>
}

export interface WikiOfflineAdmission {
  readonly service: AxAIService
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  summary(): Readonly<WikiOfflineUsage>
  close(): Promise<void>
}

type OfflineDispatchUsage = { inputTokens: number; outputTokens: number; totalTokens: number; costMicros: number }
interface OfflineWireTool {
  readonly type?: unknown
  readonly name?: unknown
  readonly function?: { readonly name?: unknown }
  readonly function_declarations?: readonly { readonly name?: unknown }[]
}
interface OfflineWireBody {
  readonly model?: unknown
  readonly stream?: unknown
  readonly n?: unknown
  readonly background?: unknown
  readonly cachedContent?: unknown
  readonly service_tier?: unknown
  readonly speed?: unknown
  readonly max_tokens?: number
  readonly max_completion_tokens?: number
  readonly max_output_tokens?: number
  readonly generationConfig?: { readonly maxOutputTokens?: number; readonly candidateCount?: unknown }
  readonly tools?: readonly OfflineWireTool[]
}
interface OfflineSharedAllowanceState {
  readonly ownerId: number
  readonly maximumCalls: number
  readonly maximumTokens: number
  readonly maximumCostMicros: number
  tail: Promise<unknown>
  halted: boolean
}
const allowanceStates = new WeakMap<WikiOfflineAllowance, OfflineSharedAllowanceState>()
const offlineFailure = (): Error => new Error('Offline inference failed; only numeric accounting is retained')

/** Every inference owns a real, fenced run. No production tools or queued tool replay. */
export const createWikiOfflineDispatchAdmission = async (
  knex: Knex,
  input: WikiOfflineLimits & {
    readonly ownerId: number
    readonly profileVersionId: string
    readonly registry: AgentProviderRegistry
    readonly secrets: AgentSecretRegistry
    readonly reasoningEffort?: AgentReasoningEffort
    readonly label: string
    readonly sharedAllowance?: WikiOfflineAllowance
  }
): Promise<WikiOfflineAdmission> => {
  for (const value of [input.ownerId, input.maximumCalls, input.maximumTokens, input.maximumCostMicros, input.maximumOutputTokens])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Offline admission requires positive integer limits')
  let sharedState: OfflineSharedAllowanceState | undefined
  if (input.sharedAllowance) {
    for (const value of [input.sharedAllowance.calls, input.sharedAllowance.tokens, input.sharedAllowance.costMicros])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Offline shared allowance is invalid')
    sharedState = allowanceStates.get(input.sharedAllowance)
    if (sharedState && (sharedState.ownerId !== input.ownerId || sharedState.maximumCalls !== input.maximumCalls ||
      sharedState.maximumTokens !== input.maximumTokens || sharedState.maximumCostMicros !== input.maximumCostMicros))
      throw new Error('Offline shared allowance requires one account and one global limit')
    sharedState ??= { ownerId: input.ownerId, maximumCalls: input.maximumCalls, maximumTokens: input.maximumTokens,
      maximumCostMicros: input.maximumCostMicros, tail: Promise.resolve(), halted: false }
    allowanceStates.set(input.sharedAllowance, sharedState)
  }
  const version = await knex('agentProviderProfileVersions').where({ id: input.profileVersionId, conformed: true }).first('profileId')
  if (!version) throw new Error('Offline evaluation requires an existing conformed profile version')
  const session = await createAgentSession(knex, {
    ownerId: input.ownerId, title: `Offline Wiki synthesis evaluation: ${input.label}`,
    retention: 'temporary', providerProfileId: version.profileId, executionMode: 'agent',
    expiresAt: new Date(Date.now() + 86_400_000)
  })
  const binding = { ownerId: input.ownerId, sessionId: session.id, profileId: version.profileId as string, profileVersionId: input.profileVersionId }
  const initial = await knex.transaction(async transaction => {
    await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
    return input.registry.resolveRoutingCandidate(transaction, binding)
  })
  let active: {
    claim?: AgentRunClaim
    exposure?: OfflineDispatchUsage
    dispatched: boolean
    signal: AbortSignal
    controller: AbortController
    outputTokens: number
    providerStartedAt?: number
    heartbeat?: NodeJS.Timeout
    heartbeatPending?: Promise<void>
  } | undefined
  let closed = false
  let accountingFailed = false
  let tail: Promise<unknown> = Promise.resolve()
  const usage: WikiOfflineUsage = { calls: 0, dispatchedCalls: 0, failedCalls: 0, providerMilliseconds: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0, unknownExposureTokens: 0, unknownExposureCostMicros: 0 }
  const appendUsage = async (transaction: Knex.Transaction, claim: AgentRunClaim, values: OfflineDispatchUsage, unknown: boolean): Promise<void> => {
    await appendAgentEvent(transaction, { id: randomUUID(), runId: claim.id, ownerId: claim.ownerId, attempt: claim.attempts, leaseToken: claim.leaseToken, type: 'usage.updated',
      data: { purpose: 'offline.wiki-synthesis', usageVersion: 2,
        inputTokens: unknown ? 0 : values.inputTokens, outputTokens: unknown ? 0 : values.outputTokens,
        totalTokens: values.totalTokens, costMicros: values.costMicros, unknownExposure: unknown,
        receiptInputTokens: unknown ? 0 : values.inputTokens, receiptOutputTokens: unknown ? 0 : values.outputTokens,
        receiptTotalTokens: unknown ? 0 : values.totalTokens, receiptCostMicros: unknown ? 0 : values.costMicros,
        unsettledExposureTokens: unknown ? values.totalTokens : 0, unsettledExposureCostMicros: unknown ? values.costMicros : 0 } })
  }
  const assertAuthority = async (transaction: Knex.Transaction) => {
    const current = await input.registry.resolveRoutingCandidate(transaction, binding)
    if (current.profileResolutionSha256 !== initial.profileResolutionSha256 || current.ownerAuthVersion !== initial.ownerAuthVersion)
      throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Offline evaluation authority changed', 409)
    return current
  }
  const assertLease = async (transaction: Knex.Transaction, claim: AgentRunClaim): Promise<void> => {
    const run = await transaction('agentRuns').where({ id: claim.id, ownerId: claim.ownerId, status: 'running', leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
      .whereNull('cancelRequestedAt').forUpdate().first('leaseExpiresAt')
    const expiresAt = run ? new Date(run.leaseExpiresAt).valueOf() : NaN
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new AgentRepositoryError('RUN_LEASE_LOST', 'Offline evaluation lease expired or was cancelled', 409)
  }
  const guardedImplementation: AgentProviderFetch = Object.assign(async (destination: Parameters<AgentProviderFetch>[0], init?: Parameters<AgentProviderFetch>[1]) => {
    const dispatch = active
    if (!dispatch || dispatch.claim || dispatch.dispatched) throw offlineFailure()
    const signal = init?.signal ? AbortSignal.any([dispatch.signal, init.signal]) : dispatch.signal
    signal.throwIfAborted()
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw offlineFailure()
    const body = JSON.parse(init.body) as OfflineWireBody
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw offlineFailure()
    const gemini = provider.transportKind === 'gemini-api'
    const outputTokens = gemini ? body.generationConfig?.maxOutputTokens
      : provider.transportKind === 'openai-responses' || provider.transportKind === 'openresponses' ? body.max_output_tokens
      : body.max_completion_tokens ?? body.max_tokens
    if (typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > dispatch.outputTokens ||
      (!gemini && body.model !== provider.model) || (body.stream !== undefined && body.stream !== false) || (body.n !== undefined && body.n !== 1) ||
      (body.background !== undefined && body.background !== false) || body.cachedContent !== undefined || body.speed === 'fast' ||
      (body.service_tier !== undefined && body.service_tier !== 'standard' && body.service_tier !== 'default') ||
      (gemini && body.generationConfig?.candidateCount !== undefined && body.generationConfig.candidateCount !== 1))
      throw offlineFailure()
    const tools = body.tools
    if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool: OfflineWireTool) =>
      gemini ? !Array.isArray(tool.function_declarations) || Object.keys(tool).some(key => key !== 'function_declarations') ||
        tool.function_declarations.some((fn: { readonly name?: unknown }) => fn.name !== '__axOutput')
        : provider.transportKind === 'anthropic-messages' ? tool.name !== '__axOutput'
          : tool.type !== 'function' || (tool.name ?? tool.function?.name) !== '__axOutput')))
      throw offlineFailure()
    // Measure the final provider dialect, including Ax's schema, adapter defaults and effort.
    // Text-only bytes are a conservative token bound; binary/remote media is rejected below.
    const inputTokens = Buffer.byteLength(init.body, 'utf8')
    const totalTokens = inputTokens + outputTokens
    if (!Number.isSafeInteger(totalTokens) || totalTokens > provider.capabilities.maxContextTokens) throw offlineFailure()
    const exposure = { inputTokens, outputTokens, totalTokens, costMicros: agentProviderCostMicros(provider.pricing, inputTokens, outputTokens, totalTokens) }
    const spentTokens = input.sharedAllowance?.tokens ?? usage.totalTokens + usage.unknownExposureTokens
    const spentCost = input.sharedAllowance?.costMicros ?? usage.costMicros + usage.unknownExposureCostMicros
    if (exposure.totalTokens > input.maximumTokens - spentTokens || exposure.costMicros > input.maximumCostMicros - spentCost)
      throw offlineFailure()
    const claim = await knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
      const resolved = await assertAuthority(transaction)
      const currentSession = await getOwnedAgentSession(transaction, input.ownerId, session.id)
      signal.throwIfAborted()
      const now = new Date()
      const admitted = await admitAgentRunInTransaction(transaction, { ...resolved, ownerId: input.ownerId, sessionId: session.id, clientRequestId: randomUUID(), expectedSessionVersion: currentSession.version,
        content: 'Local operator offline Wiki synthesis inference; synthetic fixtures only; no tools.', mediaBindings: {}, generationTools: [], skillVersionIds: [], maxAttempts: 1,
        quota: { tokens: exposure.totalTokens, costMicros: exposure.costMicros }, reservationExpiresAt: new Date(now.valueOf() + 180_000), now })
      const leaseOwner = `wiki-offline:${process.pid}`
      const leaseToken = randomUUID()
      const leaseExpiresAt = new Date(now.valueOf() + 180_000)
      const changed = await transaction('agentRuns').where({ id: admitted.run.id, ownerId: input.ownerId, status: 'queued', eventSequence: 1 }).whereNull('cancelRequestedAt')
        .update({ status: 'running', attempts: 1, leaseOwner, leaseToken, leaseExpiresAt, startedAt: now, updatedAt: now, sideEffectsStarted: true })
      if (changed !== 1 || admitted.replayed) throw offlineFailure()
      const claimed = { ...admitted.run, status: 'running' as const, attempts: 1, leaseOwner, leaseToken, leaseExpiresAt: leaseExpiresAt.toISOString() } satisfies AgentRunClaim
      // Admission, no-replay marker and unknown-paid journal commit together before HTTP.
      // A positive pending settlement intent here would prohibit a clean pre-HTTP release.
      await appendUsage(transaction, claimed, exposure, true)
      signal.throwIfAborted()
      return claimed
    })
    dispatch.claim = claim
    dispatch.exposure = exposure
    usage.calls++
    if (input.sharedAllowance) {
      input.sharedAllowance.calls++
      input.sharedAllowance.tokens += exposure.totalTokens
      input.sharedAllowance.costMicros += exposure.costMicros
    }
    dispatch.heartbeat = setInterval(() => {
      if (dispatch.heartbeatPending) return
      const pending: Promise<void> = knex.transaction(async transaction => {
        await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
        await assertLease(transaction, claim)
        if (!(await heartbeatAgentRun(transaction, claim, 180_000))) throw offlineFailure()
      }).catch(() => { dispatch.controller.abort() }).finally(() => {
        if (dispatch.heartbeatPending === pending) delete dispatch.heartbeatPending
      })
      dispatch.heartbeatPending = pending
    }, 5_000)
    dispatch.heartbeat.unref()
    // Recheck after the journal commit; an explicit denial never becomes paid consumption.
    await knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
      await assertAuthority(transaction)
      await assertLease(transaction, claim)
      signal.throwIfAborted()
    })
    signal.throwIfAborted()
    dispatch.dispatched = true
    usage.dispatchedCalls++
    dispatch.providerStartedAt = performance.now()
    return undiciFetch(destination as Parameters<typeof undiciFetch>[0], { ...init, signal } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
  }, { preconnect: (() => {}) as typeof fetch.preconnect })
  const provider = await new AgentProviderFactory(knex, input.secrets, guardedImplementation).create(input.profileVersionId, {
    requireConformed: true, purpose: 'agent', ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort })
  })
  const execute: AxAIService['chat'] = async (request, options) => {
    if (closed || accountingFailed || sharedState?.halted ||
      (input.sharedAllowance?.calls ?? usage.calls) >= input.maximumCalls) throw offlineFailure()
    if (request.functions?.some(fn => fn.name !== '__axOutput') || request.modelConfig?.audio ||
      request.modelConfig?.speed === 'fast' || request.modelConfig?.taskBudget ||
      request.chatPrompt.some(message =>
        message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type !== 'text') ||
        message.role === 'assistant' && (message.audio || message.images?.length || message.thoughtBlocks?.length) ||
        message.role === 'function' && (message.protocolResult || message.content?.some(part => part.type !== 'text'))))
      throw offlineFailure()
    const requestedOutput = request.modelConfig?.maxTokens ?? input.maximumOutputTokens
    if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) throw offlineFailure()
    const outputTokens = Math.min(requestedOutput, input.maximumOutputTokens, provider.capabilities.maxOutputTokens)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, ...(options?.abortSignal ? [options.abortSignal] : []), AbortSignal.timeout(120_000)])
    const dispatch: NonNullable<typeof active> = { dispatched: false, signal, controller, outputTokens }
    active = dispatch
    let actual: OfflineDispatchUsage | undefined
    let response: AxChatResponse | undefined
    let failed = false
    try {
      signal.throwIfAborted()
      const modelConfig = { ...request.modelConfig, maxTokens: outputTokens, n: 1, stream: false }
      delete modelConfig.effort
      response = await provider.service.chat({ ...request, model: provider.model,
        modelConfig }, {
        ...(options?.functionCallMode === undefined ? {} : { functionCallMode: options.functionCallMode }),
        ...(options?.functionCallSource === undefined ? {} : { functionCallSource: options.functionCallSource }),
        stream: false, asyncMode: 'off', abortSignal: signal, timeout: 120_000, debug: false, verbose: false,
        logger: () => {}, excludeContentFromTrace: true, includeRequestBodyInErrors: false, retry: { maxRetries: 0 }
      }) as AxChatResponse
      if (dispatch.providerStartedAt !== undefined) usage.providerMilliseconds += performance.now() - dispatch.providerStartedAt
      delete dispatch.providerStartedAt
      if (response instanceof ReadableStream || !dispatch.dispatched || !dispatch.exposure) throw offlineFailure()
      const receipt = readAgentProviderUsage(provider.transportKind, response)
      if (!receipt) throw offlineFailure()
      actual = { inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, totalTokens: receipt.totalTokens, costMicros: agentProviderCostMicros(provider.pricing, receipt.inputTokens, receipt.outputTokens, receipt.totalTokens) }
      usage.inputTokens += actual.inputTokens
      usage.outputTokens += actual.outputTokens
      usage.totalTokens += actual.totalTokens
      usage.costMicros += actual.costMicros
      if (actual.inputTokens > dispatch.exposure.inputTokens || actual.outputTokens > dispatch.exposure.outputTokens ||
        actual.totalTokens > dispatch.exposure.totalTokens || actual.costMicros > dispatch.exposure.costMicros) {
        closed = true
        if (sharedState) sharedState.halted = true
        throw offlineFailure()
      }
      signal.throwIfAborted()
    } catch {
      failed = true
    } finally {
      if (dispatch.providerStartedAt !== undefined) usage.providerMilliseconds += performance.now() - dispatch.providerStartedAt
      const { claim, exposure, dispatched } = dispatch
      if (claim && exposure) {
        const settled = actual ?? (dispatched ? exposure : { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 })
        if (!actual && dispatched) {
          usage.unknownExposureTokens += exposure.totalTokens
          usage.unknownExposureCostMicros += exposure.costMicros
        }
        try {
          // Commit the proven receipt (or proven zero pre-HTTP outcome) first, so a
          // quota-settlement failure cannot turn it back into unknown paid exposure.
          if (actual || !dispatched) await knex.transaction(async transaction => {
            await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
            await appendUsage(transaction, claim, settled, false)
          })
          const terminal = await knex.transaction(async transaction => {
            await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
            // The preceding durable usage journal is also the existing recovery input.
            return terminalizeAgentRunInTransaction(transaction, { runId: claim.id, ownerId: claim.ownerId,
              expected: { statuses: ['running'], leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken }, status: failed ? 'failed' : 'succeeded',
              assistant: { status: failed ? 'failed' : 'complete', content: 'Offline evaluation inference completed; content is not retained.' },
              runPatch: actual ? { inputTokens: actual.inputTokens, outputTokens: actual.outputTokens, totalTokens: actual.totalTokens, estimatedCostMicros: actual.costMicros }
                : { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: null },
              eventData: { purpose: 'offline.wiki-synthesis', receiptTotalTokens: actual?.totalTokens ?? 0, receiptCostMicros: actual?.costMicros ?? 0,
                unknownExposureTokens: !actual && dispatched ? exposure.totalTokens : 0, unknownExposureCostMicros: !actual && dispatched ? exposure.costMicros : 0 },
              quota: { consumedTokens: settled.totalTokens, consumedCostMicros: settled.costMicros, status: settled.totalTokens > 0 || settled.costMicros > 0 ? 'consumed' : 'released' },
              errorCode: failed ? 'OFFLINE_INFERENCE_FAILED' : null, errorMessage: failed ? 'Offline inference failed; see numeric accounting receipt.' : null })
          })
          if (terminal.status !== 'succeeded' || signal.aborted) failed = true
          if (input.sharedAllowance) {
            input.sharedAllowance.tokens += settled.totalTokens - exposure.totalTokens
            input.sharedAllowance.costMicros += settled.costMicros - exposure.costMicros
          }
        } catch {
          failed = true
          accountingFailed = true
          if (sharedState) sharedState.halted = true
        }
      }
      clearInterval(dispatch.heartbeat)
      await dispatch.heartbeatPending
      active = undefined
      if (failed && claim) usage.failedCalls++
    }
    if (failed || !response) throw offlineFailure()
    return response
  }
  const service: AxAIService = { ...provider.service, getLogger: () => () => {},
    getOptions: () => ({ stream: false, debug: false, verbose: false, asyncMode: 'off', timeout: 120_000,
      retry: { maxRetries: 0 }, includeRequestBodyInErrors: false, excludeContentFromTrace: true }),
    setOptions: () => { throw new Error('Offline provider options are locked') },
    validateChatRequest: (request, options) => {
      try {
        provider.service.validateChatRequest?.({ ...request, model: provider.model }, {
          ...(options?.functionCallMode === undefined ? {} : { functionCallMode: options.functionCallMode }),
          ...(options?.functionCallSource === undefined ? {} : { functionCallSource: options.functionCallSource }),
          stream: false, asyncMode: 'off', debug: false, verbose: false, includeRequestBodyInErrors: false, excludeContentFromTrace: true
        })
      } catch {
        throw offlineFailure()
      }
    },
    chat: (request, options) => {
      const next = (sharedState?.tail ?? tail).then(() => execute(request, options))
      tail = next.catch(() => {})
      if (sharedState) sharedState.tail = tail
      if (input.sharedAllowance) input.sharedAllowance.tail = tail
      return next
    }
  }
  return { service, model: provider.model, ...(provider.reasoningEffort === undefined ? {} : { reasoningEffort: provider.reasoningEffort }),
    summary: () => ({ ...usage }), close: async () => { closed = true; await tail; if (accountingFailed) throw offlineFailure() } }
}
