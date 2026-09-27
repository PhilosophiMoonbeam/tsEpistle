import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  LocalePolicySchema,
  LocaleCatalogSchema,
  LocaleCatalogEntrySchema,
  LocaleCodeSchema,
  LocaleFileReviewSchema,
  MAX_LOCALE_FILE_BYTES,
  localePolicyFromConfiguration,
  localeChangedFields,
  type LocaleCatalogEntry,
  type LocaleFileReview,
  type LocaleWorkspace,
  type LocaleEvent,
  type LocaleOperation,
  type LocaleWriteResult
} from '../../shared/locale-policy.ts'
import { flattenLocaleStrings, mergeLocaleCatalog, type LocaleStrings } from '../helpers/locale-package.ts'
import { parseLocaleFileBytes, type ParsedLocaleFile } from '../repositories/locale-packages.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import { DurableJobStore, type DurableJob } from '../core/durable-jobs.ts'
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
const settingKeys = ['lang', 'localeAdministration', 'localeCatalog', 'graphEndpoint', 'offline']
interface Setting {
  key: string
  value: unknown
}
interface Group {
  id: number
  permissions: string[]
  adminRevision: string
}
interface Account {
  id: number
  isActive: boolean
  authVersion: number
}
interface InstalledLocale extends LocaleCatalogEntry {
  createdAt: string
  updatedAt: string
}
interface StoredLocalFileReview extends LocaleFileReview {
  actorId: number | null
  actorFingerprint: string
  workspaceFingerprint: string
  packageFingerprint: string | null
  binding: string
  exactBytes: string
  normalizedStrings: string
  locale: LocaleCatalogEntry
  jobId?: string
  eventId?: string
}
export type LocalePackageJobContext =
  | { kind: 'local'; alreadyApplied: boolean }
  | { kind: 'remote'; endpoint: string; alreadyApplied: boolean }
