import { createHash } from 'node:crypto'
import { z } from 'zod'
import { optimize, runControl, axSerializeOptimizedProgram, axDeserializeOptimizedProgram, AxAssertionError, AxGenerateError, type AxAIService, type AxGEPAAdapter, type AxMetricFn, type AxProgramForwardOptions, type AxSerializedOptimizedProgram, type AxTypedExample } from '@ax-llm/ax'
import { ProxyTracerProvider } from '@opentelemetry/api'
import { createWikiSynthesisProgram, encodeWikiSynthesisSources, renderWikiSynthesisAnswer, validateWikiSynthesisShape, type WikiSynthesisAnswer, type WikiSynthesisBinding, type WikiSynthesisClaim, type WikiSynthesisInput, type WikiSynthesisSource } from './wiki-synthesis.ts'

const sourceSchema = z.object({ evidenceId: z.string(), sourceRevision: z.string(), unitId: z.string(), context: z.string(), text: z.string(), kind: z.string(), complete: z.boolean(), packet: z.string() })
const claimSchema = z.object({ evidenceId: z.string(), sourceRevision: z.string(), unitId: z.string(), statement: z.string() })
const answerSchema = z.object({ claims: z.array(claimSchema).max(64), unresolvedFacets: z.array(z.number().int().nonnegative()).max(64), observations: z.array(z.string()), recommendations: z.string().default('') })
const fixtureSchema = z.object({
  id: z.string(), family: z.string(), split: z.enum(['train', 'selection', 'final']),
  provenance: z.object({ kind: z.literal('synthetic'), adjudication: z.string() }),
  userRequest: z.string(), sourceUnits: z.array(sourceSchema), requestFacets: z.array(z.string()), observations: z.array(z.string()), repairFeedback: z.string(),
  details: z.array(z.object({ id: z.string(), evidenceId: z.string(), sourceRevision: z.string(), unitId: z.string(), facet: z.number().int().nonnegative(), allOf: z.array(z.string()), exact: z.array(z.string()), allowedParaphrases: z.array(z.string()), allowedAtomicAssertions: z.array(z.string()).default([]) })),
  expectedUnresolvedFacets: z.array(z.number().int().nonnegative()),
  variants: z.array(z.object({ id: z.string(), category: z.string(), expected: z.enum(['accept', 'reject', 'incomplete']), answer: answerSchema }))
})
export type WikiSynthesisFixture = z.infer<typeof fixtureSchema>
export type WikiSynthesisSplit = WikiSynthesisFixture['split']

export const WIKI_SYNTHESIS_EVALUATION_CONTRACT = Object.freeze({
  version: 2,
  cli: 'bun server/scripts/wiki-synthesis-evaluation.ts --mode classify|optimize|evaluate|compare --artifact <file> [--compare-reasoning] [--output-artifact <new-file>; required for compare]',
  apis: ['createWikiSynthesisProgram', 'renderWikiSynthesisAnswer', 'optimize', 'axSerializeOptimizedProgram', 'axDeserializeOptimizedProgram', 'createWikiOfflineDispatchAdmission'],
  rubric: 'Score = source-local precision × independently adjudicated requested-detail recall × unresolved-facet accuracy, with zero credit for an unsupported assertion or unsafe formal output shape. Support requires an entire intact source statement, or an entire independently adjudicated paraphrase/atomic assertion for the exact source binding; token overlap and unit-wide denial presence are not proof of a relation. Only whitespace and a terminal period normalize; literals, operators, modality, negation and governing qualifiers stay intact. False inability scores zero; adjudicated unavailable evidence permits truthful abstention. Standalone original advice is permitted only by the shared formal Recommendations boundary; uncited factual premises are rejected. This version-2 finite manual gold corpus is not universal semantic entailment proof. Rejections, failed forwards, correction count, wall/provider time, measured usage/cost and unknown exposure are reported separately.',
  isolation: 'Distinct physical train, selection-validation and final files; disjoint fixture families and evidence IDs. Only train and selection enter optimize. Freeze and serialize the selected artifact before loading final. Compare default versus low on selection only, with two alternately ordered paired passes; final is never a selection input.',
  privacy: 'Synthetic corpus only; stdout is numeric metadata/fixture IDs. Never log provider errors, prompts, responses or secrets. Optimization artifacts contain synthetic demos and instructions and are saved privately.'
})

