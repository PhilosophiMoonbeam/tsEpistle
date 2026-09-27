import type { Knex } from 'knex'
import {
  PAGE_INTEGRITY_BATCH_MAX,
  PageIntegrityScanRequestSchema,
  PageIntegrityScanResponseSchema,
  pageEditorIsCompatible,
  type PageIntegrityCheck,
  type PageIntegrityCheckCode,
  type PageIntegrityScanRequest,
  type PageIntegrityScanResponse
} from '../../shared/page-integrity.ts'
import { LocaleCodeSchema } from '../../shared/locale-policy.ts'
import { requireSystemAuthority, type SystemRequester } from '../helpers/system-authority.ts'
import { pageRoute } from '../helpers/page-access.ts'
import { classifyStoragePageDocument } from '../modules/storage/page-document.ts'
import { OKF_MAX_DOCUMENT_BYTES } from '../okf/format.ts'
import errors from './errors.ts'

interface Dependencies {
  db: Knex
  now?(): Date
}
interface PageRow extends Record<string, unknown> {
  id: number
  sourceRevision: string | number
  renderedSourceRevision: string | number | null
  editorKey: string
  contentType: string
  localeCode: string
  path: string
  visibility: string
  ownerId: number | null
  isPublished: boolean | number
  isSearchable: boolean | number
  updatedAt: string | Date
  diagnosticSource: string | null
  sourceByteLength: number | string
  renderLength: number | string | null
}
interface EffectRow extends Record<string, unknown> {
  effectKind: string
  status: string
  postcondition: unknown
  updatedAt?: string | Date
}
interface ProtectedAssetRow extends Record<string, unknown> {
  assetId: number | string | null
}
interface FenceRow extends Record<string, unknown> {
  id: number
  sourceRevision: string | number
  renderedSourceRevision: string | number | null
  editorKey: string
  contentType: string
  localeCode: string
  path: string
  visibility: string
  ownerId: number | null
  isPublished: boolean | number
  isSearchable: boolean | number
  updatedAt: string | Date
}
interface PageFence {
  readonly pageId: number
  readonly key: string
  readonly sourceRevision: string | null
}
interface InspectedPage {
  readonly pageId: number
  readonly checks: PageIntegrityCheck[]
  readonly fence: PageFence
  readonly protectionVersion: string | null
}
interface BatchSnapshot {
  readonly upperWatermark: number
  readonly nextCursor: number | null
  readonly hasMore: boolean
  readonly cancelled: boolean
  readonly pages: InspectedPage[]
  readonly localStorage: PageIntegrityScanResponse['localStorage']
}

const projectionKinds = [
  ['render', 'PROJECTION_RENDER_RECEIPT'],
  ['links', 'PROJECTION_LINKS_RECEIPT'],
  ['search', 'PROJECTION_SEARCH_RECEIPT'],
  ['knowledge', 'PROJECTION_KNOWLEDGE_RECEIPT']
] as const satisfies readonly (readonly [string, PageIntegrityCheckCode])[]
const knownStorageStatuses: Readonly<Record<string, true>> = {
  operational: true,
  warning: true,
  error: true,
  paused: true,
  pending: true
}

