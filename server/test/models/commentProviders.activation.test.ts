import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
let initialize = async (_config: Record<string, unknown>): Promise<void> => {}
vi.mockModule('../../modules/comments/default/comment.ts', import.meta.url, () => ({ default: { init: (config: Record<string, unknown>) => initialize(config) } }))
describe('discussion provider runtime activation', () => {
  beforeEach(() => { initialize = async () => {} })
  it('serializes initialization so a slow native provider cannot overwrite a later external activation', async () => {
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    initialize = async config => { expect(config).toEqual({ akismet: '', minDelay: 30 }); entered(); await gate }
    let active = [{ key: 'default', config: { akismet: '', minDelay: 30 } }] as Array<{ key: string; config: Record<string, unknown> }>
    const getProviders = vi.fn(async () => active)
    const runtime = { data: { commentProviders: [{ key: 'default', isAvailable: true }, { key: 'commento', isAvailable: true, codeTemplate: true }], commentProvider: {} as Record<string, unknown> }, models: { commentProviders: { getProviders } } }
    const original = globalThis.WIKI; globalThis.WIKI = runtime as never
    try {
      const { default: Model } = await vi.importFresh('../../models/commentProviders.ts', import.meta.url)
      const native = Model.initProvider(); await ready
      active = [{ key: 'commento', config: { instanceUrl: 'https://comments.example.invalid' } }]
      const external = Model.initProvider()
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(getProviders).toHaveBeenCalledTimes(1)
      } finally {
        release()
        await Promise.all([native, external])
      }
      expect(getProviders).toHaveBeenCalledTimes(2)
      expect(runtime.data.commentProvider.key).toBe('commento'); expect(runtime.data.commentProvider.config).toEqual({ instanceUrl: 'https://comments.example.invalid' }); expect(typeof runtime.data.commentProvider.renderForPage).toBe('function')
    } finally { release(); globalThis.WIKI = original }
  })
})
