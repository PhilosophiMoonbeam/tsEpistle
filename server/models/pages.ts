import { Model, type StaticHookArguments } from 'objection'
import type { Knex } from 'knex'
import type { EventEmitter } from 'node:events'
import _ from 'lodash'
import { Type as JSBinType } from 'js-binary'
import pageHelper from '../helpers/page.ts'
import path from 'node:path'
import fs from 'fs-extra'
import yaml from 'js-yaml'
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
  isPrivate: boolean
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

interface CachedPageResult extends Omit<CachedPage, 'isPrivate'> {
  path: string
  localeCode: string
  isPrivate: boolean | undefined
}

interface PageLookup {
  path: string
  locale: string
  userId?: number
  isPrivate?: boolean
  privateNS?: string
}

interface CreatePageOptions {
  path: string
  locale: string
  user: PageUser
  content: string
  editor: string
  description: string
  isPrivate: boolean
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
  content: string
  description: string
  isPublished: boolean | number
  title: string
  tags: string[]
  action?: string
  locale?: string
  path?: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  scriptCss?: string
  scriptJs?: string
  skipStorage?: boolean
}

interface ConvertPageOptions {
  id: number
  editor: string
  user: PageUser
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
  isPrivate?: boolean
  skipStorage?: boolean
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
  isPrivate: boolean | number
  isPublished: boolean | number
  localeCode: string
  path: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  title: string
  action?: string
  versionDate: string
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
declare isPrivate: boolean | number
declare isPublished: boolean | number
declare privateNS: string
declare publishStartDate: string
declare publishEndDate: string
declare content: string
declare render: string
declare toc: string | unknown[]
declare contentType: string
declare createdAt: string
declare updatedAt: string
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
    privateNS: {type: 'string'},
    publishStartDate: {type: 'string'},
    publishEndDate: {type: 'string'},
    content: {type: 'string'},
    contentType: {type: 'string'},