const invalidInput = (): never => {
  throw new errors.ApplicationError('The page-integrity scan request is invalid.', { code: 'INVALID_INPUT', status: 400 })
}
const revisionString = (value: unknown): string | null => {
  if (typeof value === 'bigint') return value > 0n ? value.toString() : null
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  return /^[1-9][0-9]{0,39}$/.test(text) ? text : null
}
const rawRevisionKey = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? String(value) : '')
const normalizedBoolean = (value: unknown): boolean | null => {
  if (value === true || value === 1 || value === '1' || value === 't') return true
  if (value === false || value === 0 || value === '0' || value === 'f') return false
  return null
}
const dateKey = (value: unknown): string => {
  if (value instanceof Date) return Number.isFinite(value.valueOf()) ? value.toISOString() : ''
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : String(value)
}
const isoDate = (value: unknown): string | null => {
  const key = dateKey(value)
  if (!key) return null
  const date = new Date(key)
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null
}
const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const storageState = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return objectRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return objectRecord(value)
}
const validPath = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('//') ||
    value.split('/').some(part => part.length === 0 || part === '.' || part === '..')
  ) return false
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}
const validLocale = (value: unknown): value is string => {
  if (typeof value !== 'string' || !LocaleCodeSchema.safeParse(value).success) return false
  try {
    return Intl.getCanonicalLocales(value)[0] === value
  } catch {
    return false
  }
}
const fenceKey = (page: FenceRow): string => JSON.stringify([
  rawRevisionKey(page.sourceRevision),
  rawRevisionKey(page.renderedSourceRevision),
  page.editorKey,
  page.contentType,
  page.localeCode,
  page.path,
  page.visibility,
  page.ownerId,
  normalizedBoolean(page.isPublished),
  normalizedBoolean(page.isSearchable),
  dateKey(page.updatedAt)
])
const postconditionSatisfied = (value: unknown): boolean => {
  let record = objectRecord(value)
  if (typeof value === 'string') {
    try {
      record = objectRecord(JSON.parse(value))
    } catch {
      return false
    }
  }
  return record?.satisfied === true
}
const check = (
  pageId: number,
  sourceRevision: string | null,
  checkCode: PageIntegrityCheckCode,
  outcome: PageIntegrityCheck['outcome'],
  severity: PageIntegrityCheck['severity'],
  remediation: string
): PageIntegrityCheck => ({ pageId, sourceRevision, checkCode, outcome, severity, remediation })
const healthy = (pageId: number, revision: string | null, checkCode: PageIntegrityCheckCode): PageIntegrityCheck =>
  check(pageId, revision, checkCode, 'healthy', 'info', 'No action is required; this invariant is currently satisfied.')
const skipped = (pageId: number, revision: string | null, checkCode: PageIntegrityCheckCode, remediation: string): PageIntegrityCheck =>
  check(pageId, revision, checkCode, 'skipped', 'info', remediation)
const finding = (pageId: number, revision: string | null, checkCode: PageIntegrityCheckCode, remediation: string, severity: 'warning' | 'error' = 'warning'): PageIntegrityCheck =>
  check(pageId, revision, checkCode, 'finding', severity, remediation)
const inspectionError = (pageId: number, revision: string | null): PageIntegrityCheck =>
  check(pageId, revision, 'PAGE_INSPECTION_ERROR', 'error', 'error', 'Retry this bounded scan. If the issue persists, review operator logs without sharing page content or credentials.')
const cancelled = (signal?: AbortSignal): boolean => signal?.aborted === true

const loadLocalStorageObservation = async (tx: Knex.Transaction): Promise<PageIntegrityScanResponse['localStorage']> => {
  const rows = await tx<{ key: 'disk' | 'git'; isEnabled: boolean; state: unknown }>('storage')
    .whereIn('key', ['disk', 'git'])
    .select('key', 'isEnabled', 'state')
    .orderBy('key', 'asc')
  return rows.map(row => {
    const state = storageState(row.state)
    const rawStatus = state?.status
    return {
      key: row.key,
      enabled: normalizedBoolean(row.isEnabled) === true,
      status: typeof rawStatus === 'string' && Object.hasOwn(knownStorageStatuses, rawStatus) ? rawStatus as 'operational' | 'warning' | 'error' | 'paused' | 'pending' : 'unknown',
      lastAttempt: isoDate(state?.lastAttempt),
      hasRecordedOperation: objectRecord(state?.lastOperation) !== null
    }
  })
}

