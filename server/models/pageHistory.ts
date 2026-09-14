import type { Knex } from 'knex'
import { Model } from 'objection'
import _ from 'lodash'
import { DateTime, Duration } from 'luxon'
import Tag from './tags.ts'
import Page from './pages.ts'
import User from './users.ts'
import Editor from './editors.ts'
import Locale from './locales.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import {
  canReadPage,
  pageAuthorizationContext,
  scopePageQuery,
  type PagePrincipal,
  type PageVisibility,
  type PageVisibilityRecord
} from '../helpers/page-access.ts'

interface PageVersionOptions {
  id: number
  authorId: number
  content: string
  contentType: string
  description: string
  editorKey: string
  hash: string
  extra: unknown
  visibility: PageVisibility
  ownerId: number | null
  isPublished: boolean | number
  isSearchable?: boolean | number
  localeCode: string
  path: string
  publishEndDate?: string | null
  publishStartDate?: string | null
  title: string
  action?: string
  versionDate: string
  sourceRevision?: string | number
  transaction?: Knex.Transaction
}

interface VersionQuery {
  pageId: number
  versionId: number
  requester: PagePrincipal
  authority?: PageRuleAuthority
}

interface HistoryQuery {
  pageId: number
  offsetPage?: number
  requester: PagePrincipal
  offsetSize?: number
  authority?: PageRuleAuthority
}

interface HistoryTrailEntry {
  versionId: number
  authorId: number
  authorName: string
  actionType: string
  valueBefore: string | null
  valueAfter: string | null
  sourceRevision: string | number
  isSearchable: boolean
  versionDate: string
}

type HistoricalTagMap = Map<number, unknown[]>

