import fs from 'node:fs'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { generalPolicyDefaults, generalFieldLabels, validateGeneralPolicy, generalChangedFields, externalSourceUrl } from '../../../shared/general-policy.ts'
import { siteBannerState } from '../../../shared/site-banner.ts'
const script = fs.readFileSync('client/components/admin/admin-general.vue', 'utf8').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]!
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '').replace('export default', 'const component ='))
const snapshot = { policy: { ...structuredClone(generalPolicyDefaults), title: 'Saved workspace', host: 'https://wiki.example.com' }, fingerprint: 'review-one', history: [], runtime: { state: 'applied', observedAt: '2026-09-06T00:00:00Z' } }
function arrange(overrides = {}) {
  const transport = { fetchGeneralWorkspace: vi.fn().mockResolvedValue(structuredClone(snapshot)), saveGeneralWorkspace: vi.fn().mockResolvedValue({ activation: 'applied' }), retryGeneralRuntime: vi.fn().mockResolvedValue({ activation: 'applied' }), ...overrides }
  const window = { confirm: vi.fn().mockReturnValue(true), scrollTo: vi.fn() }, wikiStore = { site: {} }
  const deps = { AsyncState: {}, SiteBanner: {}, GeneralLogoManager: {}, wikiStore, generalFieldLabels, validateGeneralPolicy, generalChangedFields, externalSourceUrl, siteBannerState, renderFooterMarkdown: (value: string) => value, getErrorMessage: (e: Error) => e.message, window, ...transport }
  const component = new Function(...Object.keys(deps), compiled + ';return component')(...Object.values(deps))
  const state = { ...component.data(), $route: { query: {}, hash: '' }, $router: { replace: vi.fn() }, $t: (value: string) => value }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, transport, component, window, wikiStore }
}
describe('General reviewed workspace', () => {
  it('separates saved settings from drafts, supports reset and keeps schedule values explicitly UTC', async () => {
    const { state } = arrange(); await state.load(); state.draft.title = 'Draft'; expect(state.saved.policy.title).toBe('Saved workspace'); state.setSchedule('startsAt', '2026-09-08T10:30'); expect(state.draft.banner.startsAt).toBe('2026-09-08T10:30:00Z'); state.setSchedule('endsAt', null); expect(state.draft.banner.endsAt).toBeNull(); state.reset(); expect(state.dirty).toBe(false)
    state.setRobots('index', 'noindex'); expect(state.draft.robots).toContain('noindex'); expect(state.draft.robots).not.toContain('index')
  })
  it('uses an immutable review and locks navigation until the write settles', async () => {
    let release: (value: unknown) => void = () => {}
    const { state, transport, component } = arrange({ saveGeneralWorkspace: vi.fn(() => new Promise(resolve => { release = resolve })) })
    await state.load(); state.draft.title = 'Reviewed name'; state.review(); state.reason = 'Make the workspace recognizable'; const pending = state.confirm(); state.draft.title = 'Later mutation'
    expect(transport.saveGeneralWorkspace.mock.calls[0]?.[0].title).toBe('Reviewed name'); expect(state.canLeave()).toBe(false); expect(component.beforeRouteUpdate.call(state,{path:'/general'},{path:'/general'})).toBe(false); release({ activation: 'applied' }); await pending
  })
  it('retains reasons on conflicts and requires explicit reload before a repeat save', async () => {
    const { state, transport, window } = arrange(); await state.load(); state.draft.title = 'Draft'; state.review(); state.reason = 'Describe the change'; transport.saveGeneralWorkspace.mockRejectedValue(Object.assign(new Error('Settings changed'),{status:409})); await state.confirm(); await state.confirm(); expect(transport.saveGeneralWorkspace).toHaveBeenCalledOnce(); expect(state.reason).toBe('Describe the change'); expect(state.stale).toBe(true); window.confirm.mockReturnValue(false); await state.reloadReview(); expect(state.reviewing).toBe(true); window.confirm.mockReturnValue(true); await state.reloadReview(); expect(state.dirty).toBe(false)
  })
  it('requires reload after uncertain writes but preserves a confirmed save when its following read fails', async () => {
    for (const error of [new Error('Disconnected'), Object.assign(new Error('Gateway failed'),{status:502})]) { const {state,transport}=arrange(); await state.load(); state.draft.title='Draft'; state.review(); state.reason='Describe the change'; transport.saveGeneralWorkspace.mockRejectedValue(error); await state.confirm(); expect(state.locked).toBe(true) }
    const {state,transport,wikiStore}=arrange(); await state.load(); state.draft.title='Committed'; state.review(); state.reason='Describe the change'; transport.fetchGeneralWorkspace.mockRejectedValue(new Error('Read unavailable')); await state.confirm(); expect(state.saved.policy.title).toBe('Committed'); expect(state.dirty).toBe(false); expect(state.stale).toBe(true); expect(wikiStore.site).toMatchObject({title:'Committed'}); expect(state.saveError).toBe(''); expect(state.loadError).toBe('Read unavailable')
  })
  it('validates before review and permits runtime retry only for a clean saved state', async () => {
    const {state,transport}=arrange(); await state.load(); state.draft.host='javascript:alert(1)'; state.review(); expect(state.reviewing).toBe(false); expect(state.attention).toBe(true); await state.initialize(); expect(transport.retryGeneralRuntime).not.toHaveBeenCalled(); state.reset(); await state.initialize(); expect(transport.retryGeneralRuntime).toHaveBeenCalledWith('review-one')
  })
  it('suppresses outdated reads and protects drafts from route changes', async () => {
    let release: (value: unknown) => void = () => {}
    const {state,window}=arrange({fetchGeneralWorkspace:vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=resolve})).mockResolvedValue({...snapshot,fingerprint:'new'})}); const first=state.load(); await state.load(); release(snapshot); await first; expect(state.saved.fingerprint).toBe('new'); state.draft.title='Draft'; window.confirm.mockReturnValue(false); expect(state.canLeave()).toBe(false); await state.reload(); expect(state.draft.title).toBe('Draft')
  })
})
