import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import type {
  DiscussionAnnotation,
  DiscussionAnnotationInput,
  DiscussionContribution,
  DiscussionPageAnnotations,
  MyDiscussionsPage
} from '../../shared/discussion-annotations.ts'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import type { AccessPage, PageRuleAuthority } from '../helpers/group-access.ts'
import {
  canReadPage,
  managesSystem,
  pageAuthorizationContext,
  pageRoute,
  principalId,
  type PagePrincipal,
  type PageVisibilityRecord
} from '../helpers/page-access.ts'
import { rejectApiPrincipalMutation } from '../helpers/api-principal.ts'
import { renderCommentMarkdown } from '../helpers/comment-markdown.ts'
import { DISCUSSION_PAGE_LOCK } from './discussion-moderation.ts'
import { DISCUSSION_SETTINGS_LOCK } from './discussion-settings.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
const invalid = (message: string): never => {
  throw new ApplicationError(message, { status: 400 })
}
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const date = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''))

export const validateDiscussionAnnotations = (value: unknown, replyTo: number): DiscussionAnnotationInput[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) return invalid('Add at most eight annotations to a root discussion.')
  if (replyTo > 0 && value.length > 0) return invalid('Replies cannot introduce annotations.')
  return value.map(item => {
    if (
      !record(item) ||
      Object.keys(item).some(key => !['anchor', 'note'].includes(key)) ||
      typeof item.note !== 'string' ||
      item.note.length > 5000 ||
      !record(item.anchor)
    )
      return invalid('Choose a valid annotation and Markdown note of at most 5,000 characters.')
    const anchor = item.anchor
    if (
      Object.keys(anchor).some(key => !['exact', 'prefix', 'suffix', 'heading', 'offset'].includes(key)) ||
      typeof anchor.exact !== 'string' ||
      anchor.exact.trim().length === 0 ||
      anchor.exact.length > 1000 ||
      typeof anchor.prefix !== 'string' ||
      anchor.prefix.length > 64 ||
      typeof anchor.suffix !== 'string' ||
      anchor.suffix.length > 64 ||
      (anchor.heading !== null && (typeof anchor.heading !== 'string' || anchor.heading.length > 255)) ||
      typeof anchor.offset !== 'number' ||
      !Number.isSafeInteger(anchor.offset) ||
      anchor.offset < 0
    )
      return invalid('Choose a valid quote, context, heading and offset for the annotation.')
    return {
      note: item.note,
      anchor: { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix, heading: anchor.heading as string | null, offset: anchor.offset }
    }
  })
}

interface AnnotationRow extends Omit<DiscussionAnnotation, 'createdAt' | 'updatedAt' | 'resolvedAt'> {
  createdAt: string | Date
  updatedAt: string | Date
  resolvedAt: string | Date | null
}
interface PageRow extends PageVisibilityRecord {
  id: number
  title: string
  localeCode: string
  isPublished: boolean
  publishStartDate: unknown
  publishEndDate: unknown
}
interface CommentRow {
  id: number
  pageId: number
  authorId: number
  replyTo: number
  isHidden: boolean
  content: string
  createdAt: string
  updatedAt: string
}
interface Dependencies {
  db: Knex
  secret(): string
  fallbackFeatures(): Record<string, unknown>
  loadPageRuleAuthority(requester: PagePrincipal, tx: Knex.Transaction): Promise<PageRuleAuthority>
  checkPageAccess(requester: PagePrincipal, permissions: readonly string[], context: AccessPage, authority: PageRuleAuthority): boolean
}
const annotationDto = (row: AnnotationRow): DiscussionAnnotation => ({
  id: Number(row.id),
  commentId: Number(row.commentId),
  position: row.position,
  note: row.note,
  anchor: row.anchor,
  revision: row.revision,
  resolvedAt: row.resolvedAt === null ? null : date(row.resolvedAt),
  resolvedById: row.resolvedById,
  createdAt: date(row.createdAt),
  updatedAt: date(row.updatedAt)
})
interface Cursor {
  ownerId: number
  session: string
  before: { createdAt: string; id: number }
  issuedAt: number
}
const sessionDigest = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex')
const cursorKey = (secret: string): Buffer => {
  if (!secret) throw new Error('A session secret is required for discussion pagination.')
  return createHash('sha256').update('discussion-contributions:v1:').update(secret).digest()
}
const sealCursor = (cursor: Cursor, secret: string): string => {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv)
  cipher.setAAD(Buffer.from('my-discussions:v1'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(cursor), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}
const openCursor = (value: unknown, ownerId: number, sessionId: string, secret: string): Cursor => {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.length < 29 || bytes.toString('base64url') !== value) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from('my-discussions:v1'))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const cursor: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
    if (
      !record(cursor) ||
      cursor.ownerId !== ownerId ||
      cursor.session !== sessionDigest(sessionId) ||
      !record(cursor.before) ||
      !validId(cursor.before.id) ||
      typeof cursor.before.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(cursor.before.createdAt)) ||
      typeof cursor.issuedAt !== 'number' ||
      !Number.isSafeInteger(cursor.issuedAt) ||
      cursor.issuedAt > Date.now() + 60000 ||
      cursor.issuedAt < Date.now() - 15 * 60000
    )
      throw new Error()
    return cursor as unknown as Cursor
  } catch {
    return invalid('This discussion continuation is invalid or expired. Start again.')
  }
}

