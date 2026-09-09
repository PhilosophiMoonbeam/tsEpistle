import type { Knex } from 'knex'
import type PageHistory from '../models/pageHistory.ts'
import type { TaxonomyChange, TaxonomyInspection, TaxonomyPage, TaxonomyResult } from '../../shared/taxonomy.ts'
import { tagAliasMap } from '../helpers/tag-aliases.ts'
import { planTaxonomy, tagDefinition, taxonomyInventory, taxonomyRules, type TagRow, type TagGroup, type TaxonomySnapshot } from '../helpers/taxonomy-plan.ts'
import { managesSystem, principalId, type PagePrincipal } from '../helpers/page-access.ts'
import { assertPageUnlocked } from './page-protection.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import { enqueuePageMutationEffects } from '../core/page-mutation-outbox.ts'
import { mutateOkfMetadata } from '../okf/format.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
export interface TaxonomyActor { requester: PagePrincipal; sessionId: string }
type VersionInput = Parameters<typeof PageHistory.addVersion>[0]
export interface TaxonomyStoredPage extends Omit<VersionInput, 'transaction' | 'versionDate'> { updatedAt: string; extra: Record<string, unknown>; sourceRevision: string }
interface TaxonomyDependencies {
  db: Knex
  authorize(actor: TaxonomyActor): number
  assertUnlocked(actor: TaxonomyActor, pageId: number): Promise<void>
  snapshotPage(input: VersionInput): Promise<unknown>
  refresh(pages: { id: number; hash: string }[]): Promise<string[]>
}
const conflict = (): never => { throw new ApplicationError('The taxonomy, page assignments or access rules changed after this review. Review the change again.', { status: 409, code: 'TAXONOMY_REVIEW_EXPIRED' }) }
const positiveId = (id: number): number => {
  if (!Number.isSafeInteger(id) || id < 1) throw new ApplicationError('Select a valid tag.', { status: 400 })
  return id
}
export const readTaxonomySnapshot = async (db: Knex | Knex.Transaction): Promise<TaxonomySnapshot> => {
  const [rawTags, assignments, pages, groups, history] = await Promise.all([
    db<TagRow>('tags').select('id', 'tag', 'title', 'createdAt', 'updatedAt', 'redirectToId', 'isArchived').orderBy('id'),
    db('pageTags').select('pageId', 'tagId').orderBy('pageId').orderBy('tagId'),
    db('pages').select('id', 'title', 'path', 'localeCode as locale', 'visibility', 'sourceRevision').whereExists(db('pageTags').select('pageId').whereRaw('?? = ??', ['pageTags.pageId', 'pages.id'])).orderBy('id'),
    db<TagGroup>('groups').select('id', 'name', 'permissions', 'pageRules').orderBy('id'),
    db('pageHistoryTags').select('tagId').count('* as count').groupBy('tagId').orderBy('tagId')
  ])
  return {
    tags: rawTags.map(t => ({ ...t, title: t.title ?? '', createdAt: new Date(t.createdAt).toISOString(), updatedAt: new Date(t.updatedAt).toISOString(), redirectToId: t.redirectToId ?? null, isArchived: Boolean(t.isArchived) })),
    assignments, pages: pages.map(p => ({ ...p, sourceRevision: String(p.sourceRevision) })) as TaxonomyPage[], groups,
    history: history.map(h => ({ tagId: Number(h.tagId), count: Number(h.count) }))
  }
}

