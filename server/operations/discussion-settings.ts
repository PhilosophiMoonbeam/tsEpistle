import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { DEFAULT_PAGE_RATING_MODE, PageRatingModeSchema } from '../../shared/page-ratings.ts'
import { DISCUSSION_SECRET_MASK, discussionIssues, discussionSettings, type DiscussionPolicySnapshot, type DiscussionProperty, type DiscussionProvider, type DiscussionProviderSettings, type DiscussionWorkspace } from '../../shared/discussion-policy.ts'
import { managesSystem, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'
const { ApplicationError } = errors
export interface DiscussionDefinition extends Record<string, unknown> { key: string; props: Record<string, DiscussionProperty> }
export const DISCUSSION_SETTINGS_LOCK = 72401640
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const pageRatingsMode = (flags: Record<string, unknown>) => {
  const candidate = flags.pageRatingsMode
  if (candidate === undefined) return DEFAULT_PAGE_RATING_MODE
  const parsed = PageRatingModeSchema.safeParse(candidate)
  if (!parsed.success) throw new ApplicationError('The saved page ratings mode is invalid. Repair the site setting before saving.', { status: 409 })
  return parsed.data
}
const project = (rows: DiscussionProviderSettings[], definitions: DiscussionDefinition[], mask: boolean): DiscussionProvider[] => rows.map(row => {
  const definition = definitions.find(candidate => candidate.key === row.key)
  if (!definition) throw new ApplicationError(`Discussion provider ${row.key} is missing its installed definition. Restart or repair the deployment.`, { status: 409 })
  return { key: row.key, isEnabled: Boolean(row.isEnabled), title: String(definition.title ?? row.key), description: String(definition.description ?? ''), website: String(definition.website ?? ''), isAvailable: definition.isAvailable === true, external: definition.codeTemplate === true, props: definition.props,
    config: Object.fromEntries(Object.entries(row.config).filter(([key]) => !mask || Object.hasOwn(definition.props, key)).map(([key, value]) => [key, mask && definition.props[key]?.sensitive && value ? DISCUSSION_SECRET_MASK : value])) }
})
export const createDiscussionSettingsStore = (deps: { db: Knex; definitions(): DiscussionDefinition[]; fallbackFeatures(): Record<string, unknown>; activate(providersChanged: boolean): Promise<string[]> }) => {
  const features = async (db: Knex | Knex.Transaction) => record((await db('settings').where('key', 'features').first('value'))?.value ?? deps.fallbackFeatures())
  const read = async (db: Knex | Knex.Transaction = deps.db) => {
    const rows = await db<DiscussionProviderSettings>('commentProviders').select('key', 'isEnabled', 'config').orderBy('key')
    const flags = await features(db), revision = await db('settings').where('key', 'discussionPolicyRevision').first('value'), definitions = deps.definitions()
    const enabled = flags.featurePageComments === true, pageRatingsEnabled = flags.featurePageRatings === true, mode = pageRatingsMode(flags)
    return { rows, flags, definitions, snapshot: { enabled, pageRatingsEnabled, pageRatingsMode: mode, providers: project(rows, definitions, true), fingerprint: fingerprint({ rows, definitions, enabled, pageRatingsEnabled, pageRatingsMode: mode, revision: revision?.value ?? null }) } satisfies DiscussionPolicySnapshot }
  }
  const saveFlags = async (tx: Knex.Transaction, value: Record<string, unknown>) => {
    const updatedAt = new Date().toISOString(), json = JSON.stringify(value)
    await tx('settings').insert({ key: 'features', value: json, updatedAt }).onConflict('key').merge({ value: json, updatedAt })
  }
  const revise = async (tx: Knex.Transaction) => {
    const value = JSON.stringify({ revision: randomUUID() }), updatedAt = new Date().toISOString()
    await tx('settings').insert({ key: 'discussionPolicyRevision', value, updatedAt }).onConflict('key').merge({ value, updatedAt })
  }
  const activate = async (providersChanged: boolean) => { try { return await deps.activate(providersChanged) } catch { return ['Saved. Runtime activation did not finish; reload the workspace and check server logs.'] } }
  return {
    async read(): Promise<DiscussionPolicySnapshot> { return (await read()).snapshot },
    async write(input: unknown, expected?: unknown) {
      const payload = record(input), providers = payload.providers, requestedRatingsMode = payload.pageRatingsMode === undefined ? undefined : PageRatingModeSchema.safeParse(payload.pageRatingsMode)
      if (requestedRatingsMode && !requestedRatingsMode.success) throw new ApplicationError('Choose a valid page ratings mode: thumbs or stars.', { status: 400 })
      if (payload.pageRatingsEnabled !== undefined && typeof payload.pageRatingsEnabled !== 'boolean') throw new ApplicationError('Choose whether page ratings are enabled.', { status: 400 })
      if (!Array.isArray(providers) || !providers.length || providers.length > 100 || providers.some(row => !row || typeof row !== 'object' || typeof row.key !== 'string' || typeof row.isEnabled !== 'boolean' || !row.config || typeof row.config !== 'object' || Array.isArray(row.config)) || new Set(providers.map(row => row.key)).size !== providers.length || (payload.enabled !== undefined && typeof payload.enabled !== 'boolean')) throw new ApplicationError('Choose valid, unique discussion providers and configuration.', { status: 400 })
      if (expected !== undefined && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) throw new ApplicationError('Reload the saved discussion policy before saving.', { status: 400 })
      const snapshot = await deps.db.transaction(async tx => {
        await tx.raw('SELECT pg_advisory_xact_lock(?)', [DISCUSSION_SETTINGS_LOCK])
        await tx('commentProviders').orderBy('key').forUpdate().select('key')
        await tx('settings').where('key', 'features').forUpdate().first()
        const current = await read(tx)
        if (expected !== undefined && expected !== current.snapshot.fingerprint) throw new ApplicationError('Discussion settings changed after you loaded them. Reload the saved policy and review your draft.', { status: 409 })
        const next = project(current.rows, current.definitions, false)
        for (const update of providers as DiscussionProviderSettings[]) {
          const provider = next.find(row => row.key === update.key)
          if (!provider) throw new ApplicationError(`Unknown discussion provider: ${update.key}`, { status: 400 })
          if (Object.keys(update.config).some(key => !Object.hasOwn(provider.props, key))) throw new ApplicationError(`Unknown configuration option for ${provider.title}.`, { status: 400 })
          provider.isEnabled = update.isEnabled
          for (const [key, value] of Object.entries(update.config)) {
            if (provider.props[key]?.sensitive && value === DISCUSSION_SECRET_MASK) continue
            provider.config[key] = value
          }
        }
        // Validate exposed options; retained undeclared database settings are preserved but not newly accepted from callers.
        const exposed = discussionSettings(next)
        const issue = discussionIssues(next.map((provider, index) => ({ ...provider, config: exposed[index]!.config })))[0]
        if (issue) throw new ApplicationError(issue.message, { status: 400 })
        for (const update of providers as DiscussionProviderSettings[]) {
          const provider = next.find(row => row.key === update.key)!
          await tx('commentProviders').where('key', provider.key).update({ isEnabled: provider.isEnabled, config: JSON.stringify(provider.config) })
        }
        const nextFlags = { ...current.flags }
        if (payload.enabled !== undefined) nextFlags.featurePageComments = payload.enabled
        if (payload.pageRatingsEnabled !== undefined) nextFlags.featurePageRatings = payload.pageRatingsEnabled
        if (requestedRatingsMode) nextFlags.pageRatingsMode = requestedRatingsMode.data
        if (payload.enabled !== undefined || payload.pageRatingsEnabled !== undefined || requestedRatingsMode) await saveFlags(tx, nextFlags)
        await revise(tx)
        return (await read(tx)).snapshot
      })
      return { ...snapshot, warnings: await activate(true) }
    },
    async patchFeatures(input: Record<string, unknown>) {
      const keys = Object.keys(input)
      if (keys.some(key => !['featurePageRatings', 'featurePageComments', 'featurePersonalWikis'].includes(key) || typeof input[key] !== 'boolean')) throw new ApplicationError('Feature availability must use boolean values.', { status: 400 })
      if (!keys.length) return
      await deps.db.transaction(async tx => {
        await tx.raw('SELECT pg_advisory_xact_lock(?)', [DISCUSSION_SETTINGS_LOCK])
        await tx('settings').where('key', 'features').forUpdate().first()
        await saveFlags(tx, { ...await features(tx), ...input })
        if (Object.hasOwn(input, 'featurePageComments') || Object.hasOwn(input, 'featurePageRatings')) await revise(tx)
      })
      return activate(false)
    }
  }
}
interface Runtime {
  config: { features: Record<string, unknown> }
  data: { commentProviders: DiscussionDefinition[]; commentProvider?: { key?: string; getAntiSpamStatus?: () => DiscussionWorkspace['runtime']['antiSpam'] } }
  models: { knex: Knex; commentProviders: { initProvider(): Promise<void> } }
  events: { outbound: { emit(event: string): void } }
  logger: { warn(error: unknown): void }
}
const runtime = (): Runtime => WIKI as unknown as Runtime
const store = () => createDiscussionSettingsStore({ db: runtime().models.knex, definitions: () => runtime().data.commentProviders, fallbackFeatures: () => runtime().config.features,
  async activate(providersChanged) {
    const wiki = runtime(), warnings: string[] = []
    const flags = (await wiki.models.knex('settings').where('key', 'features').first('value'))?.value
    if (flags && typeof flags === 'object') wiki.config.features = flags
    try { wiki.events.outbound.emit('reloadConfig') } catch (error) { wiki.logger.warn(error); warnings.push('Saved. Other processes could not be notified; check server logs.') }
    if (providersChanged) { try { await wiki.models.commentProviders.initProvider() } catch (error) { wiki.logger.warn(error); warnings.push('Saved. The selected provider could not be activated. Check its settings and server logs.') } }
    return warnings
  }
})
const requireAdmin = (requester: PagePrincipal) => { if (!managesSystem(requester)) throw new ApplicationError('manage:system is required.', { status: 403 }) }
export const readDiscussionWorkspace = async (requester: PagePrincipal): Promise<DiscussionWorkspace> => {
  requireAdmin(requester)
  const [snapshot, commentCounts, closedCounts] = await Promise.all([
    store().read(), runtime().models.knex('comments').select(runtime().models.knex.raw('COUNT(*)::int AS comments, COUNT(*) FILTER (WHERE "isHidden")::int AS hidden, COUNT(DISTINCT "pageId")::int AS pages')).first(), runtime().models.knex('pageDiscussionPolicy').where('closed', true).count('* as count').first()
  ])
  const active = runtime().data.commentProvider
  return { ...snapshot, counts: { comments: Number(commentCounts?.comments ?? 0), hidden: Number(commentCounts?.hidden ?? 0), visible: Number(commentCounts?.comments ?? 0) - Number(commentCounts?.hidden ?? 0), pages: Number(commentCounts?.pages ?? 0), closedPages: Number(closedCounts?.count ?? 0) }, runtime: { provider: active?.key ?? null, antiSpam: active?.key === 'default' && active.getAntiSpamStatus ? active.getAntiSpamStatus() : { state: 'unavailable', checkedAt: null } } }
}
export const writeDiscussionWorkspace = async (requester: PagePrincipal, input: unknown, expected: unknown) => {
  requireAdmin(requester)
  const payload = record(input)
  if (expected === undefined || typeof payload.enabled !== 'boolean' || typeof payload.pageRatingsEnabled !== 'boolean' || !PageRatingModeSchema.safeParse(payload.pageRatingsMode).success) throw new ApplicationError('Load the saved policy and choose discussion availability, page-ratings availability and a valid page ratings mode before saving.', { status: 400 })
  return store().write(input, expected)
}
export const writeLegacyDiscussionProviders = (providers: DiscussionProviderSettings[]) => store().write({ providers })
export const patchSiteFeatures = (features: Record<string, unknown>) => store().patchFeatures(features)