const inspectIdentity = async (tx: Knex.Transaction, page: PageRow, revision: string | null): Promise<PageIntegrityCheck> => {
  const localeCode = page.localeCode
  const path = page.path
  const visibility = page.visibility
  const ownerValid = page.ownerId === null || (Number.isSafeInteger(page.ownerId) && page.ownerId > 0)
  const publicationValid = normalizedBoolean(page.isPublished) !== null && normalizedBoolean(page.isSearchable) !== null
  const routeValid =
    validLocale(localeCode) &&
    validPath(path) &&
    (visibility === 'public' || visibility === 'private') &&
    ownerValid &&
    publicationValid
  if (!routeValid) return finding(page.id, revision, 'PAGE_IDENTITY', 'Review the page locale, path, visibility, ownership and publication fields in the native page administration.', 'error')
  try {
    pageRoute({ localeCode, path, visibility: visibility as 'public' | 'private' })
  } catch {
    return finding(page.id, revision, 'PAGE_IDENTITY', 'Review the page locale and route identity in the native page administration.', 'error')
  }
  const locale = await tx('locales').where({ code: localeCode }).first('code')
  if (!locale) return finding(page.id, revision, 'PAGE_IDENTITY', 'Restore a valid installed locale assignment through the native page administration.', 'error')
  const duplicate = await tx('pages').where({ localeCode, path }).whereNot('id', page.id).first('id')
  if (duplicate) return finding(page.id, revision, 'PAGE_IDENTITY', 'Resolve the duplicate locale-and-path identity using the native page move workflow.', 'error')
  return healthy(page.id, revision, 'PAGE_IDENTITY')
}

const inspectProjectionReceipt = async (
  tx: Knex.Transaction,
  page: PageRow,
  revision: string | null,
  effectKind: string,
  checkCode: PageIntegrityCheckCode
): Promise<PageIntegrityCheck> => {
  if (revision === null)
    return skipped(page.id, revision, checkCode, 'A valid source revision is not available for an exact projection-receipt comparison.')
  const row = await tx<EffectRow>('pageMutationOutbox')
    .where({ pageId: page.id, sourceRevision: revision, effectKind })
    .orderBy('updatedAt', 'desc')
    .first('effectKind', 'status', 'postcondition')
  if (!row) return skipped(page.id, revision, checkCode, 'No exact-revision effect receipt is recorded; inspect the native page-effect workspace before drawing conclusions.')
  if (row.status === 'succeeded' && postconditionSatisfied(row.postcondition)) return healthy(page.id, revision, checkCode)
  return finding(page.id, revision, checkCode, 'Inspect the exact-revision effect receipt and resolve it through its owning native workflow; this scan does not retry or repair effects.')
}

const inspectSearchIndex = async (tx: Knex.Transaction, page: PageRow, revision: string | null): Promise<PageIntegrityCheck> => {
  const [vector, wordRow] = await Promise.all([
    tx<{ sourceRevision: string | number }>('pagesVector').where('pageId', page.id).first('sourceRevision'),
    tx('pagesWords').where({ pageId: page.id }).first('pageId')
  ])
  const eligible = page.visibility === 'public' && normalizedBoolean(page.isPublished) === true && normalizedBoolean(page.isSearchable) === true
  if (eligible) {
    if (revision === null) return skipped(page.id, revision, 'SEARCH_INDEX_STATE', 'A valid source revision is not available for an exact search-index comparison.')
    if (vector && revisionString(vector.sourceRevision) === revision) return healthy(page.id, revision, 'SEARCH_INDEX_STATE')
    return finding(page.id, revision, 'SEARCH_INDEX_STATE', 'Inspect the saved search engine and exact-revision index receipt; use its reviewed maintenance controls only if needed.')
  }
  if (!vector && !wordRow) return healthy(page.id, revision, 'SEARCH_INDEX_STATE')
  return finding(page.id, revision, 'SEARCH_INDEX_STATE', 'Review why an unpublished, private or non-searchable page has derived search rows; do not disclose or repair them from this scan.')
}

