import { newPasswordIssue } from '../../../shared/security-policy.ts'
import fs from 'node:fs'
import { accountActionTitle, accountProfileIssues } from '../../../shared/account-policy.ts'
import type { AccountWorkspace } from '../../../shared/account-policy.ts'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { document, resetBody } from '../../test/browser-dom.mts'
// The shell's themed confirm dialog is replaced by the fake window.confirm in these isolated script tests.
const confirmStubs = (host: { confirm: (text: string) => boolean }) => ({
  confirmDiscard: async (title: string) => host.confirm(title),
  requestConfirmation: async ({ title }: { title: string }) => host.confirm(title)
})

// Runtime imports must follow browser-dom: Vuetify snapshots browser capabilities during module evaluation.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const source = fs.readFileSync('client/components/admin/admin-users-edit.vue', 'utf8'),
  script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]!
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'const component ='))
const template = compileTemplate({
  source: parse(source).descriptor.template!.content,
  filename: 'client/components/admin/admin-users-edit.vue',
  id: 'account-workspace-conflict',
  compilerOptions: { mode: 'function' }
})
if (template.errors.length) throw template.errors[0]
const renderAccount = new Function('Vue', template.code)(Vue)
const toggleSource = parse(fs.readFileSync('client/components/common/password-visibility-toggle.vue', 'utf8')).descriptor
const toggleTemplate = compileTemplate({
  source: toggleSource.template!.content,
  filename: 'client/components/common/password-visibility-toggle.vue',
  id: 'account-workspace-password-toggle',
  preprocessLang: toggleSource.template!.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
const toggleScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(toggleSource.script!.content.replace(/^import .+$/gm, '').replace('export default', 'return'))
const PasswordVisibilityToggle = { ...new Function('defineComponent', toggleScript)(Vue.defineComponent), render: new Function('Vue', toggleTemplate.code)(Vue) }
const settle = async () => {
  for (let pass = 0; pass < 4; pass++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const snapshot: AccountWorkspace = {
  id: 7,
  name: 'Alex',
  email: 'alex@example.invalid',
  providerKey: 'local',
  providerTitle: 'Local sign-in',
  provider: { key: 'local', title: 'Local sign-in', strategy: 'local', enabled: true, available: true, localPassword: true, supportsTwoFactor: true },
  isSystem: false,
  isActive: true,
  isVerified: true,
  twoFactor: 'off',
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
  lastLoginAt: null,
  groups: [{ id: 3, name: 'Authors' }],
  permissions: ['read:pages'],
  mustChangePassword: false,
  sessionsRevokedAt: null,
  privateOwnershipBlocksDeletion: false,
  contributionCounts: { pagesCreated: 0, pagesAuthored: 0, comments: 0, assets: 0 },
  profile: { name: 'Alex', email: 'alex@example.invalid', location: 'Before', jobTitle: '', timezone: 'UTC', groups: [3] },
  fingerprint: 'version-one',
  availableGroups: [{ id: 3, name: 'Authors', permissions: ['read:pages'], canAssign: true, isSystem: false }],
  capabilities: { edit: true, password: true, delete: true, actions: ['deactivate', 'end-sessions'], explanation: '' },
  history: []
}
function arrange(overrides: Record<string, unknown> = {}) {
  const transport = {
    fetchAccount: vi.fn().mockResolvedValue(structuredClone(snapshot)),
    fetchAccountDirectory: vi.fn(),
    saveAccountProfile: vi.fn(),
    actOnAccount: vi.fn(),
    replaceAccountPassword: vi.fn(),
    deleteAccount: vi.fn(),
    sendAccountWelcomeEmail: vi.fn(),
    ...overrides
  }
  const window = { confirm: vi.fn().mockReturnValue(true), location: { assign: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const dependencies = {
    passwordPolicyMixin: {},
    newPasswordIssue,
    AsyncState: { render: () => Vue.h('div') },
    PasswordVisibilityToggle,
    accountActionTitle,
    accountProfileIssues,
    wikiStore: { user: { id: 1 } },
    accountRequestStatus: (error: { status?: number }) => error.status ?? 0,
    getErrorMessage: (error: Error) => error.message,
    window,
    ...transport
  }
  Object.assign(dependencies, confirmStubs(window))
  const component = new Function(...Object.keys(dependencies), compiled + ';return component')(...Object.values(dependencies))
  const state = { ...component.data(), passwordMinimum: 12, $route: { params: { id: '7' }, query: {}, hash: '' }, $router: { replace: vi.fn(), push: vi.fn() } }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, component, transport, window }
}
describe('account workspace review and recovery', () => {
  it('isolates profile drafts, supports clearing fields, and locks security actions while dirty', async () => {
    const { state } = arrange()
    await state.reload()
    state.draft.location = ''
    state.draft.groups.push(4)
    expect(state.saved.profile.location).toBe('Before')
    expect(state.saved.profile.groups).toEqual([3])
    expect(state.dirty).toBe(true)
    expect(state.actionLocked).toBe(true)
    state.open('deactivate')
    expect(state.dialog).toBe(false)
    state.reset()
    expect(state.dirty).toBe(false)
  })
  it('keeps the draft, reason and saved baseline after a conflict and disables repeat confirmation', async () => {
    const arranged = arrange()
    const { transport } = arranged
    const host = document.createElement('div')
    document.body.append(host)
    const app = Vue.createApp({ ...arranged.component, render: renderAccount })
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
    app.config.globalProperties.$route = arranged.state.$route
    app.config.globalProperties.$router = arranged.state.$router
    app.config.globalProperties.passwordMinimum = 12
    app.component('AdminHero', Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('header', [slots.default?.(), slots.actions?.()]) }))
    app.component('RouterLink', Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('a', slots.default?.()) }))
    const state = app.mount(host) as unknown as typeof arranged.state
    const confirmButton = () => {
      const button = document.querySelector<HTMLButtonElement>('.account-review-dialog .v-card-actions button:last-child')
      if (!button) throw new Error('The account review confirmation button did not render')
      return button
    }
    try {
      await settle()
      state.draft.location = ''
      state.open('profile')
      state.reason = 'Remove old location'
      transport.saveAccountProfile.mockRejectedValueOnce(Object.assign(new Error('Account changed'), { status: 409 }))
      await settle()
      expect(confirmButton().disabled).toBe(false)
      confirmButton().click()
      await settle()
      expect(state.dialog).toBe(true)
      expect(state.draft.location).toBe('')
      expect(state.saved.profile.location).toBe('Before')
      expect(state.reason).toBe('Remove old location')
      expect(state.conflict).toBe(true)
      expect(state.busy).toBe(false)
      expect(confirmButton().disabled).toBe(true)
      confirmButton().click()
      await settle()
      expect(transport.saveAccountProfile).toHaveBeenCalledOnce()
      const reloadButton = document.querySelector<HTMLButtonElement>('.account-review-dialog .v-alert button')
      if (!reloadButton) throw new Error('The conflict recovery reload button did not render')
      reloadButton.click()
      await settle()
      expect(state.dialog).toBe(false)
      expect(state.dirty).toBe(false)
      state.draft.location = ''
      state.open('profile')
      state.reason = 'Review the refreshed account'
      transport.saveAccountProfile.mockResolvedValue({ ...snapshot, profile: { ...snapshot.profile, location: '' }, fingerprint: 'version-two' })
      await settle()
      expect(confirmButton().disabled).toBe(false)
      confirmButton().click()
      await settle()
      expect(transport.saveAccountProfile).toHaveBeenCalledTimes(2)
      expect(state.dialog).toBe(false)
      expect(state.saved.fingerprint).toBe('version-two')
    } finally {
      app.unmount()
      host.remove()
      resetBody()
    }
  })
  it('uses the shared password toggle in the replacement dialog and hides the password again on reopen', async () => {
    const arranged = arrange()
    const host = document.createElement('div')
    document.body.append(host)
    const app = Vue.createApp({ ...arranged.component, render: renderAccount })
    app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
    app.config.globalProperties.$route = arranged.state.$route
    app.config.globalProperties.$router = arranged.state.$router
    app.config.globalProperties.passwordMinimum = 12
    app.config.globalProperties.$t = (key: string, options: { field?: string } = {}) => (key === 'common:password.show' ? `Show ${options.field}` : key)
    app.component('AdminHero', Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('header', [slots.default?.(), slots.actions?.()]) }))
    app.component('RouterLink', Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('a', slots.default?.()) }))
    const state = app.mount(host) as unknown as typeof arranged.state
    try {
      await settle()
      state.open('password')
      await settle()
      const toggle = () => document.querySelector<HTMLButtonElement>('.account-review-dialog .password-visibility-toggle')
      const input = () => document.querySelector<HTMLInputElement>('.account-review-dialog input[autocomplete="new-password"]')
      expect(toggle()?.getAttribute('aria-label')).toBe('Show new temporary password')
      expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
      expect(input()?.type).toBe('password')
      toggle()!.click()
      await settle()
      expect(toggle()?.getAttribute('aria-label')).toBe('Show new temporary password')
      expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
      expect(input()?.type).toBe('text')
      state.dialog = false
      state.open('password')
      await settle()
      expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
      expect(input()?.type).toBe('password')
    } finally {
      app.unmount()
      host.remove()
      resetBody()
    }
  })
  it('sends a fixed draft snapshot and keeps navigation locked through a save', async () => {
    let resolve: (value: unknown) => void = () => {}
    const { state, transport } = arrange({
      saveAccountProfile: vi.fn(
        () =>
          new Promise(r => {
            resolve = r
          })
      )
    })
    await state.reload()
    state.draft.location = ''
    state.open('profile')
    state.reason = 'Clear outdated location'
    const pending = state.confirm()
    expect(state.busy).toBe(true)
    expect(state.profileLocked).toBe(true)
    await expect(state.canLeave()).resolves.toBe(false)
    state.draft.location = 'Changed while pending'
    expect(transport.saveAccountProfile.mock.calls[0]?.[1]).toMatchObject({ location: '' })
    resolve({ ...snapshot, profile: { ...snapshot.profile, location: '' }, fingerprint: 'version-two' })
    await pending
    expect(state.draft.location).toBe('')
    expect(state.dirty).toBe(false)
    expect(state.dialog).toBe(false)
  })
  it('suppresses a late account response after another account is selected', async () => {
    let resolve: (value: unknown) => void = () => {}
    const { state } = arrange({
      fetchAccount: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(r => {
              resolve = r
            })
        )
        .mockResolvedValueOnce({ ...snapshot, id: 8 })
    })
    const pending = state.reload()
    state.$route.params.id = '8'
    await state.reload()
    resolve(snapshot)
    await pending
    expect(state.saved.id).toBe(8)
  })
  it('keeps welcome-mail acceptance separate from a failed history refresh', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.open('welcome')
    state.reason = 'Welcome this person'
    transport.sendAccountWelcomeEmail.mockResolvedValue({ accepted: true })
    transport.fetchAccount.mockRejectedValue(new Error('Read unavailable'))
    await state.confirm()
    expect(state.notice).toContain('accepted by the mail service')
    expect(state.notice).toContain('Reload to refresh')
    expect(state.actionError).toBe('')
    expect(state.dialog).toBe(false)
  })
  it('retains uncertain outcomes without changing saved status or automatically retrying a request', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.open('deactivate')
    state.reason = 'Pause the account'
    transport.actOnAccount.mockRejectedValue(new Error('Connection lost'))
    await state.confirm()
    expect(state.actionError).toContain('outcome is unconfirmed')
    expect(state.dialog).toBe(true)
    expect(transport.actOnAccount).toHaveBeenCalledOnce()
    expect(state.saved.fingerprint).toBe('version-one')
  })
  it('clears password entry after successful replacement and keeps credentials out of notices', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.open('password')
    state.password = 'temporary-password-12'
    state.reason = 'Recovery verified'
    transport.replaceAccountPassword.mockResolvedValue({ ...snapshot, fingerprint: 'new' })
    await state.confirm()
    expect(state.password).toBe('')
    expect(state.notice).not.toContain('temporary-password-12')
    expect(state.dialog).toBe(false)
  })
  it('protects unsaved navigation and synchronizes fragment navigation', async () => {
    const { state, component, window } = arrange()
    await state.reload()
    state.draft.name = 'Unsaved'
    window.confirm.mockReturnValue(false)
    await expect(component.beforeRouteLeave.call(state)).resolves.toBe(false)
    await expect(component.beforeRouteUpdate.call(state, { params: { id: '8' } }, { params: { id: '7' } })).resolves.toBe(false)
    expect(component.beforeRouteUpdate.call(state, { params: { id: '7' } }, { params: { id: '7' } })).toBe(true)
    component.watch['$route.hash'].handler.call(state, '#security')
    expect(state.section).toBe('security')
    component.watch['$route.hash'].handler.call(state, '')
    expect(state.section).toBe('profile')
  })
  it('requires both a replacement person and exact account confirmation before deletion', async () => {
    const { state, transport } = arrange()
    await state.reload()
    state.operation = 'delete'
    state.reason = 'Retire old account'
    state.replaceId = 8
    expect(state.canConfirm).toBe(false)
    state.deleteConfirmation = '7'
    expect(state.canConfirm).toBe(true)
    state.replaceId = null
    await state.confirm()
    expect(transport.deleteAccount).not.toHaveBeenCalled()
  })
})
