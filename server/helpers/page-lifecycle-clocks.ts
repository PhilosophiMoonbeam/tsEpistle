import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import type { PageLifecycleClock } from '../../shared/page-lifecycle.ts'

interface ClockRow extends PageLifecycleClock {
  pageId: number
  bodyDigest: string
  bodyObservedSourceRevision: string | number
  lastCommentEvent: string | null
}
interface BodySource { id: number; content: string; contentType: string; sourceRevision: string | number }

/** Exactly the schema75 digest framing; content and its declared type are both authored bytes. */
export const pageLifecycleBodyDigest = (content: string, contentType: string): string => {
  const type = Buffer.from(contentType, 'utf8')
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(type.length))
  return createHash('sha256').update(length).update(type).update(content, 'utf8').digest('hex')
}

export const pageLifecycleClockNow = async (transaction: Knex.Transaction): Promise<Date> => {
  const sqlite = ['sqlite3', 'better-sqlite3'].includes(String(transaction.client.config.client))
  const result = await transaction.raw(sqlite ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now" : 'SELECT clock_timestamp() AS now')
  const now = new Date(sqlite ? result[0].now : result.rows[0].now)
  if (!Number.isFinite(now.valueOf())) throw new Error('Invalid lifecycle database clock')
  return now
}
const anchorAfter = (now: Date, prior: string | Date | null): Date => {
  const previous = prior instanceof Date ? prior.valueOf() : prior === null ? NaN : Date.parse(prior)
  return Number.isFinite(previous) && previous > now.valueOf() ? new Date(previous) : now
}
const lockClock = async (transaction: Knex.Transaction, page: BodySource): Promise<ClockRow> => {
  await transaction('pageLifecycleClocks').insert({
    pageId: page.id, bodyEpoch: randomUUID(), bodyAnchorAt: null, bodyAnchorKind: 'unknown',
    bodyDigest: pageLifecycleBodyDigest(page.content, page.contentType), bodyObservedSourceRevision: page.sourceRevision,
    commentEpoch: randomUUID(), commentAnchorAt: null, commentAnchorKind: 'unknown', lastCommentEvent: null
  }).onConflict('pageId').ignore()
  const row = await transaction<ClockRow>('pageLifecycleClocks').where('pageId', page.id).forUpdate().first()
  if (!row) throw new Error('Missing lifecycle clock')
  return row
}
const currentPage = async (transaction: Knex.Transaction, pageId: number): Promise<BodySource> => {
  // Never upgrade discussion's existing FOR SHARE lock: concurrent native posts
  // serialize on the clock instead. Canonical mutations already own page locks.
  const page = await transaction<BodySource>('pages').select('id', 'content', 'contentType', 'sourceRevision').where('id', pageId).forShare().first()
  if (!page) throw new Error('Lifecycle page no longer exists')
  return page
}

export const recordPageLifecycleBody = async (transaction: Knex.Transaction, source: BodySource, options: { created?: boolean } = {}): Promise<void> => {
  const page = await currentPage(transaction, source.id)
  if (String(page.sourceRevision) !== String(source.sourceRevision) || page.content !== source.content || page.contentType !== source.contentType) throw new Error('Stale lifecycle body source')
  const clock = await lockClock(transaction, page)
  const digest = pageLifecycleBodyDigest(source.content, source.contentType)
  const patch: Record<string, unknown> = { bodyObservedSourceRevision: source.sourceRevision }
  if (digest !== clock.bodyDigest || options.created && clock.bodyAnchorKind === 'unknown') {
    const now = await pageLifecycleClockNow(transaction)
    Object.assign(patch, { bodyDigest: digest, bodyEpoch: randomUUID(), bodyAnchorAt: anchorAfter(now, clock.bodyAnchorAt), bodyAnchorKind: 'known-change' })
    if (options.created && clock.commentAnchorKind === 'unknown') Object.assign(patch, { commentEpoch: randomUUID(), commentAnchorAt: now, commentAnchorKind: 'observed-baseline' })
  }
  await transaction('pageLifecycleClocks').where('pageId', page.id).update(patch)
}

/** Only native creation/reply producers call this, with their durable event identity. */
export const recordPageLifecycleComment = async (transaction: Knex.Transaction, input: { pageId: number; eventId: string }): Promise<void> => {
  if (!input.eventId || input.eventId.length > 128) throw new Error('Invalid lifecycle comment event identity')
  const page = await currentPage(transaction, input.pageId)
  const clock = await lockClock(transaction, page)
  const inserted = await transaction('pageLifecycleCommentEvents').insert(input).onConflict(['pageId', 'eventId']).ignore().returning('eventId')
  if (inserted.length === 0) return
  const now = await pageLifecycleClockNow(transaction)
  await transaction('pageLifecycleClocks').where('pageId', page.id).update({ commentEpoch: randomUUID(), commentAnchorAt: anchorAfter(now, clock.commentAnchorAt), commentAnchorKind: 'known-change', lastCommentEvent: input.eventId })
}

/** Caller owns current human authorization; this never edits canonical source. */
export const observePageLifecycleBaseline = async (transaction: Knex.Transaction, input: { pageId: number; sourceRevision: string | number; kind: 'body' | 'comments'; now: Date }): Promise<boolean> => {
  const page = await currentPage(transaction, input.pageId)
  if (String(page.sourceRevision) !== String(input.sourceRevision)) return false
  const clock = await lockClock(transaction, page)
  const body = input.kind === 'body'
  if ((body ? clock.bodyAnchorKind : clock.commentAnchorKind) !== 'unknown') return false
  const now = await pageLifecycleClockNow(transaction)
  if (!Number.isFinite(input.now.valueOf()) || input.now.valueOf() > now.valueOf()) return false
  await transaction('pageLifecycleClocks').where('pageId', page.id).update(body
    ? { bodyEpoch: randomUUID(), bodyAnchorAt: now, bodyAnchorKind: 'observed-baseline', bodyDigest: pageLifecycleBodyDigest(page.content, page.contentType), bodyObservedSourceRevision: page.sourceRevision }
    : { commentEpoch: randomUUID(), commentAnchorAt: now, commentAnchorKind: 'observed-baseline' })
  return true
}
