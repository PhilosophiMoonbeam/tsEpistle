import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { fetch as undiciFetch } from 'undici/index.js'
import { axGlobals, type AxAIService, type AxAIServiceOptions, type AxChatResponse } from '@ax-llm/ax'
import { createNoopMeter, ProxyTracerProvider } from '@opentelemetry/api'
import {
  acquireAgentCoordinatorAdvisoryLocks,
  admitAgentRunInTransaction,
  heartbeatAgentRun,
  terminalizeAgentRunInTransaction,
  type AgentRunClaim
} from '../coordinator.ts'
import { AgentRepositoryError, appendAgentEvent, createAgentSession, getOwnedAgentSession } from '../repository.ts'
import {
  AgentProviderFactory,
  agentProviderCostMicros,
  agentProviderMeasuredCostMicros,
  deriveAgentProviderResourceLimits,
  type AgentProviderFetch
} from './factory.ts'
import { AgentProviderRegistry, type AgentProviderTransportKind } from './registry.ts'
import type { AgentReasoningEffort } from '../../../shared/agents/contracts.ts'
import type { AgentSecretRegistry } from './secrets.ts'
import { readAgentProviderUsage, type AgentProviderUsage } from './usage.ts'

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
// Native provider spans record raw exceptions even when trace content is excluded.
const privateTracer = new ProxyTracerProvider().getTracer('wiki-synthesis-offline-admission-private')
// Native metrics include provider-authored function names before host validation.
const privateMeter = createNoopMeter()
const waitForOfflineSignal = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const abort = () => reject(offlineFailure())
  pending.then(
    value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    },
    error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    }
  )
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return promise
}

const offlineRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const offlineToken = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

// Match the installed dialects' cache conventions, then reuse the host's strict
// receipt validator and pricing. This runs only after the one body reader sees EOF,
// before any native answer/refusal decoder (or a failing limiter) can discard usage.
const offlineWireReceipt = (kind: AgentProviderTransportKind, payload: Record<string, unknown>): AgentProviderUsage | null => {
  const raw = offlineRecord(kind === 'gemini-api' ? payload.usageMetadata : payload.usage)
  if (!raw) return null
  let input: unknown
  let output: unknown
  let total: unknown
  let cached: unknown
  let creation: unknown
  if (kind === 'anthropic-messages') {
    input = raw.input_tokens
    output = raw.output_tokens
    cached = raw.cache_read_input_tokens
    creation = raw.cache_creation_input_tokens
  } else if (kind === 'gemini-api') {
    input = raw.promptTokenCount
    output = raw.candidatesTokenCount
    total = raw.totalTokenCount
    cached = raw.cachedContentTokenCount
  } else {
    input = kind === 'legacy-completions' ? raw.prompt_tokens : raw.prompt_tokens ?? raw.input_tokens
    output = kind === 'legacy-completions' ? raw.completion_tokens : raw.completion_tokens ?? raw.output_tokens
    total = raw.total_tokens
    if (kind !== 'legacy-completions') {
      const promptDetails = offlineRecord(raw.prompt_tokens_details)
      const inputDetails = offlineRecord(raw.input_tokens_details)
      cached = promptDetails?.cached_tokens ?? inputDetails?.cached_tokens
      creation = promptDetails?.cache_write_tokens ?? inputDetails?.cache_write_tokens
    }
  }
  if (!offlineToken(input) || !offlineToken(output) ||
      (cached !== undefined && !offlineToken(cached)) || (creation !== undefined && !offlineToken(creation))) return null
  const cacheRead = cached as number | undefined
  const cacheWrite = creation as number | undefined
  const promptTokens = kind === 'anthropic-messages' || kind === 'legacy-completions'
    ? input
    : input - (cacheRead ?? 0) - (cacheWrite ?? 0)
  if (kind === 'anthropic-messages') total = input + output + (cacheRead ?? 0) + (cacheWrite ?? 0)
  else if (total === undefined && kind !== 'gemini-api' && kind !== 'legacy-completions') total = input + output
  if (kind === 'gemini-api' && raw.thoughtsTokenCount !== undefined &&
      (!offlineToken(raw.thoughtsTokenCount) || !offlineToken(total) || raw.thoughtsTokenCount > total - input - output)) return null
  try {
    return readAgentProviderUsage(kind, {
      results: [],
      modelUsage: {
        ai: 'offline',
        model: 'offline',
        tokens: {
          promptTokens,
          completionTokens: output,
          totalTokens: total as number,
          ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
          ...(cacheWrite === undefined ? {} : { cacheCreationTokens: cacheWrite })
        }
      }
    })
  } catch {
    return null
  }
}

