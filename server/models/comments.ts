import { Model } from 'objection'
import type { Knex } from 'knex'
import validateValues from '../../shared/validation.ts'

import _ from 'lodash'
import User from './users.ts'
import Page from './pages.ts'
import { canReadPage, pageAuthorizationContext } from '../helpers/page-access.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import { assertPageUnlocked, pageRequiresUnlock } from '../operations/page-protection.ts'
import { rejectApiPrincipalMutation } from '../helpers/api-principal.ts'
import { DISCUSSION_PAGE_LOCK } from '../operations/discussion-moderation.ts'
import { DISCUSSION_SETTINGS_LOCK } from '../operations/discussion-settings.ts'
import { renderCommentMarkdown } from '../helpers/comment-markdown.ts'
import { isCommentWebhookPageEligible } from '../core/webhooks.ts'
import type { CommentWebhookAction } from '../../shared/webhook-events.ts'
import { writeOutboxEvent } from '../core/outbox.ts'
import errors from '../operations/errors.ts'

const { ApplicationError } = errors

interface CommentUser extends Record<string, unknown> {
  id: number
}

interface CommentAction {
  user: CommentUser
  ip: string
  sessionId?: string
}

interface PostCommentOptions extends CommentAction {
  pageId: number
  replyTo?: number
  content: string
  guestName: string
  guestEmail: string
}

interface UpdateCommentOptions extends CommentAction {
  id: number
  content: string
}

interface DeleteCommentOptions extends CommentAction {
  id: number
}

interface CommentPage extends Record<string, unknown> {
  id: number
  path: string
  localeCode: string
  tags: unknown[]
  visibility: 'public' | 'private'
  ownerId: number | null
  isPublished: boolean | number
  isSearchable: boolean | number
  publishStartDate: string | Date | null
  publishEndDate: string | Date | null
}

export default class Comment extends Model {
  declare id: number
  declare content: string
  declare render: string
  declare replyTo: number
  declare isHidden: boolean
  declare name: string
  declare email: string
  declare ip: string
  declare authorId: number
  declare pageId: number
  declare createdAt: string
  declare updatedAt: string

  static override get tableName () { return 'comments' }

