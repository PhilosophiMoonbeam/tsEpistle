import type { Knex } from 'knex'

const ACTIVE_APPROVAL_INDEX = 'page_approval_requests_one_active_per_page'
const ACTIVE_STATUSES = ['submitted', 'approved', 'changes-requested'] as const

export const up = async (knex: Knex): Promise<void> => {
  const duplicate = await knex('pageApprovalRequests')
    .select('pageId')
    .whereIn('status', ACTIVE_STATUSES)
    .groupBy('pageId')
    .havingRaw('COUNT(*) > 1')
    .orderBy('pageId', 'asc')
    .first()
  if (duplicate) {
    throw new Error(`Page ${duplicate.pageId} has duplicate active approval workflows; refuse to add active approval uniqueness`)
  }

  await knex.raw(`
    CREATE UNIQUE INDEX ${ACTIVE_APPROVAL_INDEX}
    ON "pageApprovalRequests" ("pageId")
    WHERE status IN ('submitted', 'approved', 'changes-requested')
  `)
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.raw(`DROP INDEX IF EXISTS ${ACTIVE_APPROVAL_INDEX}`)
}