const offlineCorrelationHeaders = [
  'x-request-id', 'request-id', 'x-requestid', 'x-ms-request-id', 'x-goog-request-id',
  'x-amzn-requestid', 'x-amz-request-id', 'x-typesafe-request-id',
  'openai-session-id', 'anthropic-session-id', 'x-session-id'
] as const

// The independent global onUsage observer cannot be overridden per invocation.
// Give only telemetry IDs opaque local values; restore those fields after native
// decoding. Native content, function IDs and signed continuation blocks stay exact.
const privateOfflineMetadata = (
  payload: Record<string, unknown>,
  headers: Headers,
  kind: AgentProviderTransportKind,
  receipt: AgentProviderUsage | null,
  identifiers: Map<string, string>
): void => {
  const mask = (value: string): string => {
    const opaque = randomUUID()
    identifiers.set(opaque, value)
    return opaque
  }
  for (const name of offlineCorrelationHeaders) {
    const value = headers.get(name)
    if (value) headers.set(name, mask(value))
  }
  for (const name of ['id', 'responseId', 'meta_session_id']) {
    if (typeof payload[name] === 'string') payload[name] = mask(payload[name])
    else delete payload[name]
  }
  const key = kind === 'gemini-api' ? 'usageMetadata' : 'usage'
  const raw = offlineRecord(payload[key])
  if (!receipt || !raw) {
    delete payload[key]
    return
  }
  // Do not pass provider-authored strings (including optional reasoning counts,
  // speed and tier fields) into SDK token events. Keep all validated cache facts.
  const fields = kind === 'anthropic-messages'
    ? ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    : kind === 'gemini-api'
      ? ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount']
      : ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens']
  const safe: Record<string, unknown> = {}
  for (const field of fields) if (offlineToken(raw[field])) safe[field] = raw[field]
  for (const field of ['prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details', 'output_tokens_details']) {
    const details = offlineRecord(raw[field])
    if (!details) continue
    const counts: Record<string, number> = {}
    for (const count of ['cached_tokens', 'cache_write_tokens', 'reasoning_tokens'])
      if (offlineToken(details[count])) counts[count] = details[count]
    safe[field] = counts
  }
  if (raw.speed === 'standard' || raw.speed === 'fast') safe.speed = raw.speed
  if (typeof raw.serviceTier === 'string' && ['unspecified', 'standard', 'flex', 'priority'].includes(raw.serviceTier)) safe.serviceTier = raw.serviceTier
  payload[key] = safe
}

