import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { BrowserObservation } from '../../../shared/agents/contracts.ts'
import type { ActionKernel, ActionAuthority, ActionHandlerContext } from '../actions/kernel.ts'
import { AgentRepositoryError } from '../repository.ts'
import type { BrowserWorkerClient } from './client.ts'
import type { BrowserWorkerAction, BrowserWorkerLimits, BrowserWorkerResult } from './runtime.ts'
import { parseCanonicalBrowserTarget } from './target.ts'

interface RunRow { id: string; sessionId: string; ownerId: number; status: string; leaseToken: string | null; leaseExpiresAt: Date | string | null; cancelRequestedAt: Date | string | null }
interface BrowserState { readonly contextId: string; sequence: number }
const limits: BrowserWorkerLimits = { contextTtlMilliseconds: 10 * 60_000, maximumActions: 100, maximumNavigations: 20, maximumResponseBytes: 25 * 1024 * 1024 }

interface BrowserExecutor { execute(identity: Parameters<BrowserWorkerClient['execute']>[0], limits: BrowserWorkerLimits, action: BrowserWorkerAction, signal: AbortSignal): Promise<BrowserWorkerResult> }

export class BrowserActionService {
  readonly #knex: Knex
  readonly #client: BrowserExecutor
  readonly #states = new Map<string, BrowserState>()
  constructor(knex: Knex, client: BrowserExecutor) { this.#knex = knex; this.#client = client }

  async #run(authority: ActionAuthority): Promise<RunRow> {
    const ownerId = authority.requester.kind === 'user' ? authority.requester.userId : 0
    const row = await this.#knex<RunRow>('agentRuns').where({ id: authority.requestId, ownerId }).first('id', 'sessionId', 'ownerId', 'status', 'leaseToken', 'leaseExpiresAt', 'cancelRequestedAt')
    if (!row || row.status !== 'running' || row.cancelRequestedAt !== null || !row.leaseToken || !row.leaseExpiresAt || new Date(row.leaseExpiresAt).getTime() <= Date.now()) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Agent run cannot use the browser without an active lease', 409)
    return row
  }

  async #targets(): Promise<readonly string[]> {
    const rows = await this.#knex('agentBrowserTargets').where({ enabled: true }).orderBy('canonicalUrl', 'asc').select('canonicalUrl') as { canonicalUrl: string }[]
    return rows.map(row => parseCanonicalBrowserTarget(row.canonicalUrl)).filter(target => target.scheme === 'https:').map(target => target.canonicalUrl)
  }

  async #execute(authority: ActionAuthority, signal: AbortSignal, action: (targets: readonly string[]) => BrowserWorkerAction): Promise<unknown> {
    const run = await this.#run(authority)
    let state = this.#states.get(run.id)
    if (!state) { state = { contextId: randomUUID(), sequence: 0 }; this.#states.set(run.id, state) }
    const targets = await this.#targets()
    const nextSequence = state.sequence + 1
    const result = await this.#client.execute({ runId: run.id, ownerId: run.ownerId, leaseToken: run.leaseToken!, contextId: state.contextId, actionCallId: randomUUID(), sequence: nextSequence }, limits, action(targets), signal)
    state.sequence = nextSequence
    return result
  }

  async navigate(input: { url: string }, context: ActionHandlerContext): Promise<BrowserObservation> {
    const target = parseCanonicalBrowserTarget(input.url)
    if (target.scheme !== 'https:') throw new AgentRepositoryError('BROWSER_HTTPS_REQUIRED', 'Browser targets must use HTTPS', 400)
    const result = await this.#execute(context.authority, context.signal, targets => ({ kind: 'navigate', url: target.canonicalUrl, attestedUrls: targets }))
    if (typeof result !== 'object' || result === null || Reflect.get(result, 'kind') !== 'navigated') throw new AgentRepositoryError('BROWSER_RESULT_INVALID', 'Browser worker returned an unexpected result', 502)
    return Reflect.get(result, 'observation') as BrowserObservation
  }

  async observe(_input: unknown, context: ActionHandlerContext): Promise<BrowserObservation> {
    const result = await this.#execute(context.authority, context.signal, () => ({ kind: 'observe' }))
    if (typeof result !== 'object' || result === null || Reflect.get(result, 'kind') !== 'observed') throw new AgentRepositoryError('BROWSER_RESULT_INVALID', 'Browser worker returned an unexpected result', 502)
    return Reflect.get(result, 'observation') as BrowserObservation
  }

  async act(input: { action: 'scrollIntoView' | 'followLink'; ref: string; documentEpoch: string }, context: ActionHandlerContext): Promise<BrowserObservation> {
    const result = await this.#execute(context.authority, context.signal, targets => ({ kind: 'act', action: input.action, ref: input.ref, documentEpoch: input.documentEpoch, attestedUrls: targets }))
    if (typeof result !== 'object' || result === null || Reflect.get(result, 'kind') !== 'acted') throw new AgentRepositoryError('BROWSER_RESULT_INVALID', 'Browser worker returned an unexpected result', 502)
    return Reflect.get(result, 'observation') as BrowserObservation
  }

  async extract(input: { maxCharacters: number }, context: ActionHandlerContext): Promise<{ url: string; text: string; truncated: boolean }> {
    const result = await this.#execute(context.authority, context.signal, () => ({ kind: 'extract' }))
    if (typeof result !== 'object' || result === null || Reflect.get(result, 'kind') !== 'extracted') throw new AgentRepositoryError('BROWSER_RESULT_INVALID', 'Browser worker returned an unexpected result', 502)
    const text = String(Reflect.get(result, 'text'))
    return { url: String(Reflect.get(result, 'url')), text: text.slice(0, input.maxCharacters), truncated: text.length > input.maxCharacters }
  }

  async screenshot(_input: unknown, context: ActionHandlerContext): Promise<{ artifactId: string; mimeType: 'image/png'; width: number; height: number }> {
    const run = await this.#run(context.authority)
    const result = await this.#execute(context.authority, context.signal, () => ({ kind: 'screenshot' }))
    if (typeof result !== 'object' || result === null || Reflect.get(result, 'kind') !== 'screenshot') throw new AgentRepositoryError('BROWSER_RESULT_INVALID', 'Browser worker returned an unexpected result', 502)
    const bytes = Reflect.get(result, 'bytes') as Buffer
    const width = Number(Reflect.get(result, 'width')); const height = Number(Reflect.get(result, 'height')); const artifactId = randomUUID()
    await this.#knex('agentArtifacts').insert({ id: artifactId, sessionId: run.sessionId, runId: run.id, ownerId: run.ownerId, kind: 'browser-screenshot', mimeType: 'image/png', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), payload: bytes, width, height, expiresAt: new Date(Date.now() + 60 * 60_000), metadata: JSON.stringify({ source: 'isolated-browser-worker' }) })
    return { artifactId, mimeType: 'image/png', width, height }
  }

  register(kernel: ActionKernel): void {
    kernel.register('browser.navigate', (input, context) => this.navigate(input as { url: string }, context))
    kernel.register('browser.observe', (input, context) => this.observe(input, context))
    kernel.register('browser.act', (input, context) => this.act(input as { action: 'scrollIntoView' | 'followLink'; ref: string; documentEpoch: string }, context))
    kernel.register('browser.extract', (input, context) => this.extract(input as { maxCharacters: number }, context))
    kernel.register('browser.screenshot', (input, context) => this.screenshot(input, context))
  }
}
