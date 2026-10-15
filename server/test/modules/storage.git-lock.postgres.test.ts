import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { GitStorageBusyError, withGitMutationLock } from '../../modules/storage/git/mutation-lock.ts'

const connection = getPostgresTestConnection('_storage_git_lock_test', import.meta.path)
const suite = connection ? describe : describe.skip

suite('Git storage cross-replica PostgreSQL mutation admission', () => {
  let first: Knex
  let second: Knex
  beforeAll(() => {
    first = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 2 } })
    second = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 2 } })
  })
  afterAll(async () => {
    await Promise.all([first?.destroy(), second?.destroy()])
  })

  it('rejects another replica for the same target before entering its working-copy effect, but admits another target', async () => {
    const entered = Promise.withResolvers<void>()
    const leave = Promise.withResolvers<void>()
    let overlappingWork = false
    const incumbent = withGitMutationLock(first, 'git', async turn => {
      entered.resolve()
      await leave.promise
      await turn.assertHeld()
    })
    await entered.promise
    try {
      await expect(
        withGitMutationLock(second, 'git', async () => {
          overlappingWork = true
        })
      ).rejects.toBeInstanceOf(GitStorageBusyError)
      expect(overlappingWork).toBe(false)
      let independentWork = false
      await withGitMutationLock(second, 'git-other', async turn => {
        await turn.assertHeld()
        independentWork = true
      })
      expect(independentWork).toBe(true)
    } finally {
      leave.resolve()
      await incumbent
    }
    await withGitMutationLock(second, 'git', async turn => {
      await turn.assertHeld()
    })
  })

  it('does not grant a second replica admission merely because it inherits the current async context', async () => {
    let secondEffectEntered = false
    await withGitMutationLock(first, 'git-inherited', async () => {
      await expect(
        withGitMutationLock(second, 'git-inherited', async () => {
          secondEffectEntered = true
        })
      ).rejects.toBeInstanceOf(GitStorageBusyError)
    })
    expect(secondEffectEntered).toBe(false)
  })

  it('releases the session fence when a mutation fails so a durable retry can enter', async () => {
    await expect(
      withGitMutationLock(first, 'git-error', async () => {
        throw new Error('Effect failed before receipt')
      })
    ).rejects.toThrow('Effect failed before receipt')
    let retried = false
    await withGitMutationLock(second, 'git-error', async turn => {
      await turn.assertHeld()
      retried = true
    })
    expect(retried).toBe(true)
  })

  it('fails closed on cancellation and destroys the cancelled session before another replica resumes', async () => {
    const controller = new AbortController()
    await expect(
      withGitMutationLock(
        first,
        'git-cancelled',
        async turn => {
          controller.abort()
          await turn.assertHeld()
        },
        controller.signal
      )
    ).rejects.toThrow('cancelled or lost')
    let resumed = false
    await withGitMutationLock(second, 'git-cancelled', async turn => {
      await turn.assertHeld()
      resumed = true
    })
    expect(resumed).toBe(true)
  })
})

describe('Git storage fail-closed mutation admission', () => {
  it('never enters a working-copy mutation without a PostgreSQL serialization connection', async () => {
    let mutationEntered = false
    await expect(
      withGitMutationLock(undefined as unknown as Knex, 'git', async () => {
        mutationEntered = true
      })
    ).rejects.toThrow('require PostgreSQL advisory serialization')
    expect(mutationEntered).toBe(false)
  })
})
