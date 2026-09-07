import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const readdir = vi.hoisted(() => vi.fn())
vi.mockModule('fs-extra', import.meta.url, () => ({ default: { readdir } }))

const previousWiki = Reflect.get(globalThis, 'WIKI')

describe('optional extension registry', () => {
  beforeEach(() => {
    readdir.mockReset()
    Reflect.set(globalThis, 'WIKI', { SERVERPATH: '/application', logger: { info: vi.fn() } })
  })

  afterEach(() => {
    if (previousWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else Reflect.set(globalThis, 'WIKI', previousWiki)
  })

  it('withholds the registry until all deployment definitions have loaded', async () => {
    const directoryRead = Promise.withResolvers<never[]>()
    readdir.mockReturnValue(directoryRead.promise)
    const { default: extensions } = await vi.importFresh<typeof import('../../core/extensions.ts')>('../../core/extensions.ts', import.meta.url)

    const initializing = extensions.init()
    await expect(extensions.inspect()).rejects.toMatchObject({ status: 503 })
    expect(extensions.ext).toEqual({})

    directoryRead.resolve([])
    await initializing

    expect(Object.isFrozen(extensions.ext)).toBe(true)
    await expect(extensions.inspect()).resolves.toEqual([])
  })
})