/** Every mutation is reviewed against the current data and committed with page history and durable projection work. */
export const createTaxonomyService = (deps: TaxonomyDependencies) => ({
  async list(actor: TaxonomyActor) {
    deps.authorize(actor)
    return taxonomyInventory(await readTaxonomySnapshot(deps.db))
  },
  async inspect(actor: TaxonomyActor, id: number): Promise<TaxonomyInspection> {
    deps.authorize(actor)
    positiveId(id)
    const snapshot = await readTaxonomySnapshot(deps.db)
    const inventory = taxonomyInventory(snapshot)
    const tag = inventory.find(t => t.id === id)
    if (!tag) throw new ApplicationError('This tag no longer exists.', { status: 404 })
    const map = tagAliasMap(snapshot.tags)
    const name = map[tag.tag]
    const aliases = inventory.filter(t => t.id !== id && t.redirectToId !== null && (t.redirectToId === id || (name && map[t.tag] === name)))
    const names = new Set([tag.tag, ...aliases.map(t => t.tag)])
    const canonical = snapshot.tags.find(t => t.tag === name)
    const pageIds = new Set(snapshot.assignments.filter(a => a.tagId === canonical?.id).map(a => a.pageId))
    return { tag, aliases, pages: snapshot.pages.filter(p => pageIds.has(p.id)), rules: taxonomyRules(snapshot, snapshot, names) }
  },
  async create(actor: TaxonomyActor, input: unknown) {
    deps.authorize(actor)
    const definition = tagDefinition(input)
    try {
      const now = new Date().toISOString()
      const [tag] = await deps.db<TagRow>('tags').insert({ ...definition, createdAt: now, updatedAt: now, isArchived: false, redirectToId: null }).returning('id')
      return { id: tag!.id }
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === '23505') throw new ApplicationError('This name is already reserved by a tag, alias or archived tag.', { status: 409 })
      throw error
    }
  },
  async preview(actor: TaxonomyActor, input: unknown) {
    deps.authorize(actor)
    return planTaxonomy(await readTaxonomySnapshot(deps.db), input).preview
  },
  async apply(actor: TaxonomyActor, input: { change: unknown; fingerprint: unknown; acknowledgeAccess?: unknown }): Promise<TaxonomyResult> {
    const authorId = deps.authorize(actor)
    if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new ApplicationError('A current impact review is required.', { status: 400 })
    let committed: { tagId: number; pageCount: number; pages: { id: number; hash: string }[] }
    try {
      committed = await deps.db.transaction(async tx => {
        const initial = planTaxonomy(await readTaxonomySnapshot(tx), input.change)
        if (initial.preview.fingerprint !== input.fingerprint) return conflict()
        // Follow the same page → tag lock order as page editing. Shared tag locks in
        // associateTags prevent an assignment from slipping in after this review.
        if (initial.changedPageIds.length) await tx('pages').whereIn('id', initial.changedPageIds).orderBy('id').select('id').forUpdate()
        await tx('tags').orderBy('id').select('id').forUpdate()
        await tx('groups').orderBy('id').select('id').forShare()
        const before = await readTaxonomySnapshot(tx)
        const plan = planTaxonomy(before, input.change)
        if (plan.preview.fingerprint !== input.fingerprint) return conflict()
        if (plan.preview.accessChanges && input.acknowledgeAccess !== true) throw new ApplicationError('Acknowledge the changes to tag-based access rule matches before continuing.', { status: 400 })
        for (const id of plan.changedPageIds) await deps.assertUnlocked(actor, id)
        const now = new Date().toISOString()
        let tagId = plan.preview.source.id
        if (plan.preview.destination?.id === -1) {
          const destination = plan.preview.destination
          const [created] = await tx<TagRow>('tags').insert({ tag: destination.tag, title: destination.title, createdAt: now, updatedAt: now, isArchived: false, redirectToId: null }).returning('id')
          tagId = created!.id
          plan.after.tags.find(t => t.id === -1)!.id = tagId
          for (const t of plan.after.tags) if (t.redirectToId === -1) t.redirectToId = tagId
          for (const a of plan.after.assignments) if (a.tagId === -1) a.tagId = tagId
        } else if (plan.preview.destination) tagId = plan.preview.destination.id
        const pages: { id: number; hash: string }[] = []
        for (const id of plan.changedPageIds) {
          const page = await tx<TaxonomyStoredPage>('pages').where({ id }).first()
          if (!page) return conflict()
          const okf = mutateOkfMetadata({ existing: page.extra?.okf, producer: `human:${authorId}`, knowledgeChanged: true, at: new Date(now) })
          await deps.snapshotPage({ ...page, action: 'updated', versionDate: new Date(page.updatedAt).toISOString(), transaction: tx })
          await tx('pageTags').where({ pageId: id }).delete()
          const assignments = plan.after.assignments.filter(a => a.pageId === id)
          if (assignments.length) await tx('pageTags').insert(assignments)
          const extra = { ...(page.extra ?? {}) }
          if (okf) extra.okf = okf
          // Explicit revision also covers tag-only edits when the author/metadata
          // would otherwise leave the core-field database trigger unchanged.
          const sourceRevision = (BigInt(page.sourceRevision) + 1n).toString()
          await tx('pages').where({ id }).update({ authorId, updatedAt: now, extra: JSON.stringify(extra), sourceRevision })
          await enqueuePageMutationEffects(tx, { pageId: id, sourceRevision, desiredState: 'present', action: 'update', source: page.content,
            location: { locale: page.localeCode, path: page.path, visibility: page.visibility, ownerId: page.ownerId } })
          await writeOutboxEvent(tx, { type: 'page.updated', version: 1, aggregateType: 'page', aggregateId: id,
            payload: { pageId: id, actorId: authorId, actorName: actor.requester?.name, title: page.title, path: page.path,
              localeCode: page.localeCode, ownerId: page.ownerId, visibility: page.visibility,
              tags: assignments.map(a => { const tag = plan.after.tags.find(t => t.id === a.tagId)!; return { id: tag.id, tag: tag.tag } }) } })
          pages.push({ id, hash: page.hash })
        }
        for (const tag of plan.after.tags) {
          const previous = before.tags.find(t => t.id === tag.id)
          if (!previous || (previous.redirectToId === tag.redirectToId && previous.isArchived === tag.isArchived && previous.title === tag.title)) continue
          await tx('tags').where({ id: tag.id }).update({ redirectToId: tag.redirectToId, isArchived: tag.isArchived, title: tag.title, updatedAt: now })
        }
        // Display-label changes also invalidate embedded tag labels, without
        // inventing a content revision or modifying knowledge metadata.
        if (!plan.changedPageIds.length && plan.preview.change.action === 'edit') {
          const ids = before.assignments.filter(a => a.tagId === tagId).map(a => a.pageId)
          if (ids.length) pages.push(...await tx('pages').select('id', 'hash').whereIn('id', ids))
        }
        return { tagId, pageCount: plan.changedPageIds.length, pages }
      })
    } catch (error) {
      if (error && typeof error === 'object' && ['23505', '40001', '40P01'].includes(String(Reflect.get(error, 'code')))) return conflict()
      throw error
    }
    let refreshWarnings: string[]
    try { refreshWarnings = await deps.refresh(committed.pages) } catch { refreshWarnings = ['Saved. Cache refresh could not finish; reload the workspace or check server logs.'] }
    return { tagId: committed.tagId, pageCount: committed.pageCount, refreshWarnings }
  },
  async legacyChange(actor: TaxonomyActor, change: TaxonomyChange) {
    const preview = await this.preview(actor, change)
    if (preview.accessChanges) throw new ApplicationError('This change affects tag-based access rules. Review and acknowledge it in Administration → Tags.', { status: 409 })
    return this.apply(actor, { change, fingerprint: preview.fingerprint })
  }
})

