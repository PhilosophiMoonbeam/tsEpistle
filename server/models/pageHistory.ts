import { Model } from 'objection'
import _ from 'lodash'
import { DateTime, Duration } from 'luxon'
import Tag from './tags.ts'
import Page from './pages.ts'
import User from './users.ts'
import Editor from './editors.ts'
import Locale from './locales.ts'
import type { PageVisibility } from '../helpers/page-access.ts'

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
}

interface VersionQuery {
  pageId: number
  versionId: number
}

interface HistoryQuery {
  pageId: number
  offsetPage?: number
  offsetSize?: number
}

interface HistoryTrailEntry {
  versionId: number
  authorId: number
  authorName: string
  actionType: string
  valueBefore: string | null
  valueAfter: string | null
  versionDate: string
}

type WikiSource = typeof WIKI
type PageHistoryWikiContext = WikiSource & {
  models: {
    pageHistory: typeof PageHistory
  }
}

const wiki = WIKI as PageHistoryWikiContext

/* global WIKI */

/**
 * Page History model
 */
export default class PageHistory extends Model {
declare id: number
declare pageId: number
declare authorId: number
declare authorName: string
declare path: string
declare hash: string
declare title: string
declare description: string
declare visibility: PageVisibility
declare ownerId: number | null
declare isPublished: boolean
declare publishStartDate: string
declare publishEndDate: string
declare content: string
declare contentType: string
declare editorKey: string
declare localeCode: string
declare action: string
declare versionDate: string
declare createdAt: string
static override get tableName() { return 'pageHistory' } static override get jsonSchema() { return {
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
    publishStartDate: {type: 'string'},
    publishEndDate: {type: 'string'},
    content: {type: 'string'},
    contentType: {type: 'string'},

    createdAt: {type: 'string'}
  }
} } static override get relationMappings() { return {
  tags: {
    relation: Model.ManyToManyRelation,
    modelClass: Tag,
    join: {
      from: 'pageHistory.id',
      through: {
        from: 'pageHistoryTags.pageId',
        to: 'pageHistoryTags.tagId'
      },
      to: 'tags.id'
    }
  },
  page: {
    relation: Model.BelongsToOneRelation,
    modelClass: Page,
    join: {
      from: 'pageHistory.pageId',
      to: 'pages.id'
    }
  },
  author: {
    relation: Model.BelongsToOneRelation,
    modelClass: User,
    join: {
      from: 'pageHistory.authorId',
      to: 'users.id'
    }
  },
  editor: {
    relation: Model.BelongsToOneRelation,
    modelClass: Editor,
    join: {
      from: 'pageHistory.editorKey',
      to: 'editors.key'
    }
  },
  locale: {
    relation: Model.BelongsToOneRelation,
    modelClass: Locale,
    join: {
      from: 'pageHistory.localeCode',
      to: 'locales.code'
    }
  }
} } override $beforeInsert(): void { this.createdAt = new Date().toISOString() } /**
 * Create Page Version
 */
static async addVersion(opts: PageVersionOptions) {
  await wiki.models.pageHistory.query().insert({
    pageId: opts.id,
    authorId: opts.authorId,
    content: opts.content,
    contentType: opts.contentType,
    description: opts.description,
    editorKey: opts.editorKey,
    hash: opts.hash,
    visibility: opts.visibility,
    ownerId: opts.ownerId,
    isPublished: (opts.isPublished === true || opts.isPublished === 1),
    localeCode: opts.localeCode,
    path: opts.path,
    publishEndDate: opts.publishEndDate || '',
    publishStartDate: opts.publishStartDate || '',
    title: opts.title,
    action: opts.action || 'updated',
    versionDate: opts.versionDate
  })
}

/**
 * Get Page Version
 */
static async getVersion({ pageId, versionId }: VersionQuery) {
  const version = await wiki.models.pageHistory.query()
    .column([
      'pageHistory.path',
      'pageHistory.title',
      'pageHistory.description',
      'pageHistory.visibility',
      'pageHistory.ownerId',
      'pageHistory.isPublished',
      'pageHistory.publishStartDate',
      'pageHistory.publishEndDate',
      'pageHistory.content',
      'pageHistory.contentType',
      'pageHistory.createdAt',
      'pageHistory.action',
      'pageHistory.authorId',
      'pageHistory.pageId',
      'pageHistory.versionDate',
      {
        versionId: 'pageHistory.id',
        editor: 'pageHistory.editorKey',
        locale: 'pageHistory.localeCode',
        authorName: 'author.name'
      }
    ])
    .joinRelated('author')
    .where({
      'pageHistory.id': versionId,
      'pageHistory.pageId': pageId
    }).first()
  if (version) {
    return {
      ...version,
      updatedAt: version.createdAt || null,
      tags: []
    }
  } else {
    return null
  }
}

/**
 * Get History Trail of a Page
 */
static async getHistory({ pageId, offsetPage = 0, offsetSize = 100 }: HistoryQuery) {
  const history = await wiki.models.pageHistory.query()
    .column([
      'pageHistory.id',
      'pageHistory.path',
      'pageHistory.authorId',
      'pageHistory.action',
      'pageHistory.versionDate',
      {
        authorName: 'author.name'
      }
    ])
    .joinRelated('author')
    .where({
      'pageHistory.pageId': pageId
    })
    .orderBy('pageHistory.versionDate', 'desc')
    .page(offsetPage, offsetSize)

  let prevPh: PageHistory | null = null
  const upperLimit = (offsetPage + 1) * offsetSize

  if (history.total >= upperLimit) {
    prevPh = await wiki.models.pageHistory.query()
      .column([
        'pageHistory.id',
        'pageHistory.path',
        'pageHistory.authorId',
        'pageHistory.action',
        'pageHistory.versionDate',
        {
          authorName: 'author.name'
        }
      ])
      .joinRelated('author')
      .where({
        'pageHistory.pageId': pageId
      })
      .orderBy('pageHistory.versionDate', 'desc')
      .offset((offsetPage + 1) * offsetSize)
      .limit(1)
      .first() ?? null
  }

  return {
    trail: _.reduce(_.reverse(history.results), (res: HistoryTrailEntry[], ph: PageHistory) => {
      let actionType = 'edit'
      let valueBefore: string | null = null
      let valueAfter: string | null = null

      if (!prevPh && history.total < upperLimit) {
        actionType = 'initial'
      } else if ((prevPh?.path ?? '') !== ph.path) {
        actionType = 'move'
        valueBefore = prevPh?.path ?? ''
        valueAfter = ph.path
      }

      res.unshift({
        versionId: ph.id,
        authorId: ph.authorId,
        authorName: ph.authorName,
        actionType,
        valueBefore,
        valueAfter,
        versionDate: ph.versionDate
      })

      prevPh = ph
      return res
    }, [] as HistoryTrailEntry[]),
    total: history.total
  }
}

/**
 * Purge history older than X
 *
 * @param {String} olderThan ISO 8601 Duration
 */
static async purge (olderThan: string) {
  const dur = Duration.fromISO(olderThan)
  const olderThanISO = DateTime.utc().minus(dur)
  await wiki.models.pageHistory.query().where('versionDate', '<', olderThanISO.toISO()).del()
} }
