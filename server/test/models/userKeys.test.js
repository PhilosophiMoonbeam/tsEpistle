describe('user key consumption', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('validates landing-page tokens without consuming them', async () => {
    const user = { id: 7 }
    const withGraphJoined = vi.fn().mockResolvedValue({
      id: 11,
      userId: user.id,
      validUntil: '2999-01-01T00:00:00.000Z',
      user
    })
    const findOne = vi.fn().mockReturnValue({ withGraphJoined })
    const transaction = vi.fn()
    global.WIKI = {
      Error: { AuthValidationTokenInvalid: class extends Error {} },
      models: {
        knex: { transaction },
        userKeys: { query: vi.fn().mockReturnValue({ findOne }) },
        users: { query: vi.fn() }
      }
    }
    const { default: UserKey } = await vi.importFresh('../../models/userKeys.ts', import.meta.url)

    await expect(UserKey.validateToken({ kind: 'verify', token: 'mail-link', skipDelete: true })).resolves.toBe(user)

    expect(findOne).toHaveBeenCalledWith({ kind: 'verify', token: 'mail-link' })
    expect(withGraphJoined).toHaveBeenCalledWith('user')
    expect(transaction).not.toHaveBeenCalled()
  })

  it('locks and deletes a token in one transaction when an action consumes it', async () => {
    const trx = { name: 'transaction' }
    const user = { id: 7 }
    const forUpdate = vi.fn().mockResolvedValue({
      id: 11,
      userId: user.id,
      validUntil: '2999-01-01T00:00:00.000Z'
    })
    const findOne = vi.fn().mockReturnValue({ forUpdate })
    const deleteById = vi.fn().mockResolvedValue(1)
    const userKeysQuery = vi.fn()
      .mockReturnValueOnce({ findOne })
      .mockReturnValueOnce({ deleteById })
    const findById = vi.fn().mockResolvedValue(user)
    const usersQuery = vi.fn().mockReturnValue({ findById })
    const transaction = vi.fn(async callback => callback(trx))
    global.WIKI = {
      Error: { AuthValidationTokenInvalid: class extends Error {} },
      models: {
        knex: { transaction },
        userKeys: { query: userKeysQuery },
        users: { query: usersQuery }
      }
    }
    const { default: UserKey } = await vi.importFresh('../../models/userKeys.ts', import.meta.url)

    await expect(UserKey.validateToken({ kind: 'resetPwd', token: 'one-use-token' })).resolves.toBe(user)

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(userKeysQuery).toHaveBeenNthCalledWith(1, trx)
    expect(forUpdate).toHaveBeenCalledTimes(1)
    expect(usersQuery).toHaveBeenCalledWith(trx)
    expect(findById).toHaveBeenCalledWith(user.id)
    expect(userKeysQuery).toHaveBeenNthCalledWith(2, trx)
    expect(deleteById).toHaveBeenCalledWith(11)
  })
})