interface TaxonomyRuntime {
  models: { knex: Knex; pageHistory: typeof PageHistory; pages: { deletePageFromCache(hash: string): Promise<unknown> } }
  events: { outbound: { emit(event: string, value?: unknown): void } }
  collaboration?: { pageChanged(pageId: number): Promise<void> }
  logger: { warn(error: unknown): void }
}
const runtime = (): TaxonomyRuntime => WIKI as unknown as TaxonomyRuntime
const service = () => createTaxonomyService({
  db: runtime().models.knex,
  authorize(actor) {
    if (!managesSystem(actor.requester)) throw new ApplicationError('manage:system is required.', { status: 403 })
    const id = principalId(actor.requester)
    if (id === null) throw new ApplicationError('An authenticated administrator is required.', { status: 401 })
    return id
  },
  assertUnlocked: (actor, pageId) => assertPageUnlocked({ ...actor, pageId }),
  snapshotPage: input => runtime().models.pageHistory.addVersion(input),
  async refresh(pages) {
    const wiki = runtime()
    const warnings: string[] = []
    // Keep notification as a best-effort presentation refresh; it is not an authorization dependency.
    try { wiki.events.outbound.emit('reloadGroups') } catch (error) { wiki.logger.warn(error); warnings.push('Saved. Other server processes could not be notified; check server logs.') }
    for (const page of pages) {
      const results = await Promise.allSettled([
        wiki.models.pages.deletePageFromCache(page.hash),
        Promise.resolve().then(() => wiki.events.outbound.emit('deletePageFromCache', page.hash)),
        Promise.resolve().then(() => wiki.collaboration?.pageChanged(page.id))
      ])
      for (const result of results) if (result.status === 'rejected') { wiki.logger.warn(result.reason); if (!warnings.includes('Saved. Some page caches could not refresh; reload affected pages or check server logs.')) warnings.push('Saved. Some page caches could not refresh; reload affected pages or check server logs.') }
    }
    return warnings
  }
})
export default service
