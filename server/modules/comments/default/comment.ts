import { wiki } from '../../types.ts'
import md from 'markdown-it'
import { full as mdEmoji } from 'markdown-it-emoji'
import jsdomModule from 'jsdom'
import createDOMPurify from 'dompurify'
import _ from 'lodash'
import type { Knex } from 'knex'
import type { PageRuleAuthority } from '../../../helpers/group-access.ts'
import type { PagePrincipal } from '../../../helpers/page-access.ts'
import { createDiscussionPostingStore } from '../../../operations/discussion-posting.ts'

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
  requester: PagePrincipal
  sessionId: string
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
  where(column: 'pageId' | 'isHidden', value: number | boolean): CommentCountQuery
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
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(8000)
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
let antiSpamState: 'off' | 'verified' | 'unverified' = 'off'
let antiSpamCheckedAt: string | null = null

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
    const config = _config ?? wiki.data.commentProvider.config
    antiSpamState = config.akismet ? 'unverified' : 'off'
    antiSpamCheckedAt = null
    wiki.logger.info('(COMMENTS/DEFAULT) Initializing...')
    if (config.akismet && config.akismet.length > 2) {
      akismetClient = new AkismetClient({
        key: config.akismet,
        blog: wiki.config.host,
        lang: wiki.config.lang.namespacing ? wiki.config.lang.namespaces.join(', ') : wiki.config.lang.code,
        charset: 'UTF-8'
      })
      try {
        const isValid = await akismetClient.verifyKey()
        antiSpamCheckedAt = new Date().toISOString()
        if (!isValid) {
          akismetClient = null
          wiki.logger.warn('(COMMENTS/DEFAULT) Akismet Key is invalid! [ DISABLED ]')
        } else {
          antiSpamState = 'verified'
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
  getAntiSpamStatus() { return { state: antiSpamState, checkedAt: antiSpamCheckedAt } },
  async create({ page, replyTo, content, user, requester, sessionId }: CreateCommentInput) {
    const context = WIKI as unknown as {
      models: { knex: Knex }
      config: { features: Record<string, unknown> }
      auth: {
        checkPageAccess(
          user: PagePrincipal,
          permissions: readonly string[],
          page: { path: string; locale?: string; tags?: readonly { tag: string }[] },
          authority: PageRuleAuthority
        ): boolean
        loadPageRuleAuthority(requester: PagePrincipal, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
      }
    }
    return createDiscussionPostingStore({
      db: context.models.knex,
      fallbackFeatures: () => context.config.features,
      loadPageRuleAuthority: (principal, transaction) => context.auth.loadPageRuleAuthority(principal, transaction),
      canPost: (principal, currentPage, authority) => context.auth.checkPageAccess(
        principal,
        ['write:comments'],
        {
          path: String(currentPage.path ?? ''),
          locale: String(currentPage.localeCode ?? ''),
          tags: (Array.isArray(currentPage.tags) ? currentPage.tags : []) as Array<{ tag: string }>
        },
        authority
      ),
      async checkSpam({ page: currentPage, providerConfig }) {
        const client = akismetClient
        if (!client || client.key !== providerConfig.akismet) return
        let isSpam = false
        try {
          isSpam = await client.checkSpam({ ip: user.ip, ...(user.agentagent ? { useragent: user.agentagent } : {}), content, name: user.name, email: user.email,
            permalink: `${wiki.config.host}/${String(currentPage.localeCode)}/${String(currentPage.path)}`, permalinkDate: String(currentPage.updatedAt), type: (replyTo ?? 0) > 0 ? 'reply' : 'comment', role: user.groups.includes(1) ? 'administrator' : user.id === 2 ? 'guest' : 'user' })
        } catch {
          wiki.logger.warn('Akismet comment check failed; the comment will remain available for local moderation.')
        }
        if (isSpam) throw new Error('Comment was rejected because it is marked as spam.')
      }
    }).post({ pageId: page.id, replyTo: replyTo ?? 0, content, render: DOMPurify.sanitize(mkdown.render(content)), user, requester, sessionId })
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
    const result = await comments.query().count('* as total').where('pageId', pageId).where('isHidden', false).first()
    return _.toSafeInteger(result.total)
  }
}

export default plugin
