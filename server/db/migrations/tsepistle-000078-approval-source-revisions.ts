import type { Knex } from 'knex'

interface LegacyRequest { id: string; pageId: number; revisionId: number }
interface LegacyTransition { id: string; requestId: string; revisionId: number; fromStatus: string | null; toStatus: string }
interface LegacyHistory { id: number; pageId: number; action: string; sourceRevision: unknown }

const historicalSourceRevision = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null
  const revision = String(value)
  // Migration2.5.139 assigned every pre-canonical history row the default1.
  // That value cannot distinguish a real review of revision1 from a backfill.
  return /^[1-9][0-9]*$/.test(revision) && revision !== '1' ? revision : null
}

export const up = async (knex: Knex): Promise<void> => {
  for (const tableName of ['pageApprovalRequests', 'pageApprovalTransitions']) {
    await knex.schema.alterTable(tableName, table => {
      // Text retains exact decimal identity independently of driver bigint parsers.
      table.text('reviewedSourceRevision').nullable()
      table.text('publishedSourceRevision').nullable()
    })
  }

  let afterId: string | null = null
  for (;;) {
    let query = knex<LegacyRequest>('pageApprovalRequests').select('id', 'pageId', 'revisionId').orderBy('id').limit(100)
    if (afterId !== null) query = query.where('id', '>', afterId)
    const requests = await query
    const lastRequest = requests.at(-1)
    if (!lastRequest) break
    const transitions = await knex<LegacyTransition>('pageApprovalTransitions').whereIn('requestId', requests.map(request => request.id))
    const revisionIds = [...new Set([...requests.map(request => request.revisionId), ...transitions.map(transition => transition.revisionId)])]
    const history = await knex<LegacyHistory>('pageHistory').select('id', 'pageId', 'action', 'sourceRevision').whereIn('id', revisionIds)
    const historyById = new Map(history.map(row => [row.id, row]))
    // A history row reused by another request, or duplicate actual submissions,
    // is ambiguous. Submitted-to-submitted reassignment is not a submission.
    const submissions = await knex<LegacyTransition>('pageApprovalTransitions')
      .whereIn('revisionId', revisionIds)
      .where('toStatus', 'submitted')
      .andWhere(function () {
        this.whereNull('fromStatus').orWhere('fromStatus', 'changes-requested')
      })
    const submissionsByRevision = new Map<number, LegacyTransition[]>()
    for (const transition of submissions) {
      const group = submissionsByRevision.get(transition.revisionId) ?? []
      group.push(transition)
      submissionsByRevision.set(transition.revisionId, group)
    }
    for (const request of requests) {
      const revisions = new Map<number, string>()
      for (const transition of transitions) {
        if (transition.requestId !== request.id) continue
        const snapshot = historyById.get(transition.revisionId)
        if (!snapshot || snapshot.pageId !== request.pageId) continue
        const sourceRevision = historicalSourceRevision(snapshot.sourceRevision)
        if (sourceRevision === null) continue
        const submission = submissionsByRevision.get(snapshot.id)
        const origin = submission?.[0]
        if (submission?.length !== 1 || !origin || origin.requestId !== request.id) continue
        if (!(snapshot.action === 'approval-submitted' && origin.fromStatus === null) &&
          !(snapshot.action === 'approval-resubmitted' && origin.fromStatus === 'changes-requested')) continue
        revisions.set(snapshot.id, sourceRevision)
      }
      for (const [revisionId, reviewedSourceRevision] of revisions) {
        await knex('pageApprovalTransitions').where({ requestId: request.id, revisionId }).update({ reviewedSourceRevision })
      }
      const reviewedSourceRevision = revisions.get(request.revisionId)
      if (reviewedSourceRevision !== undefined) await knex('pageApprovalRequests').where({ id: request.id }).update({ reviewedSourceRevision })
    }
    // No publication result is reconstructible from a pre-publication snapshot.
    // Leave it unknown; never borrow the current page or fabricate the successor.
    afterId = lastRequest.id
  }
}

export const down = async (): Promise<void> => {
  throw new Error('Approval source revision bindings are durable review provenance; fix forward without erasing reviewed or published revisions.')
}
