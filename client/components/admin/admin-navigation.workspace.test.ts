import fs from 'node:fs'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import type { App } from 'vue'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { useTranslate } from '../../helpers/use-translate.ts'
import {
  NavigationPolicySchema,
  navigationDestination,
  navigationMenuItems,
  navigationChangedFields,
  normalizeNavigationTree,
  MAX_NAVIGATION_ITEMS,
  type NavigationItem
} from '../../../shared/navigation-policy.ts'
import { movedNavigationTarget, movedNavigationItems, applyNavigationMoveRepair } from '../../../shared/navigation-move-repair.ts'
const link = (id = 'guide'): NavigationItem => ({
  id,
  kind: 'link',
  label: 'Guide',
  icon: 'mdi-link',
  targetType: 'page',
  target: '/en/guide',
  visibilityMode: 'all',
  visibilityGroups: []
})
describe('Navigation policy and shared audience preview', () => {
  test('allows useful destinations and rejects executable or cross-origin workspace paths', () => {
    for (const target of ['/en/guide#usage', '/en/guide?view=source', '/_private/en/notes']) expect(navigationDestination('page', target)).toBe(target)
    for (const target of ['https://example.com/docs', 'mailto:help@example.com', 'tel:+15550123'])
      expect(navigationDestination('externalblank', target)).toBe(target)
    for (const target of ['javascript:alert(1)', 'data:text/html,test', 'https://user:secret@example.com', 'https://example.com/\npath'])
      expect(navigationDestination('external', target)).toBe('')
    for (const target of ['//example.com', '/\\example.com', 'https://example.com']) expect(navigationDestination('page', target)).toBe('')
  })
  test('normalizes audience groups and detects actual locale and order changes', () => {
    const policy = {
      mode: 'MIXED',
      expandParent: true,
      tree: [
        { locale: 'fr', items: [{ ...link(), visibilityMode: 'restricted', visibilityGroups: [3, 1, 3] }] },
        { locale: 'en', items: [link('a'), link('b')] }
      ]
    }
    const parsed = NavigationPolicySchema.parse(policy)
    expect(parsed.tree.map(tree => tree.locale)).toEqual(['en', 'fr'])
    expect(parsed.tree[1].items[0].visibilityGroups).toEqual([1, 3])
    const draft = structuredClone(parsed)
    draft.tree[0].items.reverse()
    expect(navigationChangedFields(parsed, draft)).toEqual(['locale:en'])
    expect(parsed.tree[0].items[0].id).toBe('a')
  })
  test('requires unique items and locale structures, meaningful labels and bounded menus', () => {
    const policy = { mode: 'STATIC', expandParent: true, tree: [{ locale: 'en', items: [link()] }] }
    expect(NavigationPolicySchema.safeParse({ ...policy, tree: [policy.tree[0], policy.tree[0]] }).success).toBe(false)
    expect(NavigationPolicySchema.safeParse({ ...policy, tree: [{ locale: 'en', items: [link(), link()] }] }).success).toBe(false)
    expect(NavigationPolicySchema.safeParse({ ...policy, tree: [{ locale: 'en', items: [{ ...link(), label: '' }] }] }).success).toBe(false)
    expect(
      NavigationPolicySchema.safeParse({ ...policy, tree: [{ locale: 'en', items: Array.from({ length: 201 }, (_, i) => link(String(i))) }] }).success
    ).toBe(false)
  })
  test('fails closed for a restricted link with an empty audience', () => {
    const privateLink = { ...link('restricted'), visibilityMode: 'restricted' as const, visibilityGroups: [7] }
    expect(navigationMenuItems([{ ...privateLink, visibilityGroups: [] }], [7])).toEqual([])
  })
  test('retains legacy menus while removing the duplicated built-in home link', () => {
    const rows = normalizeNavigationTree([{ ...link('home'), targetType: 'home' }, link()])
    expect(rows[0].locale).toBe('en')
    expect(rows[0].items.map(item => item.id)).toEqual(['guide'])
  })
  test('repairs encoded literal percent and Unicode segments without changing query/hash bytes or decoding separators twice', () => {
    const oldIdentity = { locale: 'en', path: '100%/été' },
      newIdentity = { locale: 'fr', path: 'révisé/100%' }
    expect(movedNavigationTarget('/en/100%25/%C3%A9t%C3%A9?q=%252F#part?keep=%2f', oldIdentity, newIdentity)).toBe(
      '/fr/r%C3%A9vis%C3%A9/100%25?q=%252F#part?keep=%2f'
    )
    for (const target of [
      '/en/100%/été',
      '/en/100%25/%C3%A9t%C3%A9/',
      '/en/100%25%2F%C3%A9t%C3%A9',
      '/en/100%25/%00',
      '/en/100%25/%5C',
      '/en/100%25/%2e%2e/été',
      '//en/100%25/été'
    ])
      expect(movedNavigationTarget(target, oldIdentity, newIdentity)).toBeNull()
  })
  test('does not propose or apply public move repairs whose native routes resolve to private identities', () => {
    const oldIdentity = { locale: 'en', path: 'guide' }
    const privateAlias = { locale: 'en', path: '_private/en/notes' }
    expect(movedNavigationTarget('/en/guide?keep=one#part', oldIdentity, privateAlias)).toBeNull()
    expect(movedNavigationTarget('/en/_private/en/notes', privateAlias, oldIdentity)).toBeNull()
    expect(movedNavigationTarget('/en/%5Fprivate/en/notes?keep=one#part', privateAlias, oldIdentity)).toBeNull()
    // These identities remain public under the native parser: do not replace route resolution with a prefix ban.
    expect(movedNavigationTarget('/en/guide', oldIdentity, { locale: 'en', path: '_private/en' })).toBe('/en/_private/en')
    expect(movedNavigationTarget('/en/guide', oldIdentity, { locale: 'en', path: 'section/_private/en/notes' })).toBe('/en/section/_private/en/notes')
    const policy = NavigationPolicySchema.parse({ mode: 'STATIC', expandParent: false, tree: [{ locale: 'en', items: [link('chosen')] }] })
    expect(movedNavigationItems(policy, 'en', oldIdentity, privateAlias)).toEqual([])
    expect(applyNavigationMoveRepair(policy, [{ locale: 'en', itemId: 'chosen', oldTarget: '/en/guide', newTarget: '/en/_private/en/notes' }])).toEqual(policy)
    const privateOldPolicy = NavigationPolicySchema.parse({
      ...policy,
      tree: [{ locale: 'en', items: [{ ...link('chosen'), target: '/en/_private/en/notes' }] }]
    })
    expect(
      applyNavigationMoveRepair(privateOldPolicy, [{ locale: 'en', itemId: 'chosen', oldTarget: '/en/_private/en/notes', newTarget: '/en/guide' }])
    ).toEqual(privateOldPolicy)
  })
  test('applies exact reviewed selections immutably while retaining empty restricted audiences and other menu trees', () => {
    const policy = NavigationPolicySchema.parse({
        mode: 'STATIC',
        expandParent: false,
        tree: [
          { locale: 'en', items: [{ ...link('chosen'), visibilityMode: 'restricted', visibilityGroups: [] }, link('not-chosen')] },
          { locale: 'fr', items: [link('chosen')] }
        ]
      }),
      before = structuredClone(policy)
    const repairs = movedNavigationItems(policy, 'en', { locale: 'en', path: 'guide' }, { locale: 'fr', path: 'nouveau' })
    const after = applyNavigationMoveRepair(policy, repairs.slice(0, 1))
    expect(after.tree[0].items[0]).toEqual({ ...before.tree[0].items[0], target: '/fr/nouveau' })
    expect(after.tree[0].items[1]).toEqual(before.tree[0].items[1])
    expect(after.tree[1]).toEqual(before.tree[1])
    expect(policy).toEqual(before)
    expect(navigationMenuItems(after.tree[0].items, [7]).map(item => item.id)).toEqual(['not-chosen'])
    expect(applyNavigationMoveRepair(policy, [])).toEqual(before)
    expect(applyNavigationMoveRepair(policy, [{ ...repairs[0], oldTarget: '/en/stale' }])).toEqual(before)
  })
})

