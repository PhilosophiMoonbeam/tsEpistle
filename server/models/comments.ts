import { Model } from 'objection'
import type { Knex } from 'knex'
import validateValues from '../../shared/validation.ts'

import _ from 'lodash'
import User from './users.ts'
import Page from './pages.ts'
import { canReadPage, pageAuthorizationContext } from '../helpers/page-access.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import { assertPageUnlocked } from '../operations/page-protection.ts'
import { rejectApiPrincipalMutation } from '../helpers/api-principal.ts'

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
  path: string
  localeCode: string
  tags: unknown[]
  visibility: 'public' | 'private'
  ownerId: number | null
}

export default class Comment extends Model {
  declare id: number
  declare content: string
  declare render: string
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

  static async updateComment ({ id, content, user, ip, sessionId = '' }: UpdateCommentOptions): Promise<unknown> {
    rejectApiPrincipalMutation(user)
    const pageId = (await this.query().findById(id).select('pageId'))?.pageId
    if (!pageId) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
    const page = await wiki.models.pages.getPageFromDb(pageId)
    if (!page) throw Object.assign(new wiki.Error.PageNotFound(), { status: 404 })
    const authority = await wiki.auth.loadPageRuleAuthority(user)
    const pageContext = pageAuthorizationContext(page)
    if (page.visibility === 'private' && !canReadPage(user, page, authority)) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
    if (
      !canReadPage(user, page, authority) ||
      pageContext === null ||
      !wiki.auth.checkPageAccess(user, ['manage:comments'], pageContext, authority)
    ) {
      throw Object.assign(new wiki.Error.CommentManageForbidden(), { status: 403 })
    }
    await assertPageUnlocked({ requester: user, pageId, sessionId, authority })
    content = _.trim(content)
    if (content.length < 2 || content.length > 50000) throw new wiki.Error.InputInvalid('Comments must be 2 to 50,000 characters.')
    const { default: native } = await import('../modules/comments/default/comment.ts')
    void ip
    return native.update({ id, content, user: user as never })
  }

  static async deleteComment ({ id, user, ip, sessionId = '' }: DeleteCommentOptions): Promise<void> {
    rejectApiPrincipalMutation(user)
    const pageId = (await this.query().findById(id).select('pageId'))?.pageId
    if (!pageId) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
    const page = await wiki.models.pages.getPageFromDb(pageId)
    if (!page) throw Object.assign(new wiki.Error.PageNotFound(), { status: 404 })
    const authority = await wiki.auth.loadPageRuleAuthority(user)
    const pageContext = pageAuthorizationContext(page)
    if (page.visibility === 'private' && !canReadPage(user, page, authority)) throw Object.assign(new wiki.Error.CommentNotFound(), { status: 404 })
    if (
      !canReadPage(user, page, authority) ||
      pageContext === null ||
      !wiki.auth.checkPageAccess(user, ['manage:comments'], pageContext, authority)
    ) {
      throw Object.assign(new wiki.Error.CommentManageForbidden(), { status: 403 })
    }
    await assertPageUnlocked({ requester: user, pageId, sessionId, authority })
    void ip
    await this.query().deleteById(id)
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
  models: { pages: { getPageFromDb: (id: number) => Promise<CommentPage | null> } }
}
