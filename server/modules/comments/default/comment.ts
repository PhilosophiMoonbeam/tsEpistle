import { wiki } from '../../types.ts'
import md from 'markdown-it'
import { full as mdEmoji } from 'markdown-it-emoji'
import jsdomModule from 'jsdom'
import createDOMPurify from 'dompurify'
import _ from 'lodash'
import moment from 'moment'

const { JSDOM } = jsdomModule
const window = new JSDOM('').window
const DOMPurify = createDOMPurify(window)

interface CommentPage {
  id: number
  localeCode: string
  path: string
  updatedAt: Date | string
}

interface CommentUser {
  id: number
  name: string
  email: string
  ip: string
  groups: readonly number[]
  agentagent?: string
}

interface CreateCommentInput {
  page: CommentPage
  replyTo: number | undefined
  content: string
  user: CommentUser
}

interface UpdateCommentInput {
  id: number
  content: string
  user: CommentUser
}

interface RemoveCommentInput {
  id: number
  user: CommentUser
}

interface NewCommentRow {
  content: string
  render: string
  replyTo: number | undefined
  pageId: number
  authorId: number
  name: string
  email: string
  ip: string
}

interface CommentRow extends Record<string, unknown> {
  id: number
  content: string
  render: string
  replyTo: number | null
  pageId: number
  authorId: number
  name: string
  email: string
  ip: string
  createdAt: Date | string
  updatedAt: Date | string
}

interface LastCommentRow {
  updatedAt: Date | string
}

interface CommentPageIdRow {
  pageId: number
}

interface CommentCountRow {
  total: bigint | number | string
}

interface CommentByIdQuery<Row> extends PromiseLike<Row | undefined> {
  patch(value: Pick<CommentRow, 'content' | 'render'>): PromiseLike<number>
  delete(): PromiseLike<number>
}

interface CommentCountQuery {
  where(column: 'pageId', value: number): CommentCountQuery
  first(): PromiseLike<CommentCountRow>
}

interface CommentQuery<Row> {
  select(column: 'pageId'): CommentQuery<CommentPageIdRow>
  select(column: 'updatedAt'): CommentQuery<LastCommentRow>
  orderBy(column: 'updatedAt', direction: 'desc'): CommentQuery<Row>
  findOne(criteria: { authorId: number }): PromiseLike<Row | undefined>
  findById(id: number): CommentByIdQuery<Row>
  insert(value: NewCommentRow): PromiseLike<Pick<CommentRow, 'id'>>
  count(expression: '* as total'): CommentCountQuery
}

interface CommentModel {
  query(): CommentQuery<CommentRow>
}

interface AkismetComment {
  ip: string
  useragent?: string
  content: string
  name: string
  email: string
  permalink: string
  permalinkDate: string
  type: 'reply' | 'comment'
  role: string
}

interface AkismetOptions {
  key: string
  blog: string
  lang: string
  charset: string
}

class AkismetClient {
  readonly key: string
  readonly blog: string
  readonly lang: string
  readonly charset: string

  constructor(options: AkismetOptions) {
    this.key = options.key
    this.blog = options.blog
    this.lang = options.lang
    this.charset = options.charset
  }

  async verifyKey(): Promise<boolean> {
    const result = await this.post('https://rest.akismet.com/1.1/verify-key', {
      key: this.key,
      blog: this.blog
    })
    if (result === 'valid') return true
    if (result === 'invalid') return false
    throw new Error(result)
  }

  async checkSpam(comment: AkismetComment): Promise<boolean> {
    const result = await this.post(`https://${this.key}.rest.akismet.com/1.1/comment-check`, {
      blog: this.blog,
      blog_lang: this.lang,
      blog_charset: this.charset,
      user_ip: comment.ip,
      ...(comment.useragent === undefined ? {} : { user_agent: comment.useragent }),
      comment_content: comment.content,
      comment_author: comment.name,
      comment_author_email: comment.email,
      permalink: comment.permalink,
      comment_post_modified_gmt: comment.permalinkDate,
      comment_type: comment.type,
      user_role: comment.role
    })
    if (result === 'true') return true
    if (result === 'false') return false
    if (result === 'invalid') throw new Error('Invalid API key')
    throw new Error(result)
  }

  async post(endpoint: string, fields: Record<string, string>): Promise<string> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'tsEpistle'
      },
      body: new URLSearchParams(fields)
    })
    const result = await response.text()
    if (!response.ok) {
      throw new Error(response.headers.get('x-akismet-debug-help') ?? (result || `Akismet returned HTTP ${response.status}`))
    }
    return result
  }
}

const isCommentModel = (value: unknown): value is CommentModel =>
  (typeof value === 'object' || typeof value === 'function') && value !== null && typeof Reflect.get(value, 'query') === 'function'

const commentModelCandidate: unknown = wiki.models.comments
if (!isCommentModel(commentModelCandidate)) {
  throw new TypeError('Comments model does not expose a query function.')
}
const comments = commentModelCandidate