    createdAt: {type: 'string'},
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
static override async beforeDelete({ asFindQuery }: StaticHookArguments<Page>): Promise<void> {
  const page = await asFindQuery().select('id')
  const deletedPage = page[0]
  if (!deletedPage) {
    throw new Error('Page deletion hook could not resolve the page id.')
  }
  await wiki.models.comments.query().delete().where('pageId', deletedPage.id)
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
    isPrivate: 'boolean',
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

  // -> Check for page access
  if (!wiki.auth.checkAccess(opts.user, ['write:pages'], {
    locale: opts.locale,
    path: opts.path
  })) {
    throw new wiki.Error.PageDeleteForbidden()
  }

  // -> Check for duplicate
  const dupCheck = await wiki.models.pages.query().select('id').where('localeCode', opts.locale).where('path', opts.path).first()
  if (dupCheck) {
    throw new wiki.Error.PageDuplicateCreate()
  }

  // -> Check for empty content
  if (!opts.content || _.trim(opts.content).length < 1) {
    throw new wiki.Error.PageEmptyContent()
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

  // -> Create page
  await wiki.models.pages.query().insert({
    authorId: opts.user.id,
    content: opts.content,
    creatorId: opts.user.id,
    contentType: wiki.data.editors.find(editor => editor.key === opts.editor)?.contentType ?? 'text',
    description: opts.description,
    editorKey: opts.editor,
    hash: pageHelper.generateHash({ path: opts.path, locale: opts.locale, privateNS: opts.isPrivate ? 'TODO' : '' }),
    isPrivate: opts.isPrivate,
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
  const page = await wiki.models.pages.getPageFromDb({
    path: opts.path,
    locale: opts.locale,
    userId: opts.user.id,
    isPrivate: opts.isPrivate
  })
  if (!page) {
    throw new wiki.Error.PageNotFound()
  }

  // -> Save Tags
  if (opts.tags && opts.tags.length > 0) {
    await wiki.models.tags.associateTags({ tags: opts.tags, page })
  }

  // -> Render page to HTML
  await wiki.models.pages.renderPage(page)

  // -> Rebuild page tree
  await wiki.models.pages.rebuildTree()

  // -> Add to Search Index
  const pageContents = await wiki.models.pages.query().findById(page.id).select('render')
  if (!pageContents) {
    throw new wiki.Error.PageNotFound()
  }
  page.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
  await wiki.data.searchEngine.created(page)

  // -> Add to Storage
  if (!opts.skipStorage) {
    await wiki.models.storage.pageEvent({
      event: 'created',
      page
    })
  }

  // -> Reconnect Links
  await wiki.models.pages.reconnectLinks({
    locale: page.localeCode,
    path: page.path,
    mode: 'create'
  })

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
  if (!ogPage) {
    throw new Error('Invalid Page Id')
  }

  // -> Check for page access
  if (!wiki.auth.checkAccess(opts.user, ['write:pages'], {
    locale: ogPage.localeCode,
    path: ogPage.path
  })) {
    throw new wiki.Error.PageUpdateForbidden()
  }

  // -> Check for empty content
  if (!opts.content || _.trim(opts.content).length < 1) {
    throw new wiki.Error.PageEmptyContent()
  }

  // -> Create version snapshot
  await wiki.models.pageHistory.addVersion({
    ...ogPage,
    isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
    action: opts.action ? opts.action : 'updated',
    versionDate: ogPage.updatedAt
  })

  // -> Format Extra Properties
  if (!_.isPlainObject(ogPage.extra)) {
    ogPage.extra = {}
  }

  // -> Format CSS Scripts
  let scriptCss = typeof ogPage.extra.css === 'string' ? ogPage.extra.css : ''
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
  let scriptJs = typeof ogPage.extra.js === 'string' ? ogPage.extra.js : ''
  if (wiki.auth.checkAccess(opts.user, ['write:scripts'], {
    locale: opts.locale,
    path: opts.path
  })) {
    scriptJs = opts.scriptJs || ''
  }

  // -> Update page
  await wiki.models.pages.query().patch({
    authorId: opts.user.id,
    content: opts.content,
    description: opts.description,
    isPublished: opts.isPublished === true || opts.isPublished === 1,
    publishEndDate: opts.publishEndDate || '',
    publishStartDate: opts.publishStartDate || '',
    title: opts.title,
    extra: {
      ...ogPage.extra,
      js: scriptJs,
      css: scriptCss
    }
  }).where('id', ogPage.id)
  const page = await wiki.models.pages.getPageFromDb(ogPage.id)
  if (!page) {
    throw new wiki.Error.PageNotFound()
  }

  // -> Save Tags
  await wiki.models.tags.associateTags({ tags: opts.tags, page })

  // -> Render page to HTML
  await wiki.models.pages.renderPage(page)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)

  // -> Update Search Index
  const pageContents = await wiki.models.pages.query().findById(page.id).select('render')
  if (!pageContents) {
    throw new wiki.Error.PageNotFound()
  }
  page.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
  await wiki.data.searchEngine.updated(page)

  // -> Update on Storage
  if (!opts.skipStorage) {
    await wiki.models.storage.pageEvent({
      event: 'updated',
      page
    })
  }

  // -> Perform move?
  if ((opts.locale && opts.locale !== page.localeCode) || (opts.path && opts.path !== page.path)) {
    // -> Check target path access
    if (!wiki.auth.checkAccess(opts.user, ['write:pages'], {
      locale: opts.locale,
      path: opts.path
    })) {
      throw new wiki.Error.PageMoveForbidden()
    }

    await wiki.models.pages.movePage({
      id: page.id,
      destinationLocale: opts.locale ?? page.localeCode,
      destinationPath: opts.path ?? page.path,
      user: opts.user
    })
  } else {
    // -> Update title of page tree entry
    await wiki.models.knex.table('pageTree').where({
      pageId: page.id
    }).update('title', page.title)
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
 * Convert an Existing Page
 *
 * @param {Object} opts Page Properties
 * @returns {Promise} Promise of the Page Model Instance
 */
static async convertPage(opts: ConvertPageOptions): Promise<void> {
  // -> Fetch original page
  const ogPage = await wiki.models.pages.query().findById(opts.id)
  if (!ogPage) {
    throw new Error('Invalid Page Id')
  }

  if (ogPage.editorKey === opts.editor) {
    throw new Error('Page is already using this editor. Nothing to convert.')
  }

  // -> Check for page access
  if (!wiki.auth.checkAccess(opts.user, ['write:pages'], {
    locale: ogPage.localeCode,
    path: ogPage.path
  })) {
    throw new wiki.Error.PageUpdateForbidden()
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

        convertedContent = $.html('body').replace('<body>', '').replace('</body>', '').replace(/&#x([0-9a-f]{1,6});/ig, (entity, code) => {
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

  // -> Create version snapshot
  if (shouldConvert) {
    await wiki.models.pageHistory.addVersion({
      ...ogPage,
      isPublished: ogPage.isPublished === true || ogPage.isPublished === 1,
      action: 'updated',
      versionDate: ogPage.updatedAt
    })
  }

  // -> Update page
  await wiki.models.pages.query().patch({
    contentType: targetContentType,
    editorKey: opts.editor,
    ...(convertedContent ? { content: convertedContent } : {})
  }).where('id', ogPage.id)
  const page = await wiki.models.pages.getPageFromDb(ogPage.id)
  if (!page) {
    throw new wiki.Error.PageNotFound()
  }

  await wiki.models.pages.deletePageFromCache(page.hash)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)

  // -> Update on Storage
  await wiki.models.storage.pageEvent({
    event: 'updated',
    page
  })
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
      localeCode: opts.locale
    })
  }
  if (!page) {
    throw new wiki.Error.PageNotFound()
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

  if (!wiki.auth.checkAccess(opts.user, ['manage:pages'], {
    locale: page.localeCode,
    path: page.path
  })) {
    throw new wiki.Error.PageMoveForbidden()
  }
  if (!wiki.auth.checkAccess(opts.user, ['write:pages'], {
    locale: opts.destinationLocale,
    path: opts.destinationPath
  })) {
    throw new wiki.Error.PageMoveForbidden()
  }

  const destinationPage = await wiki.models.pages.query().findOne({
    path: opts.destinationPath,
    localeCode: opts.destinationLocale
  })
  if (destinationPage) {
    throw new wiki.Error.PagePathCollision()
  }

  await wiki.models.pageHistory.addVersion({
    ...page,
    action: 'moved',
    versionDate: page.updatedAt
  })

  const destinationHash = pageHelper.generateHash({
    path: opts.destinationPath,
    locale: opts.destinationLocale,
    privateNS: opts.isPrivate ? 'TODO' : ''
  })
  const destinationTitle = page.title === _.last(page.path.split('/'))
    ? (_.last(opts.destinationPath.split('/')) ?? page.title)
    : page.title

  await wiki.models.pages.query().patch({
    path: opts.destinationPath,
    localeCode: opts.destinationLocale,
    title: destinationTitle,
    hash: destinationHash
  }).findById(page.id)
  await wiki.models.pages.deletePageFromCache(page.hash)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)
  await wiki.models.pages.rebuildTree()

  const pageContents = await wiki.models.pages.query().findById(page.id).select('render')
  if (!pageContents) {
    throw new wiki.Error.PageNotFound()
  }
  page.safeContent = wiki.models.pages.cleanHTML(pageContents.render)
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

static async deletePage(opts: DeletePageOptions): Promise<void> {
  const page = await wiki.models.pages.getPageFromDb(opts.id !== undefined ? opts.id : {
    path: opts.path,
    locale: opts.locale
  })
  if (!page) {
    throw new wiki.Error.PageNotFound()
  }

  if (!wiki.auth.checkAccess(opts.user, ['delete:pages'], {
    locale: page.locale,
    path: page.path
  })) {
    throw new wiki.Error.PageDeleteForbidden()
  }

  await wiki.models.pageHistory.addVersion({
    ...page,
    action: 'deleted',
    versionDate: page.updatedAt
  })
  await wiki.models.pages.query().delete().where('id', page.id)
  await wiki.models.pages.deletePageFromCache(page.hash)
  wiki.events.outbound.emit('deletePageFromCache', page.hash)
  await wiki.models.pages.rebuildTree()
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
        'pages.isPrivate',
        'pages.isPublished',
        'pages.privateNS',
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
        'pages.localeCode': opts.locale
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
    isPrivate: page.isPrivate === 1 || page.isPrivate === true,
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
    privateNS: opts.isPrivate ? 'TODO' : ''
  })
  const cachePath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, `cache/${pageHash}.bin`)
  try {
    const pageBuffer = await fs.readFile(cachePath)
    const page = wiki.models.pages.cacheSchema.decode(pageBuffer)
    return {
      ...page,
      path: opts.path,
      localeCode: opts.locale,
      isPrivate: opts.isPrivate
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
