import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { BoundedProcessError, GIT_NATIVE_DEADLINE_MS } from './bounded-process.ts'

const LOCK_NAMESPACE = 0x47495453
const CONNECTION_DEADLINE_MS = 2_000
const turns = new AsyncLocalStorage<GitMutationTurn>()

export class GitStorageBusyError extends Error {
  readonly code = 'STORAGE_GIT_BUSY'
  readonly status = 409
  readonly retryable = true
  constructor() {
    super('Git storage target is busy; the pending mutation must be retried.')
    this.name = 'GitStorageBusyError'
  }
}

export interface GitMutationTurn {
  readonly targetKey: string
  readonly deadlineAt: number
  readonly signal: AbortSignal
  readonly assertHeld: () => Promise<void>
  active: boolean
}

export const currentGitMutationTurn = (): GitMutationTurn => {
  const turn = turns.getStore()
  if (!turn?.active) throw new Error('Git storage mutation has no PostgreSQL serialization fence')
  return turn
}

const bounded = async <T>(work: PromiseLike<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Git storage ${label} exceeded its connection deadline`)), CONNECTION_DEADLINE_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Session locks cover nontransactional Git effects and are never emulated by a local mutex. */
export async function withGitMutationLock<T>(db: Knex, targetKey: string, work: (turn: GitMutationTurn) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!targetKey || targetKey.length > 255) throw new Error('Git storage target identity is invalid')
  if (db?.client?.config?.client !== 'pg' && db?.client?.config?.client !== 'postgres' && db?.client?.config?.client !== 'postgresql') {
    throw new Error('Git storage mutations require PostgreSQL advisory serialization')
  }
  if (signal?.aborted) throw new BoundedProcessError('aborted', 'Git storage mutation was cancelled', { quarantine: false })

  // A pool acquisition may finish after our admission deadline. It must still be returned.
  const acquisition = Promise.resolve(db.client.acquireConnection())
  let connection: Awaited<typeof acquisition>
  try {
    connection = await bounded(acquisition, 'connection admission')
  } catch (error) {
    void acquisition
      .then(async lateConnection => {
        try {
          await bounded(db.client.releaseConnection(lateConnection), 'late connection release')
        } catch {
          lateConnection.connection?.stream?.destroy()
          await bounded(db.client.destroyRawConnection(lateConnection), 'late connection destruction')
        }
      })
      .catch(() => undefined)
    throw error
  }

  const lockKey = createHash('sha256').update(targetKey).digest().readInt32BE(0)
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason ?? new Error('Git storage mutation was cancelled'))
  const lost = () => controller.abort(new Error('Git storage PostgreSQL serialization connection was lost'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  connection.on('error', lost)
  connection.on('end', lost)
  let locked = false
  let reusable = false
  const query = (sql: string, bindings: number[]) => db.raw(sql, bindings).connection(connection).timeout(CONNECTION_DEADLINE_MS)
  const turn: GitMutationTurn = {
    targetKey,
    deadlineAt: Date.now() + GIT_NATIVE_DEADLINE_MS,
    signal: controller.signal,
    active: true,
    assertHeld: async () => {
      if (controller.signal.aborted) throw new BoundedProcessError('aborted', 'Git storage serialization fence was cancelled or lost')
      if (Date.now() >= turn.deadlineAt) throw new BoundedProcessError('deadline', 'Git storage mutation exceeded its deadline')
      try {
        const result = await query(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = ?::oid AND objid = ?::oid AND objsubid = 2 AND granted) AS held",
          [LOCK_NAMESPACE, lockKey >>> 0]
        )
        if (result.rows?.[0]?.held !== true) throw new Error('Git storage PostgreSQL serialization fence is no longer held')
      } catch (error) {
        reusable = false
        controller.abort(error)
        throw new BoundedProcessError('monitor', 'Git storage PostgreSQL serialization fence was lost', { cause: error })
      }
    }
  }
  const deadlineTimer = setTimeout(() => controller.abort(new Error('Git storage mutation exceeded its deadline')), GIT_NATIVE_DEADLINE_MS)
  try {
    const result = await query('SELECT pg_try_advisory_lock(?, ?) AS locked', [LOCK_NAMESPACE, lockKey])
    reusable = true
    locked = result.rows?.[0]?.locked === true
    if (!locked) throw new GitStorageBusyError()
    await turn.assertHeld()
    const value = await turns.run(turn, () => work(turn))
    await turn.assertHeld()
    return value
  } finally {
    turn.active = false
    clearTimeout(deadlineTimer)
    signal?.removeEventListener('abort', abort)
    try {
      if (locked && !controller.signal.aborted) {
        try {
          const result = await query('SELECT pg_advisory_unlock(?, ?) AS unlocked', [LOCK_NAMESPACE, lockKey])
          reusable = result.rows?.[0]?.unlocked === true
        } catch {
          reusable = false
        }
      } else if (controller.signal.aborted) reusable = false
      if (!reusable) {
        // Destroy the underlying socket first: neither a stuck query nor end() may retain the lock.
        connection.connection?.stream?.destroy()
        try {
          await bounded(db.client.destroyRawConnection(connection), 'connection destruction')
        } finally {
          await bounded(db.client.releaseConnection(connection), 'connection release')
        }
      } else await bounded(db.client.releaseConnection(connection), 'connection release')
    } finally {
      connection.removeListener('error', lost)
      connection.removeListener('end', lost)
    }
  }
}