let akismetClient: AkismetClient | null = null

const mkdown = md({
  html: false,
  breaks: true,
  linkify: true,
  highlight(str, lang) {
    return `<pre><code class="language-${lang}">${_.escape(str)}</code></pre>`
  }
})

mkdown.use(mdEmoji)

// ------------------------------------
// Default Comment Provider
// ------------------------------------

const plugin = {
  /**
   * Init
   */
  async init(_config?: { akismet: string; minDelay: number }) {
    void _config
    wiki.logger.info('(COMMENTS/DEFAULT) Initializing...')
    if (wiki.data.commentProvider.config.akismet && wiki.data.commentProvider.config.akismet.length > 2) {
      akismetClient = new AkismetClient({
        key: wiki.data.commentProvider.config.akismet,
        blog: wiki.config.host,
        lang: wiki.config.lang.namespacing ? wiki.config.lang.namespaces.join(', ') : wiki.config.lang.code,
        charset: 'UTF-8'
      })
      try {
        const isValid = await akismetClient.verifyKey()
        if (!isValid) {
          akismetClient = null
          wiki.logger.warn('(COMMENTS/DEFAULT) Akismet Key is invalid! [ DISABLED ]')
        } else {
          wiki.logger.info('(COMMENTS/DEFAULT) Akismet key is valid. [ OK ]')
        }
      } catch (err: unknown) {
        akismetClient = null
        wiki.logger.warn('(COMMENTS/DEFAULT) Unable to verify Akismet Key: ' + (err instanceof Error ? err.message : String(err)))
      }
    } else {
      akismetClient = null
    }
    wiki.logger.info('(COMMENTS/DEFAULT) Initialization completed.')
  },
  /**
   * Create New Comment
   */
  async create({ page, replyTo, content, user }: CreateCommentInput) {
    // -> Build New Comment
    const newComment = {
      content,
      render: DOMPurify.sanitize(mkdown.render(content)),
      replyTo,
      pageId: page.id,
      authorId: user.id,
      name: user.name,
      email: user.email,
      ip: user.ip
    }

    // -> Check for Spam with Akismet
    if (akismetClient) {
      let userRole = 'user'
      if (user.groups.indexOf(1) >= 0) {
        userRole = 'administrator'
      } else if (user.groups.indexOf(2) >= 0) {
        userRole = 'guest'
      }

      let isSpam = false
      try {
        const spamCheck: AkismetComment = {
          ip: user.ip,
          ...(user.agentagent === undefined ? {} : { useragent: user.agentagent }),
          content,
          name: user.name,
          email: user.email,
          permalink: `${wiki.config.host}/${page.localeCode}/${page.path}`,
          permalinkDate: page.updatedAt instanceof Date ? page.updatedAt.toISOString() : page.updatedAt,
          type: (replyTo ?? 0) > 0 ? 'reply' : 'comment',
          role: userRole
        }
        isSpam = await akismetClient.checkSpam(spamCheck)
      } catch (err: unknown) {
        wiki.logger.warn('Akismet Comment Validation: [ FAILED ]')
        wiki.logger.warn(err instanceof Error ? err.message : String(err))
      }

      if (isSpam) {
        throw new Error('Comment was rejected because it is marked as spam.')
      }
    }

    // -> Check for minimum delay between posts
    if (wiki.data.commentProvider.config.minDelay > 0) {
      const lastComment = await comments.query().select('updatedAt').orderBy('updatedAt', 'desc').findOne({ authorId: user.id })
      if (lastComment && moment().subtract(wiki.data.commentProvider.config.minDelay, 'seconds').isBefore(lastComment.updatedAt)) {
        throw new Error('Your administrator has set a time limit before you can post another comment. Try again later.')
      }
    }

    // -> Save Comment to DB
    const cm = await comments.query().insert(newComment)

    // -> Return Comment ID
    return cm.id
  },
  /**
   * Update an existing comment
   */
  async update({ id, content }: UpdateCommentInput) {
    const renderedContent = DOMPurify.sanitize(mkdown.render(content))
    await comments.query().findById(id).patch({
      content,
      render: renderedContent
    })
    return renderedContent
  },
  /**
   * Delete an existing comment by ID
   */
  async remove({ id }: RemoveCommentInput) {
    return comments.query().findById(id).delete()
  },
  /**
   * Get the page ID from a comment ID
   */
  async getPageIdFromCommentId(id: number) {
    const result = await comments.query().select('pageId').findById(id)
    return result ? result.pageId : false
  },
  /**
   * Get a comment by ID
   */
  async getCommentById(id: number) {
    return comments.query().findById(id)
  },
  /**
   * Get the total comments count for a page ID
   */
  async count(pageId: number) {
    const result = await comments.query().count('* as total').where('pageId', pageId).first()
    return _.toSafeInteger(result.total)
  }
}

export default plugin
