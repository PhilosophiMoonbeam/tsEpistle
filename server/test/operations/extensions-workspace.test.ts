import { describe, expect, it, vi } from '../bun-test.mts'
import type { Knex } from 'knex'
import { createExtensionsWorkspaceStore } from '../../operations/extensions-workspace.ts'

const requester = { user: { id: 7, authVersion: 2, groups: [3], ownershipUserId: 7 } } as never

const fixture = () => {
  const transaction = { commit: vi.fn(), rollback: vi.fn() }
  const db = { transaction: vi.fn().mockResolvedValue(transaction) } as unknown as Knex
  const service = { inspect: vi.fn().mockResolvedValue([]) }
  const authority = vi.fn().mockResolvedValue({ actorId: 7 })
  return { transaction, db, service, authority }
}

describe('extensions workspace observations', () => {
  it('commits the current-authority read before it begins a bounded extension refresh', async () => {
    const { transaction, db, service, authority } = fixture()
    const observed = Promise.withResolvers<never[]>()
    service.inspect.mockReturnValue(observed.promise)
    const store = createExtensionsWorkspaceStore({
      db,
      extensions: service,
      now: () => new Date('2026-09-07T00:00:00.000Z'),
      requireAuthority: authority
    })

    const inspection = store.inspect(requester)
    await vi.waitFor(() => expect(service.inspect).toHaveBeenCalledTimes(1))
    expect(authority).toHaveBeenCalledWith(transaction, requester)
    expect(transaction.commit).toHaveBeenCalledTimes(1)
    expect(transaction.commit.mock.invocationCallOrder[0]).toBeLessThan(service.inspect.mock.invocationCallOrder[0])
    observed.resolve([])
    await inspection
  })

  it('does not reveal or refresh process observations after current authority is rejected', async () => {
    const { transaction, db, service, authority } = fixture()
    authority.mockRejectedValueOnce(Object.assign(new Error('Current system administration access is required.'), { status: 403 }))
    const store = createExtensionsWorkspaceStore({ db, extensions: service, requireAuthority: authority })

    await expect(store.inspect(requester)).rejects.toThrow('Current system administration access is required.')
    expect(transaction.rollback).toHaveBeenCalledTimes(1)
    expect(service.inspect).not.toHaveBeenCalled()
  })
})
