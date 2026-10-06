import { createHmac, timingSafeEqual } from 'node:crypto'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  PAGE_LINKS_CURSOR_MAX_LENGTH,
  PAGE_LINKS_PAGE_SIZE,
  PAGE_LINKS_SCHEMA_VERSION,
  PageLinksDirectionSchema,
  PageLinksReadyResponseSchema,
  PageLinksRefreshResponseSchema,
  PageLinksRequestSchema,
  type PageLinkItem,
  type PageLinksDirection,
  type PageLinksResponse
} from '../../shared/page-links.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { canReadPage, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import errors from './errors.ts'

const { ApplicationError } = errors

const CURSOR_TTL_MS = 15 * 60_000
const CURSOR_FUTURE_SKEW_MS = 60_000
const CANDIDATE_BATCH_SIZE = 100
const MAX_CANDIDATE_SCAN = 10_000

interface PageLinkRuntime {
  readonly models: { readonly knex: Knex }
  readonly config: { readonly sessionSecret: string }
  readonly auth: {
    loadPageRuleAuthority(requester: PagePrincipal, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
}

interface LinkPage extends PageVisibilityRecord {
  readonly id: number
  readonly title: string
  readonly sourceRevision: unknown
  readonly isPublished: boolean
  readonly isSearchable: boolean
  readonly publishStartDate: unknown
  readonly publishEndDate: unknown
  readonly tags: unknown[]
}
type LinkPageWithLocale = LinkPage & { readonly localeCode: string }

interface RawPageRow {
  readonly id: number | string
  readonly path: unknown
  readonly localeCode: unknown
  readonly title: unknown
  readonly visibility: unknown
  readonly ownerId: number | string | null
  readonly sourceRevision: unknown
  readonly isPublished: unknown
  readonly isSearchable: unknown
  readonly publishStartDate: unknown
  readonly publishEndDate: unknown
  readonly tag: unknown
}

interface LinkCursor {
  readonly version: 1
  readonly pageId: number
  readonly direction: PageLinksDirection
  readonly sourceRevision: string
  readonly afterId: number
  readonly issuedAt: number
}

const LinkCursorSchema = z.strictObject({
  version: z.literal(1),
  pageId: z.number().int().positive().safe(),
  direction: PageLinksDirectionSchema,
  sourceRevision: z.string().regex(/^[1-9][0-9]*$/),
  afterId: z.number().int().positive().safe(),
  issuedAt: z.number().int().nonnegative().safe()
})

const PageLinksOperationInputSchema = PageLinksRequestSchema.extend({
  requester: z.unknown().optional()
})
const getWiki = (): PageLinkRuntime => WIKI as unknown as PageLinkRuntime

const invalidInput = (message: string): never => {
  throw new ApplicationError(message, { code: 'INVALID_INPUT', status: 400 })
}

const sourceRevision = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value
  return undefined
}

const positiveId = (value: unknown): number | undefined => {
  const id = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

const dbBoolean = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'true'

const pageWithTags = async (db: Knex | Knex.Transaction, pageIds: readonly number[]): Promise<Map<number, LinkPage>> => {
  if (pageIds.length === 0) return new Map()
  const rows = (await db('pages as page')
    .leftJoin('pageTags as assignment', 'assignment.pageId', 'page.id')
    .leftJoin('tags as assignedTag', 'assignedTag.id', 'assignment.tagId')
    .whereIn('page.id', [...new Set(pageIds)])
    .select({
      id: 'page.id',
      path: 'page.path',
      localeCode: 'page.localeCode',
      title: 'page.title',
      visibility: 'page.visibility',
      ownerId: 'page.ownerId',
      sourceRevision: 'page.sourceRevision',
      isPublished: 'page.isPublished',
      isSearchable: 'page.isSearchable',
      publishStartDate: 'page.publishStartDate',
      publishEndDate: 'page.publishEndDate',
      tag: 'assignedTag.tag'
    })) as RawPageRow[]
  const pages = new Map<number, LinkPage>()
  for (const row of rows) {
    const id = positiveId(row.id)
    if (id === undefined) continue
    let page = pages.get(id)
    if (page === undefined) {
      const ownerId = row.ownerId === null ? null : (positiveId(row.ownerId) ?? Number.NaN)
      page = {
        id,
        path: row.path as string,
        localeCode: row.localeCode as string,
        title: row.title as string,
        visibility: row.visibility as PageVisibilityRecord['visibility'],
        ownerId,
        sourceRevision: row.sourceRevision,
        isPublished: dbBoolean(row.isPublished),
        isSearchable: dbBoolean(row.isSearchable),
        publishStartDate: row.publishStartDate,
        publishEndDate: row.publishEndDate,
        tags: []
      }
      pages.set(id, page)
    }
    if (row.tag !== null && row.tag !== undefined) page.tags.push(row.tag)
  }
  return pages
}

const currentPublicGraphPage = (page: LinkPage | undefined, now: number): page is LinkPageWithLocale =>
  page !== undefined &&
  page.visibility === 'public' &&
  typeof page.path === 'string' &&
  page.path.length > 0 &&
  typeof page.localeCode === 'string' &&
  page.localeCode.length > 0 &&
  typeof page.title === 'string' &&
  dbBoolean(page.isPublished) &&
  dbBoolean(page.isSearchable) &&
  publicationWindowOpen(page, now)

const hasCurrentLinkReceipt = async (db: Knex | Knex.Transaction, pageId: number, revision: string): Promise<boolean> => {
  const receipt = await db('pageMutationOutbox')
    .where({ pageId, sourceRevision: revision, effectKind: 'links', desiredState: 'present', status: 'succeeded' })
    .first('id')
  return receipt !== undefined
}

const receiptKeys = async (db: Knex | Knex.Transaction, pages: readonly LinkPage[]): Promise<Set<string>> => {
  if (pages.length === 0) return new Set()
  const query = db('pageMutationOutbox')
    .select('pageId', 'sourceRevision')
    .where({ effectKind: 'links', desiredState: 'present', status: 'succeeded' })
    .andWhere(function () {
      for (const page of pages) {
        const revision = sourceRevision(page.sourceRevision)
        if (revision !== undefined) this.orWhere({ pageId: page.id, sourceRevision: revision })
      }
    })
  const rows = (await query) as Array<{ pageId: number | string; sourceRevision: number | string }>
  return new Set(
    rows.flatMap(row => {
      const pageId = positiveId(row.pageId)
      const revision = sourceRevision(row.sourceRevision)
      return pageId !== undefined && revision !== undefined ? [`${pageId}:${revision}`] : []
    })
  )
}

const candidateIds = async (db: Knex | Knex.Transaction, page: LinkPage, direction: PageLinksDirection, afterId: number, limit: number): Promise<number[]> => {
  const query =
    direction === 'outgoing'
      ? db('pageLinks as links')
          .join('pages as endpoint', function () {
            this.on('endpoint.localeCode', '=', 'links.localeCode').andOn('endpoint.path', '=', 'links.path')
          })
          .where('links.pageId', page.id)
      : db('pageLinks as links')
          .join('pages as endpoint', 'endpoint.id', 'links.pageId')
          .where({ 'links.localeCode': page.localeCode, 'links.path': page.path })
  const rows = (await query
    .where('endpoint.id', '>', afterId)
    .andWhere({ 'endpoint.visibility': 'public', 'endpoint.isPublished': true, 'endpoint.isSearchable': true })
    .whereNotExists(function () {
      this.select('*').from('pageAccessPasswords as protection').whereRaw('?? = ??', ['protection.pageId', 'endpoint.id'])
    })
    .select({ endpointId: 'endpoint.id' })
    .distinct()
    .orderBy('endpoint.id', 'asc')
    .limit(limit)) as Array<{ endpointId: number | string }>
  return rows.flatMap(row => {
    const id = positiveId(row.endpointId)
    return id === undefined ? [] : [id]
  })
}

const cursorSignature = (secret: string, payload: string): Buffer => createHmac('sha256', secret).update(`page-links-cursor:v1.${payload}`).digest()

const issueCursor = (cursor: LinkCursor, secret: string): string => {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  const signature = cursorSignature(secret, payload).toString('base64url')
  const token = `${payload}.${signature}`
  if (token.length > PAGE_LINKS_CURSOR_MAX_LENGTH) throw new Error('Page links cursor exceeds its size limit')
  return token
}

const invalidCursor = (): never => invalidInput('Page links cursor is invalid.')

const readCursor = (
  value: string,
  context: { readonly pageId: number; readonly direction: PageLinksDirection },
  secret: string,
  now: number
): { readonly state: 'valid'; readonly cursor: LinkCursor } | { readonly state: 'expired'; readonly cursor: LinkCursor } => {
  if (value.length > PAGE_LINKS_CURSOR_MAX_LENGTH) return invalidCursor()
  const parts = value.split('.')
  const encodedPayload = parts[0]
  const encodedSignature = parts[1]
  if (
    parts.length !== 2 ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
    !/^[A-Za-z0-9_-]+$/.test(encodedSignature)
  ) {
    return invalidCursor()
  }
  const actualSignature = Buffer.from(encodedSignature, 'base64url')
  const expectedSignature = cursorSignature(secret, encodedPayload)
  if (
    actualSignature.toString('base64url') !== encodedSignature ||
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return invalidCursor()
  }
  const encodedBytes = Buffer.from(encodedPayload, 'base64url')
  if (encodedBytes.toString('base64url') !== encodedPayload) return invalidCursor()
  let decoded: unknown
  try {
    decoded = JSON.parse(encodedBytes.toString('utf8'))
  } catch {
    return invalidCursor()
  }
  const parsed = LinkCursorSchema.safeParse(decoded)
  if (!parsed.success || JSON.stringify(parsed.data) !== encodedBytes.toString('utf8')) return invalidCursor()
  const cursor = parsed.data
  if (cursor.pageId !== context.pageId || cursor.direction !== context.direction) return invalidCursor()
  if (cursor.issuedAt > now + CURSOR_FUTURE_SKEW_MS) return invalidCursor()
  return now - cursor.issuedAt > CURSOR_TTL_MS ? { state: 'expired', cursor } : { state: 'valid', cursor }
}

const refreshResponse = (pageId: number, direction: PageLinksDirection, revision: string): PageLinksResponse =>
  PageLinksRefreshResponseSchema.parse({
    schemaVersion: PAGE_LINKS_SCHEMA_VERSION,
    state: 'refresh',
    pageId,
    direction,
    sourceRevision: revision
  })

const notFound = (): never => {
  throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
}

const linkItem = (page: LinkPageWithLocale): PageLinkItem => ({
  id: page.id,
  locale: page.localeCode,
  path: page.path,
  title: page.title
})

export const getPageLinks = async (input: unknown): Promise<PageLinksResponse> => {
  const parsedInput = PageLinksOperationInputSchema.safeParse(input)
  if (!parsedInput.success) return invalidInput('Page links request is invalid.')
  const data = parsedInput.data
  if (data === undefined) return invalidInput('Page links request is invalid.')
  const { pageId, direction, cursor: cursorValue, requester: rawRequester } = data
  const requester = rawRequester as PagePrincipal
  const wiki = getWiki()
  const transaction = await wiki.models.knex.transaction(undefined, { isolationLevel: 'repeatable read', readOnly: true })
  try {
    const authority = await wiki.auth.loadPageRuleAuthority(requester, transaction)
    const now = Date.now()
    const page = (await pageWithTags(transaction, [pageId])).get(pageId)
    if (page === undefined) return notFound()
    if (!canReadPage(requester, page, authority)) return notFound()
    const protectedPage = await transaction('pageAccessPasswords').where({ pageId }).first('pageId')
    if (!currentPublicGraphPage(page, now) || protectedPage !== undefined) return notFound()
    const revision = sourceRevision(page.sourceRevision)
    if (revision === undefined) {
      throw new ApplicationError('Page links are unavailable because the current page revision is invalid.', {
        code: 'PAGE_LINKS_SOURCE_INVALID',
        status: 503
      })
    }

    const secret = wiki.config.sessionSecret
    if (typeof secret !== 'string' || secret.length === 0) throw new Error('Page links cursor signing is unavailable')
    let afterId = 0
    if (cursorValue !== undefined) {
      const cursor = readCursor(cursorValue, { pageId, direction }, secret, now)
      if (cursor.state === 'expired' || cursor.cursor.sourceRevision !== revision) {
        const response = refreshResponse(pageId, direction, revision)
        await transaction.commit()
        return response
      }
      afterId = cursor.cursor.afterId
    }

    if (direction === 'outgoing' && !(await hasCurrentLinkReceipt(transaction, pageId, revision))) {
      const response = refreshResponse(pageId, direction, revision)
      await transaction.commit()
      return response
    }

    const items: PageLinkItem[] = []
    let lastScannedId = afterId
    let scanned = 0
    while (scanned < MAX_CANDIDATE_SCAN) {
      const batchLimit = Math.min(CANDIDATE_BATCH_SIZE, MAX_CANDIDATE_SCAN - scanned)
      const ids = await candidateIds(transaction, page, direction, lastScannedId, batchLimit)
      if (ids.length === 0) {
        const result = PageLinksReadyResponseSchema.parse({
          schemaVersion: PAGE_LINKS_SCHEMA_VERSION,
          state: 'ready',
          pageId,
          direction,
          sourceRevision: revision,
          items,
          hasMore: false,
          nextCursor: null
        })
        await transaction.commit()
        return result
      }
      const candidates = await pageWithTags(transaction, ids)
      const pages = ids.flatMap(id => {
        const candidate = candidates.get(id)
        return currentPublicGraphPage(candidate, now) ? [candidate] : []
      })
      const received = direction === 'incoming' ? await receiptKeys(transaction, pages) : new Set<string>()

      for (const id of ids) {
        lastScannedId = id
        scanned += 1
        const candidate = candidates.get(id)
        if (!currentPublicGraphPage(candidate, now) || !canReadPage(requester, candidate, authority)) continue
        if (direction === 'incoming') {
          const candidateRevision = sourceRevision(candidate.sourceRevision)
          if (candidateRevision === undefined || !received.has(`${candidate.id}:${candidateRevision}`)) {
            const response = refreshResponse(pageId, direction, revision)
            await transaction.commit()
            return response
          }
        }
        if (items.length === PAGE_LINKS_PAGE_SIZE) {
          const lastItem = items[items.length - 1]
          if (!lastItem) throw new Error('Page links lookahead invariant failed')
          const nextCursor = issueCursor(
            {
              version: 1,
              pageId,
              direction,
              sourceRevision: revision,
              afterId: lastItem.id,
              issuedAt: now
            },
            secret
          )
          const result = PageLinksReadyResponseSchema.parse({
            schemaVersion: PAGE_LINKS_SCHEMA_VERSION,
            state: 'ready',
            pageId,
            direction,
            sourceRevision: revision,
            items,
            hasMore: true,
            nextCursor
          })
          await transaction.commit()
          return result
        }
        items.push(linkItem(candidate))
      }

      if (ids.length < batchLimit) {
        const result = PageLinksReadyResponseSchema.parse({
          schemaVersion: PAGE_LINKS_SCHEMA_VERSION,
          state: 'ready',
          pageId,
          direction,
          sourceRevision: revision,
          items,
          hasMore: false,
          nextCursor: null
        })
        await transaction.commit()
        return result
      }
    }

    const hasUnscannedCandidate = (await candidateIds(transaction, page, direction, lastScannedId, 1)).length > 0
    if (hasUnscannedCandidate) {
      throw new ApplicationError('Page links are temporarily unavailable.', {
        code: 'PAGE_LINKS_SCAN_LIMIT',
        status: 503
      })
    }
    const result = PageLinksReadyResponseSchema.parse({
      schemaVersion: PAGE_LINKS_SCHEMA_VERSION,
      state: 'ready',
      pageId,
      direction,
      sourceRevision: revision,
      items,
      hasMore: false,
      nextCursor: null
    })
    await transaction.commit()
    return result
  } catch (error) {
    await transaction.rollback()
    throw error
  }
}