export const parseWikiSynthesisFixtures = (value: unknown, split: WikiSynthesisSplit): WikiSynthesisFixture[] => {
  const fixtures = z.array(fixtureSchema).min(1).parse(value)
  const ids = new Set<string>()
  const evidence = new Set<string>()
  for (const fixture of fixtures) {
    if (fixture.split !== split || ids.has(fixture.id)) throw new Error('Invalid or duplicate offline fixture split')
    ids.add(fixture.id)
    if (fixture.requestFacets.some(facet => !fixture.userRequest.includes(facet))) throw new Error('Offline requested facets must be literal request quotes')
    for (const source of fixture.sourceUnits) {
      if (evidence.has(source.evidenceId)) throw new Error('Offline evidence IDs must be unique within each split')
      evidence.add(source.evidenceId)
    }
    for (const detail of fixture.details) {
      if (!fixture.sourceUnits.some(source => source.evidenceId === detail.evidenceId && source.sourceRevision === detail.sourceRevision && source.unitId === detail.unitId) || detail.facet >= fixture.requestFacets.length)
        throw new Error('Offline adjudication references an unknown source or facet')
      for (const pattern of detail.allOf) new RegExp(pattern, 'iu')
    }
  }
  return fixtures
}

export const assertWikiSynthesisSplitIsolation = (...splits: readonly (readonly WikiSynthesisFixture[])[]): void => {
  const identities = new Set<string>()
  for (const fixtures of splits) {
    for (const fixture of fixtures) {
      for (const key of [`fixture:${fixture.id}`, `family:${fixture.family}`, ...fixture.sourceUnits.map(source => `evidence:${source.evidenceId}`)]) {
        if (identities.has(key)) throw new Error('Offline train/selection/final contamination')
        identities.add(key)
      }
    }
  }
}

// Normalize presentation only; never erase operators, modality, negation or qualifier relationships.
const assertionText = (text: string): string => text.trim().replace(/\s+/gu, ' ').replace(/\.$/u, '')
const exactTokens = (text: string): string[] => text.match(/https?:\/\/[^\s;]+|(?:>=|<=|>|<)|\b\d+(?:\.\d+)?%?/gu)?.map(token => token.replace(/[.,]$/u, '')) ?? []