  static override get jsonSchema () {
    return {
      type: 'object',
      required: [],
      properties: {
        id: { type: 'integer' },
        content: { type: 'string' },
        render: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        ip: { type: 'string' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' }
      }
    }
  }

  static override get relationMappings () {
    return {
      author: { relation: Model.BelongsToOneRelation, modelClass: User, join: { from: 'comments.authorId', to: 'users.id' } },
      page: { relation: Model.BelongsToOneRelation, modelClass: Page, join: { from: 'comments.pageId', to: 'pages.id' } }
    }
  }

  override $beforeUpdate (): void { this.updatedAt = new Date().toISOString() }
  override $beforeInsert (): void {
    this.createdAt = new Date().toISOString()
    this.updatedAt = new Date().toISOString()
  }

  static async postNewComment ({ pageId, replyTo, content, guestName, guestEmail, user, ip, sessionId = '' }: PostCommentOptions): Promise<unknown> {
    rejectApiPrincipalMutation(user)
    if (user.id === 2) {
      const validation = validateValues({ email: _.toLower(guestEmail), name: guestName }, {
        email: { email: true, length: { maximum: 255 } },
        name: { presence: { allowEmpty: false }, length: { minimum: 2, maximum: 255 } }
      }, { format: 'flat' })
      if (validation?.[0]) throw new wiki.Error.InputInvalid(validation[0])
    }
    content = _.trim(content)
    if (content.length > 50000) throw new wiki.Error.InputInvalid('Comments must be at most 50,000 characters.')
    if (content.length < 2) throw Object.assign(new wiki.Error.CommentContentMissing(), { status: 400 })
    const page = await wiki.models.pages.getPageFromDb(pageId)
    if (!page) throw Object.assign(new wiki.Error.PageNotFound(), { status: 404 })
    const authority = await wiki.auth.loadPageRuleAuthority(user)
    const pageContext = pageAuthorizationContext(page)
    if (page.visibility === 'private' && !canReadPage(user, page, authority)) throw Object.assign(new wiki.Error.PageNotFound(), { status: 404 })
    if (
      !canReadPage(user, page, authority) ||
      pageContext === null ||
      !wiki.auth.checkPageAccess(user, ['write:comments'], pageContext, authority)
    ) {
      throw Object.assign(new wiki.Error.CommentPostForbidden(), { status: 403 })
    }
    await assertPageUnlocked({ requester: user, pageId, sessionId, authority })
    if (typeof wiki.data.commentProvider.create !== 'function') throw new wiki.Error.InputInvalid('Built-in discussions are not the active provider.')
    return wiki.data.commentProvider.create({
      requester: user,
      sessionId,
      page,
      replyTo,
      content,
      user: { ...user, ...(user.id === 2 ? { name: guestName, email: guestEmail } : {}), ip }
    })
  }

  static async updateComment ({ id, content, user, sessionId = '' }: UpdateCommentOptions): Promise<unknown> {
    rejectApiPrincipalMutation(user)
    content = _.trim(content)
    if (content.length < 2 || content.length > 50000) throw new wiki.Error.InputInvalid('Comments must be 2 to 50,000 characters.')
    const renderedContent = renderCommentMarkdown(content)
    return wiki.models.knex.transaction(async transaction => {
      const subject = await transaction('comments').where('id', id).first('pageId')
      if (!subject) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
      const page = await loadDiscussionPageForMutation(transaction, Number(subject.pageId))
      await transaction.raw('SELECT pg_advisory_xact_lock_shared(?, ?)', [DISCUSSION_PAGE_LOCK, page.id])
      await transaction.raw('SELECT pg_advisory_xact_lock_shared(?)', [DISCUSSION_SETTINGS_LOCK])
      const comment = await transaction('comments').where({ id, pageId: page.id }).forUpdate().first()
      if (!comment) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
      await authorizeCommentManagement(user, page, transaction, sessionId)
      const now = new Date()
      await transaction('comments').where({ id, pageId: page.id }).update({ content, render: renderedContent, updatedAt: now.toISOString() })
      if (!comment.isHidden && await anonymousDiscussionIsVisible(transaction, page, now)) {
        await writeCommentWebhookEvent(transaction, page.id, id, 'updated', now)
      }
      return renderedContent
    })
  }

  static async deleteComment ({ id, user, sessionId = '' }: DeleteCommentOptions): Promise<void> {
    rejectApiPrincipalMutation(user)
    await wiki.models.knex.transaction(async transaction => {
      const subject = await transaction('comments').where('id', id).first('pageId')
      if (!subject) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
      const page = await loadDiscussionPageForMutation(transaction, Number(subject.pageId))
      await transaction.raw('SELECT pg_advisory_xact_lock(?, ?)', [DISCUSSION_PAGE_LOCK, page.id])
      await transaction.raw('SELECT pg_advisory_xact_lock_shared(?)', [DISCUSSION_SETTINGS_LOCK])
      const target = await transaction('comments').where({ id, pageId: page.id }).forUpdate().first()
      if (!target) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
      await authorizeCommentManagement(user, page, transaction, sessionId)
      const now = new Date()
      await this.query(transaction).where({ pageId: page.id, replyTo: id }).patch({ replyTo: 0 })
      await this.query(transaction).where({ id, pageId: page.id }).delete()
      if (!target.isHidden && await anonymousDiscussionIsVisible(transaction, page, now)) {
        await writeCommentWebhookEvent(transaction, page.id, id, 'deleted', now)
      }
    })
  }

}

interface CommentProvider {
  create: (input: Record<string, unknown>) => Promise<unknown>
  update: (input: Record<string, unknown>) => Promise<unknown>
  remove: (input: Record<string, unknown>) => Promise<void>
  getPageIdFromCommentId: (id: number) => Promise<number | null>
}

const wiki = WIKI as unknown as {
  Error: {
    InputInvalid: new (message: string) => Error
    CommentContentMissing: new () => Error
    CommentNotFound: new () => Error
    CommentPostForbidden: new () => Error
    CommentManageForbidden: new () => Error
    PageNotFound: new () => Error
  }
  auth: {
    checkAccess: (user: CommentUser, permissions: readonly string[]) => boolean
    checkPageAccess: (user: CommentUser, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority) => boolean
    loadPageRuleAuthority: (requester: CommentUser, transaction?: Knex.Transaction) => Promise<PageRuleAuthority>
  }
  data: { commentProvider: CommentProvider }
  config: { features: Record<string, unknown> }
  models: { knex: Knex, pages: { getPageFromDb: (id: number) => Promise<CommentPage | null> } }
}

const anonymousCommentReader: CommentUser = { id: 2, ownershipUserId: null }

const loadDiscussionPageForMutation = async (transaction: Knex.Transaction, pageId: number): Promise<CommentPage> => {
  const page = await transaction('pages').where('id', pageId).forShare().first()
  if (!page) throw Object.assign(new wiki.Error.PageNotFound(), { status: 404 })
  const tags = await transaction('pageTags')
    .join('tags', 'tags.id', 'pageTags.tagId')
    .where('pageTags.pageId', pageId)
    .select('tags.tag')
  page.tags = tags.map(row => ({ tag: row.tag }))
  return page as CommentPage
}

const authorizeCommentManagement = async (
  user: CommentUser,
  page: CommentPage,
  transaction: Knex.Transaction,
  sessionId: string
): Promise<void> => {
  const authority = await wiki.auth.loadPageRuleAuthority(user, transaction)
  const context = pageAuthorizationContext(page)
  if (page.visibility === 'private' && !canReadPage(user, page, authority)) {
    throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
  }
  if (!canReadPage(user, page, authority) || context === null || !wiki.auth.checkPageAccess(user, ['manage:comments'], context, authority)) {
    throw Object.assign(new wiki.Error.CommentManageForbidden(), { status: 403 })
  }
  if (await pageRequiresUnlock({ requester: user, pageId: page.id, sessionId, transaction })) {
    throw new ApplicationError('Access denied', { status: 403, code: 'PAGE_LOCKED' })
  }
}

const anonymousDiscussionIsVisible = async (
  transaction: Knex.Transaction,
  page: CommentPage,
  now: Date
): Promise<boolean> => {
  const protection = await transaction('pageAccessPasswords').where('pageId', page.id).first('pageId')
  if (!isCommentWebhookPageEligible(page, Boolean(protection), now)) return false
  const featureRow = await transaction('settings').where('key', 'features').first('value')
  const storedFeatures = featureRow?.value
  const features = storedFeatures && typeof storedFeatures === 'object' && !Array.isArray(storedFeatures)
    ? storedFeatures
    : wiki.config.features
  const commentsEnabled = Reflect.get(features, 'featurePageComments') === true || Reflect.get(features, 'featurePageComments') === 1
  if (!commentsEnabled) return false
  const providers = await transaction('commentProviders').where('isEnabled', true).orderBy('key').select('key')
  if (providers.length !== 1 || providers[0].key !== 'default') return false
  const authority = await wiki.auth.loadPageRuleAuthority(anonymousCommentReader, transaction)
  const context = pageAuthorizationContext(page)
  return context !== null &&
    canReadPage(anonymousCommentReader, page, authority) &&
    wiki.auth.checkPageAccess(anonymousCommentReader, ['read:comments'], context, authority)
}

const writeCommentWebhookEvent = async (
  transaction: Knex.Transaction,
  pageId: number,
  commentId: number,
  action: CommentWebhookAction,
  createdAt: Date
): Promise<void> => {
  await writeOutboxEvent(transaction, {
    type: `comment.${action}`,
    version: 1,
    aggregateType: 'comment',
    aggregateId: commentId,
    createdAt,
    payload: { pageId, commentId, action }
  })
}
