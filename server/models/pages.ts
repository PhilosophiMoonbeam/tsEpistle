import { Model, type StaticHookArguments } from 'objection'
import type { Knex } from 'knex'
import type { EventEmitter } from 'node:events'
import _ from 'lodash'
import { Type as JSBinType } from 'js-binary'
import pageHelper from '../helpers/page.ts'
import { canDeletePage, canWritePage, managesSystem, principalId, type PageVisibility } from '../helpers/page-access.ts'
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
import { assertVisualMarkdownCompatible } from '../../shared/visual-markdown.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import { enqueuePageMutationEffects, type PageProjectionPayload } from '../core/page-mutation-outbox.ts'
import { redactProtectedPageForSearch, syncProtectedPageAssets } from '../operations/page-protection.ts'

type UnknownRecord = Record<string, unknown>
type PageErrorConstructor = new () => Error

interface PageUser extends Express.User {
  id: number
  name: string
  email: string
}
interface PageAccessTarget {
  locale?: string | undefined
  path?: string | undefined
}

interface PageExtra extends UnknownRecord {
  css?: string
  js?: string
}

interface CachedPage {
  id: number
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
  title: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  scriptCss?: string
  scriptJs?: string
  tags?: string[]
  skipStorage?: boolean
}

interface UpdatePageOptions {
  id: number
  user: PageUser
  content?: string
  description?: string
  isPublished?: boolean | number
  title?: string
  tags?: string[]
  expectedUpdatedAt?: string
  expectedSourceRevision?: string
  editor?: string
  contentType?: string
  action?: string
  locale?: string
  path?: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  scriptCss?: string
  scriptJs?: string
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
  user: PageUser
  expectedSourceRevision?: string
}

type MovePageOptions = ({
  id: number
  path?: string
  locale?: string
} | {
  id?: undefined
  path: string
  locale: string
}) & {
  destinationPath: string
  destinationLocale: string
  user: PageUser
  skipStorage?: boolean
  expectedSourceRevision?: string
}

type DeletePageOptions = ({
  id: number
  path?: string
  locale?: string
} | {
  id?: undefined
  path: string
  locale: string
}) & {
  user?: PageUser
  skipStorage?: boolean
  expectedSourceRevision?: string
}

type ReconnectLinksOptions = {
  path: string
  locale: string
  mode: 'create' | 'delete'
} | {
  path: string
  locale: string
  sourcePath: string
  sourceLocale: string
  mode: 'move'
}

