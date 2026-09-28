import fs from 'node:fs'
import { groupPermissions, normalizeGroupRulePath } from '../../../shared/group-policy.ts'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
function arrange(name: string, dependencies: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const source = fs.readFileSync(`client/components/admin/${name}.vue`, 'utf8')
  const script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]!
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'const component ='))
  const window = { confirm: vi.fn().mockReturnValue(true) }
  const bindings = {
    AsyncState: {},
    GroupCreate: {},
    groupPermissions,
    normalizeGroupRulePath,
    window,
    getErrorMessage: (error: Error) => error.message,
    groupRequestStatus: (error: { status?: number }) => error.status ?? 0,
    ...dependencies
  }
  const component = new Function(...Object.keys(bindings), compiled + ';return component')(...Object.values(bindings))
  const state = {
    ...component.data(),
    $emit: vi.fn(),
    $route: { query: {}, fullPath: '/groups?kind=empty' },
    $router: { replace: vi.fn(), push: vi.fn() },
    ...props
  }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed ?? {})) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, component, window }
}
describe('group directory and creation', () => {
  it('keeps the latest directory response and preserves filter context in detail links', async () => {
    let release: (value: unknown) => void = () => {}
    const fetchGroupDirectory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = resolve
          })
      )
      .mockResolvedValueOnce({ items: [{ id: 9 }], total: 1 })
    const { state } = arrange('admin-groups', { fetchGroupDirectory })
    const pending = state.load(false)
    state.search = 'research'
    state.kind = 'empty'
    await state.load()
    release({ items: [], total: 0 })
    await pending
    expect(state.directory.total).toBe(1)
    expect(state.$router.replace).toHaveBeenCalledWith({ query: { search: 'research', kind: 'empty' } })
    expect(state.groupLink(9)).toEqual({ path: '/groups/9', query: { from: '/groups?kind=empty' } })
    expect(fetchGroupDirectory.mock.calls[1]![0].get('search')).toBe('research')
  })
  it('clears filters and pagination, reports read errors and retries', async () => {
    const fetchGroupDirectory = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({ items: [], total: 0 })
    const { state } = arrange('admin-groups', { fetchGroupDirectory })
    await state.load(false)
    expect(state.error).toBe('Unavailable')
    expect(state.loading).toBe(false)
    state.search = 'old'
    state.kind = 'system'
    state.offset = 50
    state.clearFilters()
    await Promise.resolve()
    await Promise.resolve()
    expect([state.search, state.kind, state.offset]).toEqual(['', 'all', 0])
    expect(state.error).toBe('')
    expect(state.directory.total).toBe(0)
  })
  it('creates a reviewed group without granting access or adding members by default', async () => {
    const createReviewedGroup = vi.fn().mockResolvedValue({ id: 19 }),
      fetchGroupCreationOptions = vi.fn().mockResolvedValue({ fingerprint: 'current', allowedPermissions: groupPermissions.map(p => p.key) })
    const { state } = arrange('admin-groups-create', { createReviewedGroup, fetchGroupCreationOptions }, { modelValue: true })
    await state.load()
    state.name = ' Research '
    state.description = ' A purpose '
    state.reason = ' Organize research '
    await state.create()
    expect(createReviewedGroup).toHaveBeenCalledWith(
      { name: 'Research', description: 'A purpose', redirectOnLogin: '/', permissions: [], pageRules: [] },
      'Organize research',
      'current'
    )
    expect(state.$emit).toHaveBeenCalledWith('created', 19)
    expect(state.canLeave()).toBe(true)
  })
  it('enforces allowed presets and requires a current creation policy after conflicts or failed reloads', async () => {
    const createReviewedGroup = vi.fn().mockRejectedValue(Object.assign(new Error('Changed'), { status: 409 })),
      fetchGroupCreationOptions = vi.fn().mockResolvedValue({ fingerprint: 'current', allowedPermissions: [] })
    const { state } = arrange('admin-groups-create', { createReviewedGroup, fetchGroupCreationOptions })
    await state.load()
    state.name = 'Research'
    state.reason = 'Create research'
    state.preset = 'readers'
    expect(state.valid).toBe(false)
    state.preset = 'empty'
    await state.create()
    await state.create()
    expect(createReviewedGroup).toHaveBeenCalledOnce()
    expect(state.name).toBe('Research')
    expect(state.conflict).toBe(true)
    fetchGroupCreationOptions.mockRejectedValue(new Error('Offline'))
    await state.load()
    expect(state.options).toBe(null)
    expect(state.valid).toBe(false)
    expect(state.loadError).toBe('Offline')
  })
  it('blocks leaving during creation and never repeats an uncertain write', async () => {
    let reject: (error: Error) => void = () => {}
    const createReviewedGroup = vi.fn(
      () =>
        new Promise((_, r) => {
          reject = r
        })
    )
    const { state, window } = arrange('admin-groups-create', { createReviewedGroup }, { modelValue: true })
    state.options = { fingerprint: 'f', allowedPermissions: [] }
    state.name = 'Research'
    state.reason = 'Create research'
    const pending = state.create()
    expect(state.canLeave()).toBe(false)
    reject(new Error('Connection lost'))
    await pending
    await state.create()
    expect(createReviewedGroup).toHaveBeenCalledOnce()
    expect(state.saveError).toContain('outcome is unconfirmed')
    window.confirm.mockReturnValue(false)
    state.close(false)
    expect(state.$emit).not.toHaveBeenCalled()
    expect(state.name).toBe('Research')
  })
})
describe('group page-rule and membership drafts', () => {
  it('edits page rules in isolation and stages an immutable policy without persisting', () => {
    const policy = {
      name: 'Research',
      permissions: ['read:pages'],
      pageRules: [{ id: 'r', path: 'docs', match: 'SUBTREE', deny: false, roles: ['read:pages'], locales: [] }]
    }
    const { state } = arrange('admin-groups-edit-rules', {}, { modelValue: structuredClone(policy), disabled: false })
    state.open(state.modelValue.pageRules[0])
    state.draft.path = ' reference/// '
    state.draft.locales = ['en', 'en']
    state.apply()
    expect(state.modelValue).toEqual(policy)
    expect(state.$emit).toHaveBeenCalledWith('update:modelValue', { ...policy, pageRules: [{ ...policy.pageRules[0], path: 'reference', locales: ['en'] }] })
    expect(state.dialog).toBe(false)
    state.disabled = true
    state.remove('r')
    expect(state.$emit).toHaveBeenCalledOnce()
  })
  it('rejects invalid expressions and language codes and explains missing global permissions', () => {
    const { state } = arrange('admin-groups-edit-rules', {}, { modelValue: { permissions: [], pageRules: [] }, disabled: false })
    state.open()
    state.draft.match = 'REGEX'
    state.draft.path = '['
    state.apply()
    expect(state.issue).toContain('regular expression')
    expect(state.$emit).not.toHaveBeenCalled()
    state.draft.path = '^docs'
    state.draft.locales = ['not a locale']
    expect(state.issue).toContain('language')
    expect(state.missingPermissions(state.draft)).toEqual(['read:pages'])
  })
  it('protects unmanageable members and caps unique selections at 100', () => {
    const { state } = arrange('admin-groups-edit-users', {}, { canManage: true, disabled: false })
    state.select({ id: 1, name: 'Root', canRemove: false }, true)
    expect(state.selected).toEqual([])
    for (let id = 2; id <= 103; id++) state.select({ id, name: 'Member', canRemove: true }, true)
    expect(state.selected).toHaveLength(100)
    state.select({ id: 2, name: 'Member', canRemove: true }, true)
    expect(state.selected).toHaveLength(100)
    state.select({ id: 2, name: 'Member', canRemove: true }, false)
    expect(state.selected).toHaveLength(99)
    state.canManage = false
    state.select({ id: 2, name: 'Member', canRemove: true }, true)
    expect(state.selected).toHaveLength(99)
  })
  it('discards selections after a membership revision and ignores late search results', async () => {
    let release: (value: unknown) => void = () => {}
    const fetchGroupMembers = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = resolve
          })
      )
      .mockResolvedValue({ items: [{ id: 8 }], total: 1 })
    const { state, component } = arrange('admin-groups-edit-users', { fetchGroupMembers }, { groupId: 3 })
    const pending = state.load()
    state.selected = [{ id: 7, name: 'Before' }]
    component.watch.revision.call(state)
    await Promise.resolve()
    await Promise.resolve()
    release({ items: [], total: 0 })
    await pending
    expect(state.directory.total).toBe(1)
    expect(state.selected).toEqual([])
    expect(state.loading).toBe(false)
  })
})
