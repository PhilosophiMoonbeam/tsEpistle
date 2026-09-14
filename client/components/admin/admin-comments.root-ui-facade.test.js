import fs from 'node:fs'
import { DISCUSSION_SECRET_MASK, discussionEnumOptions, discussionIssues, discussionProviderTitle, discussionSettings } from '../../../shared/discussion-policy.ts'
const source = fs.readFileSync('client/components/admin/admin-comments.vue', 'utf8'), script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1]
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'const component ='))
const provider = { key: 'default', title: 'Default', isEnabled: true, isAvailable: true, external: false, description: '', website: '', config: { akismet: '********', minDelay: 30 }, props: { akismet: { type: 'string', sensitive: true }, minDelay: { type: 'number' } } }
const snapshot = { providers: [provider], enabled: true, fingerprint: 'first', counts: { visible: 2, hidden: 1, closedPages: 0 }, runtime: { provider: 'default', antiSpam: { state: 'verified' } } }
function arrange(overrides = {}) {
  const transport = { fetchDiscussionWorkspace: vi.fn().mockResolvedValue(structuredClone(snapshot)), saveDiscussionWorkspace: vi.fn(), fetchDiscussionInventory: vi.fn().mockResolvedValue({ items: [], total: 0 }), inspectDiscussion: vi.fn(), moderateDiscussion: vi.fn(), fetchClosedDiscussions: vi.fn().mockResolvedValue({ items: [], total: 0 }), fetchPageDiscussionPolicy: vi.fn(), savePageDiscussionPolicy: vi.fn(), fetchPageList: vi.fn().mockResolvedValue([]), ...overrides }
  const dependencies = { AsyncState: {}, DISCUSSION_SECRET_MASK, discussionEnumOptions, discussionIssues, discussionProviderTitle, discussionSettings, getErrorMessage: error => error.message, ...transport }
  const component = new Function(...Object.keys(dependencies), compiled + ';return component')(...Object.values(dependencies))
  const state = { ...component.data(), $route: { query: {}, hash: '' }, $router: { replace: vi.fn() } }
  for (const [key, method] of Object.entries(component.methods)) state[key] = method.bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => getter.call(state) })
  return { state, component, transport }
}
describe('discussion workspace drafts and action recovery', () => {
  it('accepts stored values from labelled provider option definitions', () => {
    const providers = [
      structuredClone(provider),
      { key: 'giscus', title: 'Giscus', isEnabled: false, isAvailable: true, external: true, description: '', website: '', config: { theme: 'preferred_color_scheme' }, props: { theme: { type: 'string', title: 'Theme', enum: ['preferred_color_scheme|Follow the reader', 'light|Light'] } } },
      { key: 'hyvortalk', title: 'Hyvor Talk', isEnabled: false, isAvailable: true, external: true, description: '', website: '', config: { colorScheme: 'os' }, props: { colorScheme: { type: 'string', title: 'Colour Scheme', enum: ['os|Follow the reader', 'light|Light'] } } },
      { key: 'remark42', title: 'Remark42', isEnabled: false, isAvailable: true, external: true, description: '', website: '', config: { theme: 'light' }, props: { theme: { type: 'string', title: 'Theme', enum: ['light|Light', 'dark|Dark'] } } }
    ]
    expect(discussionIssues(providers)).toEqual([])
    expect(discussionEnumOptions(providers[1].props.theme)).toEqual([{ value: 'preferred_color_scheme', title: 'Follow the reader' }, { value: 'light', title: 'Light' }])
    providers[1].config.theme = 'sepia'
    expect(discussionIssues(providers)).toEqual([{ provider: 'giscus', field: 'theme', message: 'Giscus · Theme must use one of the listed options.' }])
  })
  it('isolates draft settings and keeps the saved secret masked until explicitly replaced', async () => {
    const { state } = arrange(); await state.reload(); state.current.config.minDelay = 60
    expect(state.saved.providers[0].config.minDelay).toBe(30); expect(state.dirty).toBe(true); expect(state.current.config.akismet).toBe('********')
    state.current.config.akismet = ''; expect(state.savedSecret('default', 'akismet')).toBe(true); state.resetPolicy(); expect(state.dirty).toBe(false)
  })
  it('retains the review and baseline after a conflicting save', async () => {
    const { state, transport } = arrange(); await state.reload(); state.enabled = false; state.reviewOpen = true
    transport.saveDiscussionWorkspace.mockRejectedValue(new Error('Settings changed. Reload.')); await state.savePolicy()
    expect(state.dirty).toBe(true); expect(state.saved.enabled).toBe(true); expect(state.reviewOpen).toBe(true); expect(state.saveError).toBe('Settings changed. Reload.'); expect(state.busy).toBe(false)
  })
  it('keeps a committed save distinct from a failed runtime refresh', async () => {
    const { state, transport } = arrange(); await state.reload(); state.enabled = false
    transport.saveDiscussionWorkspace.mockResolvedValue({ ...snapshot, enabled: false, fingerprint: 'second', warnings: [] }); transport.fetchDiscussionWorkspace.mockRejectedValue(new Error('Unavailable'))
    await state.savePolicy(); expect(state.dirty).toBe(false); expect(state.saved.enabled).toBe(false); expect(state.notice).toContain('saved.'); expect(state.notice).toContain('could not be refreshed'); expect(state.saveError).toBe('')
  })
  it('ignores a late comment inspection when another comment is selected', async () => {
    let release
    const { state, transport } = arrange({ inspectDiscussion: vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValueOnce({ id: 2 }) })
    const pending = state.openComment(1); await state.openComment(2); release({ id: 1 }); await pending
    expect(state.detail.id).toBe(2); expect(transport.inspectDiscussion).toHaveBeenCalledTimes(2)
  })
  it('does not replace an unsaved policy when moderation refreshes workspace counts', async () => {
    const { state, transport } = arrange(); await state.reload(); state.current.config.minDelay = 60
    state.detail = { id: 1, isHidden: false, fingerprint: 'before' }; state.reason = 'Needs context'
    transport.moderateDiscussion.mockResolvedValue({ id: 1, isHidden: true, fingerprint: 'after' }); await state.moderate()
    expect(state.detail.isHidden).toBe(true); expect(state.reason).toBe(''); expect(state.current.config.minDelay).toBe(60); expect(state.saved.providers[0].config.minDelay).toBe(30)
  })
  it('retains a failed moderation reason and does not flip visibility', async () => {
    const { state, transport } = arrange(); state.detail = { id: 1, isHidden: false, fingerprint: 'before' }; state.reason = 'Needs context'
    transport.moderateDiscussion.mockRejectedValue(new Error('Comment changed')); await state.moderate()
    expect(state.detail.isHidden).toBe(false); expect(state.reason).toBe('Needs context'); expect(state.actionError).toBe('Comment changed'); expect(state.busy).toBe(false)
  })
  it('follows back/forward section navigation and returns to policy when a fragment is cleared', () => {
    const { state, component } = arrange(); state.inventory = { items: [] }
    component.watch['$route.hash'].call(state, '#moderation'); expect(state.section).toBe('moderation')
    component.watch['$route.hash'].call(state, ''); expect(state.section).toBe('policy')
  })
  it('blocks empty moderation actions and late asynchronous updates after disposal', async () => {
    let release; const { state, transport } = arrange({ fetchDiscussionWorkspace: () => new Promise(resolve => { release = resolve }) })
    state.detail = { id: 1 }; await state.moderate(); expect(transport.moderateDiscussion).not.toHaveBeenCalled()
    const pending = state.reload(); state.disposed = true; release(snapshot); await pending; expect(state.saved).toBeNull()
  })
})
