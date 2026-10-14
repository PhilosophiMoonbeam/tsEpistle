import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { encodeWikiSynthesisSources } from '../agents/providers/wiki-synthesis.ts'

const factSchema = z.object({ id: z.string().min(1), sourceKeys: z.array(z.string()).min(1), statement: z.string().min(1) }).strict()
const turnSchema = z.object({ id: z.string().min(1), userRequest: z.string().min(1), retrievalQuery: z.string().min(1), requiredFacts: z.array(factSchema).min(1), materialRestrictions: z.array(factSchema), expectedUnavailable: z.boolean() }).strict()
const corpusSchema = z.object({ version: z.literal(1), provenance: z.string(), topK: z.number().int().min(1).max(10),
  pages: z.array(z.object({ key: z.string(), locale: z.string(), path: z.string().startsWith('agent-bench-meridian-'), title: z.string(), body: z.string().optional(), bodyFile: z.string().regex(/^[a-zA-Z0-9_-]+\.txt$/u).optional() }).strict()).min(2),
  scenarios: z.array(z.object({ id: z.string(), kind: z.string(), turns: z.array(turnSchema).min(1) }).strict()).min(1), rubric: z.record(z.string(), z.string()) }).strict()
const resolvedCorpusSchema = corpusSchema.extend({ pages: z.array(z.object({
  key: z.string(), locale: z.string(), path: z.string().startsWith('agent-bench-meridian-'), title: z.string(),
  body: z.string(), bodySha256: z.string().regex(/^[a-f0-9]{64}$/u), bodyBytes: z.number().int().nonnegative()
}).strict()).min(2) })
export type WikiQnaComparisonCorpus = Omit<z.infer<typeof corpusSchema>, 'pages'> & { pages: readonly { key: string; locale: string; path: string; title: string; body: string; bodySha256: string; bodyBytes: number }[] }
export type WikiQnaComparisonMode = 'ordinary' | 'ranked-source-selection'
type Phase = 'collection' | 'readiness' | 'synthesis' | 'repair' | 'verification' | 'coverage' | 'compaction' | 'unclassified'
const accountingSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), costMicros: z.number().int().nonnegative(), unknownExposureTokens: z.number().int().nonnegative(), unknownExposureCostMicros: z.number().int().nonnegative() }).strict()
const bindingSchema = z.object({ key: z.string(), id: z.number().int().positive(), sourceRevision: z.string(), bodySha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const rankedSchema = z.object({ id: z.number().int().positive(), sourceRevision: z.string(), rank: z.number().int().nonnegative() }).strict()
const retainedSchema = z.object({ id: z.number().int().positive(), sourceRevision: z.string(), bodySha256: z.string().regex(/^[a-f0-9]{64}$/u), bodyBytes: z.number().int().nonnegative(), receiptActionCallId: z.string().min(1) }).strict()
export interface WikiQnaRequestMeasurement {
  readonly phase: Phase
  readonly serializedBytes: number
  readonly contentBytes: number | null
  readonly structureBytes: number | null
  readonly retainedBodyBytes: number | null
}
export interface WikiQnaComparisonTrialResult {
  readonly runId: string
  readonly status: string
  readonly rankedSources?: readonly z.infer<typeof rankedSchema>[]
  readonly retainedReads?: readonly z.infer<typeof retainedSchema>[]
  readonly accounting: z.infer<typeof accountingSchema>
}
export interface WikiQnaComparisonDriver {
  prepare(corpus: WikiQnaComparisonCorpus): Promise<{
    readonly pages: readonly z.infer<typeof bindingSchema>[]
    run(input: { readonly mode: WikiQnaComparisonMode; readonly scenarioId: string; readonly turnIndex: number; readonly sessionKey: string;
      readonly userRequest: string; readonly retrievalQuery: string; readonly topK: number;
      readonly onEvent: (type: string, data: Readonly<Record<string, unknown>>) => void;
      readonly onPublishedText: (text: string) => void;
      readonly onRequestMeasurement: (value: WikiQnaRequestMeasurement) => void
    }): Promise<WikiQnaComparisonTrialResult>
    /** Cancel/drain owned pending runs; remove only pages and sessions created by this invocation. Keep durable paid accounting. */
    close(): Promise<void>
  }>
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const sumKnown = (values: readonly (number | null)[]): number | null => values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0)
const phases: readonly Phase[] = ['collection', 'readiness', 'synthesis', 'repair', 'verification', 'coverage', 'compaction', 'unclassified']
const modelCallObservation = (turns: readonly Record<string, unknown>[], accounting: z.infer<typeof accountingSchema>) => {
  const observedUnknownTokens = turns.reduce((sum, turn) => sum + (numeric(turn.unknownExposureTokens) ?? 0), 0)
  const observedUnknownCost = turns.reduce((sum, turn) => sum + (numeric(turn.unknownExposureCostMicros) ?? 0), 0)
  const unobservedExposureTokens = Math.max(0, accounting.unknownExposureTokens - observedUnknownTokens)
  const unobservedExposureCostMicros = Math.max(0, accounting.unknownExposureCostMicros - observedUnknownCost)
  const observedTokens = sumKnown(turns.map(turn => numeric(turn.totalTokens)))
  const observedCost = sumKnown(turns.map(turn => numeric(turn.costMicros)))
  const completeness = unobservedExposureTokens > 0 || unobservedExposureCostMicros > 0 ||
    observedTokens === null || observedCost === null || accounting.totalTokens > observedTokens || accounting.costMicros > observedCost
    ? 'lower-bound' : 'complete'
  return { observedDispatches: turns.length, lowerBound: turns.length, completeness,
    unobservedExposureTokens, unobservedExposureCostMicros,
    boundary: 'Only observed dispatched model.turn outcomes count. Durable exposure without a matching outcome does not establish a call count; no zero-call claim is made when completeness is lower-bound.' }
}
const observedReadinessDecisions = (turns: readonly Record<string, unknown>[]) => turns.flatMap((turn, index) => {
  if (turn.phase !== 'readiness') return []
  let next: Record<string, unknown> | undefined
  for (let cursor = index + 1; cursor < turns.length; cursor++) {
    const row = turns[cursor]!
    if (row.phase === 'readiness' || row.phase === 'collection' || row.phase === 'synthesis' || row.phase === 'repair') {
      next = row
      break
    }
  }
  const observedPipelineRoute = next?.phase === 'collection' ? 'collection' :
    next?.phase === 'synthesis' || next?.phase === 'repair' ? 'synthesis' :
      turn.outcome === 'verification_failed' ? 'failed' : 'unknown'
  return [{ classifierDecision: turn.readinessDecision, observedPipelineRoute,
    boundary: 'Route is subsequent observed pipeline behavior, not an inferred exact classifier choice/confidence. Raw semantic decisions require the separately accounted readiness qualification.' }]
})
const privateFile = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
}
const loadCorpus = async (): Promise<WikiQnaComparisonCorpus> => {
  const base = new URL('../test/agents/fixtures/', import.meta.url)
  const parsed = corpusSchema.parse(JSON.parse(await readFile(new URL('wiki-qna-comparison.json', base), 'utf8')))
  const pages = await Promise.all(parsed.pages.map(async page => {
    if ((page.body === undefined) === (page.bodyFile === undefined)) throw new Error('Invalid fictional page body')
    const body = page.body ?? await readFile(new URL(page.bodyFile!, base), 'utf8')
    return { key: page.key, locale: page.locale, path: page.path, title: page.title, body, bodySha256: sha256(body), bodyBytes: bytes(body) }
  }))
  if (new Set(pages.map(page => page.key)).size !== pages.length || new Set(pages.map(page => `${page.locale}/${page.path}`)).size !== pages.length || new Set(parsed.scenarios.map(scenario => scenario.id)).size !== parsed.scenarios.length) throw new Error('Duplicate frozen identity')
  const keys = new Set(pages.map(page => page.key))
  for (const scenario of parsed.scenarios) for (const turn of scenario.turns) {
    const facts = [...turn.requiredFacts, ...turn.materialRestrictions]
    if (new Set(facts.map(fact => fact.id)).size !== facts.length || facts.some(fact => fact.sourceKeys.some(key => !keys.has(key)))) throw new Error('Invalid frozen rubric binding')
  }
  return { ...parsed, pages }
}
const fingerprint = (corpus: WikiQnaComparisonCorpus): string => sha256(JSON.stringify(corpus))

const phaseFor = (data: Record<string, unknown>): Phase => {
  if (data.purpose === 'verification') {
    const phase = record(data.verification).phase
    return phase === 'context_readiness' ? 'readiness' : phase === 'coverage_audit' ? 'coverage' : 'verification'
  }
  const performance = record(data.performance)
  if (Object.keys(record(performance.synthesisFrame)).length > 0) return 'synthesis'
  if (String(data.outcome ?? '').includes('compaction') || data.sourceSha256 !== undefined) return 'compaction'
  if (data.outcome === 'tool_calls' || data.outcome === 'collection_complete') return 'collection'
  return 'unclassified'
}

const observeTrial = (pages: readonly z.infer<typeof bindingSchema>[], corpus: WikiQnaComparisonCorpus) => {
  const pageById = new Map(pages.map(binding => [binding.id, { ...binding, fixture: corpus.pages.find(page => page.key === binding.key)! }]))
  const turns: Record<string, unknown>[] = []
  const tools: Record<string, unknown>[] = []
  const wholeReads: z.infer<typeof retainedSchema>[] = []
  const measurements: WikiQnaRequestMeasurement[] = []
  const retrievalInputs = new Map<string, string>()
  const completedRetrievals = new Set<string>()
  let published = ''
  let outsiderReads = 0
  let outsiderResults = 0
  let observationFailed = false
  let synthesisAttempts = 0
  let nonDispatchedModelEvents = 0
  const onEvent = (type: string, data: Readonly<Record<string, unknown>>): void => {
    if (type === 'tool.started' && typeof data.actionCallId === 'string' && typeof data.actionName === 'string' && data.actionName.startsWith('pages.') && typeof data.input === 'string') {
      // Inputs can contain private text. Only an in-memory digest is used for repeated-call counts; it is never persisted.
      retrievalInputs.set(data.actionCallId, `${data.actionName}:${sha256(data.input)}`)
      return
    }
    if (type === 'model.turn') {
      const performance = record(data.performance)
      const frame = record(performance.synthesisFrame)
      const verification = record(data.verification)
      const exposure = record(data.unknownExposure)
      const dispatched = data.purpose !== 'routing.binding' && data.usageSource !== 'not-dispatched' &&
        (performance.providerUsageReported === true || data.usageSource === 'provider' ||
          numeric(performance.providerElapsedMs) !== null || numeric(data.latencyMs) !== null ||
          (numeric(performance.unknownExposureTokens) ?? 0) > 0 || (numeric(exposure.tokens) ?? 0) > 0 ||
          (numeric(performance.unknownExposureCostMicros) ?? 0) > 0 || (numeric(exposure.costMicros) ?? 0) > 0 ||
          (numeric(data.totalTokens) ?? 0) > 0 || (numeric(data.costMicros) ?? 0) > 0)
      if (!dispatched) { nonDispatchedModelEvents++; return }
      const initialPhase = phaseFor({ ...data })
      const phase = initialPhase === 'synthesis' && synthesisAttempts++ > 0 ? 'repair' : initialPhase
      turns.push({ phase, outcome: typeof data.outcome === 'string' ? data.outcome : null,
        inputTokens: numeric(data.inputTokens), outputTokens: numeric(data.outputTokens), totalTokens: numeric(data.totalTokens), costMicros: numeric(data.costMicros),
        usageSource: typeof data.usageSource === 'string' ? data.usageSource : performance.providerUsageReported === true ? 'provider' : 'unmeasured',
        providerReportedInputTokens: numeric(performance.inputTokensReported), providerReportedTotalTokens: numeric(performance.totalTokensReported),
        cachedInputTokens: numeric(performance.cachedInputTokensReported), cacheCreationInputTokens: numeric(performance.cacheCreationInputTokensReported),
        unknownExposureTokens: numeric(performance.unknownExposureTokens) ?? numeric(exposure.tokens) ?? 0,
        unknownExposureCostMicros: numeric(performance.unknownExposureCostMicros) ?? numeric(exposure.costMicros) ?? 0,
        providerMilliseconds: numeric(performance.providerElapsedMs) ?? numeric(data.latencyMs),
        serializedRequestBytes: numeric(performance.serializedRequestBytes) ?? numeric(verification.requestBytes),
        bodyBytesRetained: numeric(frame.sourceBytes), contentBytes: numeric(frame.authoredBytes), structureBytes: numeric(frame.structureBytes),
        bindingBytes: numeric(frame.bindingBytes), schemaBytes: numeric(frame.schemaBytes), prefixBytes: numeric(frame.prefixBytes),
        repairAttempts: numeric(performance.repairAttempts), cacheHitCount: numeric(performance.cacheHitCount),
        confidenceFloor: numeric(verification.confidenceFloor), verificationChecks: numeric(verification.checks) })
      const row = turns[turns.length - 1]!
      row.verificationPhase = typeof verification.phase === 'string' ? verification.phase : null
      row.readinessDecision = phase === 'readiness' ? {
        selectedOutcome: typeof record(verification.readiness).selectedOutcome === 'string' ? record(verification.readiness).selectedOutcome : null,
        selectedProbability: numeric(record(verification.readiness).selectedProbability),
        confidence: numeric(record(verification.readiness).confidence),
        route: typeof record(verification.readiness).route === 'string' ? record(verification.readiness).route : null
      } : null
    }
    if (type !== 'tool.completed' && type !== 'tool.failed' && type !== 'tool.notExecuted') return
    const actionName = typeof data.actionName === 'string' ? data.actionName : ''
    const projection = record(data.projection)
    const retrievalInput = typeof data.actionCallId === 'string' ? retrievalInputs.get(data.actionCallId) : undefined
    const repeatedRetrieval = type === 'tool.completed' && retrievalInput !== undefined ? completedRetrievals.has(retrievalInput) : null
    if (type === 'tool.completed' && retrievalInput !== undefined) completedRetrievals.add(retrievalInput)
    tools.push({ actionName, actionCallId: typeof data.actionCallId === 'string' ? data.actionCallId : null, outcome: type,
      cacheHit: data.cacheHit === true, omitted: data.contextExclusion !== undefined, repeatedRetrieval,
      elapsedMilliseconds: numeric(data.actionElapsedMs), canonicalBytes: numeric(projection.canonicalBytes), providerBytes: numeric(projection.providerBytes) })
    if (type !== 'tool.completed' || typeof data.result !== 'string') return
    let result: Record<string, unknown>
    try { result = record(JSON.parse(data.result)) } catch { observationFailed = true; return }
    if (actionName === 'pages.search' || actionName === 'pages.discover' || actionName === 'pages.related' || actionName === 'pages.listRecent') {
      const results = result.results ?? result.pages
      if (Array.isArray(results)) outsiderResults += results.filter(value => !pageById.has(Number(record(value).id ?? record(value).pageId))).length
    }
    if (actionName !== 'pages.get' && actionName !== 'pages.getOkf' && actionName !== 'pages.getVersion') return
    const id = Number(result.id ?? result.pageId)
    const fixture = pageById.get(id)
    if (!fixture) { outsiderReads++; return }
    const source = actionName === 'pages.getOkf' ? result.document : result.content
    if (typeof source !== 'string' || data.contextExclusion !== undefined || result.contentTruncated === true || result.complete === false || result.status === 'omitted' || result.status === 'error') return
    // Only an unchanged original full Markdown receipt qualifies; OKF transformations do not silently count.
    if (sha256(source) !== fixture.fixture.bodySha256 || String(result.sourceRevision) !== fixture.sourceRevision || Object.keys(record(result.citation)).length === 0) return
    wholeReads.push({ id, sourceRevision: fixture.sourceRevision, bodySha256: sha256(source), bodyBytes: bytes(source), receiptActionCallId: String(data.cacheHit === true ? data.reusedActionCallId ?? data.actionCallId : data.actionCallId) })
  }
  return { onEvent, onPublishedText: (text: string) => { published += text },
    onRequestMeasurement: (value: WikiQnaRequestMeasurement) => {
      if (![value.serializedBytes, value.contentBytes, value.structureBytes, value.retainedBodyBytes].every(value => value === null || numeric(value) !== null)) { observationFailed = true; return }
      measurements.push(value)
    }, finish: () => ({ turns, tools, wholeReads, measurements, outsiderReads, outsiderResults, observationFailed, nonDispatchedModelEvents, published }) }
}

const pairedComparisons = (results: readonly Record<string, unknown>[]) => results.filter(row => row.mode === 'ordinary').map(ordinary => {
  const ranked = results.find(row => row.mode === 'ranked-source-selection' && row.scenarioId === ordinary.scenarioId && row.turnId === ordinary.turnId)
  const delta = (left: unknown, right: unknown): number | null => {
    const ordinaryValue = numeric(left)
    const rankedValue = numeric(right)
    return ordinaryValue === null || rankedValue === null ? null : rankedValue - ordinaryValue
  }
  const ordinaryUsage = record(ordinary.accounting)
  const rankedUsage = record(ranked?.accounting)
  return { scenarioId: ordinary.scenarioId, turnId: ordinary.turnId, ordinaryTrialId: ordinary.trialId, rankedTrialId: ranked?.trialId ?? null,
    validPair: ordinary.validComparisonTrial === true && ranked?.validComparisonTrial === true,
    differenceDirection: 'ranked-source-selection minus ordinary; negative tokens/time/cost is lower consumption',
    providerReceiptTokensDelta: delta(ordinary.actualProviderReceiptTokens, ranked?.actualProviderReceiptTokens),
    authoritativeTotalTokensDelta: delta(ordinaryUsage.totalTokens, rankedUsage.totalTokens),
    unknownExposureTokensDelta: delta(ordinaryUsage.unknownExposureTokens, rankedUsage.unknownExposureTokens),
    costMicrosDelta: delta(ordinaryUsage.costMicros, rankedUsage.costMicros),
    elapsedMillisecondsDelta: delta(ordinary.elapsedMilliseconds, ranked?.elapsedMilliseconds),
    providerMillisecondsDelta: delta(ordinary.providerMilliseconds, ranked?.providerMilliseconds),
    modelCallsDelta: record(ordinary.modelCallObservation).completeness === 'complete' && record(ranked?.modelCallObservation).completeness === 'complete' ? delta(ordinary.modelCalls, ranked?.modelCalls) : null,
    observedModelCallsDelta: delta(ordinary.modelCalls, ranked?.modelCalls), toolCallsDelta: delta(ordinary.toolCalls, ranked?.toolCalls),
    qualityScoreDelta: delta(record(ordinary.quality).score, record(ranked?.quality).score) }
})

export const runWikiQnaComparison = async (driver: WikiQnaComparisonDriver, outputPath: string): Promise<void> => {
  const corpus = await loadCorpus()
  const frozenFingerprint = fingerprint(corpus)
  // Emitted before setup, ranking or inference. Neither rubric nor query may be refined during this run.
  process.stdout.write(`${JSON.stringify({ mode: 'live', corpusFingerprint: frozenFingerprint, topK: corpus.topK, corpusFrozen: true, quality: 'unadjudicated' })}\n`)
  const prepared = await driver.prepare(corpus)
  const results: Record<string, unknown>[] = []
  try {
    const pages = z.array(bindingSchema).parse(prepared.pages)
    if (pages.length !== corpus.pages.length || new Set(pages.map(page => page.key)).size !== corpus.pages.length || new Set(pages.map(page => page.id)).size !== corpus.pages.length || pages.some(binding => corpus.pages.find(page => page.key === binding.key)?.bodySha256 !== binding.bodySha256)) throw new Error('Live fictional corpus binding changed')
    for (let scenarioIndex = 0; scenarioIndex < corpus.scenarios.length; scenarioIndex++) {
      const scenario = corpus.scenarios[scenarioIndex]!
      const modes: readonly WikiQnaComparisonMode[] = scenarioIndex % 2 === 0 ? ['ordinary', 'ranked-source-selection'] : ['ranked-source-selection', 'ordinary']
      // Each arm owns a separate real session; follow-ups reuse only their own arm's history and receipts.
      for (const mode of modes) for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
        const turn = scenario.turns[turnIndex]!
        const observed = observeTrial(pages, corpus)
        const started = performance.now()
        let result: WikiQnaComparisonTrialResult
        try {
          result = await prepared.run({ mode, scenarioId: scenario.id, turnIndex, sessionKey: `${mode}:${scenario.id}`, userRequest: turn.userRequest,
            retrievalQuery: turn.retrievalQuery, topK: corpus.topK, onEvent: observed.onEvent, onPublishedText: observed.onPublishedText, onRequestMeasurement: observed.onRequestMeasurement })
        } catch {
          const partial = observed.finish()
          await privateFile(`${outputPath}.interrupted.json`, { version: 1, corpusFingerprint: frozenFingerprint, corpus, results,
            interruptedTrial: { trialId: `${mode}:${scenario.id}:${turn.id}`, accounting: null, quality: null,
              elapsedMilliseconds: performance.now() - started, turns: partial.turns, tools: partial.tools, requestMeasurements: partial.measurements },
            boundary: 'Driver failed before authoritative settlement projection. These observed numeric events do not establish complete paid exposure; retain normal durable application accounting.' })
          throw new Error('Accounted API trial interrupted')
        }
        const accounting = accountingSchema.parse(result.accounting)
        const observedResult = observed.finish()
        const rankedSources = z.array(rankedSchema).parse(result.rankedSources ?? [])
        const retainedReads = z.array(retainedSchema).parse(result.retainedReads ?? [])
        const allReads = [...observedResult.wholeReads, ...retainedReads]
        const invalidRetained = retainedReads.filter(read => !pages.some(binding => binding.id === read.id && binding.sourceRevision === read.sourceRevision && binding.bodySha256 === read.bodySha256 && corpus.pages.find(page => page.key === binding.key)?.bodyBytes === read.bodyBytes)).length
        const rankingValid = mode === 'ordinary' || rankedSources.length > 0 && rankedSources.length <= corpus.topK && new Set(rankedSources.map(source => source.id)).size === rankedSources.length && rankedSources.every((source, index) => source.rank === index && pages.some(page => page.id === source.id && page.sourceRevision === source.sourceRevision))
        const missingWholePageIds = rankedSources.filter(source => !allReads.some(read => read.id === source.id && read.sourceRevision === source.sourceRevision)).map(source => source.id)
        const privacySafe = observedResult.outsiderReads === 0 && observedResult.outsiderResults === 0 && invalidRetained === 0
        const terminalExecution = ['completed', 'succeeded', 'partial', 'failed', 'cancelled', 'recovery_required'].includes(result.status)
        const measuredExecutionValid = terminalExecution && privacySafe && !observedResult.observationFailed
        const selectedKeys = rankedSources.map(source => pages.find(page => page.id === source.id)?.key)
        const requiredSourceKeys = [...new Set([...turn.requiredFacts, ...turn.materialRestrictions].flatMap(fact => fact.sourceKeys))]
        const callObservation = modelCallObservation(observedResult.turns, accounting)
        const phaseTotals = Object.fromEntries(phases.map(phase => {
          const rows = observedResult.turns.filter(row => row.phase === phase)
          return [phase, { modelCalls: rows.length, inputTokens: sumKnown(rows.map(row => numeric(row.inputTokens))), outputTokens: sumKnown(rows.map(row => numeric(row.outputTokens))),
            totalTokens: sumKnown(rows.map(row => numeric(row.totalTokens))), costMicros: sumKnown(rows.map(row => numeric(row.costMicros))),
            providerReceiptTokens: sumKnown(rows.map(row => row.usageSource === 'provider' ? numeric(row.totalTokens) : null)),
            providerMilliseconds: sumKnown(rows.map(row => numeric(row.providerMilliseconds))), serializedRequestBytes: sumKnown(rows.map(row => numeric(row.serializedRequestBytes))),
            contentBytes: sumKnown(rows.map(row => numeric(row.contentBytes))), structureBytes: sumKnown(rows.map(row => numeric(row.structureBytes))),
            retainedBodyBytes: sumKnown(rows.map(row => numeric(row.bodyBytesRetained))),
            requestMeasurements: observedResult.measurements.filter(measurement => measurement.phase === phase),
            boundary: phase === 'readiness' ? 'Utility classifier only; not final answer verification or independent quality.' : phase === 'verification' ? 'Final candidate support/coverage verification, not readiness.' : null }]
        }))
        const reads = new Map(allReads.map(read => [`${read.id}:${read.sourceRevision}:${read.bodySha256}`, read]))
        const trialId = `${mode}:${scenario.id}:${turn.id}`
        results.push({ trialId, runId: result.runId, status: result.status, mode, scenarioId: scenario.id, turnId: turn.id, elapsedMilliseconds: performance.now() - started,
          accounting, phaseTotals, modelCalls: observedResult.turns.length, modelCallObservation: callObservation, toolCalls: observedResult.tools.length,
          nonDispatchedModelEvents: observedResult.nonDispatchedModelEvents,
          frameworkStatus: result.status, terminalExecution, measuredExecutionValid,
          frameworkCompleted: result.status === 'completed' || result.status === 'succeeded',
          nativeAnswerAccepted: observedResult.turns.some(row => row.outcome === 'answer_accepted'),
          nativeAnswerRejections: observedResult.turns.filter(row => row.outcome === 'answer_rejected').length,
          nativeVerificationFailures: observedResult.turns.filter(row => row.phase === 'verification' && row.outcome === 'verification_failed').length,
          nativeReadinessFailures: observedResult.turns.filter(row => row.phase === 'readiness' && row.outcome === 'verification_failed').length,
          readinessDecisions: observedReadinessDecisions(observedResult.turns),
          completedToolCalls: observedResult.tools.filter(tool => tool.outcome === 'tool.completed').length,
          providerMilliseconds: sumKnown(observedResult.turns.map(row => numeric(row.providerMilliseconds))),
          actualProviderReceiptTokens: sumKnown(observedResult.turns.map(row => row.usageSource === 'provider' ? numeric(row.totalTokens) : null)),
          byteMetricBoundary: 'Turn contentBytes is authored full-body bytes; structureBytes is only the source-text wrapper. Binding, schema and host prefix are separate. Full request content/structure split is reported only by an actual driver requestMeasurement.',
          rankedSources, requestedK: mode === 'ordinary' ? null : corpus.topK, selectedK: mode === 'ordinary' ? null : rankedSources.length,
          retrievalMissSourceKeys: mode === 'ordinary' ? null : requiredSourceKeys.filter(key => !selectedKeys.includes(key)),
          wholePageIngestion: mode === 'ordinary' ? 'not-applicable' : rankingValid && missingWholePageIds.length === 0 ? 'observed-all-selected-pages' : 'invalid-or-incomplete',
          missingWholePageIds, rankingValid, measuredWholeBodyBytes: [...reads.values()].reduce((sum, read) => sum + read.bodyBytes, 0),
          wholeReads: [...reads.values()], repeatedReceiptReplays: observedResult.wholeReads.length - new Set(observedResult.wholeReads.map(read => read.receiptActionCallId)).size,
          repeatedWholeBodyRetrievals: observedResult.wholeReads.length - new Set(observedResult.wholeReads.map(read => `${read.id}:${read.sourceRevision}:${read.bodySha256}`)).size,
          cachedRetrievalCalls: observedResult.tools.filter(tool => tool.cacheHit === true).length,
          repeatedRetrievalCalls: observedResult.tools.some(tool => tool.repeatedRetrieval === null && String(tool.actionName).startsWith('pages.'))
            ? null : observedResult.tools.filter(tool => tool.repeatedRetrieval === true).length,
          repairCount: Math.max(0, ...observedResult.turns.map(row => numeric(row.repairAttempts) ?? 0)),
          privacySafe, outsiderReads: observedResult.outsiderReads, outsiderResults: observedResult.outsiderResults, invalidRetained, observationFailed: observedResult.observationFailed,
          protocolEligibility: { privacySafe, rankingValid, wholePageIngestionValid: missingWholePageIds.length === 0,
            observationValid: !observedResult.observationFailed, terminalExecution, independentQuality: 'unadjudicated' },
          validComparisonTrial: measuredExecutionValid && rankingValid && missingWholePageIds.length === 0,
          publishedAnswer: privacySafe ? observedResult.published : null, quality: null,
          turns: observedResult.turns, tools: observedResult.tools, requestMeasurements: observedResult.measurements })
        // Persist after every paid trial to a NEW exclusive checkpoint; failures never discard prior receipts.
        await privateFile(`${outputPath}.${results.length}.json`, { version: 1, corpusFingerprint: frozenFingerprint, corpus, results, quality: 'unadjudicated' })
      }
    }
    await privateFile(outputPath, { version: 1, corpusFingerprint: frozenFingerprint, corpus, results, pairedComparisons: pairedComparisons(results), quality: 'unadjudicated',
      boundary: 'Normal authenticated Wiki API; native publication and priced provider admission are unchanged. Ranked-source-selection is not an ideal deterministic two-call RAG protocol. Static request proof is not live token or quality evidence.' })
    process.stdout.write(`${JSON.stringify({ mode: 'live', corpusFingerprint: frozenFingerprint, trials: results.length, validComparisonTrials: results.filter(row => row.validComparisonTrial === true).length, quality: 'unadjudicated' })}\n`)
  } finally { await prepared.close() }
}