const MAX_PROTECTED_ASSET_REFERENCES = 100
const inspectProtectedReferences = async (tx: Knex.Transaction, page: PageRow, revision: string | null): Promise<{ check: PageIntegrityCheck; protectionVersion: string | null }> => {
  const protection = await tx<{ version: number | string }>('pageAccessPasswords').where('pageId', page.id).first('version')
  const references = await tx<ProtectedAssetRow>('pageProtectedAssets').where({ pageId: page.id }).select('assetId').limit(MAX_PROTECTED_ASSET_REFERENCES + 1)
  const protectionVersion = protection ? String(protection.version) : null
  if (!protection && references.length > 0) {
    return {
      check: finding(page.id, revision, 'PROTECTED_ASSET_REFERENCE', 'Review protected-asset ownership against the page protection state through the native page-protection workflow.', 'error'),
      protectionVersion
    }
  }
  const assetIds = [...new Set(references.map(reference => Number(reference.assetId)).filter(id => Number.isSafeInteger(id) && id > 0))]
  if (references.length > MAX_PROTECTED_ASSET_REFERENCES) {
    return {
      check: skipped(page.id, revision, 'PROTECTED_ASSET_REFERENCE', 'The protected-asset reference set exceeds the scan bound; inspect it through the native page-protection workflow.'),
      protectionVersion
    }
  }
  const unresolvedReferences = references.some(reference => reference.assetId === null || reference.assetId === undefined)
  if (assetIds.length === 0) {
    return {
      check: unresolvedReferences
        ? skipped(page.id, revision, 'PROTECTED_ASSET_REFERENCE', 'Some protected asset paths have no recorded asset identity; inspect the protected page and asset workspace without exposing those paths.')
        : healthy(page.id, revision, 'PROTECTED_ASSET_REFERENCE'),
      protectionVersion
    }
  }
  const assets = await tx<{ id: number }>('assets').whereIn('id', assetIds).select('id')
  const found = new Set(assets.map(asset => Number(asset.id)))
  if (assetIds.some(id => !found.has(id))) {
    return {
      check: finding(page.id, revision, 'PROTECTED_ASSET_REFERENCE', 'Review missing protected-asset identities through the native asset and page-protection workflows.', 'error'),
      protectionVersion
    }
  }
  return {
    check: unresolvedReferences
      ? skipped(page.id, revision, 'PROTECTED_ASSET_REFERENCE', 'Some protected asset paths have no recorded asset identity; inspect the protected page and asset workspace without exposing those paths.')
      : healthy(page.id, revision, 'PROTECTED_ASSET_REFERENCE'),
    protectionVersion
  }
}

const inspectPage = async (tx: Knex.Transaction, page: PageRow, signal?: AbortSignal): Promise<InspectedPage> => {
  const revision = revisionString(page.sourceRevision)
  const checks: PageIntegrityCheck[] = []
  if (revision === null) checks.push(finding(page.id, revision, 'SOURCE_REVISION_INVALID', 'Review the page revision through the native page history and mutation workflows.', 'error'))
  else checks.push(healthy(page.id, revision, 'SOURCE_REVISION_INVALID'))

  if (!pageEditorIsCompatible(page.editorKey, page.contentType)) {
    checks.push(finding(page.id, revision, 'SOURCE_EDITOR_COMPATIBILITY', 'Select a native editor that supports this page content type, then save through the revision-checked page workflow.', 'error'))
  } else checks.push(healthy(page.id, revision, 'SOURCE_EDITOR_COMPATIBILITY'))

  if (page.contentType !== 'markdown') {
    checks.push(skipped(page.id, revision, 'MARKDOWN_OKF_VALIDITY', 'OKF validation applies only to Markdown source.'))
  } else if (Number(page.sourceByteLength) > OKF_MAX_DOCUMENT_BYTES || typeof page.diagnosticSource !== 'string') {
    checks.push(skipped(page.id, revision, 'MARKDOWN_OKF_VALIDITY', 'The bounded Markdown source was not available for safe OKF inspection; no source bytes were returned.'))
  } else {
    const document = classifyStoragePageDocument({
      rawDocument: page.diagnosticSource,
      importer: 'page-integrity-diagnostics',
      locale: page.localeCode,
      pagePath: page.path,
      contentType: page.contentType
    })
    checks.push(document.format === 'okf_invalid'
      ? finding(page.id, revision, 'MARKDOWN_OKF_VALIDITY', 'Review the Markdown document with the native page editor and OKF validation workflow; scan output intentionally omits parser detail.', 'error')
      : healthy(page.id, revision, 'MARKDOWN_OKF_VALIDITY'))
  }

  const renderedRevision = revisionString(page.renderedSourceRevision)
  if (revision === null) checks.push(skipped(page.id, revision, 'RENDERED_SOURCE_REVISION', 'A valid source revision is not available for the render comparison.'))
  else if (renderedRevision === revision && Number(page.renderLength) > 0) checks.push(healthy(page.id, revision, 'RENDERED_SOURCE_REVISION'))
  else checks.push(finding(page.id, revision, 'RENDERED_SOURCE_REVISION', 'Inspect the page render revision and its current render receipt in the native rendering workspace.'))

  checks.push(await inspectIdentity(tx, page, revision))
  for (const [effectKind, code] of projectionKinds) {
    if (signal?.aborted) throw new ScanCancelled()
    checks.push(await inspectProjectionReceipt(tx, page, revision, effectKind, code))
  }
  if (signal?.aborted) throw new ScanCancelled()
  checks.push(await inspectSearchIndex(tx, page, revision))
  const protectedState = await inspectProtectedReferences(tx, page, revision)
  checks.push(protectedState.check)
  return {
    pageId: page.id,
    checks,
    fence: { pageId: page.id, key: fenceKey(page), sourceRevision: revision },
    protectionVersion: protectedState.protectionVersion
  }
}

