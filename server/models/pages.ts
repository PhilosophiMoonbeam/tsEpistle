import { createHash } from 'node:crypto'
import { CollaborationRoomStore } from '../core/collaboration-store.ts'
import { verifyPageMoveReviewToken } from '../helpers/page-move-review-token.ts'
import { rewriteMovedPageLinks, type PageMoveLinkRewriteResult } from '../helpers/page-move-link-rewrite.ts'
import { z } from 'zod'
import { Model, type StaticHookArguments } from 'objection'
import type { Knex } from 'knex'
import type { EventEmitter } from 'node:events'
import _ from 'lodash'
import { Type as JSBinType } from 'js-binary'
import pageHelper from '../helpers/page.ts'
import { tagNames } from '../helpers/taxonomy-plan.ts'
import {
  canDeletePage,
  canReadPage,
  canWritePage,
  managesSystem,
  pageAuthorizationContext,
  principalId,
  type PageAuthorizationContext,
  type PageVisibility
} from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { localeRelationMovePatch } from '../helpers/page-locale-relations.ts'
import path from 'node:path'
import fs from 'fs-extra'
import * as yaml from 'js-yaml'
import striptags from 'striptags'
import emojiRegex from 'emoji-regex'
import he from 'he'
import CleanCSS from 'clean-css'
import TurndownService from 'turndown'
import { gfm as turndownPluginGfm } from '@joplin/turndown-plugin-gfm'
import * as cheerio from 'cheerio'
import Tag from './tags.ts'
import PageLink from './pageLinks.ts'
import User from './users.ts'
import Editor from './editors.ts'
import Locale from './locales.ts'
import type Comment from './comments.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import errors from '../operations/errors.ts'
import { enqueuePageMutationEffects, type PageProjectionPayload } from '../core/page-mutation-outbox.ts'
import { redactProtectedPageForSearch, syncProtectedPageAssets } from '../operations/page-protection.ts'
import { mutateOkfMetadata, OkfDocumentError, type OkfMetadata } from '../okf/format.ts'
import { PageBrandingAssignmentSchema, type PageBrandingAssignment } from '../../shared/page-branding.ts'
import { DEFAULT_PAGE_FEATURES, PageFeaturesSchema, normalizePageFeatures, parsePageFeatures, type PageFeatures } from '../../shared/page-features.ts'
import { authorizePageBrandingAssignment } from '../helpers/asset-branding.ts'
import { rejectApiPrincipalMutation } from '../helpers/api-principal.ts'
import { pageRequiresUnlock } from '../operations/page-protection.ts'
import { assertAssetLocationReservations, lockAssetLocation } from '../helpers/asset-location-lock.ts'
import { okfFilePath } from '../okf/format.ts'

type UnknownRecord = Record<string, unknown>
const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === 'object' && !Array.isArray(value)
export const DeletedPageRecoverySecurityContextSchema = z.strictObject({
  version: z.literal(1),
  former: z.strictObject({
    path: z.string().min(1),
    localeCode: z.string().min(2),
    visibility: z.enum(['public', 'private']),
    ownerId: z.number().int().positive().safe().nullable(),
    tags: z.array(z.string().min(1))
  }),
  protection: z.strictObject({
    passwordHash: z.string().min(1).max(4096),
    version: z.number().int().positive().safe(),
    updatedBy: z.number().int().positive().safe().nullable(),
    updatedAt: z.string().datetime({ offset: true })
  }).nullable()
})
export type DeletedPageRecoverySecurityContext = z.infer<typeof DeletedPageRecoverySecurityContextSchema>
type PageErrorConstructor = new () => Error

interface PageUser extends Express.User {
  id: number
  name: string
  email: string
}

interface PageExtra extends UnknownRecord {
  css?: string
  js?: string
  okf?: OkfMetadata
  branding?: PageBrandingAssignment
  pageFeatures?: PageFeatures
}

interface CachedPage {
  id: number
  sourceRevision: string
  authorId: number
  authorName: string
  createdAt: string
  creatorId: number
  creatorName: string
  description: string
  editorKey: string
  visibility: PageVisibility
  ownerId: number
  isPublished: boolean
  isSearchable: boolean
  publishEndDate: string
  publishStartDate: string
  contentType: string
  render: string
  tags: Array<{
    tag: string
    title: string
  }>
  extra: {
    js: string
    css: string
  }
  title: string
  toc: string
  updatedAt: string
}

interface CachedPageResult extends Omit<CachedPage, 'ownerId'> {
  path: string
  localeCode: string
  ownerId: number | null
  extra: CachedPage['extra'] & {
    branding?: PageBrandingAssignment
  }
}

interface PageCacheIdentityMarker {
  id: number
  hash: string
  sourceRevision: string | number
  path: string
  localeCode: string
  visibility: PageVisibility
  ownerId: number | null
  isSearchable: boolean
  extra?: unknown
}

interface PageLookup {
  path: string
  locale: string
  visibility: PageVisibility
  ownerId: number | null
}

interface CreatePageOptions {
  path: string
  locale: string
  user: PageUser
  content: string
  editor: string
  description: string
  visibility: PageVisibility
  isPublished: boolean | number
  isSearchable?: boolean | number
  title: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  scriptCss?: string
  scriptJs?: string
  tags?: unknown
  pageFeatures?: PageFeatures
  okfMetadata?: OkfMetadata
  okfProducer?: string
  branding?: PageBrandingAssignment | null
  brandingContext?: {
    requester?: Express.User
    sessionId: string
  }
  skipStorage?: boolean
}

interface UpdatePageOptions {
  id: number
  user: PageUser
  content?: string
  description?: string
  isPublished?: boolean | number
  isSearchable?: boolean | number
  title?: string
  tags?: string[]
  expectedUpdatedAt?: string
  expectedSourceRevision?: string
  expectedCollaborationGeneration?: number
  editor?: string
  contentType?: string
  action?: string
  locale?: string
  path?: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  scriptCss?: string
  scriptJs?: string
  pageFeatures?: PageFeatures
  okfMetadata?: OkfMetadata
  replaceOkfMetadata?: boolean
  okfProducer?: string
  okfRestoreRevision?: string | number
  branding?: PageBrandingAssignment | null
  brandingContext?: {
    requester?: Express.User
    sessionId: string
  }
  skipStorage?: boolean
}

interface ChangeVisibilityOptions {
  id: number
  visibility: PageVisibility
  user: PageUser
  confirmPublication?: boolean
  skipStorage?: boolean
  expectedSourceRevision?: string
}

interface TransferOwnershipOptions {
  id: number
  ownerId: number
  user: PageUser
  expectedSourceRevision?: string
}

interface ConvertPageOptions {
  id: number
  editor: string
  okfProducer?: string
  user: PageUser
  expectedSourceRevision?: string
}

type MovePageOptions = (
  | {
      id: number
      path?: string
      locale?: string
    }
  | {
      id?: undefined
      path: string
      locale: string
    }
) & {
  destinationPath: string
  destinationLocale: string
  user: PageUser
  skipStorage?: boolean
  expectedSourceRevision?: string
  okfProducer?: string
  reviewToken?: string
  updateLinks?: boolean
  sessionId?: string
}

interface PageMoveReceipt {
  message: 'Page has been moved.'
  pageId: number
  sourceRevision: string
  updated: Array<{ id: number; sourceRevision: string }>
  projections: 'pending'
}

type DeletePageOptions = (
  | {
      id: number
      path?: string
      locale?: string
    }
  | {
      id?: undefined
      path: string
      locale: string
    }
) & {
  user?: PageUser
  skipStorage?: boolean
  expectedSourceRevision?: string
}
interface RestoreDeletedPageOptions {
  pageId: number
  deletionVersionId: number
  destination: { path: string; localeCode: string }
  ownerId?: number
  recoveringAdminId: number
  securityContext: DeletedPageRecoverySecurityContext | null
  legacyQuarantine: boolean
  expectedDeletionRevision: string
  user: PageUser
}
interface DeletedPageHistoryRow {
  id: number
  pageId: number
  authorId: number
  content: string
  contentType: string
  description: string
  editorKey: string
  hash: string
  visibility: PageVisibility
  ownerId: number | null
  isPublished: boolean | number
  isSearchable: boolean | number
  localeCode: string
  path: string
  publishEndDate: string | null
  publishStartDate: string | null
  title: string
  extra: unknown
  sourceRevision: string | number
  versionDate: string | Date
}

interface DeletedPageRecoveryRow {
  deletionRevision: string | number
  securityContext: unknown
}

type ReconnectLinksOptions = {
  path: string
  locale: string
  mode: 'create' | 'delete'
}
interface PageVersionOptions {
  id: number
  authorId: number
  content: string
  contentType: string
  description: string
  editorKey: string
  hash: string
  extra: PageExtra
  visibility: PageVisibility
  ownerId: number | null
  isPublished: boolean | number
  localeCode: string
  path: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  title: string
  action?: string
  versionDate: string
  isSearchable?: boolean | number
  sourceRevision?: string | number | bigint
  transaction?: Knex.Transaction
}

interface PageRenameDetails {
  id: number
  hash: string
  path: string
  localeCode: string
  title: string
  description: string
  contentType: string
  visibility: PageVisibility
  isPublished: boolean | number
  safeContent: string
  destinationPath: string
  destinationLocaleCode: string
  destinationHash: string
}

interface StorageRenameDetails extends PageRenameDetails {
  authorName: string
  authorEmail: string
  updatedAt: string
  tags: Tag[]
  moveAuthorId: number
  moveAuthorName: string
  moveAuthorEmail: string
}

type StoragePageEvent = { event: 'created' | 'updated' | 'deleted'; page: Page } | { event: 'renamed'; page: StorageRenameDetails }

interface EditorDefinition {
  key: string
  contentType: string
}

interface SchedulerJob {
  finished: Promise<unknown>
}

interface SchedulerJobDefinition {
  name: string
  immediate: boolean
  worker: boolean
}

interface PagesWikiContext {
  ROOTPATH: string
  Error: {
    PageDeleteForbidden: PageErrorConstructor
    PageDuplicateCreate: PageErrorConstructor
    PageEmptyContent: PageErrorConstructor
    PageIllegalPath: PageErrorConstructor
    PageMoveForbidden: PageErrorConstructor
    PageNotFound: PageErrorConstructor
    PagePathCollision: PageErrorConstructor
    PageUpdateForbidden: PageErrorConstructor
  }
  collaboration?: { pageChanged(pageId: number, forceConflict?: boolean): Promise<void> }
  auth: {
    checkPageAccess(user: PageUser | undefined, permissions: readonly string[], context: PageAuthorizationContext, authority: PageRuleAuthority): boolean
    loadPageRuleAuthority(requester: PageUser | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  config: {
    dataPath: string
    sessionSecret: string
    lang: { code: string; namespacing?: boolean }
    db: {
      type: string
    }
  }
  data: {
    editors: EditorDefinition[]
  }
  events: {
    inbound: EventEmitter
    outbound: EventEmitter
  }
  logger: {
    error(message: unknown): void
    warn(message: unknown): void
  }
  models: {
    comments: typeof Comment
    knex: Knex
    pageHistory: {
      addVersion(options: PageVersionOptions): Promise<{ id: number }>
    }
    pages: typeof Page
    renderers?: { getRenderingPipeline(contentType: string): Promise<Array<{ key: string; config: unknown }>> }
    storage: {
      pageEvent(event: StoragePageEvent): Promise<unknown>
    }
    tags: typeof Tag
  }
  scheduler: {
    registerJob(definition: SchedulerJobDefinition, pageId?: number): Promise<SchedulerJob>
  }
}

const wiki = WIKI as unknown as PagesWikiContext
const notifyCollaboration = async (pageId: number, forceConflict = false): Promise<void> => {
  try {
    await wiki.collaboration?.pageChanged(pageId, forceConflict)
  } catch (error) {
    wiki.logger.warn(error)
  }
}
const deliverAfterPageCommit = async (label: string, action: () => Promise<unknown>): Promise<void> => {
  try {
    await action()
  } catch (error) {
    wiki.logger.warn(`Canonical page change committed; ${label} remains pending: ${String(error)}`)
  }
}

/**
 * Queue a fresh pipeline render after an invalidating page write commits.
 * The invalidating write clears renderedSourceRevision; only the render job's
 * source-revision CAS may certify the replacement bytes.
 */
const schedulePageRerenders = (pageIds: readonly number[]): void => {
  for (const pageId of new Set(pageIds)) {
    try {
      void Promise.resolve(wiki.models.pages.renderPage({ id: pageId } as Page)).catch(error => wiki.logger.warn(error))
    } catch (error) {
      wiki.logger.warn(error)
    }
  }
}

const pageUpdateConflict = (): Error & { status: number } =>
  Object.assign(new Error('The page changed after history was opened. Reload history before restoring.'), {
    name: 'PageUpdateConflict',
    status: 409
  })
const collaborationDraftDiscardedConflict = (): Error & { status: number } =>
  Object.assign(new Error('This collaboration draft was discarded. Reload the page before saving.'), {
    name: 'CollaborationDraftDiscarded',
    status: 409
  })
const invalidateOkfVerification = (metadata: OkfMetadata): OkfMetadata => {
  const unverified = { ...metadata }
  delete unverified.verified
  return unverified
}
const pageFeaturesFromOkfMetadata = (metadata: OkfMetadata | undefined): PageFeatures | undefined => {
  const extension = metadata?.['x-wiki']
  if (!isRecord(extension) || !Object.hasOwn(extension, 'page_features')) return undefined
  const pageFeatures = parsePageFeatures(extension.page_features)
  if (pageFeatures === null) throw new TypeError('OKF extension x-wiki.page_features must use the strict version 1 page feature schema')
  return pageFeatures
}
const pageRecoveryConflict = (): Error =>
  new errors.ApplicationError('The deleted page changed or is no longer recoverable. Reload the recovery record.', {
    status: 409,
    code: 'PAGE_RECOVERY_CONFLICT'
  })

const pageRecoveryCollision = (): Error =>
  new errors.ApplicationError('The restore destination is already occupied.', { status: 409, code: 'PAGE_RECOVERY_COLLISION' })

const pageRecoveryRevision = (value: unknown): bigint | null => {
  const revision = String(value)
  if (!/^[1-9][0-9]*$/.test(revision)) return null
  try {
    return BigInt(revision)
  } catch {
    return null
  }
}

const parseStoredJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const assertNoStorageAssetCollision = async (transaction: Knex.Transaction, storagePath: string): Promise<void> => {
  try {
    await lockAssetLocation(transaction, storagePath)
    await assertAssetLocationReservations(transaction, [storagePath])
  } catch (error: unknown) {
    if (isRecord(error) && Reflect.get(error, 'status') === 409) throw pageRecoveryCollision()
    throw error
  }

  const pathParts = storagePath.split('/')
  const filename = pathParts.pop()
  if (!filename) throw pageRecoveryCollision()
  let parentId: number | null = null
  for (const slug of pathParts) {
    const folderQuery = transaction('assetFolders').where({ slug })
    if (parentId === null) folderQuery.whereNull('parentId')
    else folderQuery.where({ parentId })
    const folder = (await folderQuery.first('id')) as { id: number } | undefined
    if (!folder) return
    parentId = Number(folder.id)
  }
  const assetQuery = transaction('assets').where({ filename })
  if (parentId === null) {
    assetQuery.where((query: Knex.QueryBuilder) => query.whereNull('folderId').orWhere('folderId', 0))
  } else {
    assetQuery.where({ folderId: parentId })
  }
  if (await assetQuery.first('id')) throw pageRecoveryCollision()
}

const assertRecoveryPath = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('.') ||
    value.includes(' ') ||
    value.includes('\\') ||
    value.includes('//') ||
    value.split('/').some(segment => segment.length === 0)
  ) {
    throw new errors.ApplicationError('The restore destination path is invalid.', { status: 400, code: 'INVALID_INPUT' })
  }
  return value
}

const loadPageTags = async (page: Page, transaction?: Knex.Transaction, reload = false): Promise<Tag[] | undefined> => {
  if (!reload && Array.isArray(page.tags)) return page.tags
  const relatedQuery = Reflect.get(page, '$relatedQuery')
  if (typeof relatedQuery !== 'function') return Array.isArray(page.tags) ? page.tags : undefined
  const tags = await relatedQuery.call(page, 'tags', transaction)
  if (!Array.isArray(tags)) return undefined
  page.tags = tags as Tag[]
  return page.tags
}

