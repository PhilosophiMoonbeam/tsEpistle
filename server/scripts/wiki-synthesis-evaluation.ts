import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import createKnex from 'knex'
import { z } from 'zod'
import type { AxSerializedOptimizedProgram } from '@ax-llm/ax'
import { AgentProviderRegistry, type AgentProfileTokenKeys } from '../agents/providers/registry.ts'
import { DatabaseAgentSecretRegistry, decodeAgentProviderSecretKeys, environmentSecretValue } from '../agents/providers/secrets.ts'
import { createWikiOfflineDispatchAdmission, type WikiOfflineAdmission } from '../agents/providers/wiki-synthesis-offline-admission.ts'
import { WIKI_SYNTHESIS_EVALUATION_CONTRACT, assertWikiSynthesisSplitIsolation, classifyWikiSynthesisCorpus, evaluateWikiSynthesisFixtures, optimizeWikiSynthesis, parseWikiSynthesisFixtures, type WikiSynthesisEvaluation, type WikiSynthesisSplit } from '../agents/providers/wiki-synthesis-evaluation.ts'

const artifactSchema = z.object({ version: z.literal(2), corpusFingerprint: z.string().length(64), fingerprint: z.string().length(64),
  studentProfileVersionId: z.string(), model: z.string(), reasoningSelection: z.enum(['default', 'low']), optimizedProgram: z.record(z.string(), z.unknown()) })

