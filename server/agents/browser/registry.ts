import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { AgentRepositoryError } from '../repository.ts'
import { parseCanonicalBrowserTarget } from './target.ts'

interface BrowserTargetRow { id: string; canonicalUrl: string; enabled: boolean | number; policySha256: string; createdBy: number | null; updatedBy: number | null; createdAt: Date | string; updatedAt: Date | string }
export interface BrowserTargetView { readonly id: string; readonly canonicalUrl: string; readonly enabled: boolean; readonly policySha256: string; readonly createdBy: number | null; readonly updatedBy: number | null; readonly createdAt: string; readonly updatedAt: string }
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const view = (row: BrowserTargetRow): BrowserTargetView => ({ ...row, enabled: Boolean(row.enabled), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })
const policyHash = (canonicalUrl: string): string => createHash('sha256').update(canonicalJson({ version: 1, canonicalUrl, anonymousGetOnly: true })).digest('hex')

export class BrowserTargetRegistry {
  readonly #knex: Knex
  constructor(knex: Knex) { this.#knex = knex }
  async list(): Promise<readonly BrowserTargetView[]> { return (await this.#knex<BrowserTargetRow>('agentBrowserTargets').orderBy('canonicalUrl', 'asc')).map(view) }
  async create(input: { canonicalUrl: string; enabled: boolean; actorId: number }): Promise<BrowserTargetView> {
    let target: ReturnType<typeof parseCanonicalBrowserTarget>
    try { target = parseCanonicalBrowserTarget(input.canonicalUrl) } catch { throw new AgentRepositoryError('INVALID_BROWSER_TARGET', 'Browser target must be an exact canonical HTTPS URL', 400) }
    if (target.scheme !== 'https:') throw new AgentRepositoryError('BROWSER_HTTPS_REQUIRED', 'Browser targets must use HTTPS', 400)
    const id = randomUUID()
    const now = new Date()
    try {
      await this.#knex('agentBrowserTargets').insert({ id, canonicalUrl: target.canonicalUrl, enabled: input.enabled, policySha256: policyHash(target.canonicalUrl), createdBy: input.actorId, updatedBy: input.actorId, createdAt: now, updatedAt: now })
    } catch {
      throw new AgentRepositoryError('BROWSER_TARGET_EXISTS', 'Browser target already exists', 409)
    }
    return view((await this.#knex<BrowserTargetRow>('agentBrowserTargets').where({ id }).first())!)
  }
  async setEnabled(input: { id: string; enabled: boolean; actorId: number }): Promise<BrowserTargetView> {
    const changed = await this.#knex('agentBrowserTargets').where({ id: input.id }).update({ enabled: input.enabled, updatedBy: input.actorId, updatedAt: new Date() })
    if (changed !== 1) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Browser target was not found', 404)
    return view((await this.#knex<BrowserTargetRow>('agentBrowserTargets').where({ id: input.id }).first())!)
  }
}
