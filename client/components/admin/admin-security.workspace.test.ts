import fs from 'node:fs'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import {
  securityPolicyDefaults,
  securityPolicyLabels,
  validateSecurityPolicy,
  securityChangedFields,
  securityEndsSessions
} from '../../../shared/security-policy.ts'
// The shell's themed confirm dialog is replaced by the fake window.confirm in these isolated script tests.
const confirmStubs = (host: { confirm: (text: string) => boolean }) => ({
  confirmDiscard: async (title: string) => host.confirm(title),
  requestConfirmation: async ({ title }: { title: string }) => host.confirm(title)
})
const script = fs.readFileSync('client/components/admin/admin-security.vue', 'utf8').match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]!
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default', 'const component =')
)
const snapshot = {
  policy: structuredClone(securityPolicyDefaults),
  fingerprint: 'review-one',
  host: 'https://wiki.example.invalid',
  providers: [],
  coverage: {},
  history: [],
  headers: {},
  runtime: { state: 'applied', observedAt: '2026-09-06T00:00:00Z', policy: structuredClone(securityPolicyDefaults) }
}
function arrange(overrides: Record<string, unknown> = {}) {
  const transport = {
    fetchSecurityWorkspace: vi.fn().mockResolvedValue(structuredClone(snapshot)),
    saveSecurityWorkspace: vi.fn().mockResolvedValue({ sessionsEnded: 0, currentSessionEnded: false, activation: 'applied' }),
    retrySecurityRuntime: vi.fn().mockResolvedValue({ activation: 'applied' }),
    ...overrides
  }
  const window = { confirm: vi.fn().mockReturnValue(true), location: { assign: vi.fn() } },
    wikiStore = { editor: { activeModal: '', editorKey: '' } }
  const dependencies = {
    AsyncState: {},
    SecurityDuration: {},
    defineAsyncComponent: () => ({}),
    wikiStore,
    onEditorInsert: vi.fn(),
    offEditorInsert: vi.fn(),
    securityPolicyLabels,
    validateSecurityPolicy,
    securityChangedFields,
    securityEndsSessions,
    getErrorMessage: (e: Error) => e.message,
    window,
    ...transport
  }
  Object.assign(dependencies, confirmStubs(window))
  const component = new Function(...Object.keys(dependencies), compiled + ';return component')(...Object.values(dependencies))
  const state = { ...component.data(), $route: { query: {}, hash: '' }, $router: { replace: vi.fn() } }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, transport, component, window, wikiStore }
}
describe('Security workspace review and recovery', () => {
  it('keeps drafts separate from saved policy and stages session-only actions', async () => {
    const { state } = arrange()
    await state.load()
    state.draft.authEnforce2FA = true
    expect(state.saved.policy.authEnforce2FA).toBe(false)
    expect(state.dirty).toBe(true)
    state.reset()
    state.endSessions = true
    state.review()
    expect(state.reviewEndsSessions).toBe(true)
    expect(state.changes).toEqual([])
  })
  it('sends a fixed review and locks navigation throughout persistence', async () => {
    let release: (value: unknown) => void = () => {}
    const { state, transport, component } = arrange({
      saveSecurityWorkspace: vi.fn(
        () =>
          new Promise(r => {
            release = r
          })
      )
    })
    await state.load()
    state.draft.uploadMaxFileSize = 0
    state.review()
    state.reason = 'Pause new uploads'
    const pending = state.confirm()
    state.draft.uploadMaxFileSize = 100
    expect(transport.saveSecurityWorkspace.mock.calls[0]?.[0].uploadMaxFileSize).toBe(0)
    await expect(component.beforeRouteUpdate.call(state, { path: '/security' }, { path: '/security' })).resolves.toBe(false)
    await expect(state.canLeave()).resolves.toBe(false)
    release({ sessionsEnded: 0, currentSessionEnded: false, activation: 'applied' })
    await pending
  })
  it('retains conflicts and administrative reasons without allowing another save', async () => {
    const { state, transport, window } = arrange()
    await state.load()
    state.draft.uploadScanSVG = false
    state.review()
    state.reason = 'Review upload handling'
    transport.saveSecurityWorkspace.mockRejectedValue(Object.assign(new Error('Policy changed'), { status: 409 }))
    await state.confirm()
    await state.confirm()
    expect(transport.saveSecurityWorkspace).toHaveBeenCalledOnce()
    expect(state.reason).toBe('Review upload handling')
    expect(state.stale).toBe(true)
    window.confirm.mockReturnValue(false)
    await state.reloadReview()
    expect(state.reviewing).toBe(true)
    window.confirm.mockReturnValue(true)
    await state.reloadReview()
    expect(state.dirty).toBe(false)
  })
  it('requires reload for network and server failures with an uncertain outcome', async () => {
    for (const error of [new Error('Disconnected'), Object.assign(new Error('Gateway failed'), { status: 502 })]) {
      const { state, transport } = arrange()
      await state.load()
      state.draft.uploadMaxFileSize = 0
      state.review()
      state.reason = 'Pause upload capacity'
      transport.saveSecurityWorkspace.mockRejectedValue(error)
      await state.confirm()
      expect(state.stale).toBe(true)
      expect(state.locked).toBe(true)
    }
  })
  it('preserves committed state if the following read fails', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.draft.uploadMaxFileSize = 0
    state.review()
    state.reason = 'Pause new uploads'
    transport.fetchSecurityWorkspace.mockRejectedValue(new Error('Read unavailable'))
    await state.confirm()
    expect(state.saved.policy.uploadMaxFileSize).toBe(0)
    expect(state.dirty).toBe(false)
    expect(state.notice).toContain('Security policy saved')
    expect(state.stale).toBe(true)
    expect(state.reviewed).toBeNull()
  })
  it('rejects invalid policies before review and only retries runtime for a clean saved policy', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.draft.authPasswordMinLength = 6
    state.review()
    expect(state.reviewing).toBe(false)
    expect(state.attention).toBe(true)
    await state.initialize()
    expect(transport.retrySecurityRuntime).not.toHaveBeenCalled()
    state.reset()
    await state.initialize()
    expect(transport.retrySecurityRuntime).toHaveBeenCalledWith('review-one')
  })
  it('redirects to the recovery sign-in page after ending the current session', async () => {
    const { state, transport, window } = arrange()
    await state.load()
    state.endSessions = true
    state.review()
    state.reason = 'Require fresh account sign-ins'
    transport.saveSecurityWorkspace.mockResolvedValue({ sessionsEnded: 4, currentSessionEnded: true, activation: 'applied' })
    await state.confirm()
    expect(window.location.assign).toHaveBeenCalledWith('/login?all=1')
    await expect(state.canLeave()).resolves.toBe(true)
  })
  it('ignores outdated reads, protects unsaved navigation and scopes asset selection to this workspace', async () => {
    let release: (value: unknown) => void = () => {}
    const { state, window, wikiStore } = arrange({
      fetchSecurityWorkspace: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(r => {
              release = r
            })
        )
        .mockResolvedValue({ ...snapshot, fingerprint: 'new' })
    })
    const first = state.load()
    await state.load()
    release(snapshot)
    await first
    expect(state.saved.fingerprint).toBe('new')
    state.browseBackground()
    expect(wikiStore.editor.activeModal).toBe('editorModalMedia')
    state.handleBackgroundSelection({ path: '/uploads/background.svg' })
    expect(state.draft.authLoginBgUrl).toBe('/uploads/background.svg')
    expect(state.saved.policy.authLoginBgUrl).toBe('')
    window.confirm.mockReturnValue(false)
    await expect(state.canLeave()).resolves.toBe(false)
    state.handleBackgroundSelection({ path: '/unrelated' })
    expect(state.draft.authLoginBgUrl).toBe('/uploads/background.svg')
  })
})