export interface WikiQnaHistoricalReplay {
  readonly runId: string
  readonly sessionId: string
  readonly status: string
  readonly events: readonly { readonly type: string; readonly data: Readonly<Record<string, unknown>> }[]
}

export class WikiQnaHistoricalReplayError extends Error {
  readonly code: `HISTORICAL_${string}`
  readonly trialIndex: number | undefined

  constructor(code: `HISTORICAL_${string}`, trialIndex?: number) {
    super('Historical evidence replay rejected')
    this.name = 'WikiQnaHistoricalReplayError'
    this.code = code
    this.trialIndex = trialIndex
  }
}

/** Add historical evidence corrections only. The caller must obtain owned, terminal run events through GET. */
export const rehydrateWikiQnaHistoricalEvidence = (value: unknown, replays: readonly WikiQnaHistoricalReplay[], originalReportSha256: string): Record<string, unknown> => {
  let trialIndex: number | undefined
  const fail = (code: `HISTORICAL_${string}`): never => { throw new WikiQnaHistoricalReplayError(code, trialIndex) }
  const parse = <T>(schema: z.ZodType<T>, input: unknown, code: `HISTORICAL_${string}`): T => {
    const parsed = schema.safeParse(input)
    if (!parsed.success) return fail(code)
    return parsed.data
  }
  const report = record(value)
  if (!Array.isArray(report.results) || report.corpusFingerprint !== sha256(JSON.stringify(report.corpus)) ||
    !/^[a-f0-9]{64}$/u.test(originalReportSha256) || report.historicalEvidenceCorrection !== undefined) fail('HISTORICAL_FROZEN_REPORT_INVALID')
  const corpus = parse(resolvedCorpusSchema, report.corpus, 'HISTORICAL_CORPUS_SCHEMA_INVALID')
  if (corpus.pages.some(page => sha256(page.body) !== page.bodySha256 || bytes(page.body) !== page.bodyBytes)) fail('HISTORICAL_FROZEN_BODY_CHANGED')
  const trials = (report.results as unknown[]).map(record)
  if (trials.some(trial => trial.quality !== null) || new Set(trials.map(trial => trial.trialId)).size !== trials.length ||
    new Set(trials.map(trial => trial.runId)).size !== trials.length || replays.length !== trials.length ||
    new Set(replays.map(replay => replay.runId)).size !== replays.length) fail('HISTORICAL_TRIAL_IDENTITY_CHANGED')
  // Bind only exact fixture identities already evidenced in this historical report; never today's search/pages.
  const bindings = new Map<number, z.infer<typeof bindingSchema>>()
  for (const [index, trial] of trials.entries()) {
    trialIndex = index
    for (const read of parse(z.array(retainedSchema), trial.wholeReads, 'HISTORICAL_FROZEN_RECEIPT_INVALID')) {
      const fixtures = corpus.pages.filter(page => page.bodySha256 === read.bodySha256 && page.bodyBytes === read.bodyBytes)
      if (fixtures.length !== 1) fail('HISTORICAL_OWNED_BODY_AMBIGUOUS')
      const binding = { key: fixtures[0]!.key, id: read.id, sourceRevision: read.sourceRevision, bodySha256: read.bodySha256 }
      const prior = bindings.get(read.id)
      if (prior && JSON.stringify(prior) !== JSON.stringify(binding)) fail('HISTORICAL_OWNED_IDENTITY_CHANGED')
      bindings.set(read.id, binding)
    }
  }
  trialIndex = undefined
  const pages = [...bindings.values()]
  if (pages.length !== corpus.pages.length || new Set(pages.map(page => page.key)).size !== corpus.pages.length) fail('HISTORICAL_FIXTURE_BINDINGS_INCOMPLETE')
  const arms = new Map<string, { sessionId: string; nextTurn: number; receipts: Map<string, z.infer<typeof retainedSchema>> }>()
  const sessionArms = new Map<string, string>()
  const correctedTrials: Record<string, unknown>[] = []
  const terminalStatuses: Record<string, true> = { succeeded: true, partial: true, failed: true, cancelled: true, recovery_required: true }
  const results = trials.map((trial, index) => {
    trialIndex = index
    const mode = parse(z.enum(['ordinary', 'ranked-source-selection']), trial.mode, 'HISTORICAL_TRIAL_MODE_INVALID')
    const scenario = corpus.scenarios.find(scenario => scenario.id === trial.scenarioId)
    const turnIndex = scenario?.turns.findIndex(turn => turn.id === trial.turnId) ?? -1
    const replay = replays.find(replay => replay.runId === trial.runId)
    // The normal SSE contract names durable succeeded runs run.completed; the paid driver froze that event suffix.
    const durableStatus = trial.status === 'completed' ? 'succeeded' : trial.status
    if (!scenario || turnIndex < 0 || trial.trialId !== `${mode}:${scenario.id}:${scenario.turns[turnIndex]!.id}` ||
      !replay || !replay.sessionId || terminalStatuses[replay.status] !== true || replay.status !== durableStatus) return fail('HISTORICAL_RUN_BINDING_CHANGED')
    const terminalEventType = replay.status === 'succeeded' ? 'run.completed' : `run.${replay.status}`
    const armKey = `${mode}:${scenario.id}`
    let arm = arms.get(armKey)
    if (!arm) {
      if (sessionArms.has(replay.sessionId)) fail('HISTORICAL_SCENARIO_SESSIONS_SHARED')
      arm = { sessionId: replay.sessionId, nextTurn: 0, receipts: new Map() }
      arms.set(armKey, arm)
      sessionArms.set(replay.sessionId, armKey)
    }
    if (arm.sessionId !== replay.sessionId || arm.nextTurn !== turnIndex) fail('HISTORICAL_SESSION_LINEAGE_CHANGED')
    arm.nextTurn++
    const observer = observeTrial(pages, corpus)
    const provenReceiptIds = new Set<string>()
    let terminalObserved = false
    let receiptCursor = 0
    for (const event of replay.events) {
      observer.onEvent(event.type, event.data)
      if (event.type === 'tool.completed') {
        const freshReads = observer.finish().wholeReads
        for (; receiptCursor < freshReads.length; receiptCursor++) {
          const read = freshReads[receiptCursor]!
          if (typeof event.data.actionCallId !== 'string' || !event.data.actionCallId) fail('HISTORICAL_READ_ACTION_ID_INVALID')
          const prior = arm.receipts.get(read.receiptActionCallId)
          if (event.data.cacheHit === true && (typeof event.data.reusedActionCallId !== 'string' || !prior))
            fail('HISTORICAL_CACHED_RECEIPT_SOURCE_MISSING')
          if (prior && JSON.stringify(prior) !== JSON.stringify(read)) fail('HISTORICAL_RECEIPT_IDENTITY_CHANGED')
          arm.receipts.set(read.receiptActionCallId, read)
        }
      }
      if (event.type === 'evidence.provenance' && event.data.accepted === true) {
        for (const retrieval of Array.isArray(event.data.retrievals) ? event.data.retrievals : []) {
          const entry = record(retrieval)
          const receipt = typeof entry.actionCallId === 'string' ? arm.receipts.get(entry.actionCallId) : undefined
          if (receipt && ['pages.get', 'pages.getOkf', 'pages.getVersion'].includes(String(entry.actionName)) &&
            Array.isArray(entry.evidenceIds) && entry.evidenceIds.includes(`page:${receipt.id}:revision:${receipt.sourceRevision}`))
            provenReceiptIds.add(receipt.receiptActionCallId)
        }
      }
      if (event.type === terminalEventType) terminalObserved = true
    }
    if (!terminalObserved) fail('HISTORICAL_TERMINAL_EVENT_MISSING')
    const observed = observer.finish()
    const currentReceiptIds = new Set(observed.wholeReads.map(read => read.receiptActionCallId))
    const reads = new Map<string, z.infer<typeof retainedSchema>>()
    for (const read of [...parse(z.array(retainedSchema), trial.wholeReads, 'HISTORICAL_FROZEN_RECEIPT_INVALID'), ...observed.wholeReads,
      ...[...provenReceiptIds].map(id => arm.receipts.get(id)!)]) {
      if (!pages.some(page => page.id === read.id && page.sourceRevision === read.sourceRevision && page.bodySha256 === read.bodySha256))
        fail('HISTORICAL_RECEIPT_NOT_OWNED')
      const sessionReceipt = arm.receipts.get(read.receiptActionCallId)
      if (!sessionReceipt || JSON.stringify(sessionReceipt) !== JSON.stringify(read)) fail('HISTORICAL_SESSION_RECEIPT_SOURCE_MISSING')
      // A frozen follow-up receipt alone is not proof it was retained for this turn.
      if (!currentReceiptIds.has(read.receiptActionCallId) && !provenReceiptIds.has(read.receiptActionCallId))
        fail('HISTORICAL_FOLLOWUP_ACCEPTED_RETRIEVAL_MISSING')
      reads.set(`${read.id}:${read.sourceRevision}:${read.bodySha256}`, read)
    }
    const rankedSources = parse(z.array(rankedSchema), trial.rankedSources, 'HISTORICAL_FROZEN_RANKING_INVALID')
    const rankingValid = mode === 'ordinary' || rankedSources.length > 0 && rankedSources.length <= corpus.topK &&
      new Set(rankedSources.map(source => source.id)).size === rankedSources.length &&
      rankedSources.every((source, sourceIndex) => source.rank === sourceIndex && pages.some(page => page.id === source.id && page.sourceRevision === source.sourceRevision))
    const wholeReads = [...reads.values()]
    const missingWholePageIds = rankedSources.filter(source => !wholeReads.some(read => read.id === source.id && read.sourceRevision === source.sourceRevision)).map(source => source.id)
    const privacySafe = trial.privacySafe === true && observed.outsiderReads === 0 && observed.outsiderResults === 0 && !observed.observationFailed
    const validComparisonTrial = trial.terminalExecution === true && privacySafe && trial.observationFailed === false && rankingValid && missingWholePageIds.length === 0
    const correction = { sessionId: replay.sessionId, durableRunStatus: replay.status, terminalEventType, wholeReads,
      acceptedRetainedReceiptIds: [...provenReceiptIds], measuredWholeBodyBytes: wholeReads.reduce((sum, read) => sum + read.bodyBytes, 0),
      missingWholePageIds, rankingValid, privacySafe, validComparisonTrial,
      wholePageIngestion: mode === 'ordinary' ? 'not-applicable' : rankingValid && missingWholePageIds.length === 0 ? 'observed-all-selected-pages' : 'invalid-or-incomplete',
      modelCallObservation: modelCallObservation(observed.turns, parse(accountingSchema, trial.accounting, 'HISTORICAL_FROZEN_ACCOUNTING_INVALID')),
      nonDispatchedModelEvents: observed.nonDispatchedModelEvents,
      readinessDecisions: observedReadinessDecisions(observed.turns),
      quality: null, boundary: 'Historical ingestion evidence only. Exact same-session receipts and accepted provenance retrievals; not fresh-current authorization, answer coverage, quality, or new paid measurements.' }
    correctedTrials.push({ ...trial, validComparisonTrial, modelCalls: correction.modelCallObservation.observedDispatches,
      modelCallObservation: correction.modelCallObservation })
    return { ...trial, historicalEvidenceCorrection: correction }
  })
  return { ...report, results, historicalEvidenceCorrection: {
    version: 1, originalReportSha256, paidMetricsUnchanged: true, requests: 'GET only; no generation',
    pairedComparisons: pairedComparisons(correctedTrials),
    boundary: 'Original report fields, elapsed/tokens/cost/prompts/corpus/fingerprint and original comparisons are preserved. Additive correction is historical receipt evidence, not current authority; independent actual-answer rubric quality remains null.' } }
}

