import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { DiscussionPage, DiscussionHistoryEntry, ModerationRecord, ModerationInspection, ModerationInventory, PageDiscussionPolicy } from '../../shared/discussion-policy.ts'
import { managesSystem, principalId, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'
const { ApplicationError } = errors
export const DISCUSSION_PAGE_LOCK = 72401641
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const date = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value ?? '')
const validId = (id: number) => { if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new ApplicationError('Choose a valid page or comment.', { status: 400 }) }
const reasonValue = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 1000) throw new ApplicationError('Add a reason of 3 to 1,000 characters.', { status: 400 })
  return value.trim()
}
interface PageRow { id: number; title: string; path: string; localeCode: string; visibility: 'public' | 'private' }
interface CommentRow { id: number; pageId: number; replyTo: number; content: string; name: string; authorId: number; email: string; ip: string; createdAt: string; updatedAt: string; isHidden: boolean; moderationRevision: string; moderationReason: string; moderatedAt: Date | null; moderatedBy: number | null }
interface PolicyRow { pageId: number; closed: boolean; reason: string; updatedAt: Date; updatedBy: number | null; revision: string }
const pageDto = (page: PageRow): DiscussionPage => ({ id: page.id, title: page.title, path: page.path, locale: page.localeCode, visibility: page.visibility })
const commentFingerprint = (row: CommentRow) => hash([row.id, row.replyTo, row.content, row.updatedAt, row.isHidden, row.moderationRevision])
const policyFingerprint = (page: PageRow, row?: PolicyRow) => hash([page.id, row?.revision ?? null, row?.closed ?? false])
const commentDto = (row: CommentRow, page: PageRow): ModerationRecord => ({ id: row.id, excerpt: row.content.slice(0, 240), authorId: row.authorId, authorName: row.name, createdAt: date(row.createdAt), updatedAt: date(row.updatedAt), isHidden: row.isHidden, page: pageDto(page) })
const requireAdmin = (requester: PagePrincipal) => { if (!managesSystem(requester)) throw new ApplicationError('manage:system is required.', { status: 403 }) }
export const createDiscussionModerationStore = (db: Knex) => {
  const page = async (id: number, tx: Knex | Knex.Transaction = db, lock = false): Promise<PageRow> => {
    validId(id)
    const query = tx<PageRow>('pages').where('id', id).select('id', 'title', 'path', 'localeCode', 'visibility')
    const row = await (lock ? query.forShare() : query).first()
    if (!row) throw new ApplicationError('Page not found.', { status: 404 })
    return row
  }
  const history = async (criteria: Record<string, unknown>, tx: Knex | Knex.Transaction = db): Promise<DiscussionHistoryEntry[]> => (await tx('discussionModerationHistory').where(criteria).orderBy('id', 'desc').limit(50).select('id', 'action', 'reason', 'actorId', 'createdAt')).map(row => ({ ...row, createdAt: date(row.createdAt) }))
  const inspect = async (id: number, tx: Knex | Knex.Transaction = db): Promise<ModerationInspection> => {
    validId(id)
    const row = await tx<CommentRow>('comments').where('id', id).first()
    if (!row) throw new ApplicationError('Comment not found.', { status: 404 })
    return { ...commentDto(row, await page(row.pageId, tx)), content: row.content, authorEmail: row.email, authorIP: row.ip, moderationReason: row.moderationReason, moderatedAt: row.moderatedAt ? date(row.moderatedAt) : null, moderatedBy: row.moderatedBy, fingerprint: commentFingerprint(row), history: await history({ commentId: id }, tx) }
  }
  const policy = async (id: number, tx: Knex | Knex.Transaction = db): Promise<PageDiscussionPolicy> => {
    const item = await page(id, tx), row = await tx<PolicyRow>('pageDiscussionPolicy').where('pageId', id).first()
    return { page: pageDto(item), closed: row?.closed ?? false, reason: row?.reason ?? '', updatedBy: row?.updatedBy ?? null, updatedAt: row ? date(row.updatedAt) : null, fingerprint: policyFingerprint(item, row), history: await history({ pageId: id, commentId: null }, tx) }
  }
  return {
    async list(requester: PagePrincipal, input: Record<string, unknown>): Promise<ModerationInventory> {
      requireAdmin(requester)
      const search = typeof input.search === 'string' ? input.search.trim() : '', state = input.state ?? 'all', visibility = input.visibility ?? 'all', limit = Number(input.limit ?? 30), offset = Number(input.offset ?? 0)
      if (search.length > 200 || !['all', 'visible', 'hidden'].includes(String(state)) || !['all', 'public', 'private'].includes(String(visibility)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new ApplicationError('Choose valid discussion filters and pagination.', { status: 400 })
      const base = db('comments as c').join('pages as p', 'p.id', 'c.pageId')
      if (state !== 'all') base.where('c.isHidden', state === 'hidden')
      if (visibility !== 'all') base.where('p.visibility', visibility)
      if (input.pageId !== undefined && input.pageId !== '') { const id = Number(input.pageId); validId(id); base.where('c.pageId', id) }
      if (search) { const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`; base.where(builder => { for (const field of ['c.content', 'c.name', 'p.title', 'p.path']) builder.orWhereILike(field, pattern) }) }
      const [count, rows] = await Promise.all([base.clone().count('* as total').first(), base.clone().select('c.id', 'c.pageId', 'c.name', 'c.authorId', 'c.createdAt', 'c.updatedAt', 'c.isHidden', db.raw('LEFT(??, 240) AS content', ['c.content']), 'p.title as pageTitle', 'p.path as pagePath', 'p.localeCode as pageLocale', 'p.visibility as pageVisibility').orderBy('c.createdAt', 'desc').orderBy('c.id', 'desc').limit(limit).offset(offset)])
      return { items: rows.map(row => commentDto(row as CommentRow, { id: row.pageId, title: row.pageTitle, path: row.pagePath, localeCode: row.pageLocale, visibility: row.pageVisibility })), total: Number(count?.total ?? 0), limit, offset }
    },
    async inspect(requester: PagePrincipal, id: number) { requireAdmin(requester); return inspect(id) },
    async moderate(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      requireAdmin(requester); validId(id)
      const reason = reasonValue(input.reason)
      if (typeof input.hidden !== 'boolean' || typeof input.fingerprint !== 'string') throw new ApplicationError('Load a comment and choose its visibility before saving.', { status: 400 })
      return db.transaction(async tx => {
        const subject = await tx<CommentRow>('comments').where('id', id).first('pageId')
        if (!subject) throw new ApplicationError('Comment not found.', { status: 404 })
        await page(subject.pageId, tx, true)
        await tx.raw('SELECT pg_advisory_xact_lock(?, ?)', [DISCUSSION_PAGE_LOCK, subject.pageId])
        const row = await tx<CommentRow>('comments').where('id', id).forUpdate().first()
        if (!row) throw new ApplicationError('Comment not found.', { status: 404 })
        if (input.fingerprint !== commentFingerprint(row)) throw new ApplicationError('This comment changed. Reload it before moderating.', { status: 409 })
        if (input.hidden === row.isHidden) throw new ApplicationError('The comment already has that visibility.', { status: 409 })
        const now = new Date(), actorId = principalId(requester)
        await tx('comments').where('id', id).update({ isHidden: input.hidden, moderationRevision: randomUUID(), moderationReason: reason, moderatedAt: now, moderatedBy: actorId })
        await tx('discussionModerationHistory').insert({ commentId: id, pageId: row.pageId, action: input.hidden ? 'hide' : 'restore', reason, actorId, createdAt: now })
        return inspect(id, tx)
      })
    },
    async policy(requester: PagePrincipal, id: number) { requireAdmin(requester); return policy(id) },
    async setPolicy(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      requireAdmin(requester); validId(id)
      const reason = reasonValue(input.reason)
      if (typeof input.closed !== 'boolean' || typeof input.fingerprint !== 'string') throw new ApplicationError('Load a page and choose discussion availability before saving.', { status: 400 })
      return db.transaction(async tx => {
        const item = await page(id, tx, true)
        await tx.raw('SELECT pg_advisory_xact_lock(?, ?)', [DISCUSSION_PAGE_LOCK, id])
        const row = await tx<PolicyRow>('pageDiscussionPolicy').where('pageId', id).forUpdate().first()
        if (input.fingerprint !== policyFingerprint(item, row)) throw new ApplicationError('This page’s discussion policy changed. Reload it before saving.', { status: 409 })
        if (input.closed === (row?.closed ?? false)) throw new ApplicationError('The page already has that discussion policy.', { status: 409 })
        const actorId = principalId(requester), now = new Date(), next = { pageId: id, closed: input.closed, reason, updatedBy: actorId, updatedAt: now, revision: randomUUID() }
        await tx('pageDiscussionPolicy').insert(next).onConflict('pageId').merge(next)
        await tx('discussionModerationHistory').insert({ commentId: null, pageId: id, action: input.closed ? 'close' : 'reopen', reason, actorId, createdAt: now })
        return policy(id, tx)
      })
    },
    async closedPages(requester: PagePrincipal, input: Record<string, unknown>) {
      requireAdmin(requester)
      const search = typeof input.search === 'string' ? input.search.trim() : '', limit = Number(input.limit ?? 30), offset = Number(input.offset ?? 0)
      if (search.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new ApplicationError('Choose valid page filters.', { status: 400 })
      const base = db('pageDiscussionPolicy as d').join('pages as p', 'p.id', 'd.pageId').where('d.closed', true)
      if (search) { const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`; base.where(builder => builder.whereILike('p.title', pattern).orWhereILike('p.path', pattern)) }
      const [count, rows] = await Promise.all([base.clone().count('* as total').first(), base.clone().select('p.id', 'p.title', 'p.path', 'p.localeCode', 'p.visibility', 'd.updatedAt').orderBy('d.updatedAt', 'desc').orderBy('p.id').limit(limit).offset(offset)])
      return { items: rows.map(row => ({ page: pageDto(row as PageRow), updatedAt: date(row.updatedAt) })), total: Number(count?.total ?? 0), limit, offset }
    }
  }
}
export const discussionModeration = () => createDiscussionModerationStore((WIKI as unknown as { models: { knex: Knex } }).models.knex)