/** A finite, independently adjudicated assertion corpus, not a word-overlap semantic judge. */
export const validateWikiFixtureClaim = (fixture: WikiSynthesisFixture, claim: WikiSynthesisClaim, source: WikiSynthesisSource): boolean => {
  if (!source.complete || source.evidenceId !== claim.evidenceId || source.sourceRevision !== claim.sourceRevision || source.unitId !== claim.unitId || /\[\[|\]\]|\[source|\[citation|##|```/iu.test(claim.statement)) return false
  const statement = assertionText(claim.statement)
  if (!statement) return false
  if (statement === assertionText(source.text)) return true
  const details = fixture.details.filter(detail => detail.evidenceId === source.evidenceId && detail.sourceRevision === source.sourceRevision && detail.unitId === source.unitId)
  return details.some(detail => [...detail.allowedParaphrases, ...detail.allowedAtomicAssertions].some(assertion => statement === assertionText(assertion)))
}

// Content-exclusion flags do not redact exception messages in inherited spans.
const privateTracer = new ProxyTracerProvider().getTracer('wiki-synthesis-evaluation-private')

// Override inherited generation defaults, including native GEPA's teacher AxGen.
// An attached native run control bypasses inherited response-cache reads/writes.
const offlineForwardOptions = () => ({
  control: runControl(), maxRetries: 0, maxSteps: 1, asyncMode: 'off', sampleCount: 1,
  debug: false, verbose: false,
  excludeContentFromTrace: true, includeRequestBodyInErrors: false, tracer: privateTracer, logger: () => {}
} satisfies AxProgramForwardOptions<string>)

export interface WikiSynthesisRubric {
  readonly score: number
  readonly shapeSafe: boolean
  readonly precision: number
  readonly coverage: number
  readonly exactIntegrity: number
  readonly locality: number
  readonly falseRejection: number
  readonly coveredDetails: number
  readonly requestedDetails: number
  readonly rejectedClaims: number
}

export interface WikiSynthesisFixtureEvaluation extends WikiSynthesisRubric {
  readonly fixtureId: string
  readonly rejectedAttempts: number
  readonly failedAttempts: number
  readonly corrections: number
  readonly wallMilliseconds: number
}

export interface WikiSynthesisEvaluation {
  readonly fixtureCount: number
  readonly meanScore: number
  readonly failedAttempts: number
  readonly rejectedAttempts: number
  readonly corrections: number
  readonly results: readonly WikiSynthesisFixtureEvaluation[]
}

export const scoreWikiSynthesisAnswer = (fixture: WikiSynthesisFixture, value: unknown): WikiSynthesisRubric => {
  const parsed = answerSchema.safeParse(value)
  const empty = { score: 0, shapeSafe: false, precision: 0, coverage: 0, exactIntegrity: 0, locality: 0, falseRejection: fixture.details.length > 0 ? 1 : 0, coveredDetails: 0, requestedDetails: fixture.details.length, rejectedClaims: 0 }
  if (!parsed.success) return empty
  const answer = parsed.data
  const shapeSafe = validateWikiSynthesisShape(answer) === true
  let valid = 0
  let local = 0
  let exact = 0
  const supported = new Map<string, string[]>()
  for (const claim of answer.claims) {
    const source = fixture.sourceUnits.find(unit => unit.evidenceId === claim.evidenceId && unit.sourceRevision === claim.sourceRevision && unit.unitId === claim.unitId)
    if (!source) continue
    local++
    if (exactTokens(claim.statement).every(token => exactTokens(source.text).includes(token))) exact++
    if (!validateWikiFixtureClaim(fixture, claim, source)) continue
    valid++
    const key = `${source.evidenceId}:${source.unitId}`
    const statements = supported.get(key) ?? []
    statements.push(claim.statement)
    supported.set(key, statements)
  }
  let covered = 0
  for (const detail of fixture.details) {
    const statements = supported.get(`${detail.evidenceId}:${detail.unitId}`) ?? []
    // A qualifier in another claim must not qualify a bare threshold/owned record.
    if (statements.some(text => detail.allOf.every(pattern => new RegExp(pattern, 'iu').test(text)) && detail.exact.every(literal => text.includes(literal)))) covered++
  }
  const precision = answer.claims.length ? valid / answer.claims.length : fixture.details.length === 0 ? 1 : 0
  const coverage = fixture.details.length ? covered / fixture.details.length : 1
  const unresolvedCorrect = answer.unresolvedFacets.length === fixture.expectedUnresolvedFacets.length && new Set(answer.unresolvedFacets).size === answer.unresolvedFacets.length && answer.unresolvedFacets.every(facet => fixture.expectedUnresolvedFacets.includes(facet))
  const observationsCorrect = answer.observations.every(observation => fixture.observations.includes(observation))
  return { score: precision * coverage * Number(shapeSafe && valid === answer.claims.length && unresolvedCorrect && observationsCorrect), shapeSafe, precision, coverage, exactIntegrity: answer.claims.length ? exact / answer.claims.length : fixture.details.length === 0 ? 1 : 0,
    locality: answer.claims.length ? local / answer.claims.length : fixture.details.length === 0 ? 1 : 0, falseRejection: fixture.details.length > 0 && covered === 0 ? 1 : 0, coveredDetails: covered, requestedDetails: fixture.details.length, rejectedClaims: answer.claims.length - valid }
}

export const classifyWikiSynthesisCorpus = (fixtures: readonly WikiSynthesisFixture[]) => fixtures.flatMap(fixture => fixture.variants.map(variant => {
  const rubric = scoreWikiSynthesisAnswer(fixture, variant.answer)
  const classification = !rubric.shapeSafe || rubric.rejectedClaims > 0 || rubric.locality < 1 && variant.answer.claims.length > 0 ? 'reject' : rubric.score === 1 ? 'accept' : 'incomplete'
  return { fixtureId: fixture.id, variantId: variant.id, category: variant.category, expected: variant.expected, classification, matched: variant.expected === classification, ...rubric }
}))

const createFixtureProgram = (fixtures: readonly WikiSynthesisFixture[], service: AxAIService, rejected: () => void) => {
  const features = service.getFeatures()
  return createWikiSynthesisProgram(fixtures.flatMap(fixture => fixture.sourceUnits), {
    structured: features.structuredOutputModes === undefined ? features.functions || features.structuredOutputs === true : features.structuredOutputModes.length > 0,
    facetCount: Math.max(...fixtures.map(fixture => fixture.requestFacets.length)), observations: fixtures.flatMap(fixture => fixture.observations),
    validateClaim: (claim, source) => {
      const fixture = fixtures.find(entry => entry.sourceUnits.some(unit => unit.evidenceId === source.evidenceId))
      const valid = fixture !== undefined && validateWikiFixtureClaim(fixture, claim, source)
      if (!valid) rejected()
      return valid || 'The offline adjudicated source-locality gate rejected this claim.'
    }
  })
}

export const evaluateWikiSynthesisFixtures = async (fixtures: readonly WikiSynthesisFixture[], service: AxAIService, artifact?: AxSerializedOptimizedProgram, maximumCorrections = 0): Promise<WikiSynthesisEvaluation> => {
  if (!Number.isInteger(maximumCorrections) || maximumCorrections < 0 || maximumCorrections > 1) throw new Error('Offline corrections must be zero or one')
  const results: WikiSynthesisFixtureEvaluation[] = []
  for (const fixture of fixtures) {
    let rejectedAttempts = 0
    let failedAttempts = 0
    let corrections = 0
    let answer: WikiSynthesisAnswer | undefined
    const started = performance.now()
    let sourceRejected = false
    for (let attempt = 0; attempt <= maximumCorrections; attempt++) {
      sourceRejected = false
      const program = createFixtureProgram([fixture], service, () => { sourceRejected = true })
      if (artifact) program.applyOptimization(axDeserializeOptimizedProgram(artifact))
      let completedInference = false
      let terminalFailure = false
      // Distinguish a paid, completed invalid answer from a failed dispatch.
      // AxGenerateError wraps both, and exhausted validation loses its typed cause.
      const observedChat: AxAIService['chat'] = async (request, options) => {
        const response = await service.chat(request, options)
        if (!(response instanceof ReadableStream)) {
          completedInference = true
          terminalFailure = response.results.some(result => result.finishReason === 'error' || result.finishReason === 'length')
        }
        return response
      }
      const observedAI = new Proxy(service, {
        get(target, property) {
          if (property === 'chat') return observedChat
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      try {
        answer = await program.forward(observedAI, { userRequest: fixture.userRequest, ...encodeWikiSynthesisSources(fixture.sourceUnits), requestFacets: fixture.requestFacets, availableObservations: fixture.observations, repairFeedback: attempt ? 'The previous synthesis failed its source-locality or shape gate. Re-read each complete source unit and preserve requested coverage.' : '' }, offlineForwardOptions())
        if (terminalFailure) {
          answer = undefined
          failedAttempts++
          break
        }
        renderWikiSynthesisAnswer(answer)
        break
      } catch (error) {
        failedAttempts++
        if (sourceRejected || error instanceof AxAssertionError || error instanceof AxGenerateError && error.cause instanceof AxAssertionError) rejectedAttempts++
        if (!completedInference || terminalFailure || !(error instanceof AxGenerateError || error instanceof AxAssertionError) || attempt >= maximumCorrections) break
        corrections++
      }
    }
    results.push({ fixtureId: fixture.id, ...scoreWikiSynthesisAnswer(fixture, answer), rejectedAttempts, failedAttempts, corrections, wallMilliseconds: performance.now() - started })
  }
  return { fixtureCount: fixtures.length, meanScore: results.reduce((sum, result) => sum + result.score, 0) / fixtures.length,
    failedAttempts: results.reduce((sum, result) => sum + result.failedAttempts, 0), rejectedAttempts: results.reduce((sum, result) => sum + result.rejectedAttempts, 0), corrections: results.reduce((sum, result) => sum + result.corrections, 0), results }
}

/** Holdout loader and writer enforce the irreversible selection/final boundary in the caller. */
export const optimizeWikiSynthesis = async (input: {
  readonly train: readonly WikiSynthesisFixture[]
  readonly selection: readonly WikiSynthesisFixture[]
  readonly studentAI: AxAIService
  readonly teacherAI: AxAIService
  readonly maximumMetricCalls: number
  readonly trials: number
  readonly saveArtifact: (artifact: AxSerializedOptimizedProgram, fingerprint: string) => Promise<void>
  readonly loadFinal: () => Promise<readonly WikiSynthesisFixture[]>
  readonly selectReasoning?: (artifact: AxSerializedOptimizedProgram) => Promise<{ readonly ai: AxAIService; readonly report: unknown }>
}) => {
  assertWikiSynthesisSplitIsolation(input.train, input.selection)
  const minibatchSize = input.train.length
  const minimumMetricCalls = input.selection.length + minibatchSize * 2 + input.selection.length
  if (!input.train.length || !input.selection.length || !Number.isSafeInteger(input.maximumMetricCalls) || input.maximumMetricCalls < minimumMetricCalls || !Number.isSafeInteger(input.trials) || input.trials < 1)
    throw new Error('Offline optimizer allowance must cover baseline, parent, mutated child and full validation')
  let rejectedAttempts = 0
  let failedAttempts = 0
  let evaluatedAttempts = 0
  let metricCalls = 0
  let teacherProposalFailures = 0
  let teacherRejectedAttempts = 0
  let baselineSelectionScore: number | undefined
  let mutatedCandidateEvaluations = 0
  const evaluatedMutations = new Set<string>()
  const tuning = [...input.train, ...input.selection]
  const program = createFixtureProgram([input.train[0]!], input.studentAI, () => { rejectedAttempts++ })
  const initialComponents = Object.fromEntries(program.getOptimizableComponents().map(component => [component.key, component.current]))
  const examples = (fixtures: readonly WikiSynthesisFixture[]) => fixtures.map(fixture => ({
    userRequest: fixture.userRequest, ...encodeWikiSynthesisSources(fixture.sourceUnits), requestFacets: fixture.requestFacets, availableObservations: fixture.observations, repairFeedback: fixture.repairFeedback,
    ...fixture.variants.find(variant => variant.id === 'reference')!.answer
  }))
  const metric: AxMetricFn = ({ prediction, example }) => {
    metricCalls++
    const bindings = JSON.parse(example.sourceBindings as string) as WikiSynthesisBinding[]
    const fixture = tuning.find(entry => entry.userRequest === example.userRequest && entry.sourceUnits[0]?.evidenceId === bindings[0]?.[0])
    return fixture ? scoreWikiSynthesisAnswer(fixture, prediction).score : 0
  }
  type Trace = { fixtureId: string; rubric: WikiSynthesisRubric; failed: boolean; prediction?: WikiSynthesisAnswer }
  const adapter: AxGEPAAdapter<AxTypedExample<WikiSynthesisInput>, Trace, WikiSynthesisAnswer | undefined> = {
    evaluate: async (batch, candidate, captureTraces) => {
      if (metricCalls + batch.length > input.maximumMetricCalls) throw new Error('Offline optimizer cannot admit a complete evaluation batch')
      const candidateChanged = Object.entries(candidate).some(([key, value]) => Object.hasOwn(initialComponents, key) && initialComponents[key] !== value)
      let appliedMutation = false
      const outputs: (WikiSynthesisAnswer | undefined)[] = []
      const scores: number[] = []
      const trajectories: Trace[] = []
      for (const example of batch) {
        if (metricCalls >= input.maximumMetricCalls) throw new Error('Offline optimizer metric allowance exhausted')
        const bindings = JSON.parse(example.sourceBindings) as WikiSynthesisBinding[]
        const fixture = tuning.find(entry => entry.userRequest === example.userRequest && entry.sourceUnits[0]?.evidenceId === bindings[0]?.[0])
        if (!fixture) throw new Error('Optimizer attempted an example outside train/selection')
        let rejected = false
        let prediction: WikiSynthesisAnswer | undefined
        const bound = createFixtureProgram([fixture], input.studentAI, () => { rejected = true })
        const beforeComponents = Object.fromEntries(bound.getOptimizableComponents().map(component => [component.key, component.current]))
        bound.applyOptimizedComponents(candidate)
        const changedForward = candidateChanged && bound.getOptimizableComponents().some(component => component.current !== beforeComponents[component.key])
        if (changedForward) {
          mutatedCandidateEvaluations++
          appliedMutation = true
        }
        evaluatedAttempts++
        let failed = false
        try {
          prediction = await bound.forward(input.studentAI, {
            userRequest: fixture.userRequest, ...encodeWikiSynthesisSources(fixture.sourceUnits), requestFacets: fixture.requestFacets, availableObservations: fixture.observations, repairFeedback: fixture.repairFeedback
          }, offlineForwardOptions())
          renderWikiSynthesisAnswer(prediction)
        } catch (error) {
          failed = true
          failedAttempts++
          if (error instanceof AxAssertionError || error instanceof AxGenerateError && error.cause instanceof AxAssertionError) rejected = true
        }
        if (rejected) rejectedAttempts++
        const rubric = scoreWikiSynthesisAnswer(fixture, prediction)
        outputs.push(prediction)
        scores.push(await metric({ prediction, example }))
        if (captureTraces) trajectories.push({ fixtureId: fixture.id, rubric, failed, ...(prediction ? { prediction } : {}) })
      }
      if (appliedMutation) evaluatedMutations.add(createHash('sha256').update(JSON.stringify(Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right)))).digest('hex'))
      if (!candidateChanged && batch.length === input.selection.length && input.selection.every(fixture => batch.some(example => example.userRequest === fixture.userRequest && (JSON.parse(example.sourceBindings) as WikiSynthesisBinding[])[0]?.[0] === fixture.sourceUnits[0]?.evidenceId)))
        baselineSelectionScore = scores.reduce((sum, score) => sum + score, 0) / scores.length
      return { outputs, scores, ...(captureTraces ? { trajectories } : {}) }
    },
    make_reflective_dataset: (_candidate, batch, components) => Object.fromEntries(components.map(component => [component, (batch.trajectories ?? []).map(trace => {
      const fixture = tuning.find(entry => entry.id === trace.fixtureId)!
      return { userRequest: fixture.userRequest, ...encodeWikiSynthesisSources(fixture.sourceUnits), requestFacets: fixture.requestFacets,
        independentlyAdjudicatedDetails: fixture.details, prediction: trace.prediction, feedback: trace.rubric, failed: trace.failed }
    })]))
  }
  const result = await optimize(program, examples(input.train), metric, {
    studentAI: input.studentAI, teacherAI: input.teacherAI, validationExamples: examples(input.selection), maxMetricCalls: input.maximumMetricCalls,
    gepaAdapter: adapter, numTrials: input.trials, minibatch: true, minibatchSize, minibatchFullEvalSteps: 1, skipPerfectScore: false, sampleCount: 1, bootstrap: false, seed: 42, verbose: false,
    logger: event => { if (event.name === 'Notification' && event.id === 'gepa_teacher') teacherProposalFailures++ }, optimizerLogger: () => {},
    teacherOptions: { ...offlineForwardOptions(), logger: event => { if (event.name === 'ValidationError' || event.name === 'RefusalError') teacherRejectedAttempts++ } }
  })
  if (!result.optimizedProgram) throw new Error('Native optimizer did not produce an applicable artifact')
  const baselinePerfect = baselineSelectionScore === 1
  if (evaluatedMutations.size === 0 && !baselinePerfect) throw new Error('Native optimizer did not evaluate a changed candidate; no optimized artifact may be claimed')
  program.applyOptimization(result.optimizedProgram)
  const artifact = axSerializeOptimizedProgram(result.optimizedProgram)
  const fingerprint = createHash('sha256').update(JSON.stringify(artifact)).digest('hex')
  const reasoning = await input.selectReasoning?.(artifact)
  const selectedAI = reasoning?.ai ?? input.studentAI
  const selection = await evaluateWikiSynthesisFixtures(input.selection, selectedAI, artifact)
  await input.saveArtifact(artifact, fingerprint)
  const final = await input.loadFinal()
  assertWikiSynthesisSplitIsolation(input.train, input.selection, final)
  const finalHoldout = await evaluateWikiSynthesisFixtures(final, selectedAI, artifact)
  return { fingerprint, optimizerBestScore: result.bestScore, optimizationStatus: evaluatedMutations.size === 0 ? 'baseline-perfect-no-optimization-needed' : 'mutated-candidate-evaluated',
    baselineSelectionScore: baselineSelectionScore ?? null, minibatchSize, minimumMetricCalls, mutatedCandidateEvaluations, evaluatedMutatedCandidates: evaluatedMutations.size,
    metricCalls, evaluatedAttempts, rejectedAttempts, failedAttempts, synthesisCorrections: 0, teacherProposalFailures, teacherRejectedAttempts, selection, ...(reasoning ? { reasoningSelection: reasoning.report } : {}), finalHoldout }
}
