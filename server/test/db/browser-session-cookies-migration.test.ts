import { up } from '../../db/migrations/tsepistle-000028-browser-session-cookies.ts'

describe('browser session cookie cutover migration', () => {
  it('advances human auth generations without touching API-key tables', async () => {
    const update = vi.fn().mockResolvedValue(3)
    const whereNot = vi.fn().mockReturnValue({ update })
    const knex = Object.assign(vi.fn().mockReturnValue({ whereNot }), {
      raw: vi.fn().mockReturnValue('authVersion + 1')
    })
    await up(knex as never)


    expect(knex).toHaveBeenCalledWith('users')
    expect(whereNot).toHaveBeenCalledWith('id', 2)
    expect(update).toHaveBeenCalledWith({
      authVersion: 'authVersion + 1',
      sessionsRevokedAt: expect.any(String)
    })
    expect(knex).not.toHaveBeenCalledWith('userKeys')
  })
})