export const createDiscussionAnnotationStore = (deps: Dependencies) => {
  const policyEnabled = async (tx: Knex.Transaction): Promise<boolean> => {
    await tx.raw('SELECT pg_advisory_xact_lock_shared(?)', [DISCUSSION_SETTINGS_LOCK])
    const providers = await tx('commentProviders').where('isEnabled', true).forShare().select('key')
    const features = (await tx('settings').where('key', 'features').forShare().first('value'))?.value ?? deps.fallbackFeatures()
    return features.featurePageComments === true && providers.length === 1 && providers[0].key === 'default'
  }
  const readablePage = async (
    tx: Knex.Transaction,
    requester: PagePrincipal,
    pageId: number,
    sessionId: string,
    authority: PageRuleAuthority
  ): Promise<PageRow | null> => {
    const page = await tx<PageRow>('pages')
      .where('id', pageId)
      .forShare()
      .first('id', 'title', 'path', 'localeCode', 'visibility', 'ownerId', 'isPublished', 'publishStartDate', 'publishEndDate')
    if (!page) return null
    const tags = (await tx('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', pageId).select('tags.tag')).map(row => ({
      tag: row.tag
    }))
    const taggedPage: PageRow = { ...page, tags }
    const context = pageAuthorizationContext(taggedPage)
    if (
      (page.visibility === 'public' && (page.isPublished !== true || !publicationWindowOpen(page))) ||
      !context ||
      !canReadPage(requester, taggedPage, authority) ||
      !deps.checkPageAccess(requester, ['read:comments'], context, authority)
    )
      return null
    const protection = await tx('pageAccessPasswords').where('pageId', pageId).forShare().first('version')
    if (protection && !managesSystem(requester)) {
      if (
        !sessionId ||
        !(await tx('pageUnlockGrants')
          .where({ pageId, sessionId, userId: principalId(requester), passwordVersion: protection.version })
          .where('expiresAt', '>', new Date())
          .first('id'))
      )
        return null
    }
    return taggedPage
  }
  const rowsFor = async (tx: Knex.Transaction, ids: number[]): Promise<Map<number, DiscussionAnnotation[]>> => {
    const result = new Map<number, DiscussionAnnotation[]>()
    if (ids.length === 0) return result
    for (const row of await tx<AnnotationRow>('commentAnnotations').whereIn('commentId', ids).orderBy('commentId').orderBy('position')) {
      const items = result.get(row.commentId) ?? []
      items.push(annotationDto(row))
      result.set(row.commentId, items)
    }
    return result
  }
  return {
    async pageAnnotations(requester: PagePrincipal, pageId: number, input: Record<string, unknown>, sessionId = ''): Promise<DiscussionPageAnnotations> {
      const limit = input.limit === undefined ? 50 : Number(input.limit)
      const after = input.after === undefined ? 0 : Number(input.after)
      if (
        !validId(pageId) ||
        Object.keys(input).some(key => !['limit', 'after'].includes(key)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(after) ||
        after < 0
      )
        return invalid('Choose a valid page and annotation continuation.')
      return deps.db.transaction(async tx => {
        if (!(await policyEnabled(tx))) return { items: [], nextAfter: null }
        const authority = await deps.loadPageRuleAuthority(requester, tx)
        if (!(await readablePage(tx, requester, pageId, sessionId, authority))) throw new ApplicationError('Annotations not found.', { status: 404 })
        await tx.raw('SELECT pg_advisory_xact_lock_shared(?, ?)', [DISCUSSION_PAGE_LOCK, pageId])
        const rows = await tx<AnnotationRow>('commentAnnotations')
          .join('comments', 'comments.id', 'commentAnnotations.commentId')
          .where({ 'comments.pageId': pageId, 'comments.isHidden': false, 'comments.replyTo': 0 })
          .where('commentAnnotations.id', '>', after)
          .orderBy('commentAnnotations.id')
          .limit(limit + 1)
          .select('commentAnnotations.*')
        return { items: rows.slice(0, limit).map(annotationDto), nextAfter: rows.length > limit ? Number(rows[limit - 1]!.id) : null }
      })
    },
    async annotations(requester: PagePrincipal, pageId: number, ids: number[], sessionId = ''): Promise<Map<number, DiscussionAnnotation[]>> {
      if (ids.length === 0) return new Map()
      return deps.db.transaction(async tx => {
        if (!(await policyEnabled(tx))) return new Map()
        const authority = await deps.loadPageRuleAuthority(requester, tx)
        if (!(await readablePage(tx, requester, pageId, sessionId, authority))) return new Map()
        await tx.raw('SELECT pg_advisory_xact_lock_shared(?, ?)', [DISCUSSION_PAGE_LOCK, pageId])
        const comments = await tx<CommentRow>('comments').where({ pageId, isHidden: false, replyTo: 0 }).whereIn('id', ids).forShare().select('id')
        return rowsFor(
          tx,
          comments.map(row => row.id)
        )
      })
    },
    async changeState(requester: PagePrincipal, id: number, annotationId: number, input: unknown, sessionId = ''): Promise<DiscussionAnnotation> {
      rejectApiPrincipalMutation(requester)
      const actorId = principalId(requester)
      if (actorId === null || actorId === 2) throw new ApplicationError('Sign in to change an annotation.', { status: 401 })
      if (
        !validId(id) ||
        !validId(annotationId) ||
        !record(input) ||
        Object.keys(input).some(key => !['resolved', 'expectedRevision'].includes(key)) ||
        !validId(input.expectedRevision) ||
        typeof input.resolved !== 'boolean'
      )
        return invalid('Choose an annotation state and its current revision.')
      return deps.db.transaction(async tx => {
        const subject = await tx<CommentRow>('comments').where('id', id).first('pageId')
        if (!subject) throw new ApplicationError('Annotation not found.', { status: 404 })
        const authority = await deps.loadPageRuleAuthority(requester, tx)
        const page = await readablePage(tx, requester, subject.pageId, sessionId, authority)
        if (!page) throw new ApplicationError('Annotation not found.', { status: 404 })
        await tx.raw('SELECT pg_advisory_xact_lock_shared(?, ?)', [DISCUSSION_PAGE_LOCK, page.id])
        if (!(await policyEnabled(tx))) throw new ApplicationError('Built-in discussions are not available.', { status: 409 })
        const comment = await tx<CommentRow>('comments').where({ id, pageId: page.id, isHidden: false, replyTo: 0 }).forShare().first()
        const context = pageAuthorizationContext(page)
        if (!comment) throw new ApplicationError('Annotation not found.', { status: 404 })
        if (comment.authorId !== actorId && (!context || !deps.checkPageAccess(requester, ['manage:comments', 'manage:system'], context, authority)))
          throw new ApplicationError('Only the author or a discussion moderator can change this annotation.', { status: 403 })
        const row = await tx<AnnotationRow>('commentAnnotations').where({ id: annotationId, commentId: id }).forUpdate().first()
        if (!row) throw new ApplicationError('Annotation not found.', { status: 404 })
        if (row.revision !== input.expectedRevision || (row.resolvedAt !== null) === input.resolved || row.revision === 2147483647)
          throw new ApplicationError('This annotation changed. Reload it before saving.', { status: 409 })
        const now = new Date()
        const [updated] = await tx<AnnotationRow>('commentAnnotations')
          .where({ id: annotationId, commentId: id, revision: input.expectedRevision })
          .update({ revision: row.revision + 1, resolvedAt: input.resolved ? now : null, resolvedById: input.resolved ? actorId : null, updatedAt: now })
          .returning('*')
        if (!updated) throw new ApplicationError('This annotation changed. Reload it before saving.', { status: 409 })
        return annotationDto(updated)
      })
    },
    async mine(requester: PagePrincipal, input: Record<string, unknown>, sessionId = ''): Promise<MyDiscussionsPage> {
      const ownerId = principalId(requester)
      if (ownerId === null || ownerId === 2) throw new ApplicationError('Sign in to see your discussions.', { status: 401 })
      const limit = input.limit === undefined ? 30 : Number(input.limit)
      if (Object.keys(input).some(key => !['limit', 'cursor'].includes(key)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return invalid('Choose a discussion page size from 1 to 100.')
      const cursor = input.cursor === undefined ? null : openCursor(input.cursor, ownerId, sessionId, deps.secret())
      return deps.db.transaction(async tx => {
        if (!(await policyEnabled(tx))) return { items: [], nextCursor: null }
        const authority = await deps.loadPageRuleAuthority(requester, tx)
        const pages = new Map<number, PageRow | null>(),
          items: DiscussionContribution[] = []
        let before = cursor?.before ?? null,
          scanned = 0,
          more = false
        while (scanned < 1000 && items.length < limit) {
          const query = tx<CommentRow>('comments').where({ authorId: ownerId, isHidden: false })
          if (before)
            query.where(builder =>
              builder.where('createdAt', '<', before!.createdAt).orWhere(nested => nested.where('createdAt', before!.createdAt).where('id', '<', before!.id))
            )
          const rows = await query
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
            .limit(Math.min(100, 1000 - scanned))
            .select('id', 'pageId', 'createdAt')
          if (rows.length === 0) {
            more = false
            break
          }
          more = rows.length === Math.min(100, 1000 - scanned)
          for (const row of rows) {
            before = { id: row.id, createdAt: row.createdAt }
            scanned++
            if (!pages.has(row.pageId)) pages.set(row.pageId, await readablePage(tx, requester, row.pageId, sessionId, authority))
            const page = pages.get(row.pageId)
            if (!page) continue
            await tx.raw('SELECT pg_advisory_xact_lock_shared(?, ?)', [DISCUSSION_PAGE_LOCK, page.id])
            const current = await tx<CommentRow>('comments')
              .where({ id: row.id, authorId: ownerId, pageId: page.id, isHidden: false })
              .forShare()
              .first('id', 'pageId', 'authorId', 'replyTo', 'content', 'createdAt', 'updatedAt')
            if (!current) continue
            const parent =
              current.replyTo > 0 ? await tx('comments').where({ id: current.replyTo, pageId: page.id, isHidden: false, replyTo: 0 }).first('id') : null
            const annotations = current.replyTo === 0 ? ((await rowsFor(tx, [current.id])).get(current.id) ?? []) : []
            items.push({
              id: current.id,
              replyTo: parent ? Number(parent.id) : 0,
              content: current.content,
              render: renderCommentMarkdown(current.content),
              createdAt: date(current.createdAt),
              updatedAt: date(current.updatedAt),
              annotations,
              page: { id: page.id, title: page.title, path: page.path, locale: page.localeCode, visibility: page.visibility, url: pageRoute(page) }
            })
            if (items.length === limit) {
              more = true
              break
            }
          }
          if (!more) break
        }
        return {
          items,
          nextCursor:
            more && before ? sealCursor({ ownerId, session: sessionDigest(sessionId), before, issuedAt: cursor?.issuedAt ?? Date.now() }, deps.secret()) : null
        }
      })
    }
  }
}

export const discussionAnnotations = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    config: { sessionSecret: string; features: Record<string, unknown> }
    auth: { loadPageRuleAuthority: Dependencies['loadPageRuleAuthority']; checkPageAccess: Dependencies['checkPageAccess'] }
  }
  return createDiscussionAnnotationStore({
    db: wiki.models.knex,
    secret: () => wiki.config.sessionSecret,
    fallbackFeatures: () => wiki.config.features,
    loadPageRuleAuthority: (requester, tx) => wiki.auth.loadPageRuleAuthority(requester, tx),
    checkPageAccess: (requester, permissions, context, authority) => wiki.auth.checkPageAccess(requester, permissions, context, authority)
  })
}