interface PageVersionOptions {
  id: number
  authorId: number
  content: string
  contentType: string
  description: string
  editorKey: string
  hash: string
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

type StoragePageEvent =
  | { event: 'created' | 'updated' | 'deleted'; page: Page }
  | { event: 'renamed'; page: StorageRenameDetails }

interface EditorDefinition {
  key: string
  contentType: string
}

interface SearchEngine {
  created(page: Page): Promise<unknown>
  updated(page: Page): Promise<unknown>
  deleted(page: Page): Promise<unknown>
  renamed(page: PageRenameDetails): Promise<unknown>
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
    checkAccess(user: PageUser | undefined, permissions: string[], page: PageAccessTarget): boolean
  }
  config: {
    dataPath: string
    db: {
      type: string
    }
  }
  data: {
    editors: EditorDefinition[]
    searchEngine: SearchEngine
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
      addVersion(options: PageVersionOptions): Promise<void>
    }
    pages: typeof Page
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
const pageUpdateConflict = (): Error & { status: number } =>
  Object.assign(new Error('The page changed after history was opened. Reload history before restoring.'), {
    name: 'PageUpdateConflict',
    status: 409
  })

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

const frontmatterRegex = {
  html: /^(<!-{2}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{2}>)?(?:\n|\r)*([\w\W]*)*/,
  legacy: /^(<!-- TITLE: ?([\w\W]+?) ?-{2}>)?(?:\n|\r)?(<!-- SUBTITLE: ?([\w\W]+?) ?-{2}>)?(?:\n|\r)*([\w\W]*)*/i,
  markdown: /^(-{3}(?:\n|\r)([\w\W]+?)(?:\n|\r)-{3})?(?:\n|\r)*([\w\W]*)*/
}

const punctuationRegex = /[!,:;/\\_+\-=()&#@<>$~%^*[\]{}"'|]+|(\.\s)|(\s\.)/ig
// const htmlEntitiesRegex = /(&#[0-9]{3};)|(&#x[a-zA-Z0-9]{2};)/ig

/**
 * Pages model
 */
export default class Page extends Model { declare id: number
declare path: string
declare locale?: string
declare hash: string
declare title: string
declare description: string
declare visibility: PageVisibility
declare ownerId: number | null
declare isPublished: boolean | number
declare publishStartDate: string
declare publishEndDate: string
declare content: string
declare render: string
declare toc: string | unknown[]
declare contentType: string
declare createdAt: string
declare updatedAt: string
declare sourceRevision: string | number
declare editorKey: string
declare localeCode: string
declare authorId: number
declare creatorId: number
declare extra: PageExtra
declare tags: Tag[]
declare authorName: string
declare authorEmail: string
declare creatorName: string
declare creatorEmail: string
declare safeContent: string
static override get tableName() { return 'pages' } static override get jsonSchema() { return {
  type: 'object',
  required: ['path', 'title'],

  properties: {
    id: {type: 'integer'},
    path: {type: 'string'},
    hash: {type: 'string'},
    title: {type: 'string'},
    description: {type: 'string'},
    isPublished: {type: 'boolean'},
    visibility: {type: 'string', enum: ['public', 'private']},
    ownerId: {type: ['integer', 'null']},
    publishEndDate: {type: 'string'},
    content: {type: 'string'},
    contentType: {type: 'string'},

    createdAt: {type: 'string'},
    sourceRevision: {type: 'integer'},
    updatedAt: {type: 'string'}
  }
} } static override get jsonAttributes() { return ['extra'] } static override get relationMappings() { return {
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
} } override $beforeUpdate() { this.updatedAt = new Date().toISOString() } override $beforeInsert() { this.createdAt = new Date().toISOString()
this.updatedAt = new Date().toISOString() } /**
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
 * Inject page metadata into contents
 *
 * @returns {string} Page Contents with Injected Metadata
 */
injectMetadata (): string | Record<string, unknown> {
  return pageHelper.injectPageMetadata({
    ...this,
    isPublished: this.isPublished === true || this.isPublished === 1
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
static parseMetadata (raw: string, contentType: string): UnknownRecord & { content: string } {
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

/**
 * Create a New Page
 *
 * @param {Object} opts Page Properties
 * @returns {Promise} Promise of the Page Model Instance
 */
static async createPage(opts: CreatePageOptions): Promise<Page> {
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

  const ownerId = opts.visibility === 'private' ? principalId(opts.user) : null
  if (opts.visibility === 'private' && ownerId === null) {
    throw new wiki.Error.PageDeleteForbidden()
  }
  if (opts.visibility === 'public' && !wiki.auth.checkAccess(opts.user, ['write:pages'], {
    locale: opts.locale,
    path: opts.path
  })) {
    throw new wiki.Error.PageDeleteForbidden()
  }

  const dupCheck = await wiki.models.pages.query()
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
  if (opts.editor === 'visual-markdown') {
    assertVisualMarkdownCompatible(opts.content)
  }

  // -> Format CSS Scripts
  let scriptCss = ''
  if (wiki.auth.checkAccess(opts.user, ['write:styles'], {
    locale: opts.locale,
    path: opts.path
  })) {
    if (typeof opts.scriptCss === 'string' && !_.isEmpty(opts.scriptCss)) {
      scriptCss = new CleanCSS({ inline: false }).minify(opts.scriptCss).styles
    } else {
      scriptCss = ''
    }
  }

  // -> Format JS Scripts
  let scriptJs = ''
  if (wiki.auth.checkAccess(opts.user, ['write:scripts'], {
    locale: opts.locale,
    path: opts.path
  })) {
    scriptJs = opts.scriptJs || ''
  }

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
      localeCode: opts.locale,
      path: opts.path,
      publishEndDate: opts.publishEndDate || '',
      publishStartDate: opts.publishStartDate || '',
      title: opts.title,
      toc: '[]',
      extra: {
        js: scriptJs,
        css: scriptCss
      }
    })
    if (opts.tags && opts.tags.length > 0) {
      await wiki.models.tags.associateTags({ tags: opts.tags, page: inserted, transaction })
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
    const pageContents = await wiki.models.pages.query().findById(page.id).select('content', 'render')
    if (!pageContents) {
      throw new wiki.Error.PageNotFound()
    }
    page.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
    await syncProtectedPageAssets(wiki.models.knex, page.id, pageContents.content, pageContents.render)
    await redactProtectedPageForSearch(page)
    await wiki.data.searchEngine.created(page)

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
  // -> Fetch original page
  const ogPage = await wiki.models.pages.query().findById(opts.id)
  if (!ogPage || (ogPage.visibility === 'private' && !canWritePage(opts.user, ogPage))) {
    throw new wiki.Error.PageNotFound()
  }
  if (!canWritePage(opts.user, ogPage)) {
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
  if (editorKey === 'visual-markdown') {
    assertVisualMarkdownCompatible(content)
  }


  // -> Format Extra Properties
  if (!_.isPlainObject(ogPage.extra)) {
    ogPage.extra = {}
  }

  // -> Format CSS Scripts
  let scriptCss = typeof ogPage.extra.css === 'string' ? ogPage.extra.css : ''
  if (wiki.auth.checkAccess(opts.user, ['write:styles'], {
    locale: opts.locale ?? ogPage.localeCode,
    path: opts.path ?? ogPage.path
  }) && opts.scriptCss !== undefined) {
    if (!_.isEmpty(opts.scriptCss)) {
      scriptCss = new CleanCSS({ inline: false }).minify(opts.scriptCss).styles
    } else {
      scriptCss = ''
    }
  }

  // -> Format JS Scripts
  let scriptJs = typeof ogPage.extra.js === 'string' ? ogPage.extra.js : ''
  if (wiki.auth.checkAccess(opts.user, ['write:scripts'], {
    locale: opts.locale ?? ogPage.localeCode,
    path: opts.path ?? ogPage.path
  }) && opts.scriptJs !== undefined) {
    scriptJs = opts.scriptJs
  }

  const destinationLocale = opts.locale ?? ogPage.localeCode
  let destinationPath = opts.path ?? ogPage.path
  if (destinationPath.includes('.') || destinationPath.includes(' ') || destinationPath.includes('\\') || destinationPath.includes('//')) {
    throw new wiki.Error.PageIllegalPath()
  }
  if (destinationPath.endsWith('/')) destinationPath = destinationPath.slice(0, -1)
  if (destinationPath.startsWith('/')) destinationPath = destinationPath.slice(1)
  const willMove = destinationLocale !== ogPage.localeCode || destinationPath !== ogPage.path
  if (willMove && ogPage.visibility === 'public' && !wiki.auth.checkAccess(opts.user, ['write:pages'], {
    locale: destinationLocale,
    path: destinationPath
  })) throw new wiki.Error.PageMoveForbidden()
  if (willMove) {
    const collision = await wiki.models.pages.query().findOne({
      path: destinationPath,
      localeCode: destinationLocale,
      visibility: ogPage.visibility,
      ownerId: ogPage.ownerId
    })
    if (collision && collision.id !== ogPage.id) throw new wiki.Error.PagePathCollision()
  }
  const destinationTitle = opts.title ?? (willMove && ogPage.title === _.last(ogPage.path.split('/'))
    ? (_.last(destinationPath.split('/')) ?? ogPage.title)
    : ogPage.title)
  const destinationHash = willMove ? pageHelper.generateHash({
    path: destinationPath,
    locale: destinationLocale,
    visibility: ogPage.visibility,
    ownerId: ogPage.ownerId
  }) : ogPage.hash
  const pageEventType = opts.action === 'restored' ? 'page.restored' : willMove ? 'page.moved' : 'page.updated'
  await wiki.models.knex.transaction(async transaction => {
    await wiki.models.pageHistory.addVersion({
      ...ogPage,
      isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
      action: opts.action ? opts.action : 'updated',
      versionDate: ogPage.updatedAt,
      transaction
    })
    const pagePatch = wiki.models.pages.query(transaction).patch({
      authorId: opts.user.id,
      content,
      contentType: opts.contentType ?? ogPage.contentType,
      description: opts.description ?? ogPage.description,
      editorKey,
      isPublished: opts.isPublished === undefined
        ? (ogPage.isPublished === true || ogPage.isPublished === 1)
        : (opts.isPublished === true || opts.isPublished === 1),
      publishEndDate: opts.publishEndDate === undefined ? ogPage.publishEndDate : (opts.publishEndDate || ''),
      publishStartDate: opts.publishStartDate === undefined ? ogPage.publishStartDate : (opts.publishStartDate || ''),
      title: destinationTitle,
      ...(willMove ? { path: destinationPath, localeCode: destinationLocale, hash: destinationHash } : {}),
      extra: {
        ...ogPage.extra,
        js: scriptJs,
        css: scriptCss
      }
    }).where('id', ogPage.id)
    if (opts.expectedUpdatedAt) pagePatch.where('updatedAt', ogPage.updatedAt)
    if (ogPage.sourceRevision !== undefined) pagePatch.where('sourceRevision', ogPage.sourceRevision)
    const updatedRows = await pagePatch
    if (updatedRows !== 1) throw pageUpdateConflict()
    if (opts.tags !== undefined) {
      const tagsChanged = await wiki.models.tags.associateTags({ tags: opts.tags, page: ogPage, transaction })
      if (tagsChanged && ogPage.sourceRevision !== undefined) {
        await transaction('pages')
          .where({ id: ogPage.id, sourceRevision: ogPage.sourceRevision })
          .update({ sourceRevision: transaction.raw('"sourceRevision" + 1') })
      }
    }
    await writePageOutboxEvent(transaction, pageEventType, {
      ...ogPage,
      path: destinationPath,
      localeCode: destinationLocale,
      title: destinationTitle
    }, opts.user)
    await enqueueCurrentPageProjections(
      transaction,
      ogPage.id,
      opts.action === 'restored' ? 'restore' : willMove ? 'move' : 'update',
      willMove ? projectionLocation(ogPage) : undefined
    )
  })
  const page = await wiki.models.pages.getPageFromDb(ogPage.id)
  if (!page) {
    throw new wiki.Error.PageNotFound()
  }

  // Tags are changed inside the page transaction so restore cannot expose mixed content and metadata.
  // -> Render page to HTML
  await wiki.models.pages.renderPage(page)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)
  if (willMove) wiki.events.outbound.emit('deletePageFromCache', ogPage.hash)

  if (page.visibility === 'public') {
    const pageContents = await wiki.models.pages.query().findById(page.id).select('content', 'render')
    if (!pageContents) throw new wiki.Error.PageNotFound()
    page.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
    await syncProtectedPageAssets(wiki.models.knex, page.id, pageContents.content, pageContents.render)
    await redactProtectedPageForSearch(page)
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
      await wiki.data.searchEngine.renamed(renamedPage)
      if (!opts.skipStorage) {
        await wiki.models.storage.pageEvent({
          event: 'renamed',
          page: {
            ...renamedPage,
            authorName: page.authorName,
            authorEmail: page.authorEmail,
            updatedAt: page.updatedAt,
            tags: page.tags,
            moveAuthorId: opts.user.id,
            moveAuthorName: opts.user.name,
            moveAuthorEmail: opts.user.email
          }
        })
      }
    } else {
      await wiki.data.searchEngine.updated(page)
      if (!opts.skipStorage) await wiki.models.storage.pageEvent({ event: 'updated', page })
    }
  }

  if (willMove) {
    await wiki.models.pages.rebuildTree()
    if (page.visibility === 'public') {
      await wiki.models.pages.reconnectLinks({
        sourceLocale: ogPage.localeCode,
        sourcePath: ogPage.path,
        locale: destinationLocale,
        path: destinationPath,
        mode: 'move'
      })
      await wiki.models.pages.reconnectLinks({
        locale: destinationLocale,
        path: destinationPath,
        mode: 'create'
      })
    }
  } else {
    await wiki.models.knex.table('pageTree').where({ pageId: page.id }).update('title', page.title)
  }

  // -> Get latest updatedAt
  const latestPage = await wiki.models.pages.query().findById(page.id).select('updatedAt')
  if (!latestPage) {
    throw new wiki.Error.PageNotFound()
  }
  page.updatedAt = latestPage.updatedAt
  await notifyCollaboration(page.id, opts.action === 'restored')

  return page
}
static async changeVisibility(opts: ChangeVisibilityOptions): Promise<Page> {
  const page = await wiki.models.pages.getPageFromDb(opts.id)
  if (!page || !canWritePage(opts.user, page)) {
    throw new wiki.Error.PageNotFound()
  }
  if (page.visibility === opts.visibility) return page

  const ownerId = opts.visibility === 'private' ? principalId(opts.user) : null
  if (opts.expectedSourceRevision && String(page.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
  if (opts.visibility === 'private' && ownerId === null) {
    throw new wiki.Error.PageUpdateForbidden()
  }
  if (opts.visibility === 'public') {
    if (!opts.confirmPublication || !wiki.auth.checkAccess(opts.user, ['write:pages'], {
      locale: page.localeCode,
      path: page.path
    })) {
      throw new wiki.Error.PageUpdateForbidden()
    }
  }
  const collision = await wiki.models.pages.query().findOne({
    visibility: opts.visibility,
    ownerId,
    localeCode: page.localeCode,
    path: page.path
  })
  if (collision) throw new wiki.Error.PagePathCollision()

  const hash = pageHelper.generateHash({
    path: page.path,
    locale: page.localeCode,
    visibility: opts.visibility,
    ownerId
  })
  await wiki.models.knex.transaction(async transaction => {
    await wiki.models.pageHistory.addVersion({
      ...page,
      action: opts.visibility === 'private' ? 'made-private' : 'published',
      versionDate: page.updatedAt,
      transaction
    })
    const changedRows = await wiki.models.pages.query(transaction).patch({
      visibility: opts.visibility,
      ownerId,
      hash
    }).where({ id: page.id, sourceRevision: page.sourceRevision })
    if (changedRows !== 1) throw pageUpdateConflict()
    await writePageOutboxEvent(transaction, 'page.visibility-changed', {
      ...page,
      visibility: opts.visibility
    }, opts.user)
    await enqueueCurrentPageProjections(transaction, page.id, 'visibility', projectionLocation(page))
  })
  await wiki.models.pages.deletePageFromCache(page.hash)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)
  await wiki.models.pages.rebuildTree()

  const updated = await wiki.models.pages.getPageFromDb(page.id)
  if (!updated) throw new wiki.Error.PageNotFound()
  const pageContents = await wiki.models.pages.query().findById(page.id).select('content', 'render')
  if (!pageContents) throw new wiki.Error.PageNotFound()
  updated.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
  await syncProtectedPageAssets(wiki.models.knex, updated.id, pageContents.content, pageContents.render)
  await redactProtectedPageForSearch(updated)

  if (updated.visibility === 'public') {
    await wiki.data.searchEngine.created(updated)
    if (!opts.skipStorage) {
      await wiki.models.storage.pageEvent({ event: 'created', page: updated })
    }
    await wiki.models.pages.reconnectLinks({
      locale: updated.localeCode,
      path: updated.path,
      mode: 'create'
    })
  } else {
    await wiki.data.searchEngine.deleted(page)
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
    const changedRows = await wiki.models.pages.query(transaction).patch({ ownerId: opts.ownerId, hash }).where({ id: page.id, sourceRevision: page.sourceRevision })
    if (changedRows !== 1) throw pageUpdateConflict()
    await wiki.models.knex('pageHistory').transacting(transaction)
      .where({ pageId: page.id, visibility: 'private' })
      .update({ ownerId: opts.ownerId })
    await writePageOutboxEvent(transaction, 'page.ownership-transferred', page, opts.user)
    await enqueueCurrentPageProjections(transaction, page.id, 'ownership', projectionLocation(page))
  })
  await wiki.models.pages.deletePageFromCache(page.hash)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)
  await wiki.models.pages.rebuildTree()
  const updated = await wiki.models.pages.getPageFromDb(page.id)
  if (!updated) throw new wiki.Error.PageNotFound()
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
  // -> Fetch original page
  const ogPage = await wiki.models.pages.query().findById(opts.id)
  if (!ogPage || (ogPage.visibility === 'private' && !canWritePage(opts.user, ogPage))) {
    throw new wiki.Error.PageNotFound()
  }
  if (opts.expectedSourceRevision && String(ogPage.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
  if (!canWritePage(opts.user, ogPage)) {
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
          $(tabElm).children('template').each((_templateIndex, templateElm) => {
            if ($(templateElm).attr('v-slot:tabs') === '') {
              $(tabElm).before('<ul class="tabset-headers">' + $(templateElm).html() + '</ul>')
            } else {
              $(tabElm).after('<div class="markdown-tabset">' + $(templateElm).html() + '</div>')
            }
          })
          // -> Parse tab headers
          $(tabElm).prev('.tabset-headers').children().each((_index, element) => {
            tabHeaders.push($(element).html())
          })
          $(tabElm).prev('.tabset-headers').remove()
          // -> Inject tab headers
          $(tabElm).next('.markdown-tabset').children().each((index, element) => {
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
        convertedContent = serializedContent.replace(/&#x([0-9a-f]{1,6});/ig, (entity, code) => {
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
  if (opts.editor === 'visual-markdown') {
    assertVisualMarkdownCompatible(convertedContent !== null ? convertedContent : ogPage.content)
  }

  await wiki.models.knex.transaction(async transaction => {
    if (shouldConvert) {
      await wiki.models.pageHistory.addVersion({
        ...ogPage,
        isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
        action: 'updated',
        versionDate: ogPage.updatedAt,
        transaction
      })
    }
    const changedRows = await wiki.models.pages.query(transaction).patch({
      contentType: targetContentType,
      editorKey: opts.editor,
      ...(convertedContent ? { content: convertedContent } : {})
    }).where({ id: ogPage.id, sourceRevision: ogPage.sourceRevision })
    if (changedRows !== 1) throw pageUpdateConflict()
    await writePageOutboxEvent(transaction, 'page.updated', ogPage, opts.user)
    await enqueueCurrentPageProjections(transaction, ogPage.id, 'convert')
  })
  const page = await wiki.models.pages.getPageFromDb(ogPage.id)
  if (!page) {
    throw new wiki.Error.PageNotFound()
  }

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
static async movePage(opts: MovePageOptions): Promise<void> {
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
  if (page.visibility === 'private' && !canWritePage(opts.user, page)) {
    throw new wiki.Error.PageNotFound()
  }
  if (opts.expectedSourceRevision && String(page.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
  if (!canWritePage(opts.user, page)) {
    throw new wiki.Error.PageMoveForbidden()
  }

  if (opts.destinationPath.includes('.') || opts.destinationPath.includes(' ') || opts.destinationPath.includes('\\') || opts.destinationPath.includes('//')) {
    throw new wiki.Error.PageIllegalPath()
  }
  if (opts.destinationPath.endsWith('/')) {
    opts.destinationPath = opts.destinationPath.slice(0, -1)
  }
  if (opts.destinationPath.startsWith('/')) {
    opts.destinationPath = opts.destinationPath.slice(1)
  }

  if (page.visibility === 'public' && !wiki.auth.checkAccess(opts.user, ['write:pages'], {
    locale: opts.destinationLocale,
    path: opts.destinationPath
  })) {
    throw new wiki.Error.PageMoveForbidden()
  }

  const destinationPage = await wiki.models.pages.query().findOne({
    path: opts.destinationPath,
    localeCode: opts.destinationLocale,
    visibility: page.visibility,
    ownerId: page.ownerId
  })
  if (destinationPage) {
    throw new wiki.Error.PagePathCollision()
  }


  const destinationHash = pageHelper.generateHash({
    path: opts.destinationPath,
    locale: opts.destinationLocale,
    visibility: page.visibility,
    ownerId: page.ownerId
  })
  const destinationTitle = page.title === _.last(page.path.split('/'))
    ? (_.last(opts.destinationPath.split('/')) ?? page.title)
    : page.title

  await wiki.models.knex.transaction(async transaction => {
    await wiki.models.pageHistory.addVersion({
      ...page,
      action: 'moved',
      versionDate: page.updatedAt,
      transaction
    })
    const changedRows = await wiki.models.pages.query(transaction).patch({
      path: opts.destinationPath,
      localeCode: opts.destinationLocale,
      title: destinationTitle,
      hash: destinationHash
    }).where({ id: page.id, sourceRevision: page.sourceRevision })
    if (changedRows !== 1) throw pageUpdateConflict()
    await writePageOutboxEvent(transaction, 'page.moved', {
      ...page,
      path: opts.destinationPath,
      localeCode: opts.destinationLocale,
      title: destinationTitle
    }, opts.user)
    await enqueueCurrentPageProjections(transaction, page.id, 'move', projectionLocation(page))
  })
  await wiki.models.pages.deletePageFromCache(page.hash)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)
  await wiki.models.pages.rebuildTree()

  if (page.visibility === 'public') {
    const pageContents = await wiki.models.pages.query().findById(page.id).select('content', 'render')
    if (!pageContents) {
      throw new wiki.Error.PageNotFound()
    }
    page.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
    await syncProtectedPageAssets(wiki.models.knex, page.id, pageContents.content, pageContents.render)
    await redactProtectedPageForSearch(page)
    const renamedPage: PageRenameDetails = {
      ...page,
      title: destinationTitle,
      destinationPath: opts.destinationPath,
      destinationLocaleCode: opts.destinationLocale,
      destinationHash
    }
    await wiki.data.searchEngine.renamed(renamedPage)

    if (!opts.skipStorage) {
      await wiki.models.storage.pageEvent({
        event: 'renamed',
        page: {
          ...page,
          title: destinationTitle,
          destinationPath: opts.destinationPath,
          destinationLocaleCode: opts.destinationLocale,
          destinationHash,
          moveAuthorId: opts.user.id,
          moveAuthorName: opts.user.name,
          moveAuthorEmail: opts.user.email
        }
      })
    }

    await wiki.models.pages.reconnectLinks({
      sourceLocale: page.localeCode,
      sourcePath: page.path,
      locale: opts.destinationLocale,
      path: opts.destinationPath,
      mode: 'move'
    })
    await wiki.models.pages.reconnectLinks({
      locale: opts.destinationLocale,
      path: opts.destinationPath,
      mode: 'create'
    })
  }
  await notifyCollaboration(page.id, true)
}

static async deletePage(opts: DeletePageOptions): Promise<void> {
  const page = await wiki.models.pages.getPageFromDb(opts.id !== undefined ? opts.id : {
    path: opts.path,
    locale: opts.locale,
    visibility: 'public',
    ownerId: null
  })
  if (!page || (page.visibility === 'private' && !canDeletePage(opts.user, page))) {
    throw new wiki.Error.PageNotFound()
  }
  if (!canDeletePage(opts.user, page)) {
    throw new wiki.Error.PageDeleteForbidden()
  }
  if (opts.expectedSourceRevision && String(page.sourceRevision) !== opts.expectedSourceRevision) throw pageUpdateConflict()
  if (!opts.user) {
    throw new wiki.Error.PageDeleteForbidden()
  }
  const user = opts.user

  await wiki.models.knex.transaction(async transaction => {
    await wiki.models.pageHistory.addVersion({
      ...page,
      action: 'deleted',
      versionDate: page.updatedAt,
      transaction
    })
    const bumpedRows = await transaction('pages')
      .where({ id: page.id, sourceRevision: page.sourceRevision })
      .update({ sourceRevision: transaction.raw('"sourceRevision" + 1') })
    if (bumpedRows !== 1) throw pageUpdateConflict()
    const deletionRevision = await transaction('pages')
      .select('sourceRevision')
      .where({ id: page.id })
      .forUpdate()
      .first() as { sourceRevision: string | number } | undefined
    if (!deletionRevision) throw new wiki.Error.PageNotFound()
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
    await wiki.data.searchEngine.deleted(page)

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
    case 'move': {
      const previousPageHref = `/${opts.sourceLocale}/${opts.sourcePath}`
      replaceArgs.from = `<a href="${previousPageHref}" class="is-internal-link is-valid-page">`
      replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
      break
    }
    case 'delete':
      replaceArgs.from = `<a href="${pageHref}" class="is-internal-link is-valid-page">`
      replaceArgs.to = `<a href="${pageHref}" class="is-internal-link is-invalid-page">`
      break
    default:
      return false
  }

  let affectedHashes: string[]
  if (wiki.config.db.type === 'postgres') {
    const queryHashes = await wiki.models.pages.query()
      .returning('hash')
      .patch({
        render: wiki.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to])
      })
      .whereIn('pages.id', builder => {
        builder.select('pageLinks.pageId').from('pageLinks').where({
          'pageLinks.path': opts.path,
          'pageLinks.localeCode': opts.locale
        })
      })
      .castTo<Array<Pick<Page, 'hash'>>>()
    affectedHashes = queryHashes.map(page => page.hash)
  } else {
    await wiki.models.pages.query()
      .patch({
        render: wiki.models.knex.raw('REPLACE(??, ?, ?)', ['render', replaceArgs.from, replaceArgs.to])
      })
      .whereIn('pages.id', builder => {
        builder.select('pageLinks.pageId').from('pageLinks').where({
          'pageLinks.path': opts.path,
          'pageLinks.localeCode': opts.locale
        })
      })
    const queryHashes = await wiki.models.pages.query()
      .column('hash')
      .whereIn('pages.id', builder => {
        builder.select('pageLinks.pageId').from('pageLinks').where({
          'pageLinks.path': opts.path,
          'pageLinks.localeCode': opts.locale
        })
      })
    affectedHashes = queryHashes.map(page => page.hash)
  }
  for (const hash of affectedHashes) {
    await wiki.models.pages.deletePageFromCache(hash)
    wiki.events.outbound.emit('deletePageFromCache', hash)
  }
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
  const renderJob = await wiki.scheduler.registerJob({
    name: 'render-page',
    immediate: true,
    worker: true
  }, page.id)
  return renderJob.finished
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
    return wiki.models.pages.query()
      .column([
        'pages.id',
        'pages.path',
        'pages.hash',
        'pages.title',
        'pages.description',
        'pages.visibility',
        'pages.ownerId',
        'pages.isPublished',
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
      .where(queryModeID ? {
        'pages.id': opts
      } : {
        'pages.path': opts.path,
        'pages.localeCode': opts.locale,
        'pages.visibility': opts.visibility,
        'pages.ownerId': opts.ownerId
      })
      .first()
  } catch (err: unknown) {
    wiki.logger.warn(err)
    throw err
  }
}

static async savePageToCache(page: Page): Promise<void> {
  const cachePath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${page.hash}.bin`)
  await fs.outputFile(cachePath, wiki.models.pages.cacheSchema.encode({
    id: page.id,
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
    publishEndDate: page.publishEndDate,
    publishStartDate: page.publishStartDate,
    contentType: page.contentType,
    render: page.render,
    tags: page.tags.map(tag => ({ tag: tag.tag, title: tag.title })),
    title: page.title,
    toc: typeof page.toc === 'string' ? page.toc : JSON.stringify(page.toc),
    updatedAt: page.updatedAt
  }))
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
    const page = wiki.models.pages.cacheSchema.decode(pageBuffer)
    return {
      ...page,
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

static async migrateToLocale(
  { sourceLocale, targetLocale }: { sourceLocale: string; targetLocale: string }
): Promise<number> {
  return wiki.models.pages.query()
    .patch({
      localeCode: targetLocale
    })
    .where({
      localeCode: sourceLocale
    })
    .whereNotExists(builder => {
      builder.select('id').from('pages AS pagesm').where('pagesm.localeCode', targetLocale).andWhereRaw('pagesm.path = pages.path')
    })
}

static cleanHTML(rawHTML = ''): string {
  const data = striptags(rawHTML || '', [], ' ')
    .replace(emojiRegex(), '')
  return he.decode(data)
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
