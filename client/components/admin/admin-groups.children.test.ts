import fs from 'node:fs'
import { compileTemplate } from '@vue/compiler-sfc'
import { document } from '../../test/browser-dom.mts'
import { groupPermissions, normalizeGroupRulePath } from '../../../shared/group-policy.ts'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { translateEnglish } from '../../test/english-translate.mts'
// The shell's themed confirm dialog is replaced by the fake window.confirm in these isolated script tests.
const confirmStubs = (host: { confirm: (text: string) => boolean }) => ({
  confirmDiscard: async (title: string) => host.confirm(title),
  requestConfirmation: async ({ title }: { title: string }) => host.confirm(title)
})
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
  Object.assign(bindings, confirmStubs(window))
  const component = new Function(...Object.keys(bindings), compiled + ';return component')(...Object.values(bindings))
  const state = {
    ...component.data.call({ $t: translateEnglish }),
    $t: translateEnglish,
    $emit: vi.fn(),
    $route: { query: {}, fullPath: '/groups?kind=empty' },
    $router: { replace: vi.fn(), push: vi.fn() },
    ...props
  }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed ?? {})) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return { state, component, window }
}

// Vue's runtime-dom must load after browser-dom has installed the document global.
const Vue = await import('vue')
function renderedSnapshot(name: string, state: Record<string, unknown>) {
  const filename = `client/components/admin/${name}.vue`
  const source = fs.readFileSync(filename, 'utf8').match(/<template>([\s\S]*?)<\/template>\s*<script/)![1]!
  const compiled = compileTemplate({ filename, id: name, source, compilerOptions: { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] } })
  if (compiled.errors.length) throw new Error(`Cannot compile ${name}: ${compiled.errors}`)
  const render = new Function('Vue', new Bun.Transpiler({ loader: 'ts' }).transformSync(compiled.code))(Vue)
  const app = Vue.createApp({ data: () => state, render })
  const passthrough = (tag = 'div') => Vue.defineComponent({
    setup(_props, { attrs, slots }) { return () => Vue.h(tag, attrs, slots.default?.()) }
  })
  for (const component of ['v-container', 'admin-hero', 'v-spacer', 'v-text-field', 'v-icon', 'group-create', 'router-link', 'v-alert', 'v-dialog', 'v-card', 'v-card-text', 'v-textarea', 'v-card-actions']) app.component(component, passthrough())
  app.component('v-btn', passthrough('button'))
  app.component('async-state', Vue.defineComponent({
    props: ['title', 'message'],
    setup(props) { return () => Vue.h('div', { role: 'status' }, [props.title, props.message]) }
  }))
  app.config.globalProperties.$t = translateEnglish
  app.config.globalProperties.$vuetify = { display: { smAndDown: false } }
  const host = document.createElement('div')
  document.body.append(host)
  try {
    app.mount(host)
    return {
      text: host.textContent ?? '',
      pagination: host.querySelector('.group-pagination')?.textContent ?? null,
      previousDisabled: host.querySelector<HTMLButtonElement>('.group-pagination .group-actions button')?.disabled
    }
  } finally {
    app.unmount()
    host.remove()
  }
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
  it('renders human-readable starting access in every group review', () => {
    const { state } = arrange('admin-groups-create', {}, { modelValue: true })
    state.options = { fingerprint: 'current', allowedPermissions: groupPermissions.map(p => p.key) }
    state.name = 'Research'
    state.reviewing = true
    for (const [preset, title, description] of [
      ['empty', 'Start with no access', 'Build a specific policy before adding members.'],
      ['readers', 'Read & discuss', 'Read all public pages, use assets and join discussions.'],
      ['authors', 'Knowledge contributors', 'Create and edit public pages, read their source and history, upload assets and join discussions.']
    ]) {
      state.preset = preset
      const rendered = renderedSnapshot('admin-groups-create', state)
      expect(rendered.text).toContain(`${title} · ${description}`)
      expect(rendered.text).not.toContain('admin:groupsCreate.')
    }
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
    await expect(state.canLeave()).resolves.toBe(true)
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
    await expect(state.canLeave()).resolves.toBe(false)
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

describe('group directory and membership offset recovery', () => {
  for (const [name, api] of [['admin-groups', 'fetchGroupDirectory'], ['admin-groups-edit-users', 'fetchGroupMembers']]) {
    const arrangeDirectory = (transport: unknown) => arrange(name!, { [api!]: transport }, { groupId: 3, revision: 'current', disabled: false, canManage: false, canReadAccounts: false, lockReason: '' })
    const requestParams = (args: unknown[]) => args[name === 'admin-groups' ? 0 : 1] as URLSearchParams

    it(`${name} recovers the last valid page after its final entry disappears`, async () => {
      const requests: URLSearchParams[] = []
      const remaining = { items: [{ id: 8, name: 'Remaining' }], total: 26, limit: 25 }
      const transport = vi.fn(async (...args: unknown[]) => {
        requests.push(new URLSearchParams(requestParams(args)))
        return requests.length === 1 ? { items: [], total: 26, limit: 25 } : remaining
      })
      const { state } = arrangeDirectory(transport)
      state.offset = 50
      state.search = 'remaining'
      state.kind = 'empty'
      state.candidates = true
      await state.load(false)
      expect(requests.map(params => params.get('offset'))).toEqual(['50', '25'])
      expect(requests.map(params => params.get('search'))).toEqual(['remaining', 'remaining'])
      expect(requests[1]!.get(name === 'admin-groups' ? 'kind' : 'candidates')).toBe(name === 'admin-groups' ? 'empty' : 'true')
      expect(state.offset).toBe(25)
      expect(state.directory).toEqual(remaining)
      expect(state.loading).toBe(false)
      if (name === 'admin-groups') expect(state.$router.replace).toHaveBeenCalledWith({ query: { search: 'remaining', kind: 'empty', offset: '25' } })
    })

    it(`${name} returns to the first page when the sole second-page entry was removed`, async () => {
      const remaining = { items: [{ id: 8, name: 'Still present' }], total: 25, limit: 25 }
      const transport = vi.fn().mockResolvedValueOnce({ items: [], total: 25, limit: 25 }).mockResolvedValueOnce(remaining)
      const { state } = arrangeDirectory(transport)
      state.offset = 25
      await state.load(false)
      expect(state.offset).toBe(0)
      expect(state.directory).toEqual(remaining)
      expect(transport).toHaveBeenCalledTimes(2)
      if (name === 'admin-groups') expect(state.$router.replace).toHaveBeenCalledWith({ query: {} })
    })

    it(`${name} never loops when the directory shrinks again during recovery`, async () => {
      const transport = vi.fn().mockResolvedValueOnce({ items: [], total: 26, limit: 25 }).mockResolvedValue({ items: [], total: 25, limit: 25 })
      const { state } = arrangeDirectory(transport)
      state.offset = 50
      await state.load(false)
      expect(transport).toHaveBeenCalledTimes(2)
      expect(state.directory.total).toBe(25)
      expect(state.offset).toBe(25)
      expect(state.loading).toBe(false)
    })

    it(`${name} keeps Previous available instead of reporting an empty positive-total directory`, async () => {
      const transport = vi.fn().mockResolvedValueOnce({ items: [], total: 26, limit: 25 }).mockResolvedValue({ items: [], total: 25, limit: 25, counts: { groups: 25, administrative: 0, empty: 0, system: 0 } })
      const { state } = arrangeDirectory(transport)
      state.offset = 50
      await state.load(false)
      const rendered = renderedSnapshot(name!, state)
      expect(rendered.pagination).toContain('Previous')
      expect(rendered.previousDisabled).toBe(false)
      expect(rendered.text).not.toContain(name === 'admin-groups' ? 'No groups to show' : 'No members yet')
    })

    it(`${name} ignores a stale out-of-range response instead of correcting newer filters`, async () => {
      const { promise, resolve: release } = Promise.withResolvers<unknown>()
      const current = { items: [{ id: 9 }], total: 1, limit: 25 }
      const transport = vi.fn().mockReturnValueOnce(promise).mockResolvedValue(current)
      const { state } = arrangeDirectory(transport)
      state.offset = 50
      const pending = state.load(false)
      state.offset = 0
      state.search = 'new filter'
      await state.load(false)
      release({ items: [], total: 25, limit: 25 })
      await pending
      expect(transport).toHaveBeenCalledTimes(2)
      expect(state.directory).toEqual(current)
      expect(state.offset).toBe(0)
      expect(state.search).toBe('new filter')
    })

    it(`${name} suppresses a late recovered page after a newer request or disposal`, async () => {
      for (const dispose of [false, true]) {
        const { promise, resolve: release } = Promise.withResolvers<unknown>()
        const current = { items: [{ id: 9 }], total: 1, limit: 25 }
        const transport = vi.fn()
          .mockResolvedValueOnce({ items: [], total: 25, limit: 25 })
          .mockReturnValueOnce(promise)
          .mockResolvedValue(current)
        const { state, component } = arrangeDirectory(transport)
        state.offset = 25
        const pending = state.load(false)
        await Promise.resolve()
        expect(transport).toHaveBeenCalledTimes(2)
        if (dispose) component.beforeUnmount.call(state)
        else { state.search = 'current'; await state.load(false) }
        release({ items: [{ id: 8 }], total: 25, limit: 25 })
        await pending
        expect(state.directory).toEqual(dispose ? null : current)
        if (name === 'admin-groups') expect(state.$router.replace).not.toHaveBeenCalled()
      }
    })

    it(`${name} surfaces recovery errors and allows reloading the corrected offset`, async () => {
      const transport = vi.fn()
        .mockResolvedValueOnce({ items: [], total: 25, limit: 25 })
        .mockRejectedValueOnce(new Error('Recovery unavailable'))
        .mockResolvedValueOnce({ items: [{ id: 8 }], total: 25, limit: 25 })
      const { state } = arrangeDirectory(transport)
      state.offset = 25
      await state.load(false)
      expect(state.error).toBe('Recovery unavailable')
      expect(state.loading).toBe(false)
      await state.load(false)
      expect(state.directory.items).toEqual([{ id: 8 }])
      expect(state.error).toBe('')
      expect(requestParams(transport.mock.calls[2]!).get('offset')).toBe('0')
    })
  }
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