const pageAccessContext = (
  page: Pick<Page, 'path' | 'localeCode' | 'visibility' | 'ownerId' | 'tags'>,
  overrides: Partial<Pick<Page, 'path' | 'localeCode' | 'visibility' | 'ownerId' | 'tags'>> = {}
): PageAuthorizationContext | null =>
  pageAuthorizationContext({
    path: overrides.path ?? page.path,
    localeCode: overrides.localeCode ?? page.localeCode,
    visibility: overrides.visibility ?? page.visibility,
    ownerId: overrides.ownerId ?? page.ownerId,
    tags: overrides.tags ?? page.tags
  })

const lockPageForMutation = async (transaction: Knex.Transaction, page: Page): Promise<Tag[] | undefined> => {
  const locked = (await transaction('pages').where({ id: page.id }).forUpdate().first()) as
    | { sourceRevision?: string | number; updatedAt?: string | Date }
    | undefined
  if (!locked) throw new wiki.Error.PageNotFound()
  if (page.sourceRevision !== undefined && (locked.sourceRevision === undefined || String(locked.sourceRevision) !== String(page.sourceRevision))) {
    throw pageUpdateConflict()
  }
  if (typeof page.updatedAt !== 'undefined' && locked.updatedAt !== undefined && new Date(locked.updatedAt).valueOf() !== new Date(page.updatedAt).valueOf()) {
    throw pageUpdateConflict()
  }
  return loadPageTags(page, transaction, true)
}

const hasPagePermission = (user: PageUser, permissions: readonly string[], context: PageAuthorizationContext | null, authority: PageRuleAuthority): boolean =>
  context !== null && wiki.auth.checkPageAccess(user, [...permissions], context, authority)

const pageBrandingFromExtra = (extra: unknown): PageBrandingAssignment | undefined => {
  let candidate = extra
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return undefined
    }
  }
  if (!isRecord(candidate)) return undefined
  const parsed = PageBrandingAssignmentSchema.safeParse(Reflect.get(candidate, 'branding'))
  return parsed.success ? parsed.data : undefined
}

const brandingContextFor = (options: { user: PageUser; brandingContext?: { requester?: Express.User; sessionId: string } }) => ({
  requester: options.brandingContext?.requester ?? options.user,
  sessionId: options.brandingContext?.sessionId ?? ''
})

const authorizeBrandingAssignment = async (
  assignment: PageBrandingAssignment | null | undefined,
  options: { user: PageUser; brandingContext?: { requester?: Express.User; sessionId: string } }
): Promise<void> => {
  if (assignment === undefined || assignment === null) return
  await authorizePageBrandingAssignment({
    assetId: assignment.assetId,
    ...brandingContextFor(options)
  })
}

const writePageOutboxEvent = async (
  knex: Knex | Knex.Transaction,
  type: string,
  page: Pick<Page, 'id' | 'title' | 'path' | 'localeCode' | 'visibility' | 'ownerId' | 'tags'>,
  actor: PageUser
): Promise<void> => {
  await writeOutboxEvent(knex, {
    type,
    version: 1,
    aggregateType: 'page',
    aggregateId: String(page.id),
    payload: {
      pageId: page.id,
      actorId: actor.id,
      actorName: actor.name,
      title: page.title,
      path: page.path,
      localeCode: page.localeCode,
      ownerId: page.ownerId,
      tags: page.tags,
      visibility: page.visibility
    }
  })
}

interface ProjectionPageRow {
  readonly id: number
  readonly sourceRevision: string | number
  readonly content: string
  readonly localeCode: string
  readonly path: string
  readonly visibility: PageVisibility
  readonly ownerId: number | null
}

const projectionLocation = (page: Pick<ProjectionPageRow, 'localeCode' | 'path' | 'visibility' | 'ownerId'>) => ({
  locale: page.localeCode,
  path: page.path,
  visibility: page.visibility,
  ownerId: page.ownerId
})

const enqueueCurrentPageProjections = async (
  transaction: Knex.Transaction,
  pageId: number,
  action: PageProjectionPayload['action'],
  previousLocation?: ReturnType<typeof projectionLocation>
): Promise<void> => {
  const page = await transaction<ProjectionPageRow>('pages')
    .select('id', 'sourceRevision', 'content', 'localeCode', 'path', 'visibility', 'ownerId')
    .where({ id: pageId })
    .forUpdate()
    .first()
  if (!page) throw new wiki.Error.PageNotFound()
  await enqueuePageMutationEffects(transaction, {
    pageId,
    sourceRevision: page.sourceRevision,
    desiredState: 'present',
    action,
    source: page.content,
    location: projectionLocation(page),
    ...(previousLocation ? { previousLocation } : {})
  })
}
interface CanonicalPageCommitInput {
  transaction: Knex.Transaction
  page: Page
  user: PageUser
  historyPage: Record<string, unknown>
  patch: Record<string, unknown>
  historyAction: string
  eventType: string
  eventPage: Pick<Page, 'id' | 'title' | 'path' | 'localeCode' | 'visibility' | 'ownerId' | 'tags'>
  projectionAction: PageProjectionPayload['action']
  previousLocation?: ReturnType<typeof projectionLocation>
  expectedUpdatedAt?: boolean
  tagsChanged?: boolean
}

const saveCanonicalPageRevision = async (input: CanonicalPageCommitInput): Promise<void> => {
  await wiki.models.pageHistory.addVersion({
    ...input.historyPage,
    action: input.historyAction,
    versionDate: input.page.updatedAt,
    transaction: input.transaction
  } as PageVersionOptions)
  let query = wiki.models.pages.query(input.transaction).patch(input.patch as Partial<Page>).where({ id: input.page.id })
  if (input.expectedUpdatedAt) query = query.where('updatedAt', input.page.updatedAt)
  if (input.page.sourceRevision !== undefined) query = query.where('sourceRevision', input.page.sourceRevision)
  const changedRows = await query
  if (changedRows !== 1) throw pageUpdateConflict()
  if (input.tagsChanged && input.page.sourceRevision !== undefined) {
    const revisionRow = await input.transaction('pages').select('sourceRevision').where({ id: input.page.id }).forUpdate().first()
    if (revisionRow && String(revisionRow.sourceRevision) === String(input.page.sourceRevision)) {
      const bumpedRows = await input.transaction('pages')
        .where({ id: input.page.id, sourceRevision: input.page.sourceRevision })
        .update({ sourceRevision: input.transaction.raw('"sourceRevision" + 1') })
      if (bumpedRows !== 1) throw pageUpdateConflict()
    }
  }
  await writePageOutboxEvent(input.transaction, input.eventType, input.eventPage, input.user)
  await enqueueCurrentPageProjections(input.transaction, input.page.id, input.projectionAction, input.previousLocation)
}
const pageHasActiveApproval = async (database: Knex | Knex.Transaction, pageId: number): Promise<boolean> =>
  (await database('pageApprovalRequests')
    .where({ pageId })
    .whereIn('status', ['submitted', 'approved', 'changes-requested'])
    .first('id')) !== undefined

interface PageHistoryIdentityRow {
  readonly id: number
  readonly path: string
  readonly visibility: PageVisibility
  readonly ownerId: number | null
}

interface PageTreeSourceRow {
  readonly id: number
  readonly path: string
  readonly localeCode: string
  readonly title: string
  readonly visibility: PageVisibility
  readonly ownerId: number | null
}

interface PageTreeInsertRow {
  id: number
  localeCode: string
  path: string
  depth: number
  title: string
  isFolder: boolean
  visibility: PageVisibility
  ownerId: number | null
  parent: number | null
  pageId: number | null
  ancestors: string
}

interface MigratedPageIdentity {
  readonly previous: Page
  readonly destinationHash: string
}

const PAGE_TREE_REBUILD_LOCK_ID = 0x574b5452

const rewriteLinkedPageRenders = async (
  transaction: Knex.Transaction,
  locale: string,
  pagePath: string,
  from: string,
  to: string
): Promise<readonly Pick<Page, 'id' | 'hash'>[]> => {
  const linkedPages = await transaction<Pick<Page, 'id' | 'hash'>>('pages')
    .select('id', 'hash')
    .whereIn('id', builder => {
      builder.select('pageId').from('pageLinks').where({ localeCode: locale, path: pagePath })
    })
    .forUpdate()
  if (linkedPages.length > 0) {
    await transaction('pages')
      .whereIn(
        'id',
        linkedPages.map(page => page.id)
      )
      .update({
        render: transaction.raw('REPLACE(??, ?, ?)', ['render', from, to]),
        renderedSourceRevision: null
      })
  }
  return linkedPages
}


const replacePageTree = async (transaction: Knex.Transaction): Promise<void> => {
  const pages = await transaction<PageTreeSourceRow>('pages')
    .select('id', 'path', 'localeCode', 'title', 'visibility', 'ownerId')
    .orderBy(['visibility', 'ownerId', 'localeCode', 'path'])
  const tree: PageTreeInsertRow[] = []
  const treeByIdentity = new Map<string, PageTreeInsertRow>()
  let nextId = 0

  for (const page of pages) {
    const pagePaths = page.path.split('/')
    let currentPath = ''
    let parentId: number | null = null
    const ancestors: number[] = []
    for (const [index, part] of pagePaths.entries()) {
      const depth = index + 1
      const isFolder = depth < pagePaths.length
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const identity = JSON.stringify([page.visibility, page.ownerId, page.localeCode, currentPath])
      let treeRow = treeByIdentity.get(identity)
      if (!treeRow) {
        treeRow = {
          id: ++nextId,
          localeCode: page.localeCode,
          path: currentPath,
          depth,
          title: isFolder ? part : page.title,
          isFolder,
          visibility: page.visibility,
          ownerId: page.ownerId,
          parent: parentId,
          pageId: isFolder ? null : page.id,
          ancestors: JSON.stringify(ancestors)
        }
        tree.push(treeRow)
        treeByIdentity.set(identity, treeRow)
      } else if (isFolder && !treeRow.isFolder) {
        treeRow.isFolder = true
      }
      parentId = treeRow.id
      ancestors.push(treeRow.id)
    }
  }

  await transaction('pageTree').truncate()
  for (const rows of _.chunk(tree, 100)) await transaction('pageTree').insert(rows)
}

const frontmatterRegex = {
  html: /^(<!-{2}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{2}>)?(?:\n|\r)*([\w\W]*)*/,
  legacy: /^(<!-- TITLE: ?([\w\W]+?) ?-{2}>)?(?:\n|\r)?(<!-- SUBTITLE: ?([\w\W]+?) ?-{2}>)?(?:\n|\r)*([\w\W]*)*/i,
  markdown: /^(-{3}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{3})?(?:\n|\r)*([\w\W]*)*/
}