export interface LocalePackageStore {
  jobContext(job: DurableJob): Promise<LocalePackageJobContext>
  publishJob(job: DurableJob, catalog: LocaleCatalogEntry[], strings?: LocaleStrings): Promise<LocaleWriteResult>
  discardLocalFileReview(job: DurableJob): Promise<void>
}
interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  cachedCatalog?(): Promise<unknown>
  runtime(): { locale: unknown; revision: unknown; configuration: unknown }
  onCommitted?(): Promise<boolean>
}
export const createLocaleAdministrationStore = (deps: Dependencies) => {
  const fingerprint = (value: unknown) => createHmac('sha256', deps.reviewKey).update(stable(value)).digest('hex')
  // The signed digest binds uploaded bytes; verifyLocalReviewBytes recomputes it before use.
  const localReviewBinding = (review: Omit<StoredLocalFileReview, 'binding'>): string =>
    fingerprint([
      review.id,
      review.code,
      review.name,
      review.nativeName,
      review.digest,
      review.reason,
      review.expiresAt,
      review.actorId,
      review.actorFingerprint,
      review.workspaceFingerprint,
      review.packageFingerprint,
      review.jobId ?? null,
      review.eventId ?? null,
      review.locale,
      review.changes
    ])
  const state = async (tx: Knex.Transaction, requester: PagePrincipal, lock = false) => {
    const groupQuery = tx<Group>('groups').select('id', 'permissions', 'adminRevision').orderBy('id'),
      groups = await (lock ? groupQuery.forUpdate() : groupQuery)
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
    if (!groups.some(group => ids.includes(group.id) && group.permissions.includes('manage:system'))) return fail('System administration is required.', 403)
    const query = tx<Setting>('settings').whereIn('key', settingKeys).orderBy('key'),
      rows = await (lock ? query.forUpdate() : query)
    const configuration = {
      ...deps.fallback(),
      ...Object.fromEntries(
        rows.map(row => [row.key, ['offline', 'graphEndpoint'].includes(row.key) && Object.hasOwn(record(row.value), 'v') ? record(row.value).v : row.value])
      )
    }
    const localeQuery = tx<InstalledLocale>('locales').select('code', 'name', 'nativeName', 'isRTL', 'availability', 'createdAt', 'updatedAt').orderBy('code'),
      locales = await (lock ? localeQuery.forShare() : localeQuery)
    const catalogData = record(configuration.localeCatalog),
      parsed = LocaleCatalogSchema.safeParse(catalogData.locales ?? (await deps.cachedCatalog?.()))
    const catalog = parsed.success ? parsed.data : []
    const policy = localePolicyFromConfiguration(configuration),
      metadata = record(configuration.localeAdministration)
    return {
      configuration,
      locales,
      policy,
      metadata,
      catalog,
      catalogData,
      actorId,
      fingerprint: fingerprint([rows.filter(row => row.key !== 'localeAdministration'), policy, locales, catalog, groups, actorId, ids])
    }
  }
  type State = Awaited<ReturnType<typeof state>>
  const put = async (tx: Knex.Transaction, key: string, value: unknown, now: string) => {
    await tx('settings')
      .insert({ key, value: JSON.stringify(value), updatedAt: now })
      .onConflict('key')
      .merge(['value', 'updatedAt'])
  }
  const events = (saved: State): LocaleEvent[] => (Array.isArray(saved.metadata.history) ? (saved.metadata.history as LocaleEvent[]) : [])
  const addEvent = (tx: Knex.Transaction, saved: State, event: LocaleEvent) =>
    put(tx, 'localeAdministration', { ...saved.metadata, revision: event.id, history: [event, ...events(saved)].slice(0, 50) }, event.createdAt)
  const assertReview = (saved: State, value: unknown) => {
    if (typeof value !== 'string' || value !== saved.fingerprint) return fail('Locale settings changed. Reload saved settings before reviewing again.', 409)
  }
  const reason = (value: unknown): string => {
    if (typeof value !== 'string' || value.trim().length < 3 || value.length > 1000) return fail('Provide an administrative reason of 3–1000 characters.')
    return value.trim()
  }
  const localPackageFingerprint = (value: Record<string, unknown> | null) => {
    if (!value) return null
    let strings = value.strings
    if (typeof strings === 'string') {
      try {
        strings = JSON.parse(strings) as unknown
      } catch {
        /* Preserve malformed stored bytes as a distinct package identity. */
      }
    }
    return createHash('sha256')
      .update(stable([value.code, value.name, value.nativeName, value.isRTL, value.availability, strings]))
      .digest('hex')
  }
  const principalFingerprint = (actorId: number | null, requester: PagePrincipal) => {
    if (!requester) return fail('An administrator sign-in is required.', 403)
    return fingerprint([
      actorId,
      requester.id,
      requester.ownershipUserId ?? null,
      actorId === null && Array.isArray(requester.groups) ? [...requester.groups].sort((a, b) => a - b) : null
    ])
  }
  const storedLocalReview = (value: unknown): StoredLocalFileReview | null => {
    const data = record(value),
      review = LocaleFileReviewSchema.safeParse({
        id: data.id,
        code: data.code,
        name: data.name,
        nativeName: data.nativeName,
        digest: data.digest,
        reason: data.reason,
        expiresAt: data.expiresAt,
        changes: data.changes
      }),
      locale = LocaleCatalogEntrySchema.safeParse(data.locale)
    if (
      !review.success ||
      !locale.success ||
      !(data.actorId === null || (typeof data.actorId === 'number' && Number.isInteger(data.actorId) && data.actorId > 0)) ||
      typeof data.actorFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.actorFingerprint) ||
      typeof data.workspaceFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.workspaceFingerprint) ||
      !(data.packageFingerprint === null || (typeof data.packageFingerprint === 'string' && /^[a-f0-9]{64}$/.test(data.packageFingerprint))) ||
      typeof data.binding !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.binding) ||
      typeof data.exactBytes !== 'string' ||
      data.exactBytes.length > Math.ceil(MAX_LOCALE_FILE_BYTES / 3) * 4 ||
      typeof data.normalizedStrings !== 'string' ||
      data.normalizedStrings.length > MAX_LOCALE_FILE_BYTES * 2 ||
      (data.jobId !== undefined && typeof data.jobId !== 'string') ||
      (data.eventId !== undefined && typeof data.eventId !== 'string')
    )
      return null
    return {
      ...review.data,
      actorId: data.actorId as number | null,
      actorFingerprint: data.actorFingerprint,
      workspaceFingerprint: data.workspaceFingerprint,
      packageFingerprint: data.packageFingerprint as string | null,
      binding: data.binding,
      exactBytes: data.exactBytes,
      normalizedStrings: data.normalizedStrings,
      locale: locale.data,
      ...(typeof data.jobId === 'string' ? { jobId: data.jobId } : {}),
      ...(typeof data.eventId === 'string' ? { eventId: data.eventId } : {})
    }
  }
  const reviewView = (review: StoredLocalFileReview): LocaleFileReview =>
    LocaleFileReviewSchema.parse({
      id: review.id,
      code: review.code,
      name: review.locale.name,
      nativeName: review.locale.nativeName,
      digest: review.digest,
      reason: review.reason,
      expiresAt: review.expiresAt,
      changes: review.changes
    })
  const assertLocalReviewBound = (saved: State, requester: PagePrincipal, review: StoredLocalFileReview) => {
    if (review.binding !== localReviewBinding(review)) return fail('The staged language-file review was changed.', 409)
    if (review.actorId !== saved.actorId || review.actorFingerprint !== principalFingerprint(saved.actorId, requester))
      return fail('This language-file review belongs to a different administrator.', 403)
    if (review.workspaceFingerprint !== saved.fingerprint)
      return fail('Locale settings or installed packages changed after this file was reviewed.', 409)
    if (Date.parse(review.expiresAt) <= Date.now()) return fail('This language-file review expired. Review the file again.', 409)
  }
  const verifyLocalReviewBytes = (review: StoredLocalFileReview) => {
    const bytes = Buffer.from(review.exactBytes, 'base64')
    if (!bytes.byteLength || bytes.byteLength > MAX_LOCALE_FILE_BYTES || bytes.toString('base64') !== review.exactBytes)
      return fail('The staged language file changed after review.', 409)
    let parsed: ParsedLocaleFile
    try {
      parsed = parseLocaleFileBytes(bytes)
    } catch {
      return fail('The staged language file changed after review.', 409)
    }
    if (parsed.digest !== review.digest || parsed.normalized !== review.normalizedStrings)
      return fail('The staged language file changed after review.', 409)
    return parsed
  }
  const localeForCode = (saved: State, code: string): LocaleCatalogEntry => {
    if (code === 'en') return fail('Bundled English translations cannot be replaced.')
    const entry = saved.locales.find(locale => locale.code === code) ?? saved.catalog.find(locale => locale.code === code),
      parsed = LocaleCatalogEntrySchema.safeParse(entry)
    if (!parsed.success) return fail('Choose a language present in the installed packages or current catalog.')
    return parsed.data
  }
  const storedPackage = async (tx: Knex.Transaction, code: string, lock: boolean) => {
    const query = tx('locales').where({ code })
    return lock ? query.forUpdate().first() : query.first()
  }
  const assertLocalPackageCurrent = async (
    tx: Knex.Transaction,
    saved: State,
    review: StoredLocalFileReview,
    lock: boolean
  ) => {
    const current = record(await storedPackage(tx, review.code, lock)),
      row = Object.keys(current).length ? current : null
    if (localPackageFingerprint(row) !== review.packageFingerprint)
      return fail('The installed package changed after this file was reviewed.', 409)
    const currentLocale = localeForCode(saved, review.code)
    if (stable(currentLocale) !== stable(review.locale))
      return fail('The language catalog or installed package changed after this file was reviewed.', 409)
    return row
  }
  const clearExpiredLocalReview = async (reviewId?: string, jobId?: string, force = false) => {
    await deps.db.transaction(async tx => {
      const row = await tx<Setting>('settings').where({ key: 'localeAdministration' }).forUpdate().first(),
        metadata = record(row?.value),
        review = storedLocalReview(metadata.localFileReview)
      if (!Object.hasOwn(metadata, 'localFileReview')) return
      if (reviewId && review && review.id !== reviewId) return
      if (jobId && review && review.jobId !== jobId) return
      let shouldClear = force || !review || Date.parse(review.expiresAt) <= Date.now()
      if (!shouldClear && review?.jobId) {
        const job = await tx('durableJobs').where({ id: review.jobId, type: 'locale-package', version: 1 }).first('state')
        shouldClear = !job || !['pending', 'running'].includes(job.state)
      }
      if (!shouldClear) return
      const next = { ...metadata }
      delete next.localFileReview
      await put(tx, 'localeAdministration', next, new Date().toISOString())
    })
  }
  const applied = (saved: State): boolean => {
    const runtime = deps.runtime(),
      lang = record(saved.configuration.lang)
    return runtime.locale === saved.policy.locale && (runtime.revision ?? '') === (lang.revision ?? '') && stable(runtime.configuration) === stable({ ...record(runtime.configuration), ...lang })
  }
  const activate = async (): Promise<LocaleWriteResult> => {
    try {
      return { activation: (await deps.onCommitted?.()) === true ? 'applied' : 'needs-attention' }
    } catch {
      return { activation: 'needs-attention' }
    }
  }
  const inspect = async (requester: PagePrincipal): Promise<LocaleWorkspace> => {
    await clearExpiredLocalReview()
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const saved = await state(tx, requester)
      const counts = await tx('pages')
        .select('localeCode')
        .count('* as pages')
        .select(tx.raw('count(*) FILTER (WHERE ?? = true) as ??', ['isPublished', 'publishedPages']))
        .select(tx.raw('count(*) FILTER (WHERE ?? IS NOT NULL) as ??', ['localeGroupId', 'linkedTranslations']))
        .where('visibility', 'public')
        .groupBy('localeCode')
      const navigation = await tx('navigation').where('key', 'site').first('config'),
        trees = Array.isArray(navigation?.config) ? navigation.config : []
      const jobs = await tx('durableJobs').where({ type: 'locale-package', version: 1 }).orderBy('createdAt', 'desc').limit(25)
      const operations: LocaleOperation[] = jobs.map(job => {
        let payload: Record<string, unknown> = {}
        try {
          payload = record(JSON.parse(job.payload))
        } catch {
          /* malformed historical jobs do not expose payloads */
        }
        return {
          id: job.id,
          kind: payload.kind === 'catalog' ? 'catalog' : payload.kind === 'local' ? 'local' : 'install',
          code: typeof payload.code === 'string' ? payload.code : null,
          state: job.state,
          attempts: job.attempts,
          createdAt: new Date(job.createdAt).toISOString(),
          updatedAt: new Date(job.updatedAt).toISOString(),
          completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
          message:
            job.state === 'failed'
              ? payload.kind === 'local'
                ? 'The local package operation did not complete. The installed package remains unchanged unless Activity records publication.'
                : 'The operation did not complete. Reload the catalog and retry; the installed package remains intact unless Activity records publication.'
              : job.state === 'pending' && job.attempts > 0
                ? 'The worker will retry this operation.'
                : null
        }
      })
      let localFileReview: LocaleFileReview | null = null
      const stagedReview = storedLocalReview(saved.metadata.localFileReview)
      if (stagedReview && !stagedReview.jobId) {
        try {
          assertLocalReviewBound(saved, requester, stagedReview)
          await assertLocalPackageCurrent(tx, saved, stagedReview, false)
          verifyLocalReviewBytes(stagedReview)
          localFileReview = reviewView(stagedReview)
        } catch {
          /* Stale, expired or corrupted staged reviews are not actionable in the workspace. */
        }
      }
      let source: string | null = null
      try {
        source = new URL(String(saved.configuration.graphEndpoint)).host
      } catch {
        /* unavailable source is explicit */
      }
      await tx.commit()
      return {
        policy: saved.policy,
        fingerprint: saved.fingerprint,
        history: events(saved).slice(0, 50),
        operations,
        locales: mergeLocaleCatalog(saved.catalog, saved.locales).map(locale => {
          const installed = saved.locales.find(row => row.code === locale.code),
            count = counts.find(row => row.localeCode === locale.code)
          return {
            ...locale,
            isInstalled: Boolean(installed),
            installDate: installed?.updatedAt ?? null,
            pages: Number(count?.pages ?? 0),
            publishedPages: Number(count?.publishedPages ?? 0),
            linkedTranslations: Number(count?.linkedTranslations ?? 0),
            menuItems: trees.find((tree: { locale?: string }) => tree.locale === locale.code)?.items?.length ?? 0
          }
        }),
        catalog: {
          source,
          observedAt: typeof saved.catalogData.observedAt === 'string' ? saved.catalogData.observedAt : null,
          offline: saved.configuration.offline === true
        },
        localFileReview,
        runtime: { state: applied(saved) ? 'applied' : 'needs-attention', observedAt: new Date().toISOString() }
      }
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  return {
    inspect,
    async save(requester: PagePrincipal, input: { policy: unknown; fingerprint: unknown; reason: unknown }) {
      const parsed = LocalePolicySchema.safeParse(input.policy)
      if (!parsed.success) return fail(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '))
      const why = reason(input.reason)
      await deps.db.transaction(async tx => {
        const saved = await state(tx, requester, true)
        assertReview(saved, input.fingerprint)
        for (const code of new Set([parsed.data.locale, ...parsed.data.namespaces]))
          if (!saved.locales.some(locale => locale.code === code)) return fail(`Install ${code} before selecting it as a reading language.`)
        const fields = localeChangedFields(saved.policy, parsed.data)
        if (!fields.length) return fail('There are no locale changes to save.')
        const event: LocaleEvent = { id: randomUUID(), actorId: saved.actorId, kind: 'settings', fields, reason: why, createdAt: new Date().toISOString() }
        await put(
          tx,
          'lang',
          {
            ...record(saved.configuration.lang),
            code: parsed.data.locale,
            autoUpdate: parsed.data.autoUpdate,
            namespacing: parsed.data.namespacing,
            namespaces: parsed.data.namespaces,
            rtl: saved.locales.find(locale => locale.code === parsed.data.locale)!.isRTL,
            revision: event.id
          },
          event.createdAt
        )
        await addEvent(tx, saved, event)
      })
      return activate()
    },
    async initialize(requester: PagePrincipal, review: unknown) {
      const saved = await inspect(requester)
      if (saved.fingerprint !== review) return fail('Locale settings changed. Reload before activation.', 409)
      return activate()
    },
    async enqueue(requester: PagePrincipal, input: { kind: unknown; code?: unknown; fingerprint: unknown; reason: unknown }) {
      if (input.kind !== 'install' && input.kind !== 'catalog') return fail('Choose a package installation or catalog refresh.')
      const kind = input.kind,
        why = reason(input.reason),
        parsedCode = LocaleCodeSchema.safeParse(input.code)
      if (kind === 'install' && !parsedCode.success) return fail('Choose a valid language code.')
      const code = kind === 'install' && parsedCode.success ? parsedCode.data : null
      return deps.db.transaction(async tx => {
        const saved = await state(tx, requester, true)
        assertReview(saved, input.fingerprint)
        if (saved.configuration.offline === true) return fail('Remote language operations are unavailable in offline mode.')
        if (code && !saved.catalog.some(locale => locale.code === code))
          return fail('This language is absent from the current catalog. Refresh the catalog first.')
        const active = await tx('durableJobs').where({ type: 'locale-package', version: 1 }).whereIn('state', ['pending', 'running']).first('id')
        if (active) return fail('A language operation is already queued or running. Wait for its result before starting another.', 409)
        const id = randomUUID(),
          now = new Date().toISOString()
        const principal =
          saved.actorId === null ? { id: 1, ownershipUserId: null, groups: requester!.groups } : { id: saved.actorId, authVersion: requester!.authVersion }
        const job = await new DurableJobStore(tx).enqueue({
          type: 'locale-package',
          version: 1,
          maxAttempts: 3,
          payload: { eventId: id, kind, code, requester: principal, sourceFingerprint: fingerprint(saved.configuration.graphEndpoint) }
        })
        await addEvent(tx, saved, {
          id,
          actorId: saved.actorId,
          reason: why,
          fields: [kind === 'catalog' ? 'catalog' : `package:${code}`],
          createdAt: now,
          kind,
          jobId: job.id,
          ...(code ? { code } : {})
        })
        return { jobId: job.id }
      })
    },
    async reviewLocalFile(
      requester: PagePrincipal,
      input: { code: unknown; fingerprint: unknown; reason: unknown; bytes: unknown }
    ): Promise<LocaleFileReview> {
      const codeResult = LocaleCodeSchema.safeParse(input.code)
      if (!codeResult.success || Intl.getCanonicalLocales(codeResult.data)[0] !== codeResult.data)
        return fail('Choose an explicit canonical language code.')
      const code = codeResult.data
      if (code === 'en') return fail('Bundled English translations cannot be replaced.')
      const why = reason(input.reason)
      if (!(input.bytes instanceof Uint8Array)) return fail('Choose a JSON language file.')
      if (!input.bytes.byteLength) return fail('Choose a nonempty JSON language file.')
      if (input.bytes.byteLength > MAX_LOCALE_FILE_BYTES) return fail('Language files cannot exceed 8 MiB.', 413)
      const fileBytes = Buffer.from(input.bytes)
      let parsedFile: ParsedLocaleFile
      try {
        parsedFile = parseLocaleFileBytes(fileBytes)
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'The language file is invalid.')
      }
      await clearExpiredLocalReview()
      return deps.db.transaction(async tx => {
        const saved = await state(tx, requester, true)
        assertReview(saved, input.fingerprint)
        const existingReview = storedLocalReview(saved.metadata.localFileReview)
        if (
          existingReview &&
          !existingReview.jobId &&
          Date.parse(existingReview.expiresAt) > Date.now() &&
          existingReview.binding === localReviewBinding(existingReview) &&
          (existingReview.actorId !== saved.actorId ||
            existingReview.actorFingerprint !== principalFingerprint(saved.actorId, requester))
        )
          return fail('Another administrator has an active local-file review. Wait for it to expire before staging a new file.', 409)
        const locale = localeForCode(saved, code)
        const active = await tx('durableJobs').where({ type: 'locale-package', version: 1 }).whereIn('state', ['pending', 'running']).first('id')
        if (active) return fail('A language operation is already queued or running. Wait for its result before reviewing a file.', 409)
        const rowValue = record(await storedPackage(tx, code, true)),
          row = Object.keys(rowValue).length ? rowValue : null
        let previous: unknown = Object.create(null)
        if (row) {
          try {
            previous = typeof row.strings === 'string' ? JSON.parse(row.strings) as unknown : row.strings
          } catch {
            return fail('The installed package cannot be safely compared with this file.', 409)
          }
          if (!previous || typeof previous !== 'object' || Array.isArray(previous))
            return fail('The installed package cannot be safely compared with this file.', 409)
        }
        const before = flattenLocaleStrings(previous),
          after = flattenLocaleStrings(parsedFile.strings),
          changes = {
            added: [...after.keys()].filter(key => !before.has(key)).sort(),
            changed: [...after].filter(([key, value]) => before.has(key) && before.get(key) !== value).map(([key]) => key).sort(),
            removed: [...before.keys()].filter(key => !after.has(key)).sort()
          },
          now = Date.now(),
          unbound: Omit<StoredLocalFileReview, 'binding' | 'jobId' | 'eventId'> = {
            id: randomUUID(),
            code,
            name: locale.name,
            nativeName: locale.nativeName,
            digest: parsedFile.digest,
            reason: why,
            expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
            changes,
            actorId: saved.actorId,
            actorFingerprint: principalFingerprint(saved.actorId, requester),
            workspaceFingerprint: saved.fingerprint,
            packageFingerprint: localPackageFingerprint(row),
            exactBytes: fileBytes.toString('base64'),
            normalizedStrings: parsedFile.normalized,
            locale
          },
          staged: StoredLocalFileReview = { ...unbound, binding: localReviewBinding(unbound) }
        await put(tx, 'localeAdministration', { ...saved.metadata, localFileReview: staged }, new Date(now).toISOString())
        return reviewView(staged)
      })
    },
    async enqueueLocalFile(requester: PagePrincipal, input: { reviewId: unknown }): Promise<{ jobId: string }> {
      await clearExpiredLocalReview()
      return deps.db.transaction(async tx => {
        const saved = await state(tx, requester, true),
          staged = storedLocalReview(saved.metadata.localFileReview)
        if (!staged || staged.id !== input.reviewId || staged.jobId)
          return fail('The reviewed language file is unavailable. Review the file again.', 409)
        assertLocalReviewBound(saved, requester, staged)
        verifyLocalReviewBytes(staged)
        await assertLocalPackageCurrent(tx, saved, staged, true)
        const active = await tx('durableJobs').where({ type: 'locale-package', version: 1 }).whereIn('state', ['pending', 'running']).first('id')
        if (active) return fail('A language operation is already queued or running. Wait for its result before committing this file.', 409)
        const eventId = randomUUID(),
          now = new Date().toISOString(),
          principal =
            saved.actorId === null
              ? { id: 1, ownershipUserId: null, groups: requester!.groups }
              : { id: saved.actorId, authVersion: requester!.authVersion },
          job = await new DurableJobStore(tx).enqueue({
            type: 'locale-package',
            version: 1,
            maxAttempts: 3,
            payload: { eventId, kind: 'local', code: staged.code, reviewId: staged.id, requester: principal }
          }),
          event: LocaleEvent = {
            id: eventId,
            actorId: saved.actorId,
            reason: staged.reason,
            fields: [`package:${staged.code}`],
            createdAt: now,
            kind: 'local',
            jobId: job.id,
            code: staged.code
          }
        const boundReview = { ...staged, jobId: job.id, eventId },
          queuedReview = { ...boundReview, binding: localReviewBinding(boundReview) }
        await put(
          tx,
          'localeAdministration',
          {
            ...saved.metadata,
            revision: eventId,
            history: [event, ...events(saved)].slice(0, 50),
            localFileReview: queuedReview
          },
          now
        )
        return { jobId: job.id }
      })
    },
    async jobContext(job: DurableJob): Promise<LocalePackageJobContext> {
      await clearExpiredLocalReview()
      const requester = record(job.payload.requester) as PagePrincipal
      const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
      try {
        const saved = await state(tx, requester),
          event = events(saved).find(row => row.id === job.payload.eventId && row.jobId === job.id)
        if (!event) return fail('This language operation no longer has an administrative receipt.')
        if (job.payload.kind === 'local') {
          if (event.kind !== 'local') return fail('This local language operation no longer has a matching receipt.', 409)
          if (event.appliedAt) {
            await tx.commit()
            return { kind: 'local', alreadyApplied: true }
          }
          const review = storedLocalReview(saved.metadata.localFileReview)
          if (
            !review ||
            review.id !== job.payload.reviewId ||
            review.jobId !== job.id ||
            review.eventId !== event.id ||
            review.code !== event.code ||
            review.code !== job.payload.code
          )
            return fail('The staged language file no longer matches this operation.', 409)
          await tx.commit()
          return { kind: 'local', alreadyApplied: false }
        }
        if (job.payload.kind !== 'install' && job.payload.kind !== 'catalog')
          return fail('The language operation payload is invalid.')
        if (event.kind !== job.payload.kind) return fail('This language operation no longer has a matching receipt.', 409)
        if (saved.configuration.offline === true) return fail('Language downloads are disabled in offline mode.')
        if (fingerprint(saved.configuration.graphEndpoint) !== job.payload.sourceFingerprint)
          return fail('The language source changed after this operation was queued.')
        await tx.commit()
        return { kind: 'remote', endpoint: String(saved.configuration.graphEndpoint), alreadyApplied: Boolean(event.appliedAt) }
      } catch (error) {
        await tx.rollback()
        throw error
      }
    },
    async discardLocalFileReview(job: DurableJob) {
      const reviewId = typeof job.payload.reviewId === 'string' ? job.payload.reviewId : undefined
      await clearExpiredLocalReview(reviewId, job.id, true)
    },
    async publishJob(job: DurableJob, catalog: LocaleCatalogEntry[], strings?: LocaleStrings) {
      await deps.db.transaction(async tx => {
        // Authority/settings locks precede the job lease lock, consistently with enqueue.
        const saved = await state(tx, record(job.payload.requester) as PagePrincipal, true),
          lease = await tx('durableJobs').where({ id: job.id, type: 'locale-package', version: 1 }).forUpdate().first()
        if (
          !lease ||
          lease.state !== 'running' ||
          !job.leaseToken ||
          lease.leaseToken !== job.leaseToken ||
          new Date(lease.leaseExpiresAt).valueOf() <= Date.now()
        )
          return fail('This language worker no longer owns its lease.', 409)
        const event = events(saved).find(row => row.id === job.payload.eventId && row.jobId === job.id)
        if (!event) return fail('This language operation no longer has an administrative receipt.')
        if (event.appliedAt) return
        const now = new Date().toISOString()
        if (job.payload.kind === 'local') {
          if (event.kind !== 'local') return fail('This local language operation no longer has a matching receipt.', 409)
          const review = storedLocalReview(saved.metadata.localFileReview)
          if (
            !review ||
            review.id !== job.payload.reviewId ||
            review.jobId !== job.id ||
            review.eventId !== event.id ||
            review.code !== event.code ||
            review.code !== job.payload.code
          )
            return fail('The staged language file no longer matches this operation.', 409)
          assertLocalReviewBound(saved, record(job.payload.requester) as PagePrincipal, review)
          const parsed = verifyLocalReviewBytes(review)
          await assertLocalPackageCurrent(tx, saved, review, true)
          const locale = localeForCode(saved, review.code),
            data = {
              code: locale.code,
              name: locale.name,
              nativeName: locale.nativeName,
              isRTL: locale.isRTL,
              availability: locale.availability,
              strings: parsed.normalized,
              createdAt: now,
              updatedAt: now
            }
          await tx('locales').insert(data).onConflict('code').merge(['name', 'nativeName', 'isRTL', 'availability', 'strings', 'updatedAt'])
          const lang = record(saved.configuration.lang),
            metadata: Record<string, unknown> = { ...saved.metadata, history: events(saved).map(row => (row.id === event.id ? { ...row, appliedAt: now } : row)) }
          delete metadata.localFileReview
          await put(tx, 'lang', { ...lang, ...(lang.code === locale.code ? { rtl: locale.isRTL } : {}), revision: event.id }, now)
          await put(tx, 'localeAdministration', metadata, now)
          return
        }
        if (job.payload.kind !== 'install' && job.payload.kind !== 'catalog')
          return fail('The language operation payload is invalid.')
        if (event.kind !== job.payload.kind) return fail('This language operation no longer has a matching receipt.', 409)
        if (saved.configuration.offline === true || fingerprint(saved.configuration.graphEndpoint) !== job.payload.sourceFingerprint)
          return fail('The language source or offline policy changed during this operation.', 409)
        if (event.kind === 'install') {
          const locale = catalog.find(row => row.code === event.code)
          if (!locale || !strings) return fail('The language package is absent from the current source.')
          const data = {
            code: locale.code,
            name: locale.name,
            nativeName: locale.nativeName,
            isRTL: locale.isRTL,
            availability: locale.availability,
            strings: JSON.stringify(strings),
            createdAt: now,
            updatedAt: now
          }
          await tx('locales').insert(data).onConflict('code').merge(['name', 'nativeName', 'isRTL', 'availability', 'strings', 'updatedAt'])
          const lang = record(saved.configuration.lang)
          await put(tx, 'lang', { ...lang, ...(lang.code === locale.code ? { rtl: locale.isRTL } : {}), revision: event.id }, now)
        }
        await put(tx, 'localeCatalog', { locales: catalog, observedAt: now }, now)
        await put(
          tx,
          'localeAdministration',
          { ...saved.metadata, history: events(saved).map(row => (row.id === event.id ? { ...row, appliedAt: now } : row)) },
          now
        )
      })
      return activate()
    },
  }
}
let runtimeStore: ReturnType<typeof createLocaleAdministrationStore> | undefined, runtimeDatabase: Knex | undefined
export const getLocaleAdministrationStore = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    config: Record<string, unknown>
    cache: { get(key: string): Promise<unknown> }
    configSvc: { loadFromDb(): Promise<void> }
    lang: { appliedRevision: string | null; appliedLocale: string | null; refreshNamespaces(): Promise<void> }
    events: { outbound: { emit(event: string): void } }
    logger: { warn(message: string): void }
  }
  if (!runtimeStore || runtimeDatabase !== wiki.models.knex) {
    runtimeDatabase = wiki.models.knex
    let queue = Promise.resolve()
    runtimeStore = createLocaleAdministrationStore({
      db: wiki.models.knex,
      reviewKey: String(wiki.config.sessionSecret),
      fallback: () => wiki.config,
      cachedCatalog: () => wiki.cache.get('locales'),
      runtime: () => ({ locale: wiki.lang.appliedLocale, revision: wiki.lang.appliedRevision, configuration: wiki.config.lang }),
      onCommitted: () => {
        const next = queue.then(async () => {
          await wiki.configSvc.loadFromDb()
          await wiki.lang.refreshNamespaces()
          let notified = true
          try {
            wiki.events.outbound.emit('reloadConfig')
          } catch {
            notified = false
            wiki.logger.warn('Locale settings saved; peer reload notification failed.')
          }
          const row = await wiki.models.knex<Setting>('settings').where('key', 'lang').first()
          return (
            notified &&
            stable({ ...record(wiki.config.lang), ...record(row?.value) }) === stable(wiki.config.lang) &&
            (record(wiki.config.lang).revision ?? null) === wiki.lang.appliedRevision
          )
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