class ScanCancelled extends Error {}

const captureBatch = async (
  deps: Dependencies,
  requester: SystemRequester,
  request: PageIntegrityScanRequest,
  signal?: AbortSignal
): Promise<BatchSnapshot> => deps.db.transaction(async (tx: Knex.Transaction) => {
  await requireSystemAuthority(tx, requester, false, deps.now?.() ?? new Date())
  if (cancelled(signal)) {
    const upperWatermark = request.upperWatermark ?? 0
    return { upperWatermark, nextCursor: request.cursor, hasMore: false, cancelled: true, pages: [], localStorage: [] }
  }
  let upperWatermark = request.upperWatermark
  if (upperWatermark === null) {
    const maximum = await tx<{ upperWatermark: number | string | null }>('pages').max({ upperWatermark: 'id' }).first()
    const parsed = Number(maximum?.upperWatermark ?? 0)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new errors.ApplicationError('Page-integrity scan could not establish a safe upper watermark.', { code: 'SCAN_UNAVAILABLE', status: 503 })
    upperWatermark = parsed
  }
  if (cancelled(signal)) return { upperWatermark, nextCursor: request.cursor, hasMore: false, cancelled: true, pages: [], localStorage: [] }

  const localStorage = await loadLocalStorageObservation(tx)
  if (cancelled(signal)) return { upperWatermark, nextCursor: request.cursor, hasMore: false, cancelled: true, pages: [], localStorage }
  const cursor = request.cursor ?? 0
  const rows = await tx<PageRow, PageRow[]>('pages')
    .select(
      'id', 'sourceRevision', 'renderedSourceRevision', 'editorKey', 'contentType', 'localeCode', 'path', 'visibility',
      'ownerId', 'isPublished', 'isSearchable', 'updatedAt',
      tx.raw('CASE WHEN octet_length(??) <= ? THEN ?? ELSE NULL END AS ??', ['content', OKF_MAX_DOCUMENT_BYTES, 'content', 'diagnosticSource']),
      tx.raw('octet_length(??) AS ??', ['content', 'sourceByteLength']),
      tx.raw('char_length(??) AS ??', ['render', 'renderLength'])
    )
    .where('id', '>', cursor)
    .andWhere('id', '<=', upperWatermark)
    .orderBy('id', 'asc')
    .limit(Math.min(PAGE_INTEGRITY_BATCH_MAX, request.limit) + 1)
  const hasMore = rows.length > request.limit
  // Knex cannot infer the diagnosticSource/sourceByteLength/renderLength aliases from raw SQL projections.
  const candidates = rows.slice(0, request.limit) as unknown as PageRow[]
  const pages: InspectedPage[] = []
  for (const page of candidates) {
    if (cancelled(signal)) break
    try {
      pages.push(await inspectPage(tx, page, signal))
    } catch (error: unknown) {
      if (error instanceof ScanCancelled || cancelled(signal)) break
      pages.push({
        pageId: page.id,
        checks: [inspectionError(page.id, revisionString(page.sourceRevision))],
        fence: { pageId: page.id, key: fenceKey(page), sourceRevision: revisionString(page.sourceRevision) },
        protectionVersion: null
      })
    }
  }
  const stopped = cancelled(signal)
  return {
    upperWatermark,
    nextCursor: stopped ? (pages.at(-1)?.pageId ?? request.cursor) : hasMore ? (pages.at(-1)?.pageId ?? cursor) : null,
    hasMore,
    cancelled: stopped,
    pages,
    localStorage
  }
}, { isolationLevel: 'repeatable read', readOnly: true })

