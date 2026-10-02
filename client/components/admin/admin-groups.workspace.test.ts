import fs from 'node:fs'
import { groupPermissions } from '../../../shared/group-policy.ts'
import { groupPolicyCopy, groupPolicySignature, emptyGroupPolicy } from '../../helpers/group-workspace-api.ts'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
// The shell's themed confirm dialog is replaced by the fake window.confirm in these isolated script tests.
const confirmStubs = (host: { confirm: (text: string) => boolean }) => ({
  confirmDiscard: async (title: string) => host.confirm(title),
  requestConfirmation: async ({ title }: { title: string }) => host.confirm(title)
})
const source = fs.readFileSync('client/components/admin/admin-groups-edit.vue', 'utf8'),
  script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]!
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'const component ='))
const snapshot = {
  id: 3,
  name: 'Researchers',
  description: 'Before',
  redirectOnLogin: '/',
  permissions: ['read:pages'],
  pageRules: [{ id: 'all', match: 'START', path: '', deny: false, roles: ['read:pages'], locales: [] }],
  isSystem: false,
  memberCount: 2,
  apiKeyCount: 0,
  updatedAt: '2026-09-06T00:00:00Z',
  fingerprint: 'version-one',
  capabilities: { edit: true, members: true, delete: true, rename: true, permissions: true, explanation: '' },
  dependencies: { authentication: 0, navigation: 0, agentProviders: 0, agentSkills: 0 },
  allowedPermissions: groupPermissions.map(p => p.key),
  history: []
}
function arrange(overrides: Record<string, unknown> = {}) {
  let current = structuredClone(snapshot)
  const transport = {
    fetchGroupWorkspace: vi.fn(async () => structuredClone(current)),
    saveGroupPolicy: vi.fn(async (_id, policy) => {
      current = { ...current, ...structuredClone(policy), fingerprint: 'version-two' }
      return { id: 3, sessionsEnded: 0, currentSessionEnded: false }
    }),
    changeGroupMembers: vi.fn().mockResolvedValue({ id: 3, sessionsEnded: 1, currentSessionEnded: false }),
    removeReviewedGroup: vi.fn().mockResolvedValue({ id: 3, sessionsEnded: 2, currentSessionEnded: false }),
    ...overrides
  }
  const window = { confirm: vi.fn().mockReturnValue(true), location: { origin: 'https://wiki.example.invalid', assign: vi.fn() } }
  const dependencies = {
    AsyncState: {},
    GroupPermissions: {},
    GroupRules: {},
    GroupUsers: {},
    GroupAccess: {},
    groupPermissions,
    groupPolicyCopy,
    groupPolicySignature,
    emptyGroupPolicy,
    wikiStore: { user: { id: 1, permissions: ['manage:system'] } },
    groupRequestStatus: (e: { status?: number }) => e.status ?? 0,
    getErrorMessage: (e: Error) => e.message,
    window,
    ...transport
  }
  Object.assign(dependencies, confirmStubs(window))
  const component = new Function(...Object.keys(dependencies), compiled + ';return component')(...Object.values(dependencies))
  const state = {
    ...component.data(),
    $route: { params: { id: '3' }, query: { from: '/groups?kind=empty' }, hash: '' },
    $router: { replace: vi.fn(), push: vi.fn() }
  }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, component, transport, window }
}
describe('group workspace review, recovery and navigation', () => {
  it('isolates policy drafts and blocks membership changes until policy is saved or reset', async () => {
    const { state } = arrange()
    await state.load()
    state.draft.description = ''
    state.draft.permissions.push('write:pages')
    expect(state.saved.description).toBe('Before')
    expect(state.saved.permissions).toEqual(['read:pages'])
    expect(state.dirty).toBe(true)
    state.reviewMembers({ action: 'add', people: [{ id: 8, name: 'Alice' }] })
    expect(state.dialog).toBe(false)
    state.reset()
    expect(state.dirty).toBe(false)
    state.draft.name += ' '
    expect(state.dirty).toBe(false)
  })
  it('sends the reviewed policy snapshot and locks navigation during persistence', async () => {
    let resolve: (value: unknown) => void = () => {}
    const { state, transport, component } = arrange({
      saveGroupPolicy: vi.fn(
        () =>
          new Promise(r => {
            resolve = r
          })
      )
    })
    await state.load()
    state.draft.description = ''
    state.reviewPolicy()
    state.reason = 'Remove the outdated purpose'
    const pending = state.confirm()
    expect(state.busy).toBe(true)
    await expect(state.canLeave()).resolves.toBe(false)
    await expect(component.beforeRouteUpdate.call(state, { params: { id: '3' } }, { params: { id: '3' } })).resolves.toBe(false)
    state.draft.description = 'Changed behind review'
    expect(transport.saveGroupPolicy.mock.calls[0]?.[1]).toMatchObject({ description: '' })
    transport.fetchGroupWorkspace.mockResolvedValue({ ...snapshot, description: '', fingerprint: 'version-two' })
    resolve({ id: 3, sessionsEnded: 0, currentSessionEnded: false })
    await pending
    expect(state.draft.description).toBe('')
    expect(state.dirty).toBe(false)
    expect(state.dialog).toBe(false)
  })
  it('retains drafts and reasons after conflict and requires a fresh review', async () => {
    const { state, transport, window } = arrange()
    await state.load()
    state.draft.description = ''
    state.reviewPolicy()
    state.reason = 'Clear the purpose'
    transport.saveGroupPolicy.mockRejectedValue(Object.assign(new Error('Group changed'), { status: 409 }))
    await state.confirm()
    expect(state.draft.description).toBe('')
    expect(state.saved.description).toBe('Before')
    expect(state.reason).toBe('Clear the purpose')
    expect(state.conflict).toBe(true)
    expect(state.canConfirm).toBe(false)
    window.confirm.mockReturnValue(false)
    await state.reloadReview()
    expect(state.dialog).toBe(true)
    window.confirm.mockReturnValue(true)
    await state.reloadReview()
    expect(state.dialog).toBe(false)
    expect(state.dirty).toBe(false)
  })
  it('keeps committed success visible when the subsequent read fails', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.draft.description = ''
    state.reviewPolicy()
    state.reason = 'Clear the purpose'
    transport.fetchGroupWorkspace.mockRejectedValue(new Error('History read failed'))
    await state.confirm()
    expect(state.notice).toContain('Group policy saved.')
    expect(state.loadError).toContain('History read failed')
    expect(state.actionError).toBe('')
    expect(state.stale).toBe(true)
    expect(state.dirty).toBe(false)
    expect(state.policyLocked).toBe(true)
    expect(state.dialog).toBe(false)
  })
  it('does not repeat writes with an uncertain outcome', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.draft.description = ''
    state.reviewPolicy()
    state.reason = 'Clear the purpose'
    transport.saveGroupPolicy.mockRejectedValue(new Error('Connection lost'))
    await state.confirm()
    await state.confirm()
    expect(state.actionError).toContain('outcome is unconfirmed')
    expect(state.conflict).toBe(true)
    expect(transport.saveGroupPolicy).toHaveBeenCalledOnce()
    expect(state.saved.description).toBe('Before')
  })
  it('suppresses a late response for a previously selected group', async () => {
    let resolve: (value: unknown) => void = () => {}
    const { state } = arrange({
      fetchGroupWorkspace: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise(r => {
              resolve = r
            })
        )
        .mockResolvedValueOnce({ ...snapshot, id: 4 })
    })
    const pending = state.load()
    state.$route.params.id = '4'
    await state.load()
    resolve(snapshot)
    await pending
    expect(state.saved.id).toBe(4)
  })
  it('reviews a fixed set of memberships and uses the saved fingerprint', async () => {
    const { state, transport } = arrange()
    await state.load()
    const people = [{ id: 8, name: 'Alice' }]
    state.reviewMembers({ action: 'add', people })
    state.reason = 'Add a researcher'
    people.push({ id: 9, name: 'Bob' })
    await state.confirm()
    expect(transport.changeGroupMembers).toHaveBeenCalledWith(3, 'add', [8], 'Add a researcher', 'version-one')
    expect(state.notice).toContain('Reviewed members added.')
  })
  it('requires resolved dependencies and an exact deletion confirmation', async () => {
    const { state, transport } = arrange()
    await state.load()
    state.saved.dependencies.authentication = 1
    state.reviewDelete()
    expect(state.dialog).toBe(false)
    state.saved.dependencies.authentication = 0
    state.reviewDelete()
    state.reason = 'Retire the group'
    state.deleteConfirmation = '03'
    expect(state.canConfirm).toBe(false)
    state.deleteConfirmation = '3'
    await state.confirm()
    expect(transport.removeReviewedGroup).toHaveBeenCalledWith(3, 'Retire the group', 'version-one')
    expect(state.$router.push).toHaveBeenCalledWith('/groups?kind=empty')
  })
  it('honors backend confirmation that the current session ended', async () => {
    const { state, transport, window } = arrange()
    await state.load()
    state.draft.permissions.push('write:pages')
    state.reviewPolicy()
    state.reason = 'Reviewed access change'
    transport.saveGroupPolicy.mockResolvedValue({ id: 3, sessionsEnded: 2, currentSessionEnded: true })
    await state.confirm()
    expect(window.location.assign).toHaveBeenCalledWith('/login')
    await expect(state.canLeave()).resolves.toBe(true)
  })
  it('protects unsaved navigation, syncs fragments and validates destinations', async () => {
    const { state, component, window } = arrange()
    await state.load()
    state.draft.description = ''
    window.confirm.mockReturnValue(false)
    await expect(component.beforeRouteLeave.call(state)).resolves.toBe(false)
    await expect(component.beforeRouteUpdate.call(state, { params: { id: '4' } }, { params: { id: '3' } })).resolves.toBe(false)
    component.watch['$route.hash'].handler.call(state, '#rules')
    expect(state.section).toBe('rules')
    component.watch['$route.hash'].handler.call(state, '')
    expect(state.section).toBe('overview')
    state.draft.redirectOnLogin = 'javascript:alert(1)'
    state.reviewPolicy()
    expect(state.dialog).toBe(false)
    expect(state.policyIssue).toContain('HTTP(S)')
  })
})