const punctuationRegex = /[!,:;/\\_+\-=()&#@<>$~%^*[\]{}"'|]+|(\.\s)|(\s\.)/gi
// const htmlEntitiesRegex = /(&#[0-9]{3};)|(&#x[a-zA-Z0-9]{2};)/ig

/**
 * Pages model
 */
export default class Page extends Model {
  declare id: number
  declare path: string
  declare locale?: string
  declare hash: string
  declare title: string
  declare description: string
  declare visibility: PageVisibility
  declare ownerId: number | null
  declare isPublished: boolean | number
  declare isSearchable: boolean | number
  declare publishStartDate: string
  declare publishEndDate: string
  declare content: string
  declare render: string
  declare toc: string | unknown[]
  declare contentType: string
  declare createdAt: string
  declare updatedAt: string
  declare sourceRevision: string | number
  declare renderedSourceRevision: string | number | null
  declare editorKey: string

  declare localeCode: string
  declare localeGroupId: string | null
  declare authorId: number
  declare creatorId: number
  declare extra: PageExtra
  declare tags: Tag[]
  declare authorName: string
  declare authorEmail: string
  declare creatorName: string
  declare creatorEmail: string
  declare safeContent: string
  static override get tableName() {
    return 'pages'
  }
  static override get jsonSchema() {
    return {
      type: 'object',
      required: ['path', 'title'],

      properties: {
        id: { type: 'integer' },
        path: { type: 'string' },
        hash: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        isPublished: { type: 'boolean' },
        isSearchable: { type: 'boolean' },
        visibility: { type: 'string', enum: ['public', 'private'] },
        ownerId: { type: ['integer', 'null'] },
        localeGroupId: { type: ['string', 'null'] },
        contentType: { type: 'string' },

        createdAt: { type: 'string' },
        sourceRevision: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        renderedSourceRevision: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] },
        updatedAt: { type: 'string' }

      }
    }
  }
  static override get jsonAttributes() {
    return ['extra']
  }
  static override get relationMappings() {
    return {
      tags: {
        relation: Model.ManyToManyRelation,
        modelClass: Tag,
        join: {
          from: 'pages.id',
          through: {
            from: 'pageTags.pageId',
            to: 'pageTags.tagId'
          },
          to: 'tags.id'
        }
      },
      links: {
        relation: Model.HasManyRelation,
        modelClass: PageLink,
        join: {
          from: 'pages.id',
          to: 'pageLinks.pageId'
        }
      },
      author: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'pages.authorId',
          to: 'users.id'
        }
      },
      creator: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'pages.creatorId',
          to: 'users.id'
        }
      },
      editor: {
        relation: Model.BelongsToOneRelation,
        modelClass: Editor,
        join: {
          from: 'pages.editorKey',
          to: 'editors.key'
        }
      },
      locale: {
        relation: Model.BelongsToOneRelation,
        modelClass: Locale,
        join: {
          from: 'pages.localeCode',
          to: 'locales.code'
        }
      }
    }
  }
  override $beforeUpdate() {
    this.updatedAt = new Date().toISOString()
  }
  override $beforeInsert() {
    this.createdAt = new Date().toISOString()
    this.updatedAt = new Date().toISOString()
  } /**
   * Solving the violates foreign key constraint using cascade strategy
   * using static hooks
   * @see https://vincit.github.io/objection.js/api/types/#type-statichookarguments
   */
  static override async beforeDelete({ asFindQuery, transaction }: StaticHookArguments<Page>): Promise<void> {
    const page = await asFindQuery().select('id')
    const deletedPage = page[0]
    if (!deletedPage) {
      throw new Error('Page deletion hook could not resolve the page id.')
    }
    await wiki.models.comments.query(transaction).delete().where('pageId', deletedPage.id)
  }
  /**
   * Cache Schema
   */
  static get cacheSchema(): JSBinType<CachedPage> {
    return new JSBinType<CachedPage>({
      id: 'uint',
      sourceRevision: 'string',
      authorId: 'uint',
      authorName: 'string',
      createdAt: 'string',
      creatorId: 'uint',
      creatorName: 'string',
      description: 'string',
      editorKey: 'string',
      visibility: 'string',
      ownerId: 'uint',
      isPublished: 'boolean',
      isSearchable: 'boolean',
      publishEndDate: 'string',
      publishStartDate: 'string',
      contentType: 'string',
      render: 'string',
      tags: [
        {
          tag: 'string',
          title: 'string'
        }
      ],
      extra: {
        js: 'string',
        css: 'string'
      },
      title: 'string',
      toc: 'string',
      updatedAt: 'string'
    })
  }

  /**
   * Get the page's file extension based on content type
   *
   * @returns {string} File Extension
   */
  getFileExtension(): string {
    return pageHelper.getFileExtension(this.contentType)
  }

  /**
   * Parse injected page metadata from raw content
   *
   * @param {String} raw Raw file contents
   * @param {String} contentType Content Type
   * @returns {Object} Parsed Page Metadata with Raw Content
   */
  static parseMetadata(raw: string, contentType: string): UnknownRecord & { content: string } {
    let result
    try {
      switch (contentType) {
        case 'markdown':
          result = frontmatterRegex.markdown.exec(raw)
          if (result?.[2]) {
            const metadata = yaml.load(result[2])
            return {
              ...(typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata : {}),
              content: result[3] ?? ''
            }
          } else {
            // Attempt legacy v1 format
            result = frontmatterRegex.legacy.exec(raw)
            if (result?.[2]) {
              return {
                title: result[2],
                description: result[4],
                content: result[5] ?? ''
              }
            }
          }
          break
        case 'html':
          result = frontmatterRegex.html.exec(raw)
          if (result?.[2]) {
            const metadata = yaml.load(result[2])
            return {
              ...(typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata : {}),
              content: result[3] ?? ''
            }
          }
          break
      }
    } catch {
      wiki.logger.warn('Failed to parse page metadata. Invalid syntax.')
    }
    return {
      content: raw
    }
  }

  static assertCreateAccess(opts: {
    path: string
    locale: string
    visibility: PageVisibility
    tags?: unknown
    user: PageUser
    authority: PageRuleAuthority
  }): string[] {
    const names = opts.tags === undefined ? [] : tagNames(opts.tags)
    if (opts.visibility === 'private') {
      if (principalId(opts.user) === null) {
        throw new errors.ApplicationError('You must be authenticated to create a private page.', { status: 403, code: 'PAGE_CREATE_FORBIDDEN' })
      }
      return names
    }
    if (
      !wiki.auth.checkPageAccess(
        opts.user,
        ['write:pages'],
        {
          path: opts.path,
          locale: opts.locale,
          localeCode: opts.locale,
          visibility: 'public',
          ownerId: null,
          tags: names.map(tag => ({ tag }))
        },
        opts.authority
      )
    ) {
      throw new errors.ApplicationError('You do not have permission to create this page.', { status: 403, code: 'PAGE_CREATE_FORBIDDEN' })
    }
    return names
  }

  /**
   * Create a New Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async createPage(opts: CreatePageOptions): Promise<Page> {
    rejectApiPrincipalMutation(opts.user)
    // -> Validate path
    if (opts.path.includes('.') || opts.path.includes(' ') || opts.path.includes('\\') || opts.path.includes('//')) {
      throw new wiki.Error.PageIllegalPath()
    }

    // -> Remove trailing slash
    if (opts.path.endsWith('/')) {
      opts.path = opts.path.slice(0, -1)
    }

    // -> Remove starting slash
    if (opts.path.startsWith('/')) {
      opts.path = opts.path.slice(1)
    }

    const preflightAuthority = await wiki.auth.loadPageRuleAuthority(opts.user)
    const normalizedTags = Page.assertCreateAccess({ ...opts, authority: preflightAuthority })
    opts.tags = normalizedTags
    const ownerId = opts.visibility === 'private' ? principalId(opts.user) : null

    const dupCheck = await wiki.models.pages
      .query()
      .select('id')
      .where({
        visibility: opts.visibility,
        ownerId,
        localeCode: opts.locale,
        path: opts.path
      })
      .first()
    if (dupCheck) {
      throw new wiki.Error.PageDuplicateCreate()
    }

    // -> Check for empty content
    if (!opts.content || _.trim(opts.content).length < 1) {
      throw new wiki.Error.PageEmptyContent()
    }

    // -> Format CSS and JS values before opening the transaction. Authorization
    // is repeated against the canonical post-association context below.
    const requestedScriptCss =
      opts.scriptCss === undefined ? undefined : _.isEmpty(opts.scriptCss) ? '' : new CleanCSS({ inline: false }).minify(opts.scriptCss).styles
    const scriptCss = requestedScriptCss ?? ''
    const requestedScriptJs = opts.scriptJs
    const scriptJs = requestedScriptJs ?? ''
    const okfMetadata = mutateOkfMetadata({
      proposed: opts.okfMetadata,
      producer: opts.okfProducer ?? `human:${opts.user.id}`,
      knowledgeChanged: true,
      at: new Date()
    })
    const requestedPageFeatures =
      opts.pageFeatures === undefined ? pageFeaturesFromOkfMetadata(opts.okfMetadata) : PageFeaturesSchema.parse(opts.pageFeatures)
    const pageFeatures = requestedPageFeatures ?? DEFAULT_PAGE_FEATURES
    const branding = opts.branding === undefined ? undefined : opts.branding === null ? null : PageBrandingAssignmentSchema.parse(opts.branding)
    await authorizeBrandingAssignment(branding, opts)

    await wiki.models.knex.transaction(async transaction => {
      const inserted = await wiki.models.pages.query(transaction).insert({
        authorId: opts.user.id,
        content: opts.content,
        creatorId: opts.user.id,
        contentType: wiki.data.editors.find(editor => editor.key === opts.editor)?.contentType ?? 'text',
        description: opts.description,
        editorKey: opts.editor,
        hash: pageHelper.generateHash({
          path: opts.path,
          locale: opts.locale,
          visibility: opts.visibility,
          ownerId
        }),
        visibility: opts.visibility,
        ownerId,
        isPublished: opts.isPublished,
        isSearchable: opts.isSearchable === undefined ? true : opts.isSearchable === true || opts.isSearchable === 1,
        localeCode: opts.locale,
        path: opts.path,
        publishEndDate: opts.publishEndDate || '',
        publishStartDate: opts.publishStartDate || '',
        title: opts.title,
        toc: '[]',
        renderedSourceRevision: null,
        extra: {
          js: scriptJs,
          css: scriptCss,
          okf: okfMetadata,
          pageFeatures,
          ...(branding === undefined || branding === null ? {} : { branding })
        }
      })
      await wiki.models.tags.associateTags({ tags: normalizedTags, page: inserted, transaction })
      const authority = await wiki.auth.loadPageRuleAuthority(opts.user, transaction)
      const canonicalContext = pageAccessContext(inserted)
      if (canonicalContext === null) {
        throw new errors.ApplicationError('Unable to resolve canonical page tags.', { status: 403, code: 'PAGE_CREATE_FORBIDDEN' })
      }
      if (requestedScriptCss !== undefined && requestedScriptCss !== '' && !hasPagePermission(opts.user, ['write:styles'], canonicalContext, authority)) {
        throw new errors.ApplicationError('You do not have permission to add page styles.', { status: 403, code: 'PAGE_CREATE_FORBIDDEN' })
      }
      if (requestedScriptJs !== undefined && requestedScriptJs !== '' && !hasPagePermission(opts.user, ['write:scripts'], canonicalContext, authority)) {
        throw new errors.ApplicationError('You do not have permission to add page scripts.', { status: 403, code: 'PAGE_CREATE_FORBIDDEN' })
      }
      if (opts.visibility === 'public' && !hasPagePermission(opts.user, ['write:pages'], canonicalContext, authority)) {
        throw new errors.ApplicationError('You do not have permission to create this page.', { status: 403, code: 'PAGE_CREATE_FORBIDDEN' })
      }
      await enqueueCurrentPageProjections(transaction, inserted.id, 'create')
      await writePageOutboxEvent(transaction, 'page.created', inserted, opts.user)
    })
    const page = await wiki.models.pages.getPageFromDb({
      path: opts.path,
      locale: opts.locale,
      visibility: opts.visibility,
      ownerId
    })
    if (!page) {
      throw new wiki.Error.PageNotFound()
    }

    // -> Render page to HTML
    await wiki.models.pages.renderPage(page)

    // -> Rebuild page tree
    await wiki.models.pages.rebuildTree()

    if (page.visibility === 'public') {
      if (!opts.skipStorage) {
        await wiki.models.storage.pageEvent({
          event: 'created',
          page
        })
      }

      await wiki.models.pages.reconnectLinks({
        locale: page.localeCode,
        path: page.path,
        mode: 'create'
      })
    }

    // -> Get latest updatedAt
    const latestPage = await wiki.models.pages.query().findById(page.id).select('updatedAt')
    if (!latestPage) {
      throw new wiki.Error.PageNotFound()
    }
    page.updatedAt = latestPage.updatedAt

    return page
  }

  /**
   * Update an Existing Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async updatePage(opts: UpdatePageOptions): Promise<Page> {
    rejectApiPrincipalMutation(opts.user)
    // -> Fetch original page
    const ogPage = await wiki.models.pages.query().findById(opts.id)
    if (ogPage && ogPage.visibility === 'public') await loadPageTags(ogPage)
    const preflightAuthority = await wiki.auth.loadPageRuleAuthority(opts.user)
    if (!ogPage || (ogPage.visibility === 'private' && !canWritePage(opts.user, ogPage, preflightAuthority))) {
      throw new wiki.Error.PageNotFound()
    }
    if (!canWritePage(opts.user, ogPage, preflightAuthority)) {
      throw new wiki.Error.PageUpdateForbidden()
    }
    if (opts.expectedUpdatedAt && new Date(ogPage.updatedAt).valueOf() !== new Date(opts.expectedUpdatedAt).valueOf()) {
      throw pageUpdateConflict()
    }
    if (opts.expectedSourceRevision && String(ogPage.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()

    const content = opts.content ?? ogPage.content
    if (!content || _.trim(content).length < 1) {
      throw new wiki.Error.PageEmptyContent()
    }
    const editorKey = opts.editor ?? ogPage.editorKey

    // -> Format Extra Properties
    const pageExtra: PageExtra = _.isPlainObject(ogPage.extra) ? { ...ogPage.extra } : {}
    ogPage.extra = pageExtra
    const requestedPageFeatures =
      opts.pageFeatures === undefined ? pageFeaturesFromOkfMetadata(opts.okfMetadata) : PageFeaturesSchema.parse(opts.pageFeatures)
    const pageFeaturesChanged =
      requestedPageFeatures !== undefined && !_.isEqual(parsePageFeatures(pageExtra.pageFeatures), requestedPageFeatures)
    const hasBrandingMutation = Object.hasOwn(opts, 'branding') && opts.branding !== undefined
    const branding = hasBrandingMutation ? (opts.branding === null ? null : PageBrandingAssignmentSchema.parse(opts.branding)) : undefined
    const existingBranding = pageBrandingFromExtra(pageExtra)
    const brandingChanged =
      hasBrandingMutation &&
      (branding === null
        ? Object.hasOwn(pageExtra, 'branding')
        : branding !== undefined && (existingBranding === undefined || existingBranding.assetId !== branding.assetId))
    if (brandingChanged && branding !== null && branding !== undefined) await authorizeBrandingAssignment(branding, opts)

    // -> Format CSS Scripts
    const existingScriptCss = typeof ogPage.extra.css === 'string' ? ogPage.extra.css : ''
    const requestedScriptCss =
      opts.scriptCss === undefined ? undefined : _.isEmpty(opts.scriptCss) ? '' : new CleanCSS({ inline: false }).minify(opts.scriptCss).styles
    let scriptCss = existingScriptCss
    const existingScriptJs = typeof ogPage.extra.js === 'string' ? ogPage.extra.js : ''
    const requestedScriptJs = opts.scriptJs
    let scriptJs = existingScriptJs
    const destinationLocale = opts.locale ?? ogPage.localeCode
    let destinationPath = opts.path ?? ogPage.path
    if (destinationPath.includes('.') || destinationPath.includes(' ') || destinationPath.includes('\\') || destinationPath.includes('//')) {
      throw new wiki.Error.PageIllegalPath()
    }
    if (destinationPath.endsWith('/')) {
      destinationPath = destinationPath.slice(0, -1)
    }
    if (destinationPath.startsWith('/')) {
      destinationPath = destinationPath.slice(1)
    }
    const restoringOkf = opts.okfRestoreRevision !== undefined
    const replacingOkf = !restoringOkf && opts.replaceOkfMetadata === true
    const okfProducer = opts.okfProducer ?? `human:${opts.user.id}`
    const okfMutationAt = new Date()
    const existingOkfMetadata = restoringOkf ? opts.okfMetadata : ogPage.extra.okf
    const replacementOkfMetadata = replacingOkf
      ? mutateOkfMetadata({
          proposed: opts.okfMetadata ?? null,
          producer: okfProducer,
          knowledgeChanged: false,
          at: okfMutationAt,
          mode: 'replace'
        })
      : undefined
    let normalizedExistingOkfMetadata: OkfMetadata | undefined
    let existingOkfIsValid = true
    try {
      normalizedExistingOkfMetadata = mutateOkfMetadata({
        existing: existingOkfMetadata,
        producer: okfProducer,
        knowledgeChanged: false,
        at: okfMutationAt
      })
    } catch (error) {
      if (!replacingOkf || !(error instanceof OkfDocumentError)) throw error
      existingOkfIsValid = false
    }
    const existingOkfForMutation = existingOkfIsValid ? existingOkfMetadata : undefined
    const proposedOkfMetadata = mutateOkfMetadata({
      existing: existingOkfForMutation,
      proposed: restoringOkf ? undefined : (replacementOkfMetadata ?? opts.okfMetadata),
      producer: okfProducer,
      knowledgeChanged: false,
      at: okfMutationAt,
      ...(replacingOkf ? { mode: 'replace' as const } : {}),
      ...(restoringOkf ? { restore: { revision: opts.okfRestoreRevision! } } : {})
    })
    const okfAuthorityChanged =
      !restoringOkf &&
      opts.okfMetadata !== undefined &&
      (!existingOkfIsValid || existingOkfMetadata === undefined || !_.isEqual(proposedOkfMetadata, normalizedExistingOkfMetadata))
    const willMove = destinationLocale !== ogPage.localeCode || destinationPath !== ogPage.path
    const knowledgeChanged =
      opts.content !== undefined || opts.title !== undefined || opts.description !== undefined || opts.tags !== undefined || okfAuthorityChanged || willMove
    let okfMetadata = mutateOkfMetadata({
      existing: existingOkfForMutation,
      proposed: restoringOkf ? undefined : (replacementOkfMetadata ?? opts.okfMetadata),
      producer: okfProducer,
      knowledgeChanged,
      at: okfMutationAt,
      ...(replacingOkf ? { mode: 'replace' as const } : {}),
      ...(restoringOkf ? { restore: { revision: opts.okfRestoreRevision! } } : {})
    })
    if (okfAuthorityChanged || willMove) okfMetadata = invalidateOkfVerification(okfMetadata)
    const noNonBrandingMutation =
      opts.content === undefined &&
      opts.description === undefined &&
      opts.isPublished === undefined &&
      opts.isSearchable === undefined &&
      opts.title === undefined &&
      opts.editor === undefined &&
      opts.contentType === undefined &&
      opts.action === undefined &&
      opts.locale === undefined &&
      opts.path === undefined &&
      opts.publishEndDate === undefined &&
      opts.publishStartDate === undefined &&
      opts.scriptCss === undefined &&
      opts.scriptJs === undefined &&
      opts.okfRestoreRevision === undefined &&
      !pageFeaturesChanged
    const metadataOnlyNoOp = opts.okfMetadata !== undefined && !okfAuthorityChanged && noNonBrandingMutation && !brandingChanged
    const brandingOnlyNoOp = hasBrandingMutation && !brandingChanged && opts.okfMetadata === undefined && noNonBrandingMutation
    const pageFeaturesOnlyNoOp =
      requestedPageFeatures !== undefined && noNonBrandingMutation && !brandingChanged && opts.okfMetadata === undefined
    if (metadataOnlyNoOp || brandingOnlyNoOp || pageFeaturesOnlyNoOp) {
      const unchangedPage = await wiki.models.pages.getPageFromDb(ogPage.id)
      if (!unchangedPage) throw new wiki.Error.PageNotFound()
      return unchangedPage
    }
    const destinationTitle =
      opts.title ?? (willMove && ogPage.title === _.last(ogPage.path.split('/')) ? (_.last(destinationPath.split('/')) ?? ogPage.title) : ogPage.title)
    const destinationHash = willMove
      ? pageHelper.generateHash({
          path: destinationPath,
          locale: destinationLocale,
          visibility: ogPage.visibility,
          ownerId: ogPage.ownerId
        })
      : ogPage.hash
    const pageEventType = opts.action === 'restored' ? 'page.restored' : willMove ? 'page.moved' : 'page.updated'
    await wiki.models.knex.transaction(async transaction => {
      const authorizationTags = await lockPageForMutation(transaction, ogPage)
      if (authorizationTags === undefined) {
        if (ogPage.visibility === 'private') throw new wiki.Error.PageNotFound()
        throw new wiki.Error.PageUpdateForbidden()
      }
      const originalTags = [...authorizationTags]
      let tagsChanged = false
      if (opts.tags !== undefined) {
        tagsChanged = await wiki.models.tags.associateTags({ tags: opts.tags, page: ogPage, transaction })
      } else {
        ogPage.tags = originalTags
      }
      const authority = await wiki.auth.loadPageRuleAuthority(opts.user, transaction)
      const currentContext = pageAccessContext({ ...ogPage, tags: authorizationTags })
      const proposedContext = pageAccessContext(ogPage, {
        path: destinationPath,
        localeCode: destinationLocale,
        tags: ogPage.tags
      })
      if (currentContext === null || !canWritePage(opts.user, currentContext, authority)) {
        if (ogPage.visibility === 'private') throw new wiki.Error.PageNotFound()
        throw new wiki.Error.PageUpdateForbidden()
      }
      if (proposedContext === null || !canWritePage(opts.user, proposedContext, authority)) {
        if (willMove) throw new wiki.Error.PageMoveForbidden()
        throw new wiki.Error.PageUpdateForbidden()
      }
      if (willMove && ogPage.visibility === 'public' && !hasPagePermission(opts.user, ['write:pages'], proposedContext, authority)) {
        throw new wiki.Error.PageMoveForbidden()
      }
      if (
        requestedScriptCss !== undefined &&
        requestedScriptCss !== existingScriptCss &&
        (!hasPagePermission(opts.user, ['write:styles'], currentContext, authority) ||
          !hasPagePermission(opts.user, ['write:styles'], proposedContext, authority))
      ) {
        throw new wiki.Error.PageUpdateForbidden()
      }
      if (
        requestedScriptJs !== undefined &&
        requestedScriptJs !== existingScriptJs &&
        (!hasPagePermission(opts.user, ['write:scripts'], currentContext, authority) ||
          !hasPagePermission(opts.user, ['write:scripts'], proposedContext, authority))
      ) {
        throw new wiki.Error.PageUpdateForbidden()
      }
      scriptCss = requestedScriptCss === undefined ? existingScriptCss : requestedScriptCss
      scriptJs = requestedScriptJs === undefined ? existingScriptJs : requestedScriptJs
      const extraForPatch: PageExtra = {
        ...pageExtra,
        js: scriptJs,
        css: scriptCss
      }
      if (requestedPageFeatures !== undefined) extraForPatch.pageFeatures = requestedPageFeatures
      if (hasBrandingMutation) {
        if (branding === null) delete extraForPatch.branding
        else if (branding !== undefined) extraForPatch.branding = branding
      }
      if (willMove) {
        const collision = await wiki.models.pages.query(transaction).findOne({
          path: destinationPath,
          localeCode: destinationLocale,
          visibility: ogPage.visibility,
          ownerId: ogPage.ownerId
        })
        if (collision && collision.id !== ogPage.id) throw new wiki.Error.PagePathCollision()
      }
      const historyPage = {
        ...ogPage,
        tags: authorizationTags,
        isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
        isSearchable: ogPage.isSearchable !== false && ogPage.isSearchable !== 0
      }
      if (opts.expectedCollaborationGeneration !== undefined) {
        const room = await transaction<{ pageId: number; generation: number }>('pageCollaborationRooms')
          .where({ pageId: ogPage.id })
          .forUpdate()
          .first('generation')
        if (!room || room.generation !== opts.expectedCollaborationGeneration) throw collaborationDraftDiscardedConflict()
      }
      const localeRelationPatch = await localeRelationMovePatch(transaction, ogPage, destinationLocale)
      await saveCanonicalPageRevision({
        transaction,
        page: ogPage,
        user: opts.user,
        historyPage,
        historyAction: opts.action ? opts.action : 'updated',
        patch: {
          authorId: opts.user.id,
          content,
          contentType: opts.contentType ?? ogPage.contentType,
          description: opts.description ?? ogPage.description,
          editorKey,
          isPublished:
            opts.isPublished === undefined ? ogPage.isPublished === true || ogPage.isPublished === 1 : opts.isPublished === true || opts.isPublished === 1,
          isSearchable:
            opts.isSearchable === undefined
              ? ogPage.isSearchable !== false && ogPage.isSearchable !== 0
              : opts.isSearchable === true || opts.isSearchable === 1,
          publishEndDate: opts.publishEndDate === undefined ? ogPage.publishEndDate : opts.publishEndDate || '',
          publishStartDate: opts.publishStartDate === undefined ? ogPage.publishStartDate : opts.publishStartDate || '',
          title: destinationTitle,
          ...(willMove ? { path: destinationPath, localeCode: destinationLocale, hash: destinationHash } : {}),
          ...localeRelationPatch,
          extra: {
            ...extraForPatch,
            ...(okfMetadata === undefined ? {} : { okf: okfMetadata })
          },
          renderedSourceRevision: null
        },
        eventType: pageEventType,
        eventPage: {
          ...ogPage,
          path: destinationPath,
          localeCode: destinationLocale,
          title: destinationTitle
        },
        projectionAction: opts.action === 'restored' ? 'restore' : willMove ? 'move' : 'update',
        ...(willMove ? { previousLocation: projectionLocation(ogPage) } : {}),
        expectedUpdatedAt: opts.expectedUpdatedAt !== undefined,
        tagsChanged
      })
    })
    let page: Page | undefined
    try {
      page = await wiki.models.pages.getPageFromDb(ogPage.id)
    } catch (error) {
      if (!willMove) throw error
      wiki.logger.warn(`Page move committed; committed page refresh remains pending: ${String(error)}`)
    }
    const fallbackExtra: PageExtra = { ...pageExtra, js: scriptJs, css: scriptCss }
    if (requestedPageFeatures !== undefined) fallbackExtra.pageFeatures = requestedPageFeatures
    if (hasBrandingMutation) {
      if (branding === null) delete fallbackExtra.branding
      else if (branding !== undefined) fallbackExtra.branding = branding
    }
    if (!page) {
      if (!willMove) throw new wiki.Error.PageNotFound()
      page = Object.assign(new Page(), ogPage, {
        authorId: opts.user.id,
        content,
        contentType: opts.contentType ?? ogPage.contentType,
        description: opts.description ?? ogPage.description,
        editorKey,
        isPublished:
          opts.isPublished === undefined ? ogPage.isPublished === true || ogPage.isPublished === 1 : opts.isPublished === true || opts.isPublished === 1,
        isSearchable:
          opts.isSearchable === undefined
            ? ogPage.isSearchable !== false && ogPage.isSearchable !== 0
            : opts.isSearchable === true || opts.isSearchable === 1,
        publishEndDate: opts.publishEndDate === undefined ? ogPage.publishEndDate : opts.publishEndDate || '',
        publishStartDate: opts.publishStartDate === undefined ? ogPage.publishStartDate : opts.publishStartDate || '',
        path: destinationPath,
        localeCode: destinationLocale,
        title: destinationTitle,
        hash: destinationHash,
        extra: { ...fallbackExtra, ...(okfMetadata === undefined ? {} : { okf: okfMetadata }) }
      })
    }

    // Tags are changed inside the page transaction so restore cannot expose mixed content and metadata.
    if (willMove) {
      await deliverAfterPageCommit('move render', () => wiki.models.pages.renderPage(page!))
      schedulePageRerenders([page.id])
      if (ogPage.hash !== page.hash) {
        await deliverAfterPageCommit('old-page cache eviction', () => wiki.models.pages.deletePageFromCache(ogPage.hash))
      }
      await deliverAfterPageCommit('moved-page cache eviction', () => wiki.models.pages.deletePageFromCache(page!.hash))
      for (const hash of new Set([page.hash, ogPage.hash])) {
        try {
          wiki.events.outbound.emit('deletePageFromCache', hash)
        } catch (error) {
          wiki.logger.warn(`Page move committed; cache eviction notification remains pending: ${String(error)}`)
        }
      }
    } else {
      await wiki.models.pages.renderPage(page)
      wiki.events.outbound.emit('deletePageFromCache', page.hash)
    }

    if (page.visibility === 'public') {
      if (willMove) {
        const renamedPage: PageRenameDetails = {
          ...page,
          hash: ogPage.hash,
          path: ogPage.path,
          localeCode: ogPage.localeCode,
          destinationPath,
          destinationLocaleCode: destinationLocale,
          destinationHash
        }
        if (!opts.skipStorage) {
          await deliverAfterPageCommit('renamed-page storage delivery', () => wiki.models.storage.pageEvent({
            event: 'renamed',
            page: {
              ...renamedPage,
              authorName: page!.authorName,
              authorEmail: page!.authorEmail,
              updatedAt: page!.updatedAt,
              tags: page!.tags,
              moveAuthorId: opts.user.id,
              moveAuthorName: opts.user.name,
              moveAuthorEmail: opts.user.email
            }
          }))
        }
      } else if (!opts.skipStorage) {
        await wiki.models.storage.pageEvent({ event: 'updated', page })
      }
    }

    if (willMove) {
      await deliverAfterPageCommit('page-tree rebuild', () => wiki.models.pages.rebuildTree())
      if (page.visibility === 'public') {
        await deliverAfterPageCommit('old-route link-state refresh', () =>
          wiki.models.pages.reconnectLinks({ locale: ogPage.localeCode, path: ogPage.path, mode: 'delete' }))
        await deliverAfterPageCommit('new-route link-state refresh', () =>
          wiki.models.pages.reconnectLinks({ locale: destinationLocale, path: destinationPath, mode: 'create' }))
      }
    } else {
      await wiki.models.knex.table('pageTree').where({ pageId: page.id }).update('title', page.title)
    }

    const refreshLatestUpdatedAt = async (): Promise<void> => {
      const latestPage = await wiki.models.pages.query().findById(page!.id).select('updatedAt', 'sourceRevision')
      if (!latestPage) throw new wiki.Error.PageNotFound()
      page!.updatedAt = latestPage.updatedAt
      page!.sourceRevision = latestPage.sourceRevision
    }
    if (willMove) await deliverAfterPageCommit('updated timestamp refresh', refreshLatestUpdatedAt)
    else await refreshLatestUpdatedAt()
    await notifyCollaboration(page.id, opts.action === 'restored')

    return page
  }
  static async changeVisibility(opts: ChangeVisibilityOptions): Promise<Page> {
    rejectApiPrincipalMutation(opts.user)
    const page = await wiki.models.pages.getPageFromDb(opts.id)
    const preflightAuthority = await wiki.auth.loadPageRuleAuthority(opts.user)
    if (!page || !canWritePage(opts.user, page, preflightAuthority)) {
      throw new wiki.Error.PageNotFound()
    }
    if (page.visibility === opts.visibility) return page

    const ownerId = opts.visibility === 'private' ? principalId(opts.user) : null
    if (opts.expectedSourceRevision && String(page.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
    if (opts.visibility === 'private' && ownerId === null) {
      throw new wiki.Error.PageUpdateForbidden()
    }

    const hash = pageHelper.generateHash({
      path: page.path,
      locale: page.localeCode,
      visibility: opts.visibility,
      ownerId
    })
    await wiki.models.knex.transaction(async transaction => {
      const authorizationTags = await lockPageForMutation(transaction, page)
      if (authorizationTags === undefined) throw new wiki.Error.PageUpdateForbidden()
      const authority = await wiki.auth.loadPageRuleAuthority(opts.user, transaction)
      const currentContext = pageAccessContext({ ...page, tags: authorizationTags })
      const proposedContext = pageAccessContext(page, {
        visibility: opts.visibility,
        ownerId,
        tags: authorizationTags
      })
      if (currentContext === null || !canWritePage(opts.user, currentContext, authority)) throw new wiki.Error.PageUpdateForbidden()
      if (proposedContext === null || !canWritePage(opts.user, proposedContext, authority)) throw new wiki.Error.PageUpdateForbidden()
      if (opts.visibility === 'public' && (!opts.confirmPublication || !hasPagePermission(opts.user, ['write:pages'], proposedContext, authority))) {
        throw new wiki.Error.PageUpdateForbidden()
      }
      const collision = await wiki.models.pages.query(transaction).findOne({
        visibility: opts.visibility,
        ownerId,
        localeCode: page.localeCode,
        path: page.path
      })
      if (collision) throw new wiki.Error.PagePathCollision()
      const historyPage = {
        ...page,
        tags: authorizationTags,
        isPublished: page.isPublished === true || page.isPublished === 1,
        isSearchable: page.isSearchable !== false && page.isSearchable !== 0
      }
      await wiki.models.pageHistory.addVersion({
        ...historyPage,
        action: opts.visibility === 'private' ? 'made-private' : 'published',
        versionDate: page.updatedAt,
        transaction
      })
      const changedRows = await wiki.models.pages
        .query(transaction)
        .patch({
          visibility: opts.visibility,
          ownerId,
          hash,
          renderedSourceRevision: null
        })
        .where({ id: page.id, sourceRevision: page.sourceRevision })
      if (changedRows !== 1) throw pageUpdateConflict()
      await writePageOutboxEvent(
        transaction,
        'page.visibility-changed',
        {
          ...page,
          visibility: opts.visibility,
          ownerId
        },
        opts.user
      )
      await enqueueCurrentPageProjections(transaction, page.id, 'visibility', projectionLocation(page))
    })
    await wiki.models.pages.deletePageFromCache(page.hash)
    wiki.events.outbound.emit('deletePageFromCache', page.hash)
    await wiki.models.pages.rebuildTree()

    const updated = await wiki.models.pages.getPageFromDb(page.id)
    if (!updated) throw new wiki.Error.PageNotFound()
    schedulePageRerenders([updated.id])

    if (updated.visibility === 'public') {
      if (!opts.skipStorage) {
        await wiki.models.storage.pageEvent({ event: 'created', page: updated })
      }
      await wiki.models.pages.reconnectLinks({
        locale: updated.localeCode,
        path: updated.path,
        mode: 'create'
      })
    } else {
      if (!opts.skipStorage) {
        await wiki.models.storage.pageEvent({ event: 'deleted', page })
      }
      await wiki.models.pages.reconnectLinks({
        locale: page.localeCode,
        path: page.path,
        mode: 'delete'
      })
    }
    await notifyCollaboration(updated.id)
    return updated
  }

  static async transferOwnership(opts: TransferOwnershipOptions): Promise<Page> {
    rejectApiPrincipalMutation(opts.user)
    if (!managesSystem(opts.user)) throw new wiki.Error.PageNotFound()
    const page = await wiki.models.pages.getPageFromDb(opts.id)
    if (!page || page.visibility !== 'private') throw new wiki.Error.PageNotFound()
    if (opts.expectedSourceRevision && String(page.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
    const collision = await wiki.models.pages.query().findOne({
      visibility: 'private',
      ownerId: opts.ownerId,
      localeCode: page.localeCode,
      path: page.path
    })
    if (collision) throw new wiki.Error.PagePathCollision()

    await wiki.models.knex.transaction(async transaction => {
      await wiki.models.pageHistory.addVersion({
        ...page,
        action: 'ownership-transferred',
        versionDate: page.updatedAt,
        transaction
      })
      const hash = pageHelper.generateHash({
        path: page.path,
        locale: page.localeCode,
        visibility: 'private',
        ownerId: opts.ownerId
      })
      const changedRows = await wiki.models.pages
        .query(transaction)
        .patch({ ownerId: opts.ownerId, hash, renderedSourceRevision: null })
        .where({ id: page.id, sourceRevision: page.sourceRevision })
      if (changedRows !== 1) throw pageUpdateConflict()
      await wiki.models.knex('pageHistory').transacting(transaction).where({ pageId: page.id, visibility: 'private' }).update({ ownerId: opts.ownerId })
      await writePageOutboxEvent(transaction, 'page.ownership-transferred', { ...page, ownerId: opts.ownerId }, opts.user)
      await enqueueCurrentPageProjections(transaction, page.id, 'ownership', projectionLocation(page))
    })
    await wiki.models.pages.deletePageFromCache(page.hash)
    wiki.events.outbound.emit('deletePageFromCache', page.hash)
    await wiki.models.pages.rebuildTree()
    const updated = await wiki.models.pages.getPageFromDb(page.id)
    if (!updated) throw new wiki.Error.PageNotFound()
    schedulePageRerenders([updated.id])
    await notifyCollaboration(updated.id)
    return updated
  }

  /**
   * Convert an Existing Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise of the Page Model Instance
   */
  static async convertPage(opts: ConvertPageOptions): Promise<void> {
    rejectApiPrincipalMutation(opts.user)
    // -> Fetch original page
    const ogPage = await wiki.models.pages.query().findById(opts.id)
    if (ogPage && ogPage.visibility === 'public') await loadPageTags(ogPage)
    const preflightAuthority = await wiki.auth.loadPageRuleAuthority(opts.user)
    if (!ogPage || (ogPage.visibility === 'private' && !canWritePage(opts.user, ogPage, preflightAuthority))) {
      throw new wiki.Error.PageNotFound()
    }
    if (opts.expectedSourceRevision && String(ogPage.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
    if (!canWritePage(opts.user, ogPage, preflightAuthority)) {
      throw new wiki.Error.PageUpdateForbidden()
    }
    if (ogPage.editorKey === opts.editor) {
      throw new Error('Page is already using this editor. Nothing to convert.')
    }

    // -> Check content type
    const sourceContentType = ogPage.contentType
    const targetContentType = wiki.data.editors.find(editor => editor.key === opts.editor)?.contentType ?? 'text'
    const shouldConvert = sourceContentType !== targetContentType
    let convertedContent: string | null = null

    // -> Convert content
    if (shouldConvert) {
      // -> Markdown => HTML
      if (sourceContentType === 'markdown' && targetContentType === 'html') {
        if (!ogPage.render) {
          throw new Error('Aborted conversion because rendered page content is empty!')
        }
        convertedContent = ogPage.render

        const $ = cheerio.load(convertedContent, {
          xml: { decodeEntities: true }
        })

        if ($.root().children().length > 0) {
          // Remove header anchors
          $('.toc-anchor').remove()

          // Attempt to convert tabsets
          $('tabset').each((_tabIndex, tabElm) => {
            const tabHeaders: Array<string | null> = []
            // -> Extract templates
            $(tabElm)
              .children('template')
              .each((_templateIndex, templateElm) => {
                if ($(templateElm).attr('v-slot:tabs') === '') {
                  $(tabElm).before('<ul class="tabset-headers">' + $(templateElm).html() + '</ul>')
                } else {
                  $(tabElm).after('<div class="markdown-tabset">' + $(templateElm).html() + '</div>')
                }
              })
            // -> Parse tab headers
            $(tabElm)
              .prev('.tabset-headers')
              .children()
              .each((_index, element) => {
                tabHeaders.push($(element).html())
              })
            $(tabElm).prev('.tabset-headers').remove()
            // -> Inject tab headers
            $(tabElm)
              .next('.markdown-tabset')
              .children()
              .each((index, element) => {
                const tabHeader = tabHeaders[index]
                if (tabHeader !== undefined) {
                  $(element).prepend(`<h2>${tabHeader}</h2>`)
                }
              })
            $(tabElm).next('.markdown-tabset').prepend('<h1>Tabset</h1>')
            $(tabElm).remove()
          })

          const serializedContent = $.root().html()
          if (serializedContent === null) {
            throw new TypeError('Converted page content could not be serialized.')
          }
          convertedContent = serializedContent.replace(/&#x([0-9a-f]{1,6});/gi, (entity, code) => {
            code = parseInt(code, 16)

            // Don't unescape ASCII characters, assuming they're encoded for a good reason
            if (code < 0x80) return entity

            return String.fromCodePoint(code)
          })
        }

        // -> HTML => Markdown
      } else if (sourceContentType === 'html' && targetContentType === 'markdown') {
        const td = new TurndownService({
          bulletListMarker: '-',
          codeBlockStyle: 'fenced',
          emDelimiter: '*',
          fence: '```',
          headingStyle: 'atx',
          hr: '---',
          linkStyle: 'inlined',
          preformattedCode: true,
          strongDelimiter: '**'
        })

        td.use(turndownPluginGfm)

        td.keep(['kbd'])

        td.addRule('subscript', {
          filter: ['sub'],
          replacement: c => `~${c}~`
        })

        td.addRule('superscript', {
          filter: ['sup'],
          replacement: c => `^${c}^`
        })

        td.addRule('underline', {
          filter: ['u'],
          replacement: c => `_${c}_`
        })

        td.addRule('taskList', {
          filter: n => {
            return n.nodeName === 'INPUT' && n.getAttribute('type') === 'checkbox'
          },
          replacement: (content, n) => {
            void content
            return n.getAttribute('checked') ? '[x] ' : '[ ] '
          }
        })

        td.addRule('removeTocAnchors', {
          filter: n => {
            return n.nodeName === 'A' && n.classList.contains('toc-anchor')
          },
          replacement: () => ''
        })

        convertedContent = td.turndown(ogPage.content)
        // -> Unsupported
      } else {
        throw new Error('Unsupported source / destination content types combination.')
      }
    }

    const okfMetadata = mutateOkfMetadata({
      existing: ogPage.extra.okf,
      producer: opts.okfProducer ?? `human:${opts.user.id}`,
      knowledgeChanged: shouldConvert,
      at: new Date()
    })

    await wiki.models.knex.transaction(async transaction => {
      const authorizationTags = await lockPageForMutation(transaction, ogPage)
      if (authorizationTags === undefined) {
        if (ogPage.visibility === 'private') throw new wiki.Error.PageNotFound()
        throw new wiki.Error.PageUpdateForbidden()
      }
      const authority = await wiki.auth.loadPageRuleAuthority(opts.user, transaction)
      const context = pageAccessContext({ ...ogPage, tags: authorizationTags })
      if (context === null || !canWritePage(opts.user, context, authority)) {
        if (ogPage.visibility === 'private') throw new wiki.Error.PageNotFound()
        throw new wiki.Error.PageUpdateForbidden()
      }
      const historyPage = {
        ...ogPage,
        tags: authorizationTags,
        isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
        isSearchable: ogPage.isSearchable !== false && ogPage.isSearchable !== 0
      }
      if (shouldConvert) {
        await wiki.models.pageHistory.addVersion({
          ...historyPage,
          action: 'updated',
          versionDate: ogPage.updatedAt,
          transaction
        })
      }
      const changedRows = await wiki.models.pages
        .query(transaction)
        .patch({
          contentType: targetContentType,
          editorKey: opts.editor,
          ...(convertedContent ? { content: convertedContent } : {}),
          ...(shouldConvert
            ? {
                extra: {
                  ...ogPage.extra,
                  okf: okfMetadata
                }
              }
            : {}),
          renderedSourceRevision: null
        })
        .where({ id: ogPage.id, sourceRevision: ogPage.sourceRevision })
      if (changedRows !== 1) throw pageUpdateConflict()
      await writePageOutboxEvent(transaction, 'page.updated', ogPage, opts.user)
      await enqueueCurrentPageProjections(transaction, ogPage.id, 'convert')
    })
    const page = await wiki.models.pages.getPageFromDb(ogPage.id)
    if (!page) {
      throw new wiki.Error.PageNotFound()
    }
    schedulePageRerenders([page.id])

    await wiki.models.pages.deletePageFromCache(page.hash)
    wiki.events.outbound.emit('deletePageFromCache', page.hash)

    if (page.visibility === 'public') {
      await wiki.models.storage.pageEvent({
        event: 'updated',
        page
      })
    }
    await notifyCollaboration(page.id)
  }

  /**
   * Move a Page
   *
   * @param {Object} opts Page Properties
   * @returns {Promise} Promise with no value
   */
  static async movePage(opts: MovePageOptions): Promise<void | PageMoveReceipt> {
    rejectApiPrincipalMutation(opts.user)
    if (opts.updateLinks === true) {
      if (typeof opts.reviewToken !== 'string') {
        throw new errors.ApplicationError('A valid reviewed link-repair token is required.', { code: 'MOVE_REVIEW_REQUIRED', status: 400 })
      }
      return commitReviewedMovePage(opts)
    }
    if (opts.reviewToken !== undefined) {
      throw new errors.ApplicationError('A reviewed link-repair token requires explicit link-repair opt-in.', { code: 'INVALID_INPUT', status: 400 })
    }
    let page: Page | undefined
    if (opts.id !== undefined) {
      page = await wiki.models.pages.query().findById(opts.id)
    } else {
      page = await wiki.models.pages.query().findOne({
        path: opts.path,
        localeCode: opts.locale,
        visibility: 'public',
        ownerId: null
      })
    }
    if (!page) {
      throw new wiki.Error.PageNotFound()
    }
    if (page.visibility === 'public') await loadPageTags(page)
    const preflightAuthority = await wiki.auth.loadPageRuleAuthority(opts.user)
    if (page.visibility === 'private' && !canWritePage(opts.user, page, preflightAuthority)) {
      throw new wiki.Error.PageNotFound()
    }
    if (opts.expectedSourceRevision && String(page.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
    if (!canWritePage(opts.user, page, preflightAuthority)) {
      throw new wiki.Error.PageMoveForbidden()
    }

    if (
      opts.destinationPath.includes('.') ||
      opts.destinationPath.includes(' ') ||
      opts.destinationPath.includes('\\') ||
      opts.destinationPath.includes('//')
    ) {
      throw new wiki.Error.PageIllegalPath()
    }
    if (opts.destinationPath.endsWith('/')) {
      opts.destinationPath = opts.destinationPath.slice(0, -1)
    }
    if (opts.destinationPath.startsWith('/')) {
      opts.destinationPath = opts.destinationPath.slice(1)
    }

    const destinationHash = pageHelper.generateHash({
      path: opts.destinationPath,
      locale: opts.destinationLocale,
      visibility: page.visibility,
      ownerId: page.ownerId
    })
    const destinationTitle = page.title === _.last(page.path.split('/')) ? (_.last(opts.destinationPath.split('/')) ?? page.title) : page.title
    const pageExtra: PageExtra = _.isPlainObject(page.extra) ? page.extra : {}
    const okfMetadata = invalidateOkfVerification(
      mutateOkfMetadata({
        existing: pageExtra.okf,
        producer: opts.okfProducer ?? `human:${opts.user.id}`,
        knowledgeChanged: true,
        at: new Date()
      })
    )
    await wiki.models.knex.transaction(async transaction => {
      const authorizationTags = await lockPageForMutation(transaction, page)
      if (authorizationTags === undefined) throw new wiki.Error.PageMoveForbidden()
      const authority = await wiki.auth.loadPageRuleAuthority(opts.user, transaction)
      const currentContext = pageAccessContext({ ...page, tags: authorizationTags })
      const proposedContext = pageAccessContext(page, {
        path: opts.destinationPath,
        localeCode: opts.destinationLocale,
        tags: authorizationTags
      })
      if (currentContext === null || !canWritePage(opts.user, currentContext, authority)) {
        if (page.visibility === 'private') throw new wiki.Error.PageNotFound()
        throw new wiki.Error.PageMoveForbidden()
      }
      if (proposedContext === null || !canWritePage(opts.user, proposedContext, authority)) throw new wiki.Error.PageMoveForbidden()
      if (page.visibility === 'public' && !hasPagePermission(opts.user, ['write:pages'], proposedContext, authority)) {
        throw new wiki.Error.PageMoveForbidden()
      }
      const destinationPage = await wiki.models.pages.query(transaction).findOne({
        path: opts.destinationPath,
        localeCode: opts.destinationLocale,
        visibility: page.visibility,
        ownerId: page.ownerId
      })
      if (destinationPage) throw new wiki.Error.PagePathCollision()
      const historyPage = {
        ...page,
        tags: authorizationTags,
        isPublished: page.isPublished === true || page.isPublished === 1,
        isSearchable: page.isSearchable !== false && page.isSearchable !== 0
      }
      await wiki.models.pageHistory.addVersion({
        ...historyPage,
        action: 'moved',
        versionDate: page.updatedAt,
        transaction
      })
      const localeRelationPatch = await localeRelationMovePatch(transaction, page, opts.destinationLocale)
      const changedRows = await wiki.models.pages
        .query(transaction)
        .patch({
          path: opts.destinationPath,
          localeCode: opts.destinationLocale,
          title: destinationTitle,
          hash: destinationHash,
          ...localeRelationPatch,
          extra: {
            ...pageExtra,
            okf: okfMetadata
          },
          renderedSourceRevision: null
        })
        .where({ id: page.id, sourceRevision: page.sourceRevision })
      if (changedRows !== 1) throw pageUpdateConflict()
      await writePageOutboxEvent(
        transaction,
        'page.moved',
        {
          ...page,
          path: opts.destinationPath,
          localeCode: opts.destinationLocale,
          title: destinationTitle
        },
        opts.user
      )
      await enqueueCurrentPageProjections(transaction, page.id, 'move', projectionLocation(page))
    })
    let movedPage: Page | undefined
    await deliverAfterPageCommit('committed page refresh', async () => {
      const current = await wiki.models.pages.getPageFromDb(page.id)
      if (!current) throw new wiki.Error.PageNotFound()
      movedPage = current
    })
    schedulePageRerenders([page.id])
    for (const hash of new Set([page.hash, destinationHash])) {
      await deliverAfterPageCommit('cache eviction', () => wiki.models.pages.deletePageFromCache(hash))
      try {
        wiki.events.outbound.emit('deletePageFromCache', hash)
      } catch (error) {
        wiki.logger.warn(`Page move committed; cache eviction notification remains pending: ${String(error)}`)
      }
    }
    await deliverAfterPageCommit('page-tree rebuild', () => wiki.models.pages.rebuildTree())
    if (page.visibility === 'public') {
      if (!opts.skipStorage && movedPage) {
        await deliverAfterPageCommit('renamed-page storage delivery', () => wiki.models.storage.pageEvent({
          event: 'renamed',
          page: {
            ...movedPage!,
            hash: page.hash,
            path: page.path,
            localeCode: page.localeCode,
            destinationPath: opts.destinationPath,
            destinationLocaleCode: opts.destinationLocale,
            destinationHash,
            moveAuthorId: opts.user.id,
            moveAuthorName: opts.user.name,
            moveAuthorEmail: opts.user.email
          }
        }))
      }
      if (!opts.skipStorage && !movedPage) wiki.logger.warn('Page move committed; renamed-page storage delivery remains pending because the committed page could not be loaded.')
      await deliverAfterPageCommit('old-route link-state refresh', () =>
        wiki.models.pages.reconnectLinks({ locale: page.localeCode, path: page.path, mode: 'delete' }))
      await deliverAfterPageCommit('new-route link-state refresh', () =>
        wiki.models.pages.reconnectLinks({ locale: opts.destinationLocale, path: opts.destinationPath, mode: 'create' }))
    }
    await notifyCollaboration(page.id, true)
  }

  static async deletePage(opts: DeletePageOptions): Promise<void> {
    rejectApiPrincipalMutation(opts.user)
    const page = await wiki.models.pages.getPageFromDb(
      opts.id !== undefined
        ? opts.id
        : {
            path: opts.path,
            locale: opts.locale,
            visibility: 'public',
            ownerId: null
          }
    )
    const preflightAuthority = await wiki.auth.loadPageRuleAuthority(opts.user)
    if (!page || (page.visibility === 'private' && !canDeletePage(opts.user, page, preflightAuthority))) {
      throw new wiki.Error.PageNotFound()
    }
    if (!canDeletePage(opts.user, page, preflightAuthority)) {
      throw new wiki.Error.PageDeleteForbidden()
    }
    if (opts.expectedSourceRevision && String(page.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
    if (!opts.user) {
      throw new wiki.Error.PageDeleteForbidden()
    }
    const user = opts.user

    await wiki.models.knex.transaction(async transaction => {
      const authorizationTags = await lockPageForMutation(transaction, page)
      if (authorizationTags === undefined) throw new wiki.Error.PageNotFound()
      const authority = await wiki.auth.loadPageRuleAuthority(user, transaction)
      if (!canDeletePage(user, { ...page, tags: authorizationTags }, authority)) throw new wiki.Error.PageDeleteForbidden()
      const deletionVersion = await wiki.models.pageHistory.addVersion({
        ...page,
        action: 'deleted',
        versionDate: page.updatedAt,
        transaction
      })
      const protection = (await transaction('pageAccessPasswords').where({ pageId: page.id }).forUpdate().first()) as
        | { passwordHash: unknown; version: unknown; updatedBy: unknown; updatedAt: unknown }
        | undefined
      const securityContext = DeletedPageRecoverySecurityContextSchema.parse({
        version: 1,
        former: {
          path: page.path,
          localeCode: page.localeCode,
          visibility: page.visibility,
          ownerId: page.ownerId,
          tags: authorizationTags.map(tag => tag.tag)
        },
        protection: protection
          ? {
              passwordHash: protection.passwordHash,
              version: Number(protection.version),
              updatedBy: protection.updatedBy === null ? null : Number(protection.updatedBy),
              updatedAt: protection.updatedAt instanceof Date ? protection.updatedAt.toISOString() : String(protection.updatedAt)
            }
          : null
      })
      const bumpedRows = await transaction('pages')
        .where({ id: page.id, sourceRevision: page.sourceRevision })
        .update({ sourceRevision: transaction.raw('"sourceRevision" + 1') })
      if (bumpedRows !== 1) throw pageUpdateConflict()
      const deletionRevision = (await transaction('pages').select('sourceRevision').where({ id: page.id }).forUpdate().first()) as
        | { sourceRevision: string | number }
        | undefined
      if (!deletionRevision) throw new wiki.Error.PageNotFound()
      await transaction('deletedPageRecovery').insert({
        pageId: page.id,
        deletionVersionId: deletionVersion.id,
        deletionRevision: String(deletionRevision.sourceRevision),
        securityContext,
        createdAt: new Date()
      })
      await enqueuePageMutationEffects(transaction, {
        pageId: page.id,
        sourceRevision: deletionRevision.sourceRevision,
        desiredState: 'absent',
        action: 'delete',
        previousLocation: projectionLocation(page)
      })
      await writePageOutboxEvent(transaction, 'page.deleted', page, user)
      await wiki.models.pages.query(transaction).delete().where('id', page.id)
    })
    await notifyCollaboration(page.id)
    await wiki.models.pages.deletePageFromCache(page.hash)
    wiki.events.outbound.emit('deletePageFromCache', page.hash)
    await wiki.models.pages.rebuildTree()
    if (page.visibility === 'public') {
      if (!opts.skipStorage) {
        await wiki.models.storage.pageEvent({
          event: 'deleted',
          page
        })
      }
      await wiki.models.pages.reconnectLinks({
        locale: page.localeCode,
        path: page.path,
        mode: 'delete'
      })
    }
  }

  static async restoreDeletedPage(opts: RestoreDeletedPageOptions): Promise<{ pageId: number; sourceRevision: string; quarantined: boolean }> {
    rejectApiPrincipalMutation(opts.user)
    if (
      !Number.isSafeInteger(opts.pageId) ||
      opts.pageId <= 0 ||
      !Number.isSafeInteger(opts.deletionVersionId) ||
      opts.deletionVersionId <= 0 ||
      !Number.isSafeInteger(opts.recoveringAdminId) ||
      opts.recoveringAdminId <= 0 ||
      principalId(opts.user) !== opts.recoveringAdminId ||
      !managesSystem(opts.user) ||
      typeof opts.legacyQuarantine !== 'boolean'
    ) {
      throw new errors.ApplicationError('The deleted page changed or is no longer recoverable.', { status: 404, code: 'PAGE_NOT_FOUND' })
    }
    const destinationPath = assertRecoveryPath(opts.destination?.path)
    const destinationLocale = opts.destination?.localeCode
    if (typeof destinationLocale !== 'string' || destinationLocale.length < 2) {
      throw new errors.ApplicationError('The restore destination locale is invalid.', { status: 400, code: 'INVALID_INPUT' })
    }
    const suppliedSecurityContext =
      opts.securityContext === null ? null : DeletedPageRecoverySecurityContextSchema.safeParse(opts.securityContext)
    if (suppliedSecurityContext !== null && !suppliedSecurityContext.success) throw pageRecoveryConflict()
    const expectedDeletionRevision = pageRecoveryRevision(opts.expectedDeletionRevision)
    if (expectedDeletionRevision === null) throw pageRecoveryConflict()

    let restoredSourceRevision = ''
    let oldHash = ''
    let restoredVisibility: PageVisibility = 'private'
    let restoredOwnerId: number | null = null
    try {
      await wiki.models.knex.transaction(async transaction => {
        if (transaction.client.config.client === 'pg') {
          await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [0x57505243, String(opts.pageId)])
          await transaction.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [
            0x57505244,
            JSON.stringify([destinationLocale, destinationPath])
          ])
        }
        const recoveryAdmin = (await transaction('users')
          .where({ id: opts.recoveringAdminId })
          .forUpdate()
          .first('id', 'isActive')) as { id: number; isActive: boolean | number } | undefined
        if (!recoveryAdmin || (recoveryAdmin.isActive !== true && recoveryAdmin.isActive !== 1)) throw pageRecoveryConflict()

        const existingPage = (await transaction('pages').where({ id: opts.pageId }).forUpdate().first('id')) as { id: number } | undefined
        if (existingPage) throw pageRecoveryConflict()
        const latestVersion = (await transaction('pageHistory')
          .select('id', 'action')
          .where('pageId', opts.pageId)
          .orderBy('versionDate', 'desc')
          .orderBy('id', 'desc')
          .forUpdate()
          .first()) as { id: number; action: string } | undefined
        if (!latestVersion || Number(latestVersion.id) !== opts.deletionVersionId || latestVersion.action !== 'deleted') {
          throw pageRecoveryConflict()
        }
        const history = (await transaction('pageHistory')
          .where({ id: opts.deletionVersionId, pageId: opts.pageId })
          .forUpdate()
          .first()) as DeletedPageHistoryRow | undefined
        if (!history) throw pageRecoveryConflict()
        oldHash = history.hash

        const recoveryRow = (await transaction('deletedPageRecovery')
          .where({ pageId: opts.pageId, deletionVersionId: opts.deletionVersionId })
          .forUpdate()
          .first()) as DeletedPageRecoveryRow | undefined
        const recordRevision = recoveryRow === undefined ? null : pageRecoveryRevision(recoveryRow.deletionRevision)
        const storedSecurityContext =
          recoveryRow === undefined ? null : DeletedPageRecoverySecurityContextSchema.safeParse(parseStoredJson(recoveryRow.securityContext))
        const validStoredSecurityContext = storedSecurityContext?.success === true && recordRevision !== null
        let securityContext: DeletedPageRecoverySecurityContext | null = null
        if (opts.legacyQuarantine) {
          if (validStoredSecurityContext || suppliedSecurityContext !== null) throw pageRecoveryConflict()
        } else {
          if (
            storedSecurityContext === null ||
            !storedSecurityContext.success ||
            recordRevision === null ||
            suppliedSecurityContext === null ||
            !suppliedSecurityContext.success ||
            JSON.stringify(suppliedSecurityContext.data) !== JSON.stringify(storedSecurityContext.data)
          ) {
            throw pageRecoveryConflict()
          }
          securityContext = storedSecurityContext.data
          if (
            securityContext.former.path !== history.path ||
            securityContext.former.localeCode !== history.localeCode ||
            securityContext.former.visibility !== history.visibility ||
            securityContext.former.ownerId !== history.ownerId
          ) {
            throw pageRecoveryConflict()
          }
        }

        const effectMaximumRow = (await transaction('pageMutationOutbox')
          .where({ pageId: opts.pageId })
          .max({ maximumRevision: 'sourceRevision' })
          .first()) as { maximumRevision: string | number | null } | undefined
        const historyRevision = pageRecoveryRevision(history.sourceRevision)
        const effectMaximum = effectMaximumRow?.maximumRevision == null ? null : pageRecoveryRevision(effectMaximumRow.maximumRevision)
        if (historyRevision === null || (effectMaximumRow?.maximumRevision != null && effectMaximum === null)) throw pageRecoveryConflict()
        const fallbackFence = [historyRevision, effectMaximum]
          .filter((revision): revision is bigint => revision !== null)
          .reduce((max, revision) => (revision > max ? revision : max))
        const expectedFence = recordRevision ?? fallbackFence
        if (expectedDeletionRevision !== expectedFence || (recordRevision !== null && recordRevision < historyRevision)) throw pageRecoveryConflict()
        const sourceRevision =
          [historyRevision, recordRevision, effectMaximum]
            .filter((revision): revision is bigint => revision !== null)
            .reduce((max, revision) => (revision > max ? revision : max)) + 1n
        restoredSourceRevision = String(sourceRevision)

        const localeRow = (await transaction('locales').where({ code: destinationLocale }).forShare().first('code')) as { code: string } | undefined
        if (!localeRow) throw new errors.ApplicationError('The restore destination locale is invalid.', { status: 400, code: 'INVALID_INPUT' })
        const editor = wiki.data.editors.find(item => item.key === history.editorKey)
        if (!editor || editor.contentType !== history.contentType) throw pageRecoveryConflict()
        if (typeof history.content !== 'string' || typeof history.title !== 'string' || typeof history.description !== 'string') {
          throw pageRecoveryConflict()
        }

        let visibility: PageVisibility
        let ownerId: number | null
        let recoveryTags: string[]
        let explicitlySelectedOwner = false
        if (securityContext !== null) {
          visibility = securityContext.former.visibility
          recoveryTags = securityContext.former.tags
          if (visibility === 'public') {
            if (opts.ownerId !== undefined) throw new errors.ApplicationError('A public page cannot have an owner.', { status: 400, code: 'INVALID_OWNER' })
            ownerId = null
          } else {
            const formerOwnerId = securityContext.former.ownerId
            const formerOwner = formerOwnerId === null ? undefined : await transaction('users').where({ id: formerOwnerId }).forShare().first('id')
            if (formerOwner) {
              if (opts.ownerId !== undefined && opts.ownerId !== formerOwnerId) {
                throw new errors.ApplicationError('The former page owner is still available.', { status: 409, code: 'INVALID_OWNER' })
              }
              ownerId = formerOwnerId
            } else {
              if (opts.ownerId === undefined || !Number.isSafeInteger(opts.ownerId) || opts.ownerId <= 0) {
                throw new errors.ApplicationError('Choose a valid owner for this private page.', { status: 400, code: 'INVALID_OWNER' })
              }
              ownerId = opts.ownerId
              explicitlySelectedOwner = true
            }
          }
        } else {
          visibility = 'private'
          ownerId = opts.recoveringAdminId
          const archivedTags = (await transaction('pageHistoryTags')
            .leftJoin('tags', 'tags.id', 'pageHistoryTags.tagId')
            .select('tags.tag')
            .where('pageHistoryTags.pageId', opts.deletionVersionId)
            .orderBy('tags.id', 'asc')) as Array<{ tag: unknown }>
          recoveryTags = archivedTags.map(row => row.tag).filter((tag): tag is string => typeof tag === 'string')
        }

        const ownerRow =
          ownerId === null
            ? undefined
            : ((await transaction('users').where({ id: ownerId }).forShare().first('id', 'email', 'isActive', 'isSystem')) as
                | { id: number; email: string; isActive: boolean | number; isSystem: boolean | number }
                | undefined)
        if (
          ownerId !== null &&
          (!ownerRow ||
            ownerRow.email === 'api@localhost' ||
            ownerRow.id === 2 ||
            (explicitlySelectedOwner &&
              ((ownerRow.isActive !== true && ownerRow.isActive !== 1) || ownerRow.isSystem === true || ownerRow.isSystem === 1)))
        ) {
          throw new errors.ApplicationError('Choose a valid owner for this private page.', { status: 400, code: 'INVALID_OWNER' })
        }
        if (securityContext === null && ownerId !== opts.recoveringAdminId) throw pageRecoveryConflict()

        const accessContext = pageAuthorizationContext({
          path: destinationPath,
          localeCode: destinationLocale,
          visibility,
          ownerId,
          tags: recoveryTags.map(tag => ({ tag }))
        })
        const authority = await wiki.auth.loadPageRuleAuthority(opts.user, transaction)
        if (!accessContext || !canWritePage(opts.user, accessContext, authority)) {
          throw new errors.ApplicationError('You do not have permission to restore this page.', { status: 403, code: 'PAGE_RECOVERY_FORBIDDEN' })
        }

        const pageCollision = (await transaction('pages')
          .where({ path: destinationPath, localeCode: destinationLocale, visibility, ownerId })
          .forUpdate()
          .first('id')) as { id: number } | undefined
        if (pageCollision) throw pageRecoveryCollision()
        if (visibility === 'public') {
          const storagePath =
            history.contentType === 'markdown'
              ? okfFilePath(destinationLocale, destinationPath)
              : `${destinationLocale}/${destinationPath}${pageHelper.getFileExtension(history.contentType)}`
          await assertNoStorageAssetCollision(transaction, storagePath)
        }

        const rawExtra = parseStoredJson(history.extra)
        if (!isRecord(rawExtra)) throw pageRecoveryConflict()
        const extra: PageExtra = {
          ...rawExtra,
          pageFeatures: normalizePageFeatures(rawExtra.pageFeatures)
        }
        const now = new Date()
        const nowIso = now.toISOString()
        const hash = pageHelper.generateHash({
          path: destinationPath,
          locale: destinationLocale,
          visibility,
          ownerId
        })
        const tags = [...new Set(recoveryTags)]
        const restoredPage = await wiki.models.pages.query(transaction).insert({
          id: opts.pageId,
          authorId: opts.recoveringAdminId,
          content: history.content,
          creatorId: opts.recoveringAdminId,
          contentType: history.contentType,
          description: history.description,
          editorKey: history.editorKey,
          hash,
          visibility,
          ownerId,
          isPublished: false,
          isSearchable: history.isSearchable === true || history.isSearchable === 1,
          localeCode: destinationLocale,
          path: destinationPath,
          publishEndDate: history.publishEndDate ?? '',
          publishStartDate: history.publishStartDate ?? '',
          title: history.title,
          toc: '[]',
          renderedSourceRevision: null,
          sourceRevision: restoredSourceRevision,
          extra
        })
        await wiki.models.tags.associateTags({ tags, page: restoredPage, transaction })

        await transaction('pageUnlockGrants').where({ pageId: opts.pageId }).delete()
        await transaction('pageAccessPasswords').where({ pageId: opts.pageId }).delete()
        if (securityContext?.protection !== null && securityContext?.protection !== undefined) {
          if (securityContext.protection.version >= Number.MAX_SAFE_INTEGER) throw pageRecoveryConflict()
          await transaction('pageAccessPasswords').insert({
            pageId: opts.pageId,
            passwordHash: securityContext.protection.passwordHash,
            version: securityContext.protection.version + 1,
            updatedBy: opts.recoveringAdminId,
            updatedAt: now
          })
        }

        await wiki.models.pageHistory.addVersion({
          id: opts.pageId,
          authorId: opts.recoveringAdminId,
          content: history.content,
          contentType: history.contentType,
          description: history.description,
          editorKey: history.editorKey,
          hash,
          extra,
          visibility,
          ownerId,
          isPublished: false,
          isSearchable: history.isSearchable === true || history.isSearchable === 1,
          localeCode: destinationLocale,
          path: destinationPath,
          publishEndDate: history.publishEndDate,
          publishStartDate: history.publishStartDate,
          title: history.title,
          action: opts.legacyQuarantine ? 'recovered-quarantined' : 'restored',
          versionDate: nowIso,
          sourceRevision,
          transaction
        })
        const restoredTags = (await transaction('tags')
          .join('pageTags', 'pageTags.tagId', 'tags.id')
          .select('tags.*')
          .where('pageTags.pageId', opts.pageId)
          .orderBy('tags.id', 'asc')) as Tag[]
        restoredPage.tags = restoredTags
        await enqueueCurrentPageProjections(transaction, opts.pageId, 'restore')
        await writePageOutboxEvent(transaction, 'page.restored', restoredPage, opts.user)
        restoredVisibility = visibility
        restoredOwnerId = ownerId
      })
    } catch (error: unknown) {
      if (isRecord(error) && Reflect.get(error, 'code') === '23505') throw pageRecoveryCollision()
      throw error
    }

    const page = await wiki.models.pages.getPageFromDb({
      path: destinationPath,
      locale: destinationLocale,
      visibility: restoredVisibility,
      ownerId: restoredOwnerId
    })
    if (!page || page.id !== opts.pageId) throw pageRecoveryConflict()
    await wiki.models.pages.renderPage(page)
    await wiki.models.pages.deletePageFromCache(oldHash)
    await wiki.models.pages.deletePageFromCache(page.hash)
    wiki.events.outbound.emit('deletePageFromCache', oldHash)
    wiki.events.outbound.emit('deletePageFromCache', page.hash)
    await wiki.models.pages.rebuildTree()
    if (page.visibility === 'public') {
      await wiki.models.storage.pageEvent({ event: 'created', page })
      await wiki.models.pages.reconnectLinks({ locale: page.localeCode, path: page.path, mode: 'create' })
    }
    await notifyCollaboration(page.id, true)
    return { pageId: page.id, sourceRevision: restoredSourceRevision, quarantined: opts.legacyQuarantine }
  }


  static async reconnectLinks(opts: ReconnectLinksOptions): Promise<void | false> {
    const pageHref = `/${opts.locale}/${opts.path}`
    const replaceArgs = {
      from: '',
      to: ''
    }
    switch (opts.mode) {
      case 'create':
        replaceArgs.from = `<a href="${pageHref}" class="is-internal-link is-invalid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        break
      case 'delete':
        replaceArgs.from = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
        replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-invalid-page">`
        break
      default:
        return false
    }

    let affectedPages: Array<Pick<Page, 'id' | 'hash'>>
    if (wiki.config.db.type === 'postgres') {
      const queryPages = await wiki.models.pages
        .query()
        .returning(['id', 'hash'])
        .patch({
          render: wiki.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to]),
          renderedSourceRevision: null
        })
        .whereIn('pages.id', builder => {
          builder.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': opts.path,
            'pageLinks.localeCode': opts.locale
          })
        })
        .castTo<Array<Pick<Page, 'id' | 'hash'>>>()
      affectedPages = queryPages
    } else {
      await wiki.models.pages
        .query()
        .patch({
          render: wiki.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to]),
          renderedSourceRevision: null
        })
        .whereIn('pages.id', builder => {
          builder.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': opts.path,
            'pageLinks.localeCode': opts.locale
          })
        })
      affectedPages = await wiki.models.pages
        .query()
        .select('id', 'hash')
        .whereIn('pages.id', builder => {
          builder.select('pageLinks.pageId').from('pageLinks').where({
            'pageLinks.path': opts.path,
            'pageLinks.localeCode': opts.locale
          })
        })
    }
    for (const page of affectedPages) {
      await wiki.models.pages.deletePageFromCache(page.hash)
      wiki.events.outbound.emit('deletePageFromCache', page.hash)
    }
    schedulePageRerenders(affectedPages.map(page => page.id))
  }

  static async rebuildTree(): Promise<unknown> {
    const rebuildJob = await wiki.scheduler.registerJob({
      name: 'rebuild-tree',
      immediate: true,
      worker: true
    })
    return rebuildJob.finished
  }

  static async renderPage(page: Page): Promise<unknown> {
    const renderJob = await wiki.scheduler.registerJob(
      {
        name: 'render-page',
        immediate: true,
        worker: true
      },
      page.id
    )
    return renderJob.finished
  }

  static async prepareSearchDocument(page: Page): Promise<Page> {
    const pageContents = await wiki.models.pages.query().findById(page.id).select('content', 'render')
    if (!pageContents) throw new wiki.Error.PageNotFound()
    page.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
    await syncProtectedPageAssets(wiki.models.knex, page.id, pageContents.content, pageContents.render)
    return redactProtectedPageForSearch(page)
  }

  static async getPage(opts: PageLookup): Promise<Page | CachedPageResult | false | undefined> {
    let page: Page | CachedPageResult | false | undefined = await wiki.models.pages.getPageFromCache(opts)
    if (!page) {
      page = await wiki.models.pages.getPageFromDb(opts)
      if (page) {
        if (page.render) {
          await wiki.models.pages.savePageToCache(page)
        } else {
          throw new Error('Page has no rendered version. Looks like the Last page render failed. Try to edit the page and save it again.')
        }
      }
    }
    return page
  }

  static async getPageFromDb(opts: number | PageLookup): Promise<Page | undefined> {
    const queryModeID = typeof opts === 'number'
    try {
      return wiki.models.pages
        .query()
        .column([
          'pages.id',
          'pages.path',
          'pages.hash',
          'pages.sourceRevision',
          'pages.renderedSourceRevision',
          'pages.title',
          'pages.description',
          'pages.visibility',
          'pages.ownerId',
          'pages.isPublished',
          'pages.isSearchable',
          'pages.publishStartDate',
          'pages.publishEndDate',
          'pages.content',
          'pages.render',
          'pages.toc',
          'pages.contentType',
          'pages.createdAt',
          'pages.updatedAt',
          'pages.editorKey',
          'pages.localeCode',
          'pages.authorId',
          'pages.creatorId',
          'pages.extra',
          {
            authorName: 'author.name',
            authorEmail: 'author.email',
            creatorName: 'creator.name',
            creatorEmail: 'creator.email'
          }
        ])
        .joinRelated('author')
        .joinRelated('creator')
        .withGraphJoined('tags')
        .modifyGraph<Tag>('tags', builder => {
          builder.select('tag', 'title')
        })
        .where(
          queryModeID
            ? {
                'pages.id': opts
              }
            : {
                'pages.path': opts.path,
                'pages.localeCode': opts.locale,
                'pages.visibility': opts.visibility,
                'pages.ownerId': opts.ownerId
              }
        )
        .first()
    } catch (err: unknown) {
      wiki.logger.warn(err)
      throw err
    }
  }

  static async savePageToCache(page: Page): Promise<void> {
    const cachePath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${page.hash}.bin`)
    await fs.outputFile(
      cachePath,
      wiki.models.pages.cacheSchema.encode({
        id: page.id,
        sourceRevision: String(page.sourceRevision),
        authorId: page.authorId,
        authorName: page.authorName,
        createdAt: page.createdAt,
        creatorId: page.creatorId,
        creatorName: page.creatorName,
        description: page.description,
        editorKey: page.editorKey,
        extra: {
          css: typeof page.extra.css === 'string' ? page.extra.css : '',
          js: typeof page.extra.js === 'string' ? page.extra.js : ''
        },
        visibility: page.visibility,
        ownerId: page.ownerId ?? 0,
        isPublished: page.isPublished === 1 || page.isPublished === true,
        isSearchable: page.isSearchable !== false && page.isSearchable !== 0,
        publishEndDate: page.publishEndDate,
        publishStartDate: page.publishStartDate,
        contentType: page.contentType,
        render: page.render,
        tags: page.tags.map(tag => ({ tag: tag.tag, title: tag.title })),
        title: page.title,
        toc: typeof page.toc === 'string' ? page.toc : JSON.stringify(page.toc),
        updatedAt: page.updatedAt
      })
    )
  }

  static async getPageFromCache(opts: PageLookup): Promise<CachedPageResult | false> {
    const pageHash = pageHelper.generateHash({
      path: opts.path,
      locale: opts.locale,
      visibility: opts.visibility,
      ownerId: opts.ownerId
    })
    const cachePath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${pageHash}.bin`)
    try {
      const pageBuffer = await fs.readFile(cachePath)
      let page: CachedPage
      try {
        page = wiki.models.pages.cacheSchema.decode(pageBuffer)
      } catch {
        await fs.remove(cachePath)
        return false
      }
      const marker = await wiki.models
        .knex<PageCacheIdentityMarker>('pages')
        .select('id', 'hash', 'sourceRevision', 'path', 'localeCode', 'visibility', 'ownerId', 'isSearchable', 'extra')
        .where({
          path: opts.path,
          localeCode: opts.locale,
          visibility: opts.visibility,
          ownerId: opts.ownerId
        })
        .first()
      if (
        marker === undefined ||
        marker.hash !== pageHash ||
        marker.id !== page.id ||
        String(marker.sourceRevision) !== page.sourceRevision ||
        marker.visibility !== page.visibility ||
        marker.ownerId !== (page.ownerId === 0 ? null : page.ownerId) ||
        marker.isSearchable !== page.isSearchable
      ) {
        await fs.remove(cachePath)
        return false
      }
      const liveBranding = pageBrandingFromExtra(marker.extra)
      return {
        ...page,
        extra: liveBranding === undefined ? page.extra : { ...page.extra, branding: liveBranding },
        path: opts.path,
        localeCode: opts.locale,
        ownerId: page.ownerId === 0 ? null : page.ownerId
      }
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        return false
      }
      wiki.logger.error(err)
      throw err
    }
  }

  static async deletePageFromCache(hash: string): Promise<void> {
    return fs.remove(path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${hash}.bin`))
  }

  static async flushCache(): Promise<void> {
    return fs.emptyDir(path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'cache'))
  }

  static async acquireLocaleMigrationLocks(transaction: Knex.Transaction): Promise<void> {
    await transaction.raw('SELECT pg_advisory_xact_lock(?)', [PAGE_TREE_REBUILD_LOCK_ID])
    await transaction.raw('LOCK TABLE "pages" IN SHARE ROW EXCLUSIVE MODE')
  }

  static async migrateToLocale({ sourceLocale, targetLocale, user }: { sourceLocale: string; targetLocale: string; user: PageUser }): Promise<number> {
    rejectApiPrincipalMutation(user)
    const migration = await wiki.models.knex.transaction(async transaction => {
      await wiki.models.pages.acquireLocaleMigrationLocks(transaction)
      const pages = await wiki.models.pages
        .query(transaction)
        .where({ localeCode: sourceLocale })
        .whereNotExists(builder => {
          builder.select('id').from('pages AS pagesm').where('pagesm.localeCode', targetLocale).andWhereRaw('pagesm.path = pages.path')
        })
        .forUpdate()
        .withGraphFetched('tags')
      if (pages.length === 0) return { pages: [] as MigratedPageIdentity[], cacheHashes: [] as string[], rerenderPageIds: [] as number[] }

      const migratedPages: MigratedPageIdentity[] = []
      const cacheHashes = new Set<string>()
      const rerenderPageIds = new Set<number>()
      for (const page of pages) {
        const destinationHash = pageHelper.generateHash({
          path: page.path,
          locale: targetLocale,
          visibility: page.visibility,
          ownerId: page.ownerId
        })
        await wiki.models.pageHistory.addVersion({
          ...page,
          action: 'moved',
          versionDate: page.updatedAt,
          transaction
        })
        const localeRelationPatch = await localeRelationMovePatch(transaction, page, targetLocale)
        const changedRows = await wiki.models.pages
          .query(transaction)
          .patch({
            localeCode: targetLocale,
            hash: destinationHash,
            ...localeRelationPatch,
            renderedSourceRevision: null
          })
          .where({ id: page.id, sourceRevision: page.sourceRevision })
        if (changedRows !== 1) throw pageUpdateConflict()

        const historyRows = await transaction<PageHistoryIdentityRow>('pageHistory')
          .select('id', 'path', 'visibility', 'ownerId')
          .where('pageId', page.id)
          .forUpdate()
        for (const history of historyRows) {
          await transaction('pageHistory')
            .where({ id: history.id })
            .update({
              localeCode: targetLocale,
              hash: pageHelper.generateHash({
                path: history.path,
                locale: targetLocale,
                visibility: history.visibility,
                ownerId: history.ownerId
              })
            })
        }

        const sourceHref = `/${sourceLocale}/${page.path}`
        const destinationHref = `/${targetLocale}/${page.path}`
        for (const linkedPage of await rewriteLinkedPageRenders(
          transaction,
          sourceLocale,
          page.path,
          `<a href="${sourceHref}" class="is-internal-link is-valid-page">`,
          `<a href="${destinationHref}" class="is-internal-link is-valid-page">`
        )) {
          cacheHashes.add(linkedPage.hash)
          rerenderPageIds.add(linkedPage.id)
        }
        await transaction('pageLinks').where({ localeCode: sourceLocale, path: page.path }).update({ localeCode: targetLocale })
        for (const linkedPage of await rewriteLinkedPageRenders(
          transaction,
          targetLocale,
          page.path,
          `<a href="${destinationHref}" class="is-internal-link is-invalid-page">`,
          `<a href="${destinationHref}" class="is-internal-link is-valid-page">`
        )) {
          cacheHashes.add(linkedPage.hash)
          rerenderPageIds.add(linkedPage.id)
        }

        await writePageOutboxEvent(transaction, 'page.moved', { ...page, localeCode: targetLocale }, user)
        await enqueueCurrentPageProjections(transaction, page.id, 'move', projectionLocation(page))
        cacheHashes.add(page.hash)
        rerenderPageIds.add(page.id)
        cacheHashes.add(destinationHash)
        migratedPages.push({ previous: page, destinationHash })
      }
      await replacePageTree(transaction)
      return { pages: migratedPages, cacheHashes: [...cacheHashes], rerenderPageIds: [...rerenderPageIds] }
    })

    for (const hash of migration.cacheHashes) {
      await wiki.models.pages.deletePageFromCache(hash)
      wiki.events.outbound.emit('deletePageFromCache', hash)
    }
    schedulePageRerenders(migration.rerenderPageIds)
    for (const { previous, destinationHash } of migration.pages) {
      const updated = await wiki.models.pages.getPageFromDb(previous.id)
      if (!updated) throw new wiki.Error.PageNotFound()
      if (updated.visibility === 'public') {
        await wiki.models.storage.pageEvent({
          event: 'renamed',
          page: {
            ...updated,
            hash: previous.hash,
            path: previous.path,
            localeCode: previous.localeCode,
            destinationPath: updated.path,
            destinationLocaleCode: updated.localeCode,
            destinationHash,
            moveAuthorId: user.id,
            moveAuthorName: user.name,
            moveAuthorEmail: user.email
          }
        })
      }
      await notifyCollaboration(updated.id, true)
    }
    return migration.pages.length
  }

  static cleanHTML(rawHTML = ''): string {
    const data = striptags(rawHTML || '', [], ' ').replace(emojiRegex(), '')
    return he
      .decode(data)
      .replace(punctuationRegex, ' ')
      .replace(/(\r\n|\n|\r)/gm, ' ')
      .replace(/\s\s+/g, ' ')
      .split(' ')
      .filter(word => word.length > 1)
      .join(' ')
      .toLowerCase()
  }

  static subscribeToEvents(): void {
    wiki.events.inbound.on('deletePageFromCache', (hash: string) => {
      void wiki.models.pages.deletePageFromCache(hash)
    })
    wiki.events.inbound.on('flushCache', () => {
      void wiki.models.pages.flushCache()
    })
  }
}
interface PageMoveRendererConfiguration {
  defaultLocale: string
  namespaced: boolean
  absoluteLinks: boolean
  markdownAllowHTML: boolean
  wikiLinksEnabled: boolean
  digest: string
}

const pageMoveRendererConfiguration = async (): Promise<PageMoveRendererConfiguration> => {
  const getPipeline = wiki.models.renderers?.getRenderingPipeline
  let absoluteLinks = false
  let markdownAllowHTML = true
  let wikiLinksEnabled = false
  if (getPipeline) {
    const [markdown, html] = await Promise.all([getPipeline('markdown'), getPipeline('html')])
    const markdownConfig = markdown.find(stage => stage.key === 'markdownCore')?.config
    const htmlConfig = html.find(stage => stage.key === 'htmlCore')?.config
    markdownAllowHTML =
      typeof markdownConfig !== 'object' || markdownConfig === null || Reflect.get(markdownConfig, 'allowHTML') !== false
    wikiLinksEnabled =
      typeof markdownConfig === 'object' && markdownConfig !== null && Reflect.get(markdownConfig, 'wikilinks') === true
    absoluteLinks =
      typeof htmlConfig === 'object' && htmlConfig !== null && Reflect.get(htmlConfig, 'absoluteLinks') === true
  }
  const defaultLocale = wiki.config.lang.code
  const namespaced = wiki.config.lang.namespacing === true
  const digest = createHash('sha256')
    .update(JSON.stringify({ version: 1, defaultLocale, namespaced, absoluteLinks, markdownAllowHTML, wikiLinksEnabled }), 'utf8')
    .digest('hex')
  return { defaultLocale, namespaced, absoluteLinks, markdownAllowHTML, wikiLinksEnabled, digest }
}

const moveLinkRewrite = (
  page: Page,
  oldTarget: { locale: string; path: string },
  newTarget: { locale: string; path: string },
  config: PageMoveRendererConfiguration
): PageMoveLinkRewriteResult =>
  rewriteMovedPageLinks({
    source: page.content,
    editor: page.editorKey,
    oldTarget,
    newTarget,
    sourcePage: { locale: page.localeCode, path: page.path },
    defaultLocale: config.defaultLocale,
    namespaced: config.namespaced,
    absoluteLinks: config.absoluteLinks,
    markdownAllowHTML: config.markdownAllowHTML,
    wikiLinksEnabled: config.wikiLinksEnabled
  })

const pageMoveReviewStale = (): Error =>
  new errors.ApplicationError('The reviewed pages changed or are no longer eligible. Refresh the link review.', {
    code: 'MOVE_REVIEW_STALE',
    status: 409
  })
const canAccessCurrentPageSource = (
  requester: PageUser,
  page: Page,
  authority: PageRuleAuthority,
  now = Date.now()
): boolean => {
  const publicationWindowOpen =
    (!page.publishStartDate || new Date(page.publishStartDate).valueOf() <= now) &&
    (!page.publishEndDate || new Date(page.publishEndDate).valueOf() >= now)
  const sourceUsesReadPermission =
    page.visibility !== 'public' ||
    ((page.isPublished === true || page.isPublished === 1) && publicationWindowOpen)
  return sourceUsesReadPermission ? canReadPage(requester, page, authority) : canWritePage(requester, page, authority)
}
const reviewedMoveRewrite = (
  page: Page,
  oldTarget: { locale: string; path: string },
  newTarget: { locale: string; path: string },
  config: PageMoveRendererConfiguration
): ReturnType<typeof moveLinkRewrite> => {
  try {
    return moveLinkRewrite(page, oldTarget, newTarget, config)
  } catch {
    throw pageMoveReviewStale()
  }
}

const commitReviewedMovePage = async (opts: MovePageOptions): Promise<PageMoveReceipt> => {
  const requesterId = principalId(opts.user)
  const token = verifyPageMoveReviewToken({
    token: opts.reviewToken,
    secret: wiki.config.sessionSecret,
    requesterId: requesterId ?? -1,
    sessionId: opts.sessionId ?? ''
  })
  if (!token || requesterId === null || opts.id === undefined || !opts.expectedSourceRevision) throw pageMoveReviewStale()

  let destinationPath = opts.destinationPath
  if (destinationPath.includes('.') || destinationPath.includes(' ') || destinationPath.includes('\\') || destinationPath.includes('//')) {
    throw new wiki.Error.PageIllegalPath()
  }
  if (destinationPath.endsWith('/')) destinationPath = destinationPath.slice(0, -1)
  if (destinationPath.startsWith('/')) destinationPath = destinationPath.slice(1)
  if (
    destinationPath.length === 0 ||
    token.targetId !== opts.id ||
    token.expectedSourceRevision !== opts.expectedSourceRevision ||
    token.newTarget.path !== destinationPath ||
    token.newTarget.locale !== opts.destinationLocale ||
    token.selected.some(page => page.id === token.targetId)
  ) throw pageMoveReviewStale()

  const page = await wiki.models.pages.query().findById(opts.id)
  if (!page) throw new wiki.Error.PageNotFound()
  if (page.visibility !== 'public' || page.ownerId !== null || String(page.sourceRevision) !== token.expectedSourceRevision ||
    page.localeCode !== token.oldTarget.locale || page.path !== token.oldTarget.path) throw pageMoveReviewStale()
  await loadPageTags(page)

  const config = await pageMoveRendererConfiguration()
  if (config.digest !== token.configDigest) throw pageMoveReviewStale()
  const oldTarget = token.oldTarget
  const newTarget = token.newTarget
  const movedHash = pageHelper.generateHash({
    path: destinationPath,
    locale: opts.destinationLocale,
    visibility: page.visibility,
    ownerId: page.ownerId
  })
  const movedTitle = page.title === _.last(page.path.split('/')) ? (_.last(destinationPath.split('/')) ?? page.title) : page.title
  const collaboration = new CollaborationRoomStore(wiki.models.knex)
  const committed = await wiki.models.knex.transaction(async transaction => {
    const pageIds = [...new Set([opts.id!, ...token.selected.map(selected => selected.id)])].sort((left, right) => left - right)
    const lockedRows = await transaction('pages').select('id').whereIn('id', pageIds).orderBy('id', 'asc').forUpdate()
    if (lockedRows.length !== pageIds.length) throw pageMoveReviewStale()
    const pages = new Map<number, Page>()
    for (const pageId of pageIds) {
      const current = await wiki.models.pages.query(transaction).findById(pageId)
      if (!current) {
        if (pageId === opts.id) throw new wiki.Error.PageNotFound()
        throw pageMoveReviewStale()
      }
      const tags = await loadPageTags(current, transaction, true)
      current.tags = tags ?? []
      pages.set(pageId, current)
    }

    const currentTarget = pages.get(opts.id!)
    if (!currentTarget) throw new wiki.Error.PageNotFound()
    if (
      currentTarget.visibility !== 'public' ||
      currentTarget.ownerId !== null ||
      String(currentTarget.sourceRevision) !== token.expectedSourceRevision ||
      currentTarget.localeCode !== oldTarget.locale ||
      currentTarget.path !== oldTarget.path
    ) throw pageMoveReviewStale()
    const authority = await wiki.auth.loadPageRuleAuthority(opts.user, transaction)
    const targetContext = pageAccessContext({ ...currentTarget, tags: currentTarget.tags })
    const destinationContext = pageAccessContext(currentTarget, {
      path: destinationPath,
      localeCode: opts.destinationLocale,
      tags: currentTarget.tags
    })
    if (targetContext === null || !canWritePage(opts.user, targetContext, authority) ||
      destinationContext === null || !canWritePage(opts.user, destinationContext, authority) ||
      !hasPagePermission(opts.user, ['write:pages'], destinationContext, authority)) throw new wiki.Error.PageMoveForbidden()
    if (await pageRequiresUnlock({
      requester: opts.user,
      pageId: currentTarget.id,
      sessionId: opts.sessionId ?? '',
      transaction
    })) throw pageMoveReviewStale()

    const destinationLocale = await transaction('locales').where({ code: opts.destinationLocale }).first('code')
    if (!destinationLocale) throw new wiki.Error.PageMoveForbidden()
    const collision = await wiki.models.pages.query(transaction).findOne({
      path: destinationPath,
      localeCode: opts.destinationLocale,
      visibility: currentTarget.visibility,
      ownerId: currentTarget.ownerId
    })
    if (collision) throw new wiki.Error.PagePathCollision()

    const targetBeforeDigest = createHash('sha256').update(currentTarget.content, 'utf8').digest('hex')
    if (targetBeforeDigest !== token.targetBeforeDigest) throw pageMoveReviewStale()
    let targetSource = currentTarget.content
    const targetApprovalActive = await pageHasActiveApproval(transaction, currentTarget.id)
    if (
      !targetApprovalActive &&
      Buffer.byteLength(currentTarget.content, 'utf8') <= 1024 * 1024
    ) {
      targetSource = reviewedMoveRewrite(currentTarget, oldTarget, newTarget, config).source
    }
    const targetAfterDigest = createHash('sha256').update(targetSource, 'utf8').digest('hex')
    if (targetAfterDigest !== token.targetAfterDigest) throw pageMoveReviewStale()
    if (
      targetSource !== currentTarget.content &&
      (Buffer.byteLength(currentTarget.content, 'utf8') > 1024 * 1024 || Buffer.byteLength(targetSource, 'utf8') > 1024 * 1024)
    ) throw pageMoveReviewStale()

    let aggregateSourceBytes = targetSource === currentTarget.content ? 0 : Buffer.byteLength(targetSource, 'utf8')
    const referrerChanges: Array<{ page: Page; source: string }> = []
    for (const reviewed of [...token.selected].sort((left, right) => left.id - right.id)) {
      const referrer = pages.get(reviewed.id)
      if (
        !referrer ||
        referrer.visibility !== 'public' ||
        referrer.ownerId !== null ||
        String(referrer.sourceRevision) !== reviewed.sourceRevision ||
        !canAccessCurrentPageSource(opts.user, referrer, authority) ||
        !canWritePage(opts.user, referrer, authority) ||
        await pageRequiresUnlock({
          requester: opts.user,
          pageId: referrer.id,
          sessionId: opts.sessionId ?? '',
          transaction
        })
      ) throw pageMoveReviewStale()
      const sourceDigest = createHash('sha256').update(referrer.content, 'utf8').digest('hex')
      if (sourceDigest !== reviewed.beforeDigest) throw pageMoveReviewStale()
      const indexed = await transaction('pageLinks')
        .where({ pageId: referrer.id, localeCode: oldTarget.locale, path: oldTarget.path })
        .first('pageId')
      const receipt = await transaction('pageMutationOutbox')
        .where({
          pageId: referrer.id,
          sourceRevision: reviewed.sourceRevision,
          effectKind: 'links',
          desiredState: 'present',
          status: 'succeeded'
        })
        .first('id')
      if (!indexed || !receipt) throw pageMoveReviewStale()
      const rewritten = reviewedMoveRewrite(referrer, oldTarget, newTarget, config)
      const afterDigest = createHash('sha256').update(rewritten.source, 'utf8').digest('hex')
      if (rewritten.changes.length === 0 || rewritten.source === referrer.content ||
        sourceDigest !== reviewed.beforeDigest || afterDigest !== reviewed.afterDigest) throw pageMoveReviewStale()
      const sourceBytes = Buffer.byteLength(referrer.content, 'utf8')
      const rewrittenBytes = Buffer.byteLength(rewritten.source, 'utf8')
      aggregateSourceBytes += rewrittenBytes
      if (sourceBytes > 1024 * 1024 || rewrittenBytes > 1024 * 1024 || aggregateSourceBytes > 4 * 1024 * 1024) {
        throw pageMoveReviewStale()
      }
      if (await pageHasActiveApproval(transaction, referrer.id)) throw pageMoveReviewStale()
      referrerChanges.push({
        page: referrer,
        source: rewritten.source,
      })
    }

    if (targetSource !== currentTarget.content && await pageHasActiveApproval(transaction, currentTarget.id)) {
      throw pageMoveReviewStale()
    }
    const localeRelationPatch = await localeRelationMovePatch(transaction, currentTarget, opts.destinationLocale)
    const targetExtra: PageExtra = _.isPlainObject(currentTarget.extra) ? { ...currentTarget.extra } : {}
    const movedOkfMetadata = invalidateOkfVerification(mutateOkfMetadata({
      existing: targetExtra.okf,
      producer: opts.okfProducer ?? `human:${opts.user.id}`,
      knowledgeChanged: true,
      at: new Date()
    }))
    await saveCanonicalPageRevision({
      transaction,
      page: currentTarget,
      user: opts.user,
      historyPage: {
        ...currentTarget,
        tags: currentTarget.tags,
        isPublished: currentTarget.isPublished === true || currentTarget.isPublished === 1,
        isSearchable: currentTarget.isSearchable !== false && currentTarget.isSearchable !== 0
      },
      historyAction: 'moved',
      patch: {
        path: destinationPath,
        localeCode: opts.destinationLocale,
        title: movedTitle,
        hash: movedHash,
        ...(targetSource === currentTarget.content ? {} : { authorId: opts.user.id }),
        content: targetSource,
        ...localeRelationPatch,
        extra: { ...targetExtra, okf: movedOkfMetadata },
        renderedSourceRevision: null
      },
      eventType: 'page.moved',
      eventPage: { ...currentTarget, path: destinationPath, localeCode: opts.destinationLocale, title: movedTitle },
      projectionAction: 'move',
      previousLocation: projectionLocation(currentTarget)
    })

    const updated: Array<{ id: number; sourceRevision: string }> = []
    for (const change of referrerChanges) {
      const extra: PageExtra = _.isPlainObject(change.page.extra) ? { ...change.page.extra } : {}
      const updatedOkfMetadata = invalidateOkfVerification(mutateOkfMetadata({
        existing: extra.okf,
        producer: opts.okfProducer ?? `human:${opts.user.id}`,
        knowledgeChanged: true,
        at: new Date()
      }))
      await saveCanonicalPageRevision({
        transaction,
        page: change.page,
        user: opts.user,
        historyPage: {
          ...change.page,
          tags: change.page.tags,
          isPublished: change.page.isPublished === true || change.page.isPublished === 1,
          isSearchable: change.page.isSearchable !== false && change.page.isSearchable !== 0
        },
        historyAction: 'updated',
        patch: {
          authorId: opts.user.id,
          content: change.source,
          extra: { ...extra, okf: updatedOkfMetadata },
          renderedSourceRevision: null
        },
        eventType: 'page.updated',
        eventPage: change.page,
        projectionAction: 'update'
      })
      const revisionRow = await transaction('pages').select('sourceRevision').where({ id: change.page.id }).forUpdate().first()
      if (!revisionRow) throw pageMoveReviewStale()
      updated.push({ id: change.page.id, sourceRevision: String(revisionRow.sourceRevision) })
    }
    const movedRevisionRow = await transaction('pages').select('sourceRevision').where({ id: currentTarget.id }).forUpdate().first()
    if (!movedRevisionRow) throw new wiki.Error.PageNotFound()
    const collaborationChanges = [
      ...(targetSource === currentTarget.content ? [] : [{ page: currentTarget, source: targetSource }]),
      ...referrerChanges.map(change => ({ page: change.page, source: change.source }))
    ].sort((left, right) => left.page.id - right.page.id)
    for (const change of collaborationChanges) {
      await collaboration.resetForSourceRepairInTransaction({
        transaction,
        pageId: change.page.id,
        previousSourceRevision: String(change.page.sourceRevision),
        previousSource: change.page.content,
        nextSource: change.source,
        userId: opts.user.id
      })
    }
    return {
      pageId: currentTarget.id,
      sourceRevision: String(movedRevisionRow.sourceRevision),
      updated,
      previousHash: currentTarget.hash,
      destinationHash: movedHash,
      oldTarget,
      newTarget,
      pageIds: [currentTarget.id, ...referrerChanges.map(change => change.page.id)],
      pageHashes: [currentTarget.hash, ...referrerChanges.map(change => change.page.hash)]
    }
  })

  const deliver = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      wiki.logger.warn(`Page move committed; ${label} remains pending: ${String(error)}`)
    }
  }
  schedulePageRerenders(committed.pageIds)
  await deliver('page-tree rebuild', () => wiki.models.pages.rebuildTree())
  for (const hash of new Set([...committed.pageHashes, committed.previousHash, committed.destinationHash])) {
    await deliver('cache eviction', () => wiki.models.pages.deletePageFromCache(hash))
    try {
      wiki.events.outbound.emit('deletePageFromCache', hash)
    } catch (error) {
      wiki.logger.warn(`Page move committed; cache eviction notification remains pending: ${String(error)}`)
    }
  }
  if (!opts.skipStorage) {
    await deliver('renamed-page storage delivery', async () => {
      const movedPage = await wiki.models.pages.getPageFromDb(committed.pageId)
      if (!movedPage || movedPage.visibility !== 'public') return
      return wiki.models.storage.pageEvent({
        event: 'renamed',
        page: {
          ...movedPage,
          hash: committed.previousHash,
          path: committed.oldTarget.path,
          localeCode: committed.oldTarget.locale,
          destinationPath: committed.newTarget.path,
          destinationLocaleCode: committed.newTarget.locale,
          destinationHash: committed.destinationHash,
          moveAuthorId: opts.user.id,
          moveAuthorName: opts.user.name,
          moveAuthorEmail: opts.user.email
        }
      })
    })
    for (const item of committed.updated) {
      await deliver('referrer storage delivery', async () => {
        const updatedPage = await wiki.models.pages.getPageFromDb(item.id)
        if (!updatedPage || updatedPage.visibility !== 'public') return
        return wiki.models.storage.pageEvent({ event: 'updated', page: updatedPage })
      })
    }
  }
  await deliver('old-route link-state refresh', () =>
    wiki.models.pages.reconnectLinks({ locale: committed.oldTarget.locale, path: committed.oldTarget.path, mode: 'delete' }))
  await deliver('new-route link-state refresh', () =>
    wiki.models.pages.reconnectLinks({ locale: committed.newTarget.locale, path: committed.newTarget.path, mode: 'create' }))
  for (const pageId of committed.pageIds) await deliver('collaboration notification', () => notifyCollaboration(pageId, pageId === committed.pageId))
  return {
    message: 'Page has been moved.',
    pageId: committed.pageId,
    sourceRevision: committed.sourceRevision,
    updated: committed.updated,
    projections: 'pending'
  }
}