type WikiSource = typeof WIKI
type PageHistoryWikiContext = WikiSource & {
  auth: {
    checkPageAccess(user: PagePrincipal, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
    loadPageRuleAuthority(requester: PagePrincipal, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  models: {
    knex: Knex
    pageHistory: typeof PageHistory
  }
}

const wiki = WIKI as PageHistoryWikiContext
const normalizeDbBoolean = (value: unknown, fallback = false): boolean => {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return fallback
}

/* global WIKI */

const authorityFor = async (requester: PagePrincipal, supplied?: PageRuleAuthority): Promise<PageRuleAuthority> => {
  if (supplied !== undefined && supplied.requester === requester) return supplied
  return wiki.auth.loadPageRuleAuthority(requester)
}

const isPageVisibility = (value: unknown): value is PageVisibility => value === 'public' || value === 'private'

const isPageOwnerId = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)

const historicalContext = (row: Record<string, unknown>, tags: unknown[]): PageVisibilityRecord | null => {
  const path = Reflect.get(row, 'path')
  const localeValue = Reflect.get(row, 'localeCode')
  const localeCode = localeValue === undefined ? Reflect.get(row, 'locale') : localeValue
  const visibility = Reflect.get(row, 'visibility')
  const ownerId = Reflect.get(row, 'ownerId')
  if (typeof path !== 'string' || path.length === 0 || typeof localeCode !== 'string' || !isPageVisibility(visibility) || !isPageOwnerId(ownerId)) {
    return null
  }
  return { path, localeCode, visibility, ownerId, tags }
}

const historicalRowAuthorized = (row: Record<string, unknown>, tags: unknown[], requester: PagePrincipal, authority: PageRuleAuthority): boolean => {
  const context = historicalContext(row, tags)
  if (context === null) return false
  const page = pageAuthorizationContext(context)
  if (page === null) return false
  if (page.visibility === 'private') return canReadPage(requester, page, authority)
  return wiki.auth.checkPageAccess(requester, ['read:history'], page, authority)
}

const loadHistoricalTags = async (ids: readonly number[]): Promise<HistoricalTagMap> => {
  const tagsByHistoryId: HistoricalTagMap = new Map(ids.map(id => [id, []]))
  if (ids.length === 0) return tagsByHistoryId

  const rows = await wiki.models
    .knex('pageHistoryTags')
    .leftJoin('tags', 'tags.id', 'pageHistoryTags.tagId')
    .select({
      historyId: 'pageHistoryTags.pageId',
      tag: 'tags.tag'
    })
    .whereIn('pageHistoryTags.pageId', ids)
    .orderBy('pageHistoryTags.pageId', 'asc')
    .orderBy('tags.id', 'asc')

  for (const row of rows as Array<Record<string, unknown>>) {
    const historyId = Number(Reflect.get(row, 'historyId'))
    if (!Number.isSafeInteger(historyId) || !tagsByHistoryId.has(historyId)) continue
    tagsByHistoryId.get(historyId)?.push(Reflect.get(row, 'tag'))
  }
  return tagsByHistoryId
}

const historyOrder = (left: Pick<PageHistory, 'versionDate' | 'id'>, right: Pick<PageHistory, 'versionDate' | 'id'>): number => {
  const leftDate = String(left.versionDate ?? '')
  const rightDate = String(right.versionDate ?? '')
  if (leftDate !== rightDate) return rightDate < leftDate ? -1 : 1
  return Number(right.id) - Number(left.id)
}

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
  declare isSearchable: boolean
  declare publishStartDate: string
  declare publishEndDate: string
  declare content: string
  declare contentType: string
  declare editorKey: string
  declare extra: unknown
  declare localeCode: string
  declare action: string
  declare versionDate: string
  declare sourceRevision: string | number
  declare createdAt: string
  static override get tableName() {
    return 'pageHistory'
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
        publishStartDate: { type: 'string' },
        publishEndDate: { type: 'string' },
        content: { type: 'string' },
        contentType: { type: 'string' },
        extra: { type: 'object' },

        sourceRevision: { type: 'integer' },
        createdAt: { type: 'string' }
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
    }
  }
  override $beforeInsert(): void {
    this.createdAt = new Date().toISOString()
  } /**
   * Create Page Version
   */
  static async addVersion(opts: PageVersionOptions) {
    const version = await wiki.models.pageHistory.query(opts.transaction).insert({
      pageId: opts.id,
      authorId: opts.authorId,
      content: opts.content,
      contentType: opts.contentType,
      extra: opts.extra,
      description: opts.description,
      editorKey: opts.editorKey,
      hash: opts.hash,
      visibility: opts.visibility,
      ownerId: opts.ownerId,
      isPublished: normalizeDbBoolean(opts.isPublished),
      isSearchable: normalizeDbBoolean(opts.isSearchable, true),
      localeCode: opts.localeCode,
      path: opts.path,
      publishEndDate: opts.publishEndDate || '',
      publishStartDate: opts.publishStartDate || '',
      title: opts.title,
      action: opts.action || 'updated',
      sourceRevision: Number(opts.sourceRevision ?? 1),
      versionDate: opts.versionDate
    })
    const knex = opts.transaction ?? wiki.models.knex
    const tags = await knex('pageTags').select('tagId').where('pageId', opts.id)
    if (tags.length > 0) {
      await knex('pageHistoryTags').insert(tags.map(({ tagId }) => ({ pageId: version.id, tagId })))
    }
    return version
  }

  /**
   * Get Page Version
   */
  static async getVersion({ pageId, versionId, requester, authority: suppliedAuthority }: VersionQuery) {
    const authority = await authorityFor(requester, suppliedAuthority)
    const identityQuery = wiki.models.pageHistory
      .query()
      .column(['pageHistory.id', 'pageHistory.path', 'pageHistory.localeCode', 'pageHistory.visibility', 'pageHistory.ownerId'])
      .where({
        'pageHistory.id': versionId,
        'pageHistory.pageId': pageId
      })
    scopePageQuery(identityQuery, requester, { table: 'pageHistory', includeAllForSystemManager: true })
    const identity = (await identityQuery.first()) as unknown as Record<string, unknown> | undefined
    if (!identity) return null

    const tagsByHistoryId = await loadHistoricalTags([versionId])
    const historicalTags = tagsByHistoryId.get(versionId)
    if (!historicalTags || !historicalRowAuthorized(identity, historicalTags, requester, authority)) return null

    const query = wiki.models.pageHistory
      .query()
      .column([
        'pageHistory.path',
        'pageHistory.title',
        'pageHistory.description',
        'pageHistory.visibility',
        'pageHistory.ownerId',
        'pageHistory.isPublished',
        'pageHistory.isSearchable',
        'pageHistory.publishStartDate',
        'pageHistory.publishEndDate',
        'pageHistory.content',
        'pageHistory.contentType',
        'pageHistory.extra',
        'pageHistory.createdAt',
        'pageHistory.action',
        'pageHistory.authorId',
        'pageHistory.pageId',
        'pageHistory.sourceRevision',
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
      })
    const version = await query.first()
    if (!version) return null
    version.isSearchable = normalizeDbBoolean(version.isSearchable, true)
    if (!historicalRowAuthorized(version as unknown as Record<string, unknown>, historicalTags, requester, authority)) return null
    return {
      ...version,
      isSearchable: version.isSearchable,
      updatedAt: version.createdAt || null,
      tags: historicalTags.filter((tag): tag is string => typeof tag === 'string')
    }
  }

  /**
   * Get History Trail of a Page
   */
  static async getHistory({ pageId, offsetPage = 0, offsetSize = 100, requester, authority: suppliedAuthority }: HistoryQuery) {
    const authority = await authorityFor(requester, suppliedAuthority)
    const query = wiki.models.pageHistory
      .query()
      .column([
        'pageHistory.id',
        'pageHistory.path',
        'pageHistory.localeCode',
        'pageHistory.visibility',
        'pageHistory.ownerId',
        'pageHistory.authorId',
        'pageHistory.action',
        'pageHistory.sourceRevision',
        'pageHistory.isSearchable',
        'pageHistory.versionDate',
        {
          authorName: 'author.name'
        }
      ])
      .joinRelated('author')
      .where({
        'pageHistory.pageId': pageId
      })
    scopePageQuery(query, requester, { table: 'pageHistory', includeAllForSystemManager: true })
    const rows = (await query.orderBy('pageHistory.versionDate', 'desc').orderBy('pageHistory.id', 'desc')) as unknown as PageHistory[]
    const ids = rows.map(row => Number(row.id)).filter((id): id is number => Number.isSafeInteger(id) && id > 0)
    const tagsByHistoryId = await loadHistoricalTags(ids)
    const authorizedRows: PageHistory[] = []
    for (const row of rows) {
      const historyId = Number(row.id)
      const historicalTags = tagsByHistoryId.get(historyId)
      if (
        !Number.isSafeInteger(historyId) ||
        !historicalTags ||
        !historicalRowAuthorized(row as unknown as Record<string, unknown>, historicalTags, requester, authority)
      ) {
        continue
      }
      authorizedRows.push(row)
    }
    authorizedRows.sort(historyOrder)

    const start = offsetPage * offsetSize
    const selectedRows = authorizedRows.slice(start, start + offsetSize)
    let prevPh: PageHistory | null = authorizedRows[start + offsetSize] ?? null
    const normalizedHistory = selectedRows.map(ph => {
      ph.isSearchable = normalizeDbBoolean(ph.isSearchable, true)
      return ph
    })
    return {
      trail: _.reduce(
        normalizedHistory.slice().reverse(),
        (res: HistoryTrailEntry[], ph: PageHistory) => {
          let actionType = 'edit'
          let valueBefore: string | null = null
          let valueAfter: string | null = null

          if (!prevPh) {
            actionType = 'initial'
          } else if (prevPh.path !== ph.path) {
            actionType = 'move'
            valueBefore = prevPh.path
            valueAfter = ph.path
          }

          res.unshift({
            versionId: ph.id,
            authorId: ph.authorId,
            authorName: ph.authorName,
            actionType,
            valueBefore,
            sourceRevision: ph.sourceRevision,
            isSearchable: ph.isSearchable,
            valueAfter,
            versionDate: ph.versionDate
          })

          prevPh = ph
          return res
        },
        [] as HistoryTrailEntry[]
      ),
      total: authorizedRows.length
    }
  }

  /**
   * Purge history older than X
   *
   * @param {String} olderThan ISO 8601 Duration
   */
  static async purge(olderThan: string) {
    const dur = Duration.fromISO(olderThan)
    const olderThanISO = DateTime.utc().minus(dur)
    await wiki.models.pageHistory.query().where('versionDate', '<', olderThanISO.toISO()).del()
  }
}