const fenceCurrentPages = async (deps: Dependencies, pages: readonly InspectedPage[], signal?: AbortSignal): Promise<Set<number>> => {
  if (pages.length === 0) return new Set()
  return deps.db.transaction(async (tx: Knex.Transaction) => {
    if (cancelled(signal)) throw new ScanCancelled()
    const ids = pages.map(page => page.pageId)
    const [currentRows, protections] = await Promise.all([
      tx<FenceRow>('pages').whereIn('id', ids).select(
        'id', 'sourceRevision', 'renderedSourceRevision', 'editorKey', 'contentType', 'localeCode', 'path', 'visibility',
        'ownerId', 'isPublished', 'isSearchable', 'updatedAt'
      ),
      tx<{ pageId: number; version: number | string }>('pageAccessPasswords').whereIn('pageId', ids).select('pageId', 'version')
    ])
    if (cancelled(signal)) throw new ScanCancelled()
    const current = new Map<number, FenceRow>(currentRows.map(row => [row.id, row] as const))
    const protectionVersions = new Map<number, string>(protections.map(row => [row.pageId, String(row.version)] as const))
    return new Set<number>(pages.filter(page => {
      const row = current.get(page.pageId)
      if (!row || fenceKey(row) !== page.fence.key) return true
      return (protectionVersions.get(page.pageId) ?? null) !== page.protectionVersion
    }).map(page => page.pageId))
  }, { isolationLevel: 'read committed', readOnly: true })
}

export interface PageIntegrityOperations {
  scan(requester: SystemRequester, rawRequest: unknown, signal?: AbortSignal): Promise<PageIntegrityScanResponse>
}

export const createPageIntegrityOperations = (deps: Dependencies): PageIntegrityOperations => ({
  async scan(requester: SystemRequester, rawRequest: unknown, signal?: AbortSignal): Promise<PageIntegrityScanResponse> {
    const parsed = PageIntegrityScanRequestSchema.safeParse(rawRequest)
    if (!parsed.success) return invalidInput()
    const snapshot = await captureBatch(deps, requester, parsed.data, signal)
    let changedPages = new Set<number>()
    let fenceFailed = false
    if (!snapshot.cancelled) {
      try {
        changedPages = await fenceCurrentPages(deps, snapshot.pages.filter(page => page.checks[0]?.checkCode !== 'PAGE_INSPECTION_ERROR'), signal)
      } catch (error: unknown) {
        if (error instanceof ScanCancelled || cancelled(signal)) {
          return PageIntegrityScanResponseSchema.parse({
            upperWatermark: snapshot.upperWatermark,
            nextCursor: snapshot.nextCursor,
            state: 'cancelled',
            pagesScanned: snapshot.pages.length,
            checks: snapshot.pages.flatMap(page => page.checks),
            localStorage: snapshot.localStorage
          })
        }
        fenceFailed = true
      }
    }
    const checks = snapshot.pages.flatMap(page => {
      if (fenceFailed && page.checks[0]?.checkCode !== 'PAGE_INSPECTION_ERROR') return [inspectionError(page.pageId, page.fence.sourceRevision)]
      if (!changedPages.has(page.pageId)) return page.checks
      return page.checks.map(item => ({
        ...item,
        outcome: 'changed' as const,
        severity: 'warning' as const,
        remediation: 'This page changed while inspected. Run a fresh scan before interpreting the earlier observation.'
      }))
    })
    const result: PageIntegrityScanResponse = {
      upperWatermark: snapshot.upperWatermark,
      nextCursor: snapshot.nextCursor,
      state: snapshot.cancelled ? 'cancelled' : snapshot.hasMore ? 'running' : 'complete',
      pagesScanned: snapshot.pages.length,
      checks,
      localStorage: snapshot.localStorage
    }
    return PageIntegrityScanResponseSchema.parse(result)
  }
})