const restoreOfflineMetadata = (response: AxChatResponse, identifiers: ReadonlyMap<string, string>): void => {
  for (const field of ['remoteId', 'remoteRequestId', 'remoteSessionId'] as const) {
    const value = response[field]
    if (value !== undefined && identifiers.has(value)) response[field] = identifiers.get(value)!
  }
  for (const result of response.results)
    if (result.id !== undefined && identifiers.has(result.id)) result.id = identifiers.get(result.id)!
  for (const metadata of Object.values(response.providerMetadata ?? {})) {
    for (const field of ['requestId', 'sessionId']) {
      const value = metadata[field]
      if (typeof value === 'string' && identifiers.has(value)) metadata[field] = identifiers.get(value)!
    }
  }
}

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
    if (
      sharedState &&
      (sharedState.ownerId !== input.ownerId ||
        sharedState.maximumCalls !== input.maximumCalls ||
        sharedState.maximumTokens !== input.maximumTokens ||
        sharedState.maximumCostMicros !== input.maximumCostMicros)
    )
      throw new Error('Offline shared allowance requires one account and one global limit')
    sharedState ??= {
      ownerId: input.ownerId,
      maximumCalls: input.maximumCalls,
      maximumTokens: input.maximumTokens,
      maximumCostMicros: input.maximumCostMicros,
      tail: Promise.resolve(),
      halted: false
    }
    allowanceStates.set(input.sharedAllowance, sharedState)
  }
  const version = await knex('agentProviderProfileVersions').where({ id: input.profileVersionId, conformed: true }).first('profileId')
  if (!version) throw new Error('Offline evaluation requires an existing conformed profile version')
  const session = await createAgentSession(knex, {
    ownerId: input.ownerId,
    title: `Offline Wiki synthesis evaluation: ${input.label}`,
    retention: 'temporary',
    providerProfileId: version.profileId,
    executionMode: 'agent',
    expiresAt: new Date(Date.now() + 86_400_000)
  })
  const binding = { ownerId: input.ownerId, sessionId: session.id, profileId: version.profileId as string, profileVersionId: input.profileVersionId }
  const initial = await knex.transaction(async transaction => {
    await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
    return input.registry.resolveRoutingCandidate(transaction, binding)
  })
  let active:
    | {
        claim?: AgentRunClaim
        exposure?: OfflineDispatchUsage
        dispatched: boolean
        signal: AbortSignal
        controller: AbortController
        outputTokens: number
        providerStartedAt?: number
        heartbeat?: NodeJS.Timeout
        heartbeatPending?: Promise<void>
        fetchPending?: Promise<Response>
        receipt?: OfflineDispatchUsage
        identifiers: Map<string, string>
      }
    | undefined
  let closed = false
  let accountingFailed = false
  const closeController = new AbortController()
  let tail: Promise<unknown> = Promise.resolve()
  const usage: WikiOfflineUsage = {
    calls: 0,
    dispatchedCalls: 0,
    failedCalls: 0,
    providerMilliseconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costMicros: 0,
    unknownExposureTokens: 0,
    unknownExposureCostMicros: 0
  }
  const appendUsage = async (transaction: Knex.Transaction, claim: AgentRunClaim, values: OfflineDispatchUsage, unknown: boolean): Promise<void> => {
    await appendAgentEvent(transaction, {
      id: randomUUID(),
      runId: claim.id,
      ownerId: claim.ownerId,
      attempt: claim.attempts,
      leaseToken: claim.leaseToken,
      type: 'usage.updated',
      data: {
        purpose: 'offline.wiki-synthesis',
        usageVersion: 2,
        inputTokens: unknown ? 0 : values.inputTokens,
        outputTokens: unknown ? 0 : values.outputTokens,
        totalTokens: values.totalTokens,
        costMicros: values.costMicros,
        unknownExposure: unknown,
        receiptInputTokens: unknown ? 0 : values.inputTokens,
        receiptOutputTokens: unknown ? 0 : values.outputTokens,
        receiptTotalTokens: unknown ? 0 : values.totalTokens,
        receiptCostMicros: unknown ? 0 : values.costMicros,
        unsettledExposureTokens: unknown ? values.totalTokens : 0,
        unsettledExposureCostMicros: unknown ? values.costMicros : 0
      }
    })
  }
  const assertAuthority = async (transaction: Knex.Transaction) => {
    const current = await input.registry.resolveRoutingCandidate(transaction, binding)
    if (current.profileResolutionSha256 !== initial.profileResolutionSha256 || current.ownerAuthVersion !== initial.ownerAuthVersion)
      throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Offline evaluation authority changed', 409)
    return current
  }
  const assertLease = async (transaction: Knex.Transaction, claim: AgentRunClaim): Promise<void> => {
    const run = await transaction('agentRuns')
      .where({ id: claim.id, ownerId: claim.ownerId, status: 'running', leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken })
      .whereNull('cancelRequestedAt')
      .forUpdate()
      .first('leaseExpiresAt')
    const expiresAt = run ? new Date(run.leaseExpiresAt).valueOf() : NaN
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
      throw new AgentRepositoryError('RUN_LEASE_LOST', 'Offline evaluation lease expired or was cancelled', 409)
  }
  const fetchDispatch = async (
    dispatch: NonNullable<typeof active>,
    destination: Parameters<AgentProviderFetch>[0],
    init?: Parameters<AgentProviderFetch>[1]
  ): Promise<Response> => {
    const signal = init?.signal ? AbortSignal.any([dispatch.signal, init.signal]) : dispatch.signal
    signal.throwIfAborted()
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw offlineFailure()
    const body = JSON.parse(init.body) as OfflineWireBody
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw offlineFailure()
    const gemini = provider.transportKind === 'gemini-api'
    const outputTokens = gemini
      ? body.generationConfig?.maxOutputTokens
      : provider.transportKind === 'openai-responses' || provider.transportKind === 'openresponses'
        ? body.max_output_tokens
        : (body.max_completion_tokens ?? body.max_tokens)
    if (
      typeof outputTokens !== 'number' ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 1 ||
      outputTokens > dispatch.outputTokens ||
      (!gemini && body.model !== provider.model) ||
      (body.stream !== undefined && body.stream !== false) ||
      (body.n !== undefined && body.n !== 1) ||
      (body.background !== undefined && body.background !== false) ||
      body.cachedContent !== undefined ||
      body.speed === 'fast' ||
      (body.service_tier !== undefined && body.service_tier !== 'standard' && body.service_tier !== 'default') ||
      (gemini && body.generationConfig?.candidateCount !== undefined && body.generationConfig.candidateCount !== 1)
    )
      throw offlineFailure()
    const tools = body.tools
    if (
      tools !== undefined &&
      (!Array.isArray(tools) ||
        tools.some((tool: OfflineWireTool) =>
          gemini
            ? !Array.isArray(tool.function_declarations) ||
              Object.keys(tool).some(key => key !== 'function_declarations') ||
              tool.function_declarations.some((fn: { readonly name?: unknown }) => fn.name !== '__axOutput')
            : provider.transportKind === 'anthropic-messages'
              ? tool.name !== '__axOutput'
              : tool.type !== 'function' || (tool.name ?? tool.function?.name) !== '__axOutput'
        ))
    )
      throw offlineFailure()
    // Measure the final provider dialect, including Ax's schema, adapter defaults and effort.
    // Text-only bytes are a conservative token bound; binary/remote media is rejected below.
    const inputTokens = Buffer.byteLength(init.body, 'utf8')
    const totalTokens = inputTokens + outputTokens
    if (!Number.isSafeInteger(totalTokens) || totalTokens > provider.capabilities.maxContextTokens) throw offlineFailure()
    const exposure = { inputTokens, outputTokens, totalTokens, costMicros: agentProviderCostMicros(provider.pricing, inputTokens, outputTokens, totalTokens) }
    const spentTokens = input.sharedAllowance?.tokens ?? usage.totalTokens + usage.unknownExposureTokens
    const spentCost = input.sharedAllowance?.costMicros ?? usage.costMicros + usage.unknownExposureCostMicros
    if (exposure.totalTokens > input.maximumTokens - spentTokens || exposure.costMicros > input.maximumCostMicros - spentCost) throw offlineFailure()
    const claim = await knex.transaction(async transaction => {
      await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
      const resolved = await assertAuthority(transaction)
      const currentSession = await getOwnedAgentSession(transaction, input.ownerId, session.id)
      signal.throwIfAborted()
      const now = new Date()
      const admitted = await admitAgentRunInTransaction(transaction, {
        ...resolved,
        ownerId: input.ownerId,
        sessionId: session.id,
        clientRequestId: randomUUID(),
        expectedSessionVersion: currentSession.version,
        content: 'Local operator offline Wiki synthesis inference; synthetic fixtures only; no tools.',
        mediaBindings: {},
        generationTools: [],
        skillVersionIds: [],
        maxAttempts: 1,
        quota: { tokens: exposure.totalTokens, costMicros: exposure.costMicros },
        reservationExpiresAt: new Date(now.valueOf() + 180_000),
        now
      })
      const leaseOwner = `wiki-offline:${process.pid}`
      const leaseToken = randomUUID()
      const leaseExpiresAt = new Date(now.valueOf() + 180_000)
      const changed = await transaction('agentRuns')
        .where({ id: admitted.run.id, ownerId: input.ownerId, status: 'queued', eventSequence: 1 })
        .whereNull('cancelRequestedAt')
        .update({ status: 'running', attempts: 1, leaseOwner, leaseToken, leaseExpiresAt, startedAt: now, updatedAt: now, sideEffectsStarted: true })
      if (changed !== 1 || admitted.replayed) throw offlineFailure()
      const claimed = {
        ...admitted.run,
        status: 'running' as const,
        attempts: 1,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: leaseExpiresAt.toISOString()
      } satisfies AgentRunClaim
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
      const pending: Promise<void> = knex
        .transaction(async transaction => {
          await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
          await assertLease(transaction, claim)
          if (!(await heartbeatAgentRun(transaction, claim, 180_000))) throw offlineFailure()
        })
        .catch(() => {
          dispatch.controller.abort()
        })
        .finally(() => {
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
    const response = await undiciFetch(
      destination as Parameters<typeof undiciFetch>[0],
      { ...init, signal } as Parameters<typeof undiciFetch>[1]
    ) as unknown as Response
    if (!response.ok) return response
    const limits = deriveAgentProviderResourceLimits(dispatch.outputTokens)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > limits.rawBodyBytes) {
      await response.body?.cancel().catch(() => {})
      throw offlineFailure()
    }
    const reader = response.body?.getReader()
    if (!reader) throw offlineFailure()
    const chunks: Uint8Array[] = []
    let bytes = 0
    let complete = false
    try {
      while (true) {
        const item = await waitForOfflineSignal(reader.read(), signal)
        if (item.done) {
          complete = true
          break
        }
        if (!(item.value instanceof Uint8Array) || chunks.length >= limits.maxResponseFragments ||
            item.value.byteLength > limits.rawChunkBytes || bytes > limits.rawBodyBytes - item.value.byteLength) throw offlineFailure()
        chunks.push(item.value)
        bytes += item.value.byteLength
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const buffered = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      buffered.set(chunk, offset)
      offset += chunk.byteLength
    }
    const payload = offlineRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffered)))
    if (!payload) throw offlineFailure()
    const receipt = offlineWireReceipt(provider.transportKind, payload)
    if (receipt) {
      try {
        dispatch.receipt = {
          inputTokens: receipt.inputTokens,
          outputTokens: receipt.outputTokens,
          totalTokens: receipt.totalTokens,
          costMicros: agentProviderMeasuredCostMicros(provider.pricing, receipt)
        }
      } catch {
        // An unpriceable receipt cannot release the conservative reservation.
      }
    }
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    privateOfflineMetadata(payload, headers, provider.transportKind, receipt, dispatch.identifiers)
    const encoded = new TextEncoder().encode(JSON.stringify(payload))
    let sent = 0
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === encoded.byteLength) {
          controller.close()
          return
        }
        const end = Math.min(encoded.byteLength, sent + limits.rawChunkBytes)
        controller.enqueue(encoded.subarray(sent, end))
        sent = end
      }
    }), { status: response.status, statusText: response.statusText, headers })
  }
  const guardedImplementation: AgentProviderFetch = Object.assign(
    async (destination: Parameters<AgentProviderFetch>[0], init?: Parameters<AgentProviderFetch>[1]) => {
      const dispatch = active
      if (!dispatch || dispatch.fetchPending || dispatch.claim || dispatch.dispatched) throw offlineFailure()
      const pending = fetchDispatch(dispatch, destination, init)
      dispatch.fetchPending = pending
      // The SDK may reject its abort race before this admission transaction settles.
      // Keep the actual guarded work owned until execute has drained it.
      void pending.catch(() => {})
      return pending
    },
    { preconnect: (() => {}) as typeof fetch.preconnect }
  )
  const provider = await new AgentProviderFactory(knex, input.secrets, guardedImplementation).create(input.profileVersionId, {
    requireConformed: true,
    purpose: 'agent',
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort })
  })
  const execute = async (
    request: Parameters<AxAIService['chat']>[0],
    options: Parameters<AxAIService['chat']>[1],
    controller: AbortController,
    signal: AbortSignal
  ): Promise<AxChatResponse | ReadableStream<AxChatResponse>> => {
    if (closed || accountingFailed || sharedState?.halted || (input.sharedAllowance?.calls ?? usage.calls) >= input.maximumCalls) throw offlineFailure()
    if (
      request.functions?.some(fn => fn.name !== '__axOutput') ||
      request.modelConfig?.audio ||
      request.modelConfig?.speed === 'fast' ||
      request.modelConfig?.taskBudget ||
      request.chatPrompt.some(
        message =>
          (message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type !== 'text')) ||
          (message.role === 'assistant' && (message.audio || message.images?.length || message.thoughtBlocks?.length)) ||
          (message.role === 'function' && (message.protocolResult || message.content?.some(part => part.type !== 'text')))
      )
    )
      throw offlineFailure()
    const requestedOutput = request.modelConfig?.maxTokens ?? input.maximumOutputTokens
    if (!Number.isSafeInteger(requestedOutput) || requestedOutput < 1) throw offlineFailure()
    const outputTokens = Math.min(requestedOutput, input.maximumOutputTokens, provider.capabilities.maxOutputTokens)
    const dispatch: NonNullable<typeof active> = { dispatched: false, signal, controller, outputTokens, identifiers: new Map() }
    active = dispatch
    let actual: OfflineDispatchUsage | undefined
    let response: AxChatResponse | undefined
    let failed = false
    const limiter = options?.rateLimiter ?? provider.service.getOptions().rateLimiter ?? axGlobals.rateLimiter
    let limiterEntered = false
    const rateLimiter: NonNullable<AxAIServiceOptions['rateLimiter']> = async (next, info) => {
      if (limiterEntered) throw offlineFailure()
      limiterEntered = true
      let accepting = true
      let native: ReturnType<typeof next> | undefined
      const once = (): ReturnType<typeof next> => {
        if (!accepting || native || closed || signal.aborted) return Promise.reject(offlineFailure())
        native = Promise.resolve().then(() => {
          signal.throwIfAborted()
          return next()
        })
        void native.catch(() => {})
        return native
      }
      try {
        await waitForOfflineSignal(
          Promise.resolve().then(() => {
            signal.throwIfAborted()
            return limiter ? limiter(once, info) : once()
          }),
          signal
        )
        if (!native) throw offlineFailure()
      } catch {
        failed = true
        controller.abort()
      } finally {
        accepting = false
      }
      // Ignore hook-supplied results. A genuinely completed native receipt must
      // still pass through Ax's dialect normalization even when the hook fails.
      if (!native) throw offlineFailure()
      return await native
    }
    try {
      signal.throwIfAborted()
      const modelConfig = { ...request.modelConfig, maxTokens: outputTokens, n: 1, stream: false }
      delete modelConfig.effort
      response = (await provider.service.chat(
        { ...request, model: provider.model, modelConfig },
        {
          ...(options?.functionCallMode === undefined ? {} : { functionCallMode: options.functionCallMode }),
          ...(options?.functionCallSource === undefined ? {} : { functionCallSource: options.functionCallSource }),
          rateLimiter,
          meter: privateMeter,
          stream: false,
          asyncMode: 'off',
          abortSignal: signal,
          timeout: 120_000,
          debug: false,
          verbose: false,
          logger: () => {},
          tracer: privateTracer,
          excludeContentFromTrace: true,
          includeRequestBodyInErrors: false,
          retry: { maxRetries: 0 }
        }
      )) as AxChatResponse
      if (dispatch.providerStartedAt !== undefined) usage.providerMilliseconds += performance.now() - dispatch.providerStartedAt
      delete dispatch.providerStartedAt
      if (response instanceof ReadableStream || !dispatch.dispatched || !dispatch.exposure) throw offlineFailure()
      restoreOfflineMetadata(response, dispatch.identifiers)
      if (!dispatch.receipt) throw offlineFailure()
      // A paid receipt is still settled below, but failed, filtered or token-limit
      // terminals are not completed candidates for Ax's non-streaming parser.
      if (response.results.some(result => result.finishReason === 'error' || result.finishReason === 'length' || result.finishReason === 'content_filter'))
        throw offlineFailure()
      signal.throwIfAborted()
    } catch {
      failed = true
    } finally {
      if (failed) controller.abort()
      try {
        await dispatch.fetchPending
      } catch {
        failed = true
      }
      if (dispatch.receipt && dispatch.exposure) {
        actual = dispatch.receipt
        usage.inputTokens += actual.inputTokens
        usage.outputTokens += actual.outputTokens
        usage.totalTokens += actual.totalTokens
        usage.costMicros += actual.costMicros
        if (actual.inputTokens > dispatch.exposure.inputTokens || actual.outputTokens > dispatch.exposure.outputTokens ||
            actual.totalTokens > dispatch.exposure.totalTokens || actual.costMicros > dispatch.exposure.costMicros) {
          failed = true
          closed = true
          if (sharedState) sharedState.halted = true
        }
      }
      if (dispatch.providerStartedAt !== undefined) usage.providerMilliseconds += performance.now() - dispatch.providerStartedAt
      const { claim, exposure, dispatched } = dispatch
      if (claim && exposure) {
        const settled = actual ?? (dispatched ? exposure : { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 })
        if (!actual && dispatched) {
          // An unmeasured paid outcome is not permission to spend the remaining
          // allowance on another student, teacher or comparison candidate.
          closed = true
          if (sharedState) sharedState.halted = true
          usage.unknownExposureTokens += exposure.totalTokens
          usage.unknownExposureCostMicros += exposure.costMicros
        }
        try {
          // Commit the proven receipt (or proven zero pre-HTTP outcome) first, so a
          // quota-settlement failure cannot turn it back into unknown paid exposure.
          if (actual || !dispatched)
            await knex.transaction(async transaction => {
              await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
              await appendUsage(transaction, claim, settled, false)
            })
          const terminal = await knex.transaction(async transaction => {
            await acquireAgentCoordinatorAdvisoryLocks(transaction, [input.ownerId])
            // The preceding durable usage journal is also the existing recovery input.
            return terminalizeAgentRunInTransaction(transaction, {
              runId: claim.id,
              ownerId: claim.ownerId,
              expected: { statuses: ['running'], leaseOwner: claim.leaseOwner, leaseToken: claim.leaseToken },
              status: failed ? 'failed' : 'succeeded',
              assistant: { status: failed ? 'failed' : 'complete', content: 'Offline evaluation inference completed; content is not retained.' },
              runPatch: actual
                ? {
                    inputTokens: actual.inputTokens,
                    outputTokens: actual.outputTokens,
                    totalTokens: actual.totalTokens,
                    estimatedCostMicros: actual.costMicros
                  }
                : { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: null },
              eventData: {
                purpose: 'offline.wiki-synthesis',
                receiptTotalTokens: actual?.totalTokens ?? 0,
                receiptCostMicros: actual?.costMicros ?? 0,
                unknownExposureTokens: !actual && dispatched ? exposure.totalTokens : 0,
                unknownExposureCostMicros: !actual && dispatched ? exposure.costMicros : 0
              },
              quota: {
                consumedTokens: settled.totalTokens,
                consumedCostMicros: settled.costMicros,
                status: settled.totalTokens > 0 || settled.costMicros > 0 ? 'consumed' : 'released'
              },
              errorCode: failed ? 'OFFLINE_INFERENCE_FAILED' : null,
              errorMessage: failed ? 'Offline inference failed; see numeric accounting receipt.' : null
            })
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
  const service: AxAIService = {
    ...provider.service,
    getLogger: () => () => {},
    getOptions: () => ({
      stream: false,
      debug: false,
      verbose: false,
      asyncMode: 'off',
      timeout: 120_000,
      retry: { maxRetries: 0 },
      tracer: privateTracer,
      includeRequestBodyInErrors: false,
      excludeContentFromTrace: true
    }),
    setOptions: () => {
      throw new Error('Offline provider options are locked')
    },
    validateChatRequest: (request, options) => {
      try {
        provider.service.validateChatRequest?.(
          { ...request, model: provider.model },
          {
            ...(options?.functionCallMode === undefined ? {} : { functionCallMode: options.functionCallMode }),
            ...(options?.functionCallSource === undefined ? {} : { functionCallSource: options.functionCallSource }),
            stream: false,
            asyncMode: 'off',
            debug: false,
            verbose: false,
            tracer: privateTracer,
            meter: privateMeter,
            includeRequestBodyInErrors: false,
            excludeContentFromTrace: true
          }
        )
      } catch {
        throw offlineFailure()
      }
    },
    chat: (request, options) => {
      const controller = new AbortController()
      const signal = AbortSignal.any([
        controller.signal,
        closeController.signal,
        ...(options?.abortSignal ? [options.abortSignal] : []),
        AbortSignal.timeout(120_000)
      ])
      const previous = sharedState?.tail ?? tail
      const next = waitForOfflineSignal(previous, signal).then(() => execute(request, options, controller, signal))
      // A cancelled queue entry can reject promptly, but never release its
      // predecessor's ownership and let a later admission overlap paid work.
      tail = Promise.allSettled([previous, next])
      if (sharedState) sharedState.tail = tail
      if (input.sharedAllowance) input.sharedAllowance.tail = tail
      return next
    }
  }
  return {
    service,
    model: provider.model,
    ...(provider.reasoningEffort === undefined ? {} : { reasoningEffort: provider.reasoningEffort }),
    summary: () => ({ ...usage }),
    close: async () => {
      closed = true
      closeController.abort()
      await tail
      if (accountingFailed) throw offlineFailure()
    }
  }
}
