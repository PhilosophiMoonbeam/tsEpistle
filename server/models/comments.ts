import { Model } from 'objection'
import validateValues from '../../shared/validation.ts'
import _ from 'lodash'
import User from './users.ts'
import Page from './pages.ts'

interface CommentUser extends Record<string, unknown> {
  id: number
}

interface CommentAction {
  user: CommentUser
  ip: string
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

  static async postNewComment ({ pageId, replyTo, content, guestName, guestEmail, user, ip }: PostCommentOptions): Promise<unknown> {
    if (user.id === 2) {
      const validation = validateValues({ email: _.toLower(guestEmail), name: guestName }, {
        email: { email: true, length: { maximum: 255 } },
        name: { presence: { allowEmpty: false }, length: { minimum: 2, maximum: 255 } }
      }, { format: 'flat' })
      if (validation?.[0]) throw new wiki.Error.InputInvalid(validation[0])
    }
    content = _.trim(content)
    if (content.length < 2) throw new wiki.Error.CommentContentMissing()
    const page = await wiki.models.pages.getPageFromDb(pageId)
    if (!page) throw new wiki.Error.PageNotFound()
    if (!wiki.auth.checkAccess(user, ['write:comments'], { path: page.path, locale: page.localeCode, tags: page.tags })) {
      throw new wiki.Error.CommentPostForbidden()
    }
    return wiki.data.commentProvider.create({
      page,
      replyTo,
      content,
      user: { ...user, ...(user.id === 2 ? { name: guestName, email: guestEmail } : {}), ip }
    })
  }

  static async updateComment ({ id, content, user, ip }: UpdateCommentOptions): Promise<unknown> {
    const pageId = await wiki.data.commentProvider.getPageIdFromCommentId(id)
    if (!pageId) throw new wiki.Error.CommentNotFound()
    const page = await wiki.models.pages.getPageFromDb(pageId)
    if (!page) throw new wiki.Error.PageNotFound()
    if (!wiki.auth.checkAccess(user, ['manage:comments'], { path: page.path, locale: page.localeCode, tags: page.tags })) {
      throw new wiki.Error.CommentManageForbidden()
    }
    return wiki.data.commentProvider.update({ id, content, page, user: { ...user, ip } })
  }

  static async deleteComment ({ id, user, ip }: DeleteCommentOptions): Promise<void> {
    const pageId = await wiki.data.commentProvider.getPageIdFromCommentId(id)
    if (!pageId) throw new wiki.Error.CommentNotFound()
    const page = await wiki.models.pages.getPageFromDb(pageId)
    if (!page) throw new wiki.Error.PageNotFound()
    if (!wiki.auth.checkAccess(user, ['manage:comments'], { path: page.path, locale: page.localeCode, tags: page.tags })) {
      throw new wiki.Error.CommentManageForbidden()
    }
    await wiki.data.commentProvider.remove({ id, page, user: { ...user, ip } })
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
  auth: { checkAccess: (user: CommentUser, permissions: string[], target: { path: string, locale: string, tags: unknown[] }) => boolean }
  data: { commentProvider: CommentProvider }
  models: { pages: { getPageFromDb: (id: number) => Promise<CommentPage | null> } }
}