// Compile the real workspace and outline together. Only transport, route context,
// drag-and-drop and the unrelated audience preview are isolated.
// browser-dom must install document before Vue's DOM renderer and Vuetify load.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
function componentFactory(filename: string) {
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const compiled = compileScript(descriptor, { id: filename, genDefaultAs: 'TestComponent', inlineTemplate: true })
  const imports = babelParse(compiled.content, { sourceType: 'module', plugins: ['typescript'] }).program.body.filter(node => node.type === 'ImportDeclaration')
  let script = compiled.content
  for (const declaration of [...imports].reverse()) script = script.slice(0, declaration.start!) + script.slice(declaration.end!)
  const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script + '\nreturn TestComponent')
  return (modules: Record<string, Record<string, unknown>>) => {
    const bindings: Record<string, unknown> = { siteConfig: { lang: 'en' } }
    for (const declaration of imports) {
      if (declaration.importKind === 'type') continue
      const module: Record<string, unknown> = declaration.source.value === 'vue' ? Vue : modules[declaration.source.value]!
      if (!module) throw new Error(`Missing component dependency: ${declaration.source.value}`)
      for (const specifier of declaration.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
        bindings[specifier.local.name] =
          specifier.type === 'ImportDefaultSpecifier'
            ? module.default
            : specifier.type === 'ImportNamespaceSpecifier'
              ? module
              : module[specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value]
      }
    }
    return new Function(...Object.keys(bindings), executable)(...Object.values(bindings))
  }
}
const workspaceFactory = componentFactory('client/components/admin/admin-navigation.vue')
const outlineFactory = componentFactory('client/components/admin/navigation-outline.vue')
const mounted: { app: App; host: HTMLElement }[] = []
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount()
    host.remove()
  }
})
const settle = async () => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}
async function mountWorkspace(empty = false) {
  const saved = {
    policy: NavigationPolicySchema.parse({
      mode: 'STATIC',
      expandParent: false,
      tree: [
        { locale: 'en', items: empty ? [] : [link()] },
        { locale: 'fr', items: [{ ...link(), label: 'Guide français' }] }
      ]
    }),
    fingerprint: 'saved-navigation',
    history: [],
    runtime: { state: 'applied', observedAt: '2026-10-01T00:00:00Z' },
    defaultLocale: 'en',
    guestGroups: [],
    groups: [],
    locales: [
      { code: 'en', name: 'English', nativeName: 'English', enabled: true },
      { code: 'fr', name: 'French', nativeName: 'Français', enabled: true }
    ]
  }
  const outline = outlineFactory({
    '../common/draggable-list.vue': {
      default: Vue.defineComponent({
        setup:
          (_props, { slots }) =>
          () =>
            Vue.h('div', slots.default?.())
      })
    }
  })
  const component = workspaceFactory({
    '../common/confirm-dialog.ts': { confirmDiscard: async () => true, requestConfirmation: async () => true },
    'vue-router': {
      useRoute: () => ({ hash: '', query: {} }),
      useRouter: () => ({ replace: vi.fn() }),
      onBeforeRouteLeave: () => {},
      onBeforeRouteUpdate: () => {}
    },
    './navigation-outline.vue': { default: outline },
    './navigation-preview.vue': { default: Vue.defineComponent({ render: () => null }) },
    '../../../shared/navigation-policy.ts': {
      NavigationPolicySchema,
      navigationChangedFields,
      navigationMenuItems,
      navigationDestination,
      MAX_NAVIGATION_ITEMS
    },
    '../../helpers/navigation-workspace-api.ts': { fetchNavigationWorkspace: async () => structuredClone(saved) },
    '../../../shared/navigation-move-repair.ts': {},
    '../../helpers/use-translate.ts': { useTranslate }
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp(component)
  app.use(
    createVuetify({
      components,
      directives,
      defaults: { VDialog: { transition: false }, VTooltip: { disabled: true }, VSelect: { menuProps: { transition: false } } }
    })
  )
  app.component(
    'AdminHero',
    Vue.defineComponent({
      setup:
        (_props, { slots }) =>
        () =>
          Vue.h('header', slots.actions?.())
    })
  )
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  mounted.push({ app, host })
  await settle()
  return host
}
function field(host: HTMLElement, key: string): HTMLInputElement {
  const label = [...host.querySelectorAll<HTMLLabelElement>('label')].find(label => label.htmlFor && label.textContent?.trim() === translateEnglish(key))
  const input = label && document.getElementById(label.htmlFor)
  if (!(input instanceof browserWindow.HTMLInputElement)) throw new Error(`Missing field: ${key}`)
  return input
}
function action(host: HTMLElement, key: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === translateEnglish(key))
  if (!button) throw new Error(`Missing action: ${key}`)
  return button
}
async function chooseLocale(host: HTMLElement, title: string) {
  const input = field(host, 'admin:navigation.menuLocale')
  input.focus()
  input.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
  const popup = document.getElementById(input.getAttribute('aria-controls')!)
  const option = [...(popup?.querySelectorAll<HTMLElement>('[role="option"]') || [])].find(option => option.textContent?.trim() === title)
  if (!option) throw new Error(`Missing locale option: ${title}`)
  option.click()
  await settle()
}
describe('Navigation inspector consumer transitions', () => {
  test('starts unselected and keeps selections and edits scoped to each locale, including reset focus', async () => {
    const host = await mountWorkspace()
    expect(host.querySelector('.navigation-item-editor')).toBeNull()
    expect(host.querySelector('.navigation-outline-select[aria-pressed="true"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('.navigation-outline-select')!.click()
    await settle()
    const label = field(host, 'admin:navigation.menuLabel')
    label.value = 'English draft'
    label.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await settle()
    await chooseLocale(host, 'Français (fr)')
    // Both locales deliberately use the same item ID; selection must not leak.
    expect(host.querySelector('.navigation-item-editor')).toBeNull()
    host.querySelector<HTMLButtonElement>('.navigation-outline-select')!.click()
    await settle()
    expect(field(host, 'admin:navigation.menuLabel').value).toBe('Guide français')
    await chooseLocale(host, 'English (en)')
    expect(field(host, 'admin:navigation.menuLabel').value).toBe('English draft')
    field(host, 'admin:navigation.menuLabel').focus()
    action(host, 'admin:navigation.resetDraft').click()
    await settle()
    expect(field(host, 'admin:navigation.menuLabel').value).toBe('Guide')
    expect(document.activeElement).toBe(host.querySelector('.navigation-outline-select[aria-pressed="true"]'))
    await chooseLocale(host, 'Français (fr)')
    expect(field(host, 'admin:navigation.menuLabel').value).toBe('Guide français')
  })

  test('reveals a newly added item and collapses its discarded inspector with focus on Add link', async () => {
    const host = await mountWorkspace(true)
    expect(host.querySelector('.navigation-item-editor')).toBeNull()
    expect(host.querySelectorAll('.navigation-structure .navigation-empty')).toHaveLength(1)
    action(host, 'admin:navigation.addLink').click()
    await settle()
    const label = field(host, 'admin:navigation.menuLabel')
    expect(label.value).toBe(translateEnglish('admin:navigation.newLink'))
    label.focus()
    action(host, 'admin:navigation.resetDraft').click()
    await settle()
    expect(host.querySelector('.navigation-item-editor')).toBeNull()
    expect(host.querySelector('.navigation-outline-select')).toBeNull()
    expect(document.activeElement).toBe(action(host, 'admin:navigation.addLink'))
  })
})