const scoreReport = async (reportPath: string, adjudicationPath: string, outputPath: string): Promise<void> => {
  const report = record(JSON.parse(await readFile(reportPath, 'utf8')))
  // Grade the exact embedded frozen corpus, not today's query protocol. Historical paid reports remain independently reviewable.
  if (!Array.isArray(report.results) || report.corpusFingerprint !== sha256(JSON.stringify(report.corpus))) throw new Error('Frozen comparator report changed')
  const corpus = resolvedCorpusSchema.parse(report.corpus)
  if (corpus.pages.some(page => sha256(page.body) !== page.bodySha256 || bytes(page.body) !== page.bodyBytes)) throw new Error('Frozen source body changed')
  const judgment = z.object({ corpusFingerprint: z.string(), adjudicator: z.string().min(1), independentOfNativeVerification: z.literal(true),
    trials: z.array(z.object({ trialId: z.string(), publishedAnswerSha256: z.string().length(64), coveredFactIds: z.array(z.string()), unsupportedClaim: z.boolean(), unavailableBehaviorCorrect: z.boolean() }).strict()) }).strict().parse(JSON.parse(await readFile(adjudicationPath, 'utf8')))
  if (judgment.corpusFingerprint !== report.corpusFingerprint || new Set(judgment.trials.map(trial => trial.trialId)).size !== judgment.trials.length) throw new Error('Independent adjudication binding changed')
  const reportIds = new Set(report.results.map(value => record(value).trialId))
  if (judgment.trials.some(trial => !reportIds.has(trial.trialId))) throw new Error('Unknown independently adjudicated trial')
  const results = report.results.map(value => {
    const trial = record(value)
    const turn = corpus.scenarios.find(scenario => scenario.id === trial.scenarioId)?.turns.find(turn => turn.id === trial.turnId)
    if (!turn) throw new Error('Unknown frozen case')
    const reviewed = judgment.trials.find(review => review.trialId === trial.trialId)
    if (!reviewed) return { ...trial, quality: null }
    if (typeof trial.publishedAnswer !== 'string' || sha256(trial.publishedAnswer) !== reviewed.publishedAnswerSha256) throw new Error('Published fictional answer changed')
    const facts = [...turn.requiredFacts, ...turn.materialRestrictions]
    if (new Set(reviewed.coveredFactIds).size !== reviewed.coveredFactIds.length || reviewed.coveredFactIds.some(id => !facts.some(fact => fact.id === id))) throw new Error('Unknown independent rubric fact')
    const covered = new Set(reviewed.coveredFactIds)
    const coverage = covered.size / facts.length
    return { ...trial, quality: { adjudicator: judgment.adjudicator, independentOfNativeVerification: true, requiredFacts: turn.requiredFacts.length,
      coveredRequiredFacts: turn.requiredFacts.filter(fact => covered.has(fact.id)).length, materialRestrictions: turn.materialRestrictions.length,
      coveredRestrictions: turn.materialRestrictions.filter(fact => covered.has(fact.id)).length, missingFactIds: facts.filter(fact => !covered.has(fact.id)).map(fact => fact.id),
      unsupportedClaim: reviewed.unsupportedClaim, unavailableBehaviorCorrect: reviewed.unavailableBehaviorCorrect,
      eligibleForProtocolComparison: (record(trial.historicalEvidenceCorrection).validComparisonTrial ?? trial.validComparisonTrial) === true,
      score: reviewed.unsupportedClaim || !reviewed.unavailableBehaviorCorrect ? 0 : coverage } }
  })
  const comparisonResults = results.map(value => {
    const trial = record(value)
    return { ...trial,
      validComparisonTrial: record(trial.historicalEvidenceCorrection).validComparisonTrial ?? trial.validComparisonTrial,
      modelCalls: record(record(trial.historicalEvidenceCorrection).modelCallObservation).observedDispatches ?? trial.modelCalls,
      modelCallObservation: record(trial.historicalEvidenceCorrection).modelCallObservation ?? trial.modelCallObservation }
  })
  await privateFile(outputPath, { ...report, results, pairedComparisons: pairedComparisons(comparisonResults), quality: results.every(result => result.quality !== null) ? 'independently-adjudicated' : 'partially-adjudicated' })
  process.stdout.write(`${JSON.stringify({ mode: 'score', reviewedTrials: judgment.trials.length, totalTrials: results.length, paidCalls: 0 })}\n`)
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    process.stdout.write(`${JSON.stringify({ cli: 'bun server/scripts/wiki-qna-comparison.ts --mode request-proof|live|score --output <new-private-file> [--driver <protected-concrete-api-module>] [--report <live-report> --adjudications <independent-grading-file>]',
      setup: 'Live driver exports driver: WikiQnaComparisonDriver. Use the existing protected operator helper without printing credentials. Concrete driver creates only owned fictional pages through normal authenticated page API, obtains existing priced/conformed profile resolution, uses normal session POST/message POST/SSE and actual operations search ranking, and retains authoritative provider/unknown-exposure accounting. No direct provider SDK calls or changes to production config. Ordinary uses all-Wiki scope; ranked source selection uses existing knowledgeContext.sources. Both receive identical user text and unchanged native publication gates.',
      grading: { corpusFingerprint: '<frozen-hash>', adjudicator: '<independent-reviewer>', independentOfNativeVerification: true, trials: [{ trialId: '<arm:scenario:turn>', publishedAnswerSha256: '<sha256>', coveredFactIds: ['<frozen-fact-id>'], unsupportedClaim: false, unavailableBehaviorCorrect: true }] },
      measurements: 'Readiness is a utility phase separate from final verification; readiness route means observed subsequent pipeline behavior, not an inferred classifier verdict. modelCalls counts observed dispatches only; modelCallObservation identifies lower-bound counts when durable exposure lacks outcomes. Terminal partial/failed runs remain measured; privacy, ranking, ingestion and independent rubric quality are separate.',
      historicalReplay: 'bun server/scripts/wiki-qna-rehydrate.ts --auth-file <protected-auth-file> --report <historical-unadjudicated-report> --output <new-private-file>; owned terminal GET-only same-session replay adds evidence corrections without modifying original elapsed, tokens, cost, prompt, corpus, fingerprint or report. No current authorization or automatic quality is inferred.',
      cleanup: 'Driver owns only pages/sessions created by its invocation; cancel/drain before deletion, never delete or rewrite durable paid accounting. Output/checkpoint files are private and exclusive. Remove operator-owned output/checkpoints after review. No tests, build or provider calls are made by request-proof or score.' })}\n`)
    return
  }
  const allowed = ['--mode', '--output', '--driver', '--report', '--adjudications']
  if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !allowed.includes(arg)) || new Set(args.filter((_, index) => index % 2 === 0)).size !== args.length / 2) throw new Error('Invalid comparator options')
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2]!, args[index * 2 + 1]!]))
  const mode = z.enum(['request-proof', 'live', 'score']).parse(options['--mode'] ?? 'request-proof')
  const outputPath = options['--output']
  if (!outputPath) throw new Error('A new private output path is required')
  if (mode === 'request-proof') {
    if (options['--driver'] || options['--report'] || options['--adjudications']) throw new Error('Request proof never loads live setup or judgments')
    const corpus = await loadCorpus()
    const sources = corpus.pages.map(page => ({ evidenceId: `fiction:${page.key}`, sourceRevision: page.bodySha256, unitId: `read:${page.key}`, readId: page.key, context: page.title, text: page.body, kind: 'source-read' as const, complete: true }))
    const reads = corpus.pages.map(page => ({ evidenceId: `fiction:${page.key}`, sourceRevision: page.bodySha256, readId: page.key, title: page.title, representation: 'markdown', complete: true, source: page.body }))
    const transport = encodeWikiSynthesisSources(sources, reads)
    const bodyBytes = corpus.pages.reduce((sum, page) => sum + page.bodyBytes, 0)
    const proof = { version: 1, mode, corpusFingerprint: fingerprint(corpus), providerCalls: 0, toolCalls: 0, actualProviderTokens: null, quality: null,
      bodyBytes, sourceTextBytes: bytes(transport.sourceText), structureBytes: bytes(transport.sourceText) - bodyBytes, bindingBytes: bytes(transport.sourceReferences),
      serializedTransportBytes: bytes(JSON.stringify(transport)), pageCount: corpus.pages.length, scenarioCount: corpus.scenarios.length, turnCount: corpus.scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0),
      rankingMeasured: false, corpus, boundary: 'Offline encoding proof only. Synthetic identities are not issued receipts. No ranked pages, provider dialect, admission, live tokens, native quality or elapsed/provider performance are claimed.' }
    await privateFile(outputPath, proof)
    process.stdout.write(`${JSON.stringify({ mode, corpusFingerprint: proof.corpusFingerprint, bodyBytes, serializedTransportBytes: proof.serializedTransportBytes, providerCalls: 0, quality: null })}\n`)
  } else if (mode === 'live') {
    if (!options['--driver'] || options['--report'] || options['--adjudications']) throw new Error('Live comparison requires concrete protected API setup only')
    // The protected concrete driver path is selected by the operator at runtime; static import cannot name it.
    const module = await import(pathToFileURL(resolve(options['--driver'])).href) as { driver?: WikiQnaComparisonDriver }
    if (!module.driver || typeof module.driver.prepare !== 'function') throw new Error('Concrete accounted API driver is required')
    await runWikiQnaComparison(module.driver, outputPath)
  } else {
    if (!options['--report'] || !options['--adjudications'] || options['--driver']) throw new Error('Scoring requires a live report and independent adjudications; never a driver')
    await scoreReport(options['--report'], options['--adjudications'], outputPath)
  }
}

if (import.meta.main) {
  try { await main() } catch {
    // Provider/HTTP errors may carry credentials or private content; emit no inherited exception text.
    process.stdout.write(`${JSON.stringify({ status: 'failed', failure: 'WIKI_QNA_COMPARISON_FAILED', measurements: 'Preserve existing private checkpoints and normal durable application usage events.' })}\n`)
    process.exitCode = 1
  }
}
