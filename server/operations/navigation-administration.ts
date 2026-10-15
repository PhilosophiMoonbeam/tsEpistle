import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Knex } from 'knex'
import {
  NavigationPolicySchema,
  navigationPolicyFromConfiguration,
  navigationChangedFields,
  type NavigationPolicy,
  type NavigationWorkspace,
  type NavigationEvent,
  type NavigationWriteResult
} from '../../shared/navigation-policy.ts'
import { z } from 'zod'
import {
  NavigationMoveReviewSchema,
  movedNavigationItems,
  applyNavigationMoveRepair,
  navigationRepairItemKey,
  type NavigationMoveReview
} from '../../shared/navigation-move-repair.ts'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import { pageAuthorizationContext } from '../helpers/page-access.ts'
import { evaluateGroupAccess, pageRuleAuthorityMatchesRequester, type PageRuleAuthority } from '../helpers/group-access.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const settingKeys = ['nav', 'navigationAdministration', 'lang']
interface NavigationRow {
  key: string
  config: unknown
}
interface LocaleRow {
  code: string
  name: string
  nativeName: string
}
interface Group {
  id: number
  name: string
  permissions: string[]
  adminRevision: string
}
interface Account {
  id: number
  isActive: boolean
  authVersion: number
}
interface Setting {
  key: string
  value: unknown
}
interface NavigationState {
  policy: NavigationPolicy
  configuration: Record<string, unknown>
  metadata: Record<string, unknown>
  fingerprint: string
  actorId: number | null
  groups: Group[]
  locales: LocaleRow[]
  guestGroups: number[]
}
interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  runtime(): { mode: unknown; expandParent: unknown; revision: unknown }
  runtimeReady?(): boolean
  onCommitted?(): Promise<boolean>
  loadPageAuthority?(requester: PagePrincipal, tx: Knex.Transaction): Promise<PageRuleAuthority>
}
export const createNavigationAdministrationStore = (deps: Dependencies) => {
  const state = async (tx: Knex.Transaction, requester: PagePrincipal, lock = false): Promise<NavigationState> => {
    const g = tx<Group>('groups').select('id', 'name', 'permissions', 'adminRevision').orderBy('id'),
      groups = await (lock ? g.forUpdate() : g)
    if (!requester) return fail('An administrator sign-in is required.', 403)
    const actorId = principalId(requester)
    let ids: number[]
    if (actorId !== null) {
      const query = tx<Account>('users').where('id', actorId).select('id', 'isActive', 'authVersion').first(),
        account = await (lock ? query.forUpdate() : query)
      if (!accountSessionIsCurrent({ id: actorId, authVersion: Reflect.get(requester, 'authVersion') }, account))
        return fail('Your account session changed. Sign in again.', 403)
      ids = (await tx<{ groupId: number }>('userGroups').where('userId', actorId).select('groupId')).map(row => row.groupId).sort((a, b) => a - b)
    } else {
      if (
        requester.ownershipUserId !== null ||
        requester.id !== 1 ||
        !Array.isArray(requester.groups) ||
        requester.groups.length !== 1 ||
        typeof requester.groups[0] !== 'number'
      )
        return fail('An administrator principal is required.', 403)
      ids = requester.groups as number[]
    }
    if (!groups.some(group => ids.includes(group.id) && group.permissions.some(permission => ['manage:system', 'manage:navigation'].includes(permission))))
      return fail('Navigation administration is required.', 403)
    const query = tx<Setting>('settings').whereIn('key', settingKeys).orderBy('key'),
      rows = await (lock ? query.forUpdate() : query)
    const configuration = {
      ...deps.fallback(),
      ...Object.fromEntries(rows.map(row => [row.key, row.value]))
    }
    const navQuery = tx<NavigationRow>('navigation').where('key', 'site').first(),
      navigation = await (lock ? navQuery.forUpdate() : navQuery)
    const localeQuery = tx<LocaleRow>('locales').select('code', 'name', 'nativeName').orderBy('code'),
      locales = await (lock ? localeQuery.forShare() : localeQuery)
    const guestGroups = (await tx<{ groupId: number }>('userGroups').where('userId', 2).select('groupId')).map(row => row.groupId).sort((a, b) => a - b)
    const policy = navigationPolicyFromConfiguration(configuration, navigation?.config),
      metadata = record(configuration.navigationAdministration)
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(stable([rows, navigation, policy, groups, locales, guestGroups, actorId, ids]))
      .digest('hex')
    return { policy, configuration, metadata, fingerprint, actorId, groups, locales, guestGroups }
  }
  const runtimeMatches = (saved: NavigationState) => {
    const runtime = deps.runtime()
    return (
      runtime.mode === saved.policy.mode &&
      runtime.expandParent === saved.policy.expandParent &&
      (runtime.revision ?? '') === (record(saved.configuration.nav).revision ?? '') &&
      deps.runtimeReady?.() !== false
    )
  }
  const inspect = async (requester: PagePrincipal): Promise<NavigationWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const saved = await state(tx, requester)
      await tx.commit()
      return {
        policy: saved.policy,
        fingerprint: saved.fingerprint,
        groups: saved.groups.map(group => ({ id: group.id, name: group.name })),
        guestGroups: saved.guestGroups,
        defaultLocale: String(record(saved.configuration.lang).code || 'en'),
        locales: saved.locales.map(locale => ({
          ...locale,
          enabled:
            locale.code === String(record(saved.configuration.lang).code || 'en') ||
            (record(saved.configuration.lang).namespacing === true &&
              Array.isArray(record(saved.configuration.lang).namespaces) &&
              (record(saved.configuration.lang).namespaces as string[]).includes(locale.code))
        })),
        history: Array.isArray(saved.metadata.history) ? (saved.metadata.history.slice(0, 50) as NavigationEvent[]) : [],
        runtime: { state: runtimeMatches(saved) ? 'applied' : 'needs-attention', observedAt: new Date().toISOString() }
      }
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  const activate = async (): Promise<NavigationWriteResult> => {
    try {
      return { activation: (await deps.onCommitted?.()) === true ? 'applied' : 'needs-attention' }
    } catch {
      return { activation: 'needs-attention' }
    }
  }
  // Both publication paths own exactly the same validation, history and activation contract.
  const publish = async (tx: Knex.Transaction, current: NavigationState, policy: NavigationPolicy, reasonInput: unknown) => {
    const validation = NavigationPolicySchema.safeParse(policy)
    if (!validation.success) return fail('Navigation configuration is invalid. Review destinations and audiences.')
    if (typeof reasonInput !== 'string' || reasonInput.trim().length < 3 || reasonInput.length > 1000)
      return fail('Provide an administrative reason of 3–1000 characters.')
    const knownLocales = new Set([...current.locales.map(locale => locale.code), ...current.policy.tree.map(tree => tree.locale)])
    for (const tree of validation.data.tree) {
      if (!knownLocales.has(tree.locale)) return fail(`Install locale ${tree.locale} before adding its navigation.`)
      for (const item of tree.items)
        if (item.visibilityGroups.some(id => !current.groups.some(group => group.id === id)))
          return fail(`An audience group for ${item.label || 'a divider'} no longer exists. Update this item's audience.`)
    }
    const fields = navigationChangedFields(current.policy, validation.data)
    if (!fields.length) return fail('There are no workspace changes to save.')
    const event: NavigationEvent = { id: randomUUID(), actorId: current.actorId, reason: reasonInput.trim(), fields, createdAt: new Date().toISOString() }
    const patch: Record<string, unknown> = {
      nav: { ...record(current.configuration.nav), mode: validation.data.mode, expandParent: validation.data.expandParent, revision: event.id }
    }
    patch.navigationAdministration = {
      ...current.metadata,
      revision: event.id,
      history: [event, ...(Array.isArray(current.metadata.history) ? current.metadata.history : [])].slice(0, 50)
    }
    await tx('navigation')
      .insert({ key: 'site', config: JSON.stringify(validation.data.tree) })
      .onConflict('key')
      .merge(['config'])
    for (const [key, value] of Object.entries(patch))
      await tx('settings')
        .insert({ key, value: JSON.stringify(value), updatedAt: event.createdAt })
        .onConflict('key')
        .merge(['value', 'updatedAt'])
  }
  const repairInput = z.strictObject({ pageId: z.number().int().positive().safe(), menuLocale: z.string().min(2).max(35) })
  const reviewMove = async (
    tx: Knex.Transaction,
    requester: PagePrincipal,
    input: z.infer<typeof repairInput>,
    lock: boolean,
    issuedAt = Date.now()
  ): Promise<NavigationMoveReview> => {
    // Page mutations lock pages before loading group authority. Keep that ordering.
    const pageQuery = tx('pages')
      .where('id', input.pageId)
      .select('id', 'path', 'localeCode', 'visibility', 'ownerId', 'sourceRevision', 'isPublished', 'publishStartDate', 'publishEndDate')
      .first()
    const page = await (lock ? pageQuery.forUpdate() : pageQuery)
    const current = await state(tx, requester, lock)
    const unavailable = () => fail('Choose a currently readable, published, unlocked public page with a recorded move.', lock ? 409 : 400)
    if (
      !page ||
      page.visibility !== 'public' ||
      page.ownerId !== null ||
      page.isPublished !== true ||
      !publicationWindowOpen(page, Date.now()) ||
      !/^[1-9][0-9]*$/.test(String(page.sourceRevision))
    )
      return unavailable()
    if (await tx('pageAccessPasswords').where('pageId', page.id).first('pageId')) return unavailable()
    if (!deps.loadPageAuthority) return fail('Page authority is unavailable.', 503)
    const authority = await deps.loadPageAuthority(requester, tx)
    const tags = await tx('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', page.id).select('tags.tag')
    const context = pageAuthorizationContext({ ...page, tags })
    if (
      !pageRuleAuthorityMatchesRequester(requester, authority) ||
      !context ||
      !evaluateGroupAccess(authority.permissions, ['read:pages'], authority.groups, context, authority.tagAliases, false).allowed ||
      !evaluateGroupAccess(authority.permissions, ['read:history'], authority.groups, context, authority.tagAliases, false).allowed
    )
      return unavailable()
    const historyQuery = tx('pageHistory')
      .where({ pageId: page.id, action: 'moved' })
      .orderBy('sourceRevision', 'desc')
      .orderBy('id', 'desc')
      .select('id', 'path', 'localeCode', 'visibility', 'ownerId', 'sourceRevision')
      .first()
    const history = await (lock ? historyQuery.forShare() : historyQuery)
    if (
      !history ||
      history.visibility !== 'public' ||
      history.ownerId !== null ||
      !/^[1-9][0-9]*$/.test(String(history.sourceRevision)) ||
      BigInt(history.sourceRevision) >= BigInt(page.sourceRevision) ||
      (history.path === page.path && history.localeCode === page.localeCode)
    )
      return unavailable()
    const historicalTags = await tx('pageHistoryTags')
      .join('tags', 'tags.id', 'pageHistoryTags.tagId')
      .where('pageHistoryTags.pageId', history.id)
      .select('tags.tag')
    const oldContext = pageAuthorizationContext({ ...history, tags: historicalTags })
    if (
      !oldContext ||
      !evaluateGroupAccess(authority.permissions, ['read:pages'], authority.groups, oldContext, authority.tagAliases, false).allowed ||
      !evaluateGroupAccess(authority.permissions, ['read:history'], authority.groups, oldContext, authority.tagAliases, false).allowed
    )
      return unavailable()
    if (!current.policy.tree.some(tree => tree.locale === input.menuLocale)) return fail('Choose an existing custom-menu locale.', lock ? 409 : 400)
    if (!NavigationPolicySchema.safeParse(current.policy).success) return fail('Saved navigation must be corrected before repairing links.', lock ? 409 : 400)
    const oldIdentity = { locale: history.localeCode as string, path: history.path as string },
      newIdentity = { locale: page.localeCode as string, path: page.path as string }
    const review = {
      pageId: input.pageId,
      menuLocale: input.menuLocale,
      sourceRevision: String(page.sourceRevision),
      historyId: Number(history.id),
      oldIdentity,
      newIdentity,
      fingerprint: current.fingerprint,
      issuedAt,
      items: movedNavigationItems(current.policy, input.menuLocale, oldIdentity, newIdentity)
    }
    const session = requester
      ? [
          principalId(requester),
          Reflect.get(requester, 'authVersion'),
          Reflect.get(requester, 'api'),
          Reflect.get(requester, 'grp'),
          Reflect.get(requester, 'ownershipUserId')
        ]
      : null
    const reviewToken = createHmac('sha256', deps.reviewKey)
      .update('navigation-move:v1:' + stable([review, session]))
      .digest('hex')
    return { ...review, reviewToken }
  }
  return {
    inspect,
    async save(requester: PagePrincipal, input: { policy: unknown; fingerprint: unknown; reason: unknown }): Promise<NavigationWriteResult> {
      const validation = NavigationPolicySchema.safeParse(input.policy)
      if (!validation.success) return fail(validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '))
      await deps.db.transaction(async tx => {
        const current = await state(tx, requester, true)
        if (typeof input.fingerprint !== 'string' || current.fingerprint !== input.fingerprint)
          return fail('Workspace settings changed. Reload the saved settings before reviewing again.', 409)
        await publish(tx, current, validation.data, input.reason)
      })
      return activate()
    },
    async inspectMovedPage(requester: PagePrincipal, input: unknown): Promise<NavigationMoveReview> {
      const parsed = repairInput.safeParse(input)
      if (!parsed.success) return fail('Choose a page and custom-menu locale.')
      // The native authority loader takes shared locks; PostgreSQL forbids those in a read-only transaction.
      return deps.db.transaction(tx => reviewMove(tx, requester, parsed.data, false), { isolationLevel: 'repeatable read' })
    },
    async repairMovedPage(requester: PagePrincipal, input: unknown): Promise<NavigationWriteResult> {
      const parsed = z
        .strictObject({
          review: NavigationMoveReviewSchema,
          selected: z
            .array(z.strictObject({ locale: z.string().min(2).max(35), itemId: z.string().min(1).max(100) }))
            .min(1)
            .max(200),
          reason: z.string().min(3).max(1000)
        })
        .safeParse(input)
      if (!parsed.success) return fail('Review the moved-page links, select items and provide an administrative reason.')
      const { review, selected, reason } = parsed.data
      await deps.db.transaction(async tx => {
        const fresh = await reviewMove(tx, requester, review, true, review.issuedAt)
        if (
          Date.now() - review.issuedAt > 15 * 60_000 ||
          review.issuedAt > Date.now() + 60_000 ||
          !timingSafeEqual(Buffer.from(fresh.reviewToken), Buffer.from(review.reviewToken)) ||
          stable(fresh) !== stable(review)
        )
          return fail('The page, navigation or review changed. Reload and review the moved-page links again.', 409)
        const keys = new Set(selected.map(navigationRepairItemKey))
        const repairs = fresh.items.filter(item => keys.has(navigationRepairItemKey(item)))
        if (keys.size !== selected.length || repairs.length !== selected.length) return fail('Select only the links in this review.')
        const current = await state(tx, requester, true)
        if (current.fingerprint !== fresh.fingerprint) return fail('Navigation changed. Reload before repairing links.', 409)
        await publish(tx, current, applyNavigationMoveRepair(current.policy, repairs), reason)
      })
      return activate()
    },
    async initialize(requester: PagePrincipal, fingerprint: unknown): Promise<NavigationWriteResult> {
      const saved = await inspect(requester)
      if (typeof fingerprint !== 'string' || fingerprint !== saved.fingerprint) return fail('Workspace settings changed. Reload before activation.', 409)
      return activate()
    }
  }
}
let runtimeStore: ReturnType<typeof createNavigationAdministrationStore> | undefined
let runtimeDatabase: Knex | undefined
export const getNavigationAdministrationStore = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    auth: { loadPageRuleAuthority(requester: PagePrincipal, tx: Knex.Transaction): Promise<PageRuleAuthority> }
    config: Record<string, unknown>
    configSvc: { loadFromDb(): Promise<void> }
    events: { outbound: { emit(event: string): void } }
    logger: { warn(message: string): void }
  }
  if (!runtimeStore || runtimeDatabase !== wiki.models.knex) {
    runtimeDatabase = wiki.models.knex
    let queue = Promise.resolve()
    runtimeStore = createNavigationAdministrationStore({
      db: wiki.models.knex,
      reviewKey: String(wiki.config.sessionSecret),
      fallback: () => wiki.config,
      runtime: () => {
        const nav = record(wiki.config.nav)
        return { mode: nav.mode, expandParent: nav.expandParent !== false, revision: nav.revision }
      },
      loadPageAuthority: (requester, tx) => wiki.auth.loadPageRuleAuthority(requester, tx),
      onCommitted: () => {
        const next = queue.then(async () => {
          await wiki.configSvc.loadFromDb()
          let notified = true
          try {
            wiki.events.outbound.emit('reloadConfig')
          } catch {
            wiki.logger.warn('Workspace settings saved; peer reload notification failed.')
            notified = false
          }
          const rows = await wiki.models.knex<Setting>('settings').whereIn('key', settingKeys).orderBy('key')
          const saved = { ...wiki.config, ...Object.fromEntries(rows.map(row => [row.key, row.value])) }
          return notified && stable(record(saved.nav)) === stable(record(wiki.config.nav))
        })
        queue = next.then(
          () => {},
          () => {}
        )
        return next
      }
    })
  }
  return runtimeStore
}
