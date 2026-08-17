import { expect, it, vi } from 'vitest'

  it('registers under the configured transport-specific key', async () => {
    Reflect.set(globalThis, 'WIKI', {})
    const { default: localAuthentication } = await import('./authentication.ts')
    const passport = { use: vi.fn() }
    localAuthentication.init(passport as never, { key: 'agents:local' } as never)
    expect(passport.use).toHaveBeenCalledWith('agents:local', expect.anything())
    Reflect.deleteProperty(globalThis, 'WIKI')
  })
