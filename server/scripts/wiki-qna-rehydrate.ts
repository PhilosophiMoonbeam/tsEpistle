import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AGENT_EVENT_TYPES } from '../../shared/agents/contracts.ts'
import { rehydrateWikiQnaHistoricalEvidence, WikiQnaHistoricalReplayError, type WikiQnaHistoricalReplay } from './wiki-qna-comparison.ts'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const terminalStatuses: Record<string, true> = { succeeded: true, partial: true, failed: true, cancelled: true, recovery_required: true }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu

type Stage = 'options' | 'auth-file' | 'auth-config' | 'report-read' | 'report-parse' | 'run-get' | 'run-parse' | 'run-binding' | 'events-get' | 'events-parse' | 'evidence-replay' | 'output-write'
type Diagnostic = Readonly<{ httpStatus?: number; expectedSequence?: number; observedSequence?: number; expectedStatus?: string; observedStatus?: string }>
let stage: Stage = 'options'
let trialIndex: number | undefined
class ReplayFailure extends Error {
  readonly code: `REPLAY_${string}`
  readonly diagnostic: Diagnostic

  constructor(code: `REPLAY_${string}`, diagnostic: Diagnostic = {}) {
    super('Historical receipt replay failed')
    this.code = code
    this.diagnostic = diagnostic
  }
}
const fail = (code: `REPLAY_${string}`, diagnostic?: Diagnostic): never => { throw new ReplayFailure(code, diagnostic) }
const json = (text: string, code: `REPLAY_${string}`): unknown => {
  try { return JSON.parse(text) } catch { return fail(code) }
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    process.stdout.write(`${JSON.stringify({ cli: 'bun server/scripts/wiki-qna-rehydrate.ts --auth-file <protected-auth-file> --report <historical-unadjudicated-report> --output <new-private-file>',
      boundary: 'Read-only owned terminal run GETs and exact same-session receipt replay only. No page search, current source authorization, writes to the application, generation, or changes to original paid metrics/report. Output is exclusive/private and quality remains unadjudicated. Credentials are read only from a protected file and never printed.',
      diagnostics: 'Failure reports contain only a bounded stage, fixed code, zero-based trial index, HTTP status, known run statuses or event sequence counts. No inherited error text, credentials, URLs, user text, page bodies or HTTP response bodies are printed. Durable succeeded binds exactly to the historical run.completed event suffix.' })}\n`)
    return
  }
  const allowed = ['--auth-file', '--report', '--output']
  if (args.length !== 6 || args.some((arg, index) => index % 2 === 0 && !allowed.includes(arg)) || new Set(args.filter((_, index) => index % 2 === 0)).size !== 3) fail('REPLAY_OPTIONS_INVALID')
  const options = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [args[index * 2]!, args[index * 2 + 1]!]))
  const authPath = options['--auth-file']!
  stage = 'auth-file'
  const protectedFile = await lstat(authPath)
  if (!protectedFile.isFile() || (protectedFile.mode & 0o077) !== 0 || (process.getuid && protectedFile.uid !== process.getuid())) fail('REPLAY_PROTECTED_AUTH_FILE_REQUIRED')
  stage = 'auth-config'
  const auth = object(json(await readFile(authPath, 'utf8'), 'REPLAY_AUTH_JSON_INVALID'))
  if (typeof auth.baseUrl !== 'string' || typeof auth.cookie !== 'string' || !auth.cookie) return fail('REPLAY_AUTH_CONFIG_INVALID')
  let base: URL
  try { base = new URL(auth.baseUrl) } catch { return fail('REPLAY_APPLICATION_ORIGIN_INVALID') }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail('REPLAY_APPLICATION_ORIGIN_INVALID')
  let cookie = auth.cookie
  stage = 'report-read'
  const reportText = await readFile(options['--report']!, 'utf8')
  stage = 'report-parse'
  const report = object(json(reportText, 'REPLAY_REPORT_JSON_INVALID'))
  if (!Array.isArray(report.results)) return fail('REPLAY_HISTORICAL_REPORT_REQUIRED')
  // Ownership is established by authenticated run GETs, not a search result or a receipt from another scenario arm.
  const get = async (path: string, accept: 'application/json' | 'text/event-stream'): Promise<Response> => {
    const signal = AbortSignal.timeout(240_000)
    let response: Response
    try {
      response = await fetch(new URL(path, base), { method: 'GET', redirect: 'error',
        headers: { accept, cookie, origin: base.origin, referer: `${base.origin}/`, 'sec-fetch-site': 'same-origin' }, signal })
    } catch { return fail(signal.aborted ? 'REPLAY_GET_TIMEOUT' : 'REPLAY_GET_TRANSPORT_FAILED') }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return fail('REPLAY_OWNED_GET_REJECTED', { httpStatus: response.status })
    }
    // Reuse normal authenticated response cookie renewal in memory only; never print or rewrite the protected file.
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]!
      const separator = pair.indexOf('=')
      if (separator < 1) continue
      const name = pair.slice(0, separator)
      cookie = [...cookie.split(';').map(value => value.trim()).filter(value => value.slice(0, value.indexOf('=')) !== name), pair].join('; ')
    }
    if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== accept) {
      await response.body?.cancel().catch(() => {})
      return fail('REPLAY_GET_CONTENT_TYPE_INVALID', { httpStatus: response.status })
    }
    return response
  }
  const replays: WikiQnaHistoricalReplay[] = []
  for (const [index, value] of report.results.entries()) {
    trialIndex = index
    const trial = object(value)
    if (typeof trial.runId !== 'string' || !uuid.test(trial.runId)) return fail('REPLAY_HISTORICAL_RUN_ID_INVALID')
    stage = 'run-get'
    const runResponse = await get(`/_api/agents/runs/${trial.runId}`, 'application/json')
    stage = 'run-parse'
    const run = object(object(json(await runResponse.text(), 'REPLAY_RUN_JSON_INVALID')).run)
    stage = 'run-binding'
    if (run.id !== trial.runId || typeof run.sessionId !== 'string' || !uuid.test(run.sessionId)) return fail('REPLAY_OWNED_RUN_BINDING_INVALID')
    if (typeof run.status !== 'string' || terminalStatuses[run.status] !== true) return fail('REPLAY_OWNED_RUN_NOT_TERMINAL')
    // The durable database status and the SSE event name are deliberately different only for successful completion.
    const expectedStatus = trial.status === 'completed' ? 'succeeded' : trial.status
    if (run.status !== expectedStatus) return fail('REPLAY_RUN_STATUS_MISMATCH', {
      expectedStatus: typeof expectedStatus === 'string' && terminalStatuses[expectedStatus] === true ? expectedStatus : 'invalid', observedStatus: run.status })
    if (!Number.isSafeInteger(run.eventSequence) || Number(run.eventSequence) < 1 || !Number.isSafeInteger(run.attempt) || Number(run.attempt) < 0)
      return fail('REPLAY_RUN_EVENT_METADATA_INVALID')
    stage = 'events-get'
    const eventResponse = await get(`/_api/agents/runs/${trial.runId}/events?after=0`, 'text/event-stream')
    stage = 'events-parse'
    const raw = await eventResponse.text()
    const events: WikiQnaHistoricalReplay['events'][number][] = []
    let sequence = 0
    for (const block of raw.split(/\r?\n\r?\n/u)) {
      const lines = block.split(/\r?\n/u).filter(line => line && !line.startsWith(':'))
      if (!lines.length) continue
      const types = lines.filter(line => line.startsWith('event:'))
      const ids = lines.filter(line => line.startsWith('id:'))
      const fieldValue = (line: string): string => line.slice(line.indexOf(':') + 1).replace(/^ /u, '')
      if (types.length !== 1 || ids.length !== 1) return fail('REPLAY_EVENT_FIELDS_INVALID')
      const type = fieldValue(types[0]!)
      if (!(AGENT_EVENT_TYPES as readonly string[]).includes(type)) return fail('REPLAY_EVENT_TYPE_INVALID')
      const idText = fieldValue(ids[0]!)
      const id = /^\d+$/u.test(idText) ? Number(idText) : NaN
      const data = lines.filter(line => line.startsWith('data:')).map(fieldValue).join('\n')
      if (!Number.isSafeInteger(id) || id !== sequence + 1 || !data) return fail('REPLAY_EVENT_SEQUENCE_INCOMPLETE', {
        expectedSequence: sequence + 1, ...(Number.isSafeInteger(id) && id >= 0 ? { observedSequence: id } : {}) })
      sequence = id
      const envelope = object(json(data, 'REPLAY_EVENT_JSON_INVALID'))
      if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.attempt) || Number(envelope.attempt) < 0 || Number(envelope.attempt) > Number(run.attempt) ||
        typeof envelope.createdAt !== 'string' || !Number.isFinite(Date.parse(envelope.createdAt)) ||
        envelope.data === null || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return fail('REPLAY_EVENT_ENVELOPE_INVALID')
      events.push({ type, data: object(envelope.data) })
    }
    if (sequence !== run.eventSequence) return fail('REPLAY_EVENT_STREAM_INCOMPLETE', { expectedSequence: Number(run.eventSequence), observedSequence: sequence })
    replays.push({ runId: trial.runId, sessionId: run.sessionId, status: run.status, events })
  }
  stage = 'evidence-replay'
  trialIndex = undefined
  const corrected = rehydrateWikiQnaHistoricalEvidence(report, replays, sha256(reportText))
  stage = 'output-write'
  const output = options['--output']!
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 })
  await writeFile(output, `${JSON.stringify(corrected, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await chmod(output, 0o600)
  process.stdout.write(`${JSON.stringify({ mode: 'historical-evidence-replay', trials: replays.length, paidCalls: 0, applicationMethods: ['GET'], originalReportPreserved: true, paidMetricsUnchanged: true, quality: 'unadjudicated' })}\n`)
}

if (import.meta.main) {
  try { await main() } catch (error) {
    // Only locally assigned codes and bounded metadata are emitted; never inherited exception text or response bodies.
    const localFileCodes: Record<string, true> = { ENOENT: true, EACCES: true, EPERM: true, EEXIST: true, ENOTDIR: true, EISDIR: true, ENOSPC: true }
    const fileCode = object(error).code
    const code = error instanceof ReplayFailure || error instanceof WikiQnaHistoricalReplayError ? error.code :
      typeof fileCode === 'string' && localFileCodes[fileCode] === true ? `REPLAY_FILE_${fileCode}` : 'REPLAY_UNEXPECTED_STAGE_FAILURE'
    process.stdout.write(`${JSON.stringify({ status: 'failed', failure: 'WIKI_QNA_HISTORICAL_REPLAY_FAILED', stage, code,
      trialIndex: error instanceof WikiQnaHistoricalReplayError ? error.trialIndex : trialIndex,
      ...(error instanceof ReplayFailure ? error.diagnostic : {}),
      boundary: 'Original report is unchanged; no application mutations or generation requested. No historical read confers current authority; independent quality remains unadjudicated.' })}\n`)
    process.exitCode = 1
  }
}