const main = async (): Promise<void> => {
  const rawArgs = process.argv.slice(2)
  const compareReasoning = rawArgs.includes('--compare-reasoning')
  const args = rawArgs.filter(arg => arg !== '--compare-reasoning')
  if (args.includes('--help')) {
    process.stdout.write(`${JSON.stringify({ ...WIKI_SYNTHESIS_EVALUATION_CONTRACT,
      environment: ['WIKI_EVAL_DATABASE_URL', 'WIKI_EVAL_OWNER_ID', 'WIKI_EVAL_STUDENT_PROFILE_VERSION_ID',
        'WIKI_EVAL_TEACHER_PROFILE_VERSION_ID (optional; student by default)', 'AGENT_PROVIDER_SECRET_KEYS[_FILE]', 'AGENT_PROFILE_RESOLUTION_KEYS[_FILE]',
        'WIKI_EVAL_MAX_CALLS (default 100)', 'WIKI_EVAL_MAX_TOKENS (default 1000000)', 'WIKI_EVAL_MAX_COST_MICROS (default 10000000)',
        'WIKI_EVAL_MAX_OUTPUT_TOKENS (default 2048)', 'WIKI_EVAL_MAX_METRIC_CALLS (default 32; minimum covers baseline/parent/child/full validation)', 'WIKI_EVAL_TRIALS (default 3)'],
      modes: {
        classify: 'No inference or DB; classify train/selection only, never load the final holdout.',
        optimize: 'Tune on train/selection; --compare-reasoning selects effort on paired validation; freeze new private --artifact before final.',
        evaluate: 'Restore the exact saved program and selected effort from --artifact; evaluate final only, never tune.',
        compare: 'Restore --artifact; two alternating paired selection passes; freeze into NEW exclusive private --output-artifact before final. Later evaluate must use this new artifact. Explicit profile effort always wins.'
      } })}\n`)
    return
  }
  const allowedOptions = ['--mode', '--artifact', '--output-artifact']
  if (args.length % 2 !== 0 || args.some((value, index) => index % 2 === 0 && !allowedOptions.includes(value))) throw new Error('Invalid offline evaluation CLI options')
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2]!, args[index * 2 + 1]!]))
  const mode = z.enum(['classify', 'optimize', 'evaluate', 'compare']).parse(options['--mode'] ?? (compareReasoning ? 'compare' : 'classify'))
  if (compareReasoning && mode !== 'optimize' && mode !== 'compare') throw new Error('--compare-reasoning requires optimize or compare mode')
  const loadSplit = async (split: WikiSynthesisSplit) => parseWikiSynthesisFixtures(JSON.parse(await readFile(new URL(`../test/agents/fixtures/wiki-synthesis-${split}.json`, import.meta.url), 'utf8')), split)
  // Contract/rubric/split boundaries are emitted BEFORE any corpus classification or inference.
  process.stdout.write(`${JSON.stringify({ contract: WIKI_SYNTHESIS_EVALUATION_CONTRACT, mode })}\n`)
  if (mode === 'classify') {
    const splits = await Promise.all([loadSplit('train'), loadSplit('selection')])
    assertWikiSynthesisSplitIsolation(...splits)
    const classification = classifyWikiSynthesisCorpus(splits.flat())
    process.stdout.write(`${JSON.stringify({ splits: ['train', 'selection'], finalHoldoutLoaded: false, fixtureCount: splits.flat().length, variants: classification.length, mismatches: classification.filter(row => !row.matched).length, classification })}\n`)
    if (classification.some(row => !row.matched)) process.exitCode = 1
    return
  }
  const artifactPath = options['--artifact']
  if (!artifactPath) throw new Error('Offline inference requires --artifact')
  const outputArtifactPath = options['--output-artifact']
  if (mode === 'compare' && !outputArtifactPath) throw new Error('Compare requires a new --output-artifact for the frozen selection')
  if (mode !== 'compare' && outputArtifactPath) throw new Error('--output-artifact is reserved for compare mode')
  if (outputArtifactPath && resolve(outputArtifactPath) === resolve(artifactPath)) throw new Error('Comparison must not overwrite its input artifact')
  const required = (name: string): string => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error('Required offline environment configuration is missing')
    return value
  }
  const positiveInteger = (name: string, fallback?: number): number => {
    const value = process.env[name] === undefined && fallback !== undefined ? fallback : Number(required(name))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Offline environment limit must be a positive integer')
    return value
  }
  const limits = { maximumCalls: positiveInteger('WIKI_EVAL_MAX_CALLS', 100), maximumTokens: positiveInteger('WIKI_EVAL_MAX_TOKENS', 1_000_000), maximumCostMicros: positiveInteger('WIKI_EVAL_MAX_COST_MICROS', 10_000_000), maximumOutputTokens: positiveInteger('WIKI_EVAL_MAX_OUTPUT_TOKENS', 2_048) }
  const ownerId = positiveInteger('WIKI_EVAL_OWNER_ID')
  const studentProfileVersionId = required('WIKI_EVAL_STUDENT_PROFILE_VERSION_ID')
  const secretKeys = environmentSecretValue('AGENT_PROVIDER_SECRET_KEYS')
  const resolutionKeys = environmentSecretValue('AGENT_PROFILE_RESOLUTION_KEYS')
  if (!secretKeys || !resolutionKeys) throw new Error('Existing provider and resolution keyrings are required')
  const tokenKeys = z.object({ currentKeyId: z.string(), keys: z.record(z.string(), z.string()) }).parse(JSON.parse(resolutionKeys)) satisfies AgentProfileTokenKeys
  const train = await loadSplit('train')
  const selection = await loadSplit('selection')
  assertWikiSynthesisSplitIsolation(train, selection)
  const corpusFingerprint = createHash('sha256').update(JSON.stringify({ train, selection })).digest('hex')
  const knex = createKnex({ client: 'pg', connection: required('WIKI_EVAL_DATABASE_URL'), pool: { min: 0, max: 2 } })
  const admissions: { label: string; admitted: WikiOfflineAdmission }[] = []
  try {
    const secrets = new DatabaseAgentSecretRegistry(knex, decodeAgentProviderSecretKeys(secretKeys))
    const registry = new AgentProviderRegistry(knex, secrets, tokenKeys)
    // Global totals, not per-model allowances: a shared factory budget prevents comparison/teacher overspend.
    const admittedService = async (label: string, profileVersionId: string, low = false) => {
      const admitted = await createWikiOfflineDispatchAdmission(knex, { ...limits, ownerId, profileVersionId, registry, secrets, label, ...(low ? { reasoningEffort: 'low' as const } : {}), sharedAllowance })
      admissions.push({ label, admitted })
      return admitted
    }
    const sharedAllowance = { calls: 0, tokens: 0, costMicros: 0 }
    const student = await admittedService('student-default', studentProfileVersionId)
    let reasoningSelection: 'default' | 'low' = 'default'
    const compareSelection = async (artifact: AxSerializedOptimizedProgram) => {
      const low = await admittedService('student-low-default', studentProfileVersionId, true)
      const paired: (WikiSynthesisEvaluation & {
        pass: number; effort: 'default' | 'low'; providerMilliseconds: number; costMicros: number;
        inputTokens: number; outputTokens: number; totalTokens: number; unknownExposureTokens: number; unknownExposureCostMicros: number
      })[] = []
      for (let pass = 0; pass < 2; pass++) {
        for (const effort of pass % 2 === 0 ? ['default', 'low'] as const : ['low', 'default'] as const) {
          const service = effort === 'default' ? student : low
          const before = service.summary()
          const result = await evaluateWikiSynthesisFixtures(selection, service.service, artifact)
          const after = service.summary()
          paired.push({ pass, effort, ...result, providerMilliseconds: after.providerMilliseconds - before.providerMilliseconds, costMicros: after.costMicros - before.costMicros,
            inputTokens: after.inputTokens - before.inputTokens, outputTokens: after.outputTokens - before.outputTokens, totalTokens: after.totalTokens - before.totalTokens,
            unknownExposureTokens: after.unknownExposureTokens - before.unknownExposureTokens, unknownExposureCostMicros: after.unknownExposureCostMicros - before.unknownExposureCostMicros })
        }
      }
      const aggregate = (effort: 'default' | 'low') => {
        const rows = paired.filter(row => row.effort === effort)
        return { effort, meanScore: rows.reduce((sum, row) => sum + row.meanScore, 0) / rows.length,
          wallMilliseconds: rows.reduce((sum, row) => sum + row.results.reduce((total, result) => total + result.wallMilliseconds, 0), 0),
          providerMilliseconds: rows.reduce((sum, row) => sum + row.providerMilliseconds, 0), costMicros: rows.reduce((sum, row) => sum + row.costMicros, 0),
          failedAttempts: rows.reduce((sum, row) => sum + row.failedAttempts, 0) }
      }
      const candidates = [aggregate('default'), aggregate('low')].sort((left, right) => right.meanScore - left.meanScore || left.failedAttempts - right.failedAttempts || left.wallMilliseconds - right.wallMilliseconds || left.costMicros - right.costMicros)
      reasoningSelection = candidates[0]!.effort
      return { ai: reasoningSelection === 'default' ? student.service : low.service,
        report: { paired, candidates, selected: reasoningSelection, defaultAppliedEffort: student.reasoningEffort ?? null, lowAppliedEffort: low.reasoningEffort ?? null,
          ineffectualOverride: student.reasoningEffort === low.reasoningEffort } }
    }
    let report: unknown
    if (mode === 'optimize') {
      const teacherProfileVersionId = process.env.WIKI_EVAL_TEACHER_PROFILE_VERSION_ID?.trim() || studentProfileVersionId
      const teacher = teacherProfileVersionId === studentProfileVersionId ? student : await admittedService('teacher-default', teacherProfileVersionId)
      report = await optimizeWikiSynthesis({ train, selection, studentAI: student.service, teacherAI: teacher.service,
        maximumMetricCalls: positiveInteger('WIKI_EVAL_MAX_METRIC_CALLS', 32), trials: positiveInteger('WIKI_EVAL_TRIALS', 3),
        ...(compareReasoning ? { selectReasoning: compareSelection } : {}),
        saveArtifact: async (optimizedProgram, fingerprint) => {
          await writeFile(artifactPath, `${JSON.stringify({ version: 2, corpusFingerprint, fingerprint, studentProfileVersionId, model: student.model, reasoningSelection, optimizedProgram })}\n`, { mode: 0o600, flag: 'wx' })
        }, loadFinal: () => loadSplit('final') })
    } else {
      const saved = artifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf8')))
      if (saved.studentProfileVersionId !== studentProfileVersionId || saved.model !== student.model || saved.corpusFingerprint !== corpusFingerprint || createHash('sha256').update(JSON.stringify(saved.optimizedProgram)).digest('hex') !== saved.fingerprint) throw new Error('Offline optimization artifact, provider binding or tuning corpus changed')
      const artifact = saved.optimizedProgram as unknown as AxSerializedOptimizedProgram
      if (mode === 'evaluate') {
        const final = await loadSplit('final')
        assertWikiSynthesisSplitIsolation(train, selection, final)
        const restored = saved.reasoningSelection === 'low' ? await admittedService('restored-student-low-default', studentProfileVersionId, true) : student
        report = { fingerprint: saved.fingerprint, reasoningSelection: saved.reasoningSelection, finalHoldout: await evaluateWikiSynthesisFixtures(final, restored.service, artifact) }
      } else {
        const comparison = await compareSelection(artifact)
        await writeFile(outputArtifactPath!, `${JSON.stringify({ ...saved, reasoningSelection })}\n`, { mode: 0o600, flag: 'wx' })
        const final = await loadSplit('final')
        assertWikiSynthesisSplitIsolation(train, selection, final)
        report = { fingerprint: saved.fingerprint, reasoningSelection: comparison.report, selectionFrozen: true,
          finalHoldout: await evaluateWikiSynthesisFixtures(final, comparison.ai, artifact) }
      }
    }
    process.stdout.write(`${JSON.stringify({ mode, report, accounting: admissions.map(({ label, admitted }) => ({ label, model: admitted.model, reasoningEffort: admitted.reasoningEffort ?? null, ...admitted.summary() })) })}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({ mode, status: 'failed', failure: 'OFFLINE_EVALUATION_FAILED', accounting: admissions.map(({ label, admitted }) => ({ label, ...admitted.summary() })) })}\n`)
    process.exitCode = 1
  } finally {
    await Promise.all(admissions.map(({ admitted }) => admitted.close()))
    await knex.destroy()
  }
}

if (import.meta.main) {
  try { await main() } catch {
    process.stdout.write(`${JSON.stringify({ status: 'failed', failure: 'OFFLINE_EVALUATION_CONFIGURATION_INVALID' })}\n`)
    process.exitCode = 1
  }
}
