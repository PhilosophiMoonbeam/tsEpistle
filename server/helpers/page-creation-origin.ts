import type { Knex } from 'knex'
import type { PageCreationOrigin } from '../../shared/page-creation.ts'
import { authorizePageCreationAccount } from '../operations/live-notes.ts'
import errors from '../operations/errors.ts'
import { acquireAgentCoordinatorAdvisoryLocks } from '../agents/coordinator.ts'

/**
 * Acquire the existing Agent admission fence before any account, source, asset
 * or search locks in a receipt transaction. Taking it after those locks cannot
 * repair their ordering.
 */
export const lockPageCreationOwner = async (transaction: Knex.Transaction, requester: Express.User | undefined): Promise<void> => {
  const ownerId = requester?.id
  if (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId < 1 || ownerId === 2) {
    throw new errors.ApplicationError('A current browser account is required.', { status: 401, code: 'AUTH_REQUIRED' })
  }
  // This is a lock key, not an authorization grant; canonical account/session
  // and current group authority are checked after the fence.
  await acquireAgentCoordinatorAdvisoryLocks(transaction, [ownerId])
}

/**
 * Identity only: a reviewed answer draft remains editable, never an exact answer
 * snapshot. The caller must acquire lockPageCreationOwner before its first
 * account/source lock; this authorization helper does not acquire that fence.
 */
export const authorizeAgentAnswerCreationOrigin = async (
  transaction: Knex.Transaction,
  requester: Express.User | undefined,
  origin: Extract<PageCreationOrigin, { kind: 'agent-answer' }>
): Promise<void> => {
  const owner = await authorizePageCreationAccount(transaction, requester)
  const missing = (): never => {
    throw new errors.ApplicationError('This answer is unavailable.', { status: 404, code: 'AGENT_RESOURCE_NOT_FOUND' })
  }
  if (!owner.permissions.some(permission => permission === 'use:agents' || permission === 'manage:system')) missing()
  const session = await transaction('agentSessions').where({ id: origin.sessionId, ownerId: owner.id }).whereNull('deletedAt').forShare().first('id')
  if (!session) missing()
  // The session lock fences deletion/purge. No answer body or provider state is read.
  const answer = await transaction('agentMessages')
    .where({ id: origin.messageId, sessionId: origin.sessionId, role: 'assistant', status: 'complete' })
    .andWhere(visible => visible.where({ isVisible: true }).orWhereNull('isVisible'))
    .first('id')
  if (!answer) missing()
}
