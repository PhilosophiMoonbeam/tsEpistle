import type { Knex } from 'knex'
import errors from '../operations/errors.ts'

export interface PageEditLockRow {
  pageId: number
  isEditLocked: boolean | number
  lockVersion: string | number
  updatedBy: number
  reason: string
  updatedAt: Date | string
}
export const pageEditLocked = (row: Pick<PageEditLockRow, 'isEditLocked'> | undefined): boolean => row?.isEditLocked === true || row?.isEditLocked === 1
export const pageEditLockConflict = (): Error => new errors.ApplicationError('This page is administratively edit-locked. A current system manager must explicitly unlock it with an audited reason before changing it.', { status: 409, code: 'PAGE_EDIT_LOCKED' })

/** Caller holds all affected page rows FOR UPDATE, in ascending id order, until commit.
 * Never an authorization grant: retain source revisions, account/session and password fences.
 * Missing state is the default-false policy, including pre-policy deleted identities.
 */
export const assertPagesEditUnlocked = async (transaction: Knex.Transaction, pageIds: readonly number[]): Promise<void> => {
  const ids = [...new Set(pageIds)].sort((a, b) => a - b)
  if (!ids.length) return
  const rows = await transaction<PageEditLockRow>('pageEditLocks').whereIn('pageId', ids).orderBy('pageId').select('isEditLocked')
  // A bulk refusal deliberately contains no page identity or inaccessible descendant metadata.
  if (rows.some(pageEditLocked)) throw pageEditLockConflict()
}
export const assertPageEditUnlocked = (transaction: Knex.Transaction, pageId: number): Promise<void> => assertPagesEditUnlocked(transaction, [pageId])
