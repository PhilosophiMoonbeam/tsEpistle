import { describe, expect, test } from '../../../server/test/bun-test.mts'
import {
  NavigationPolicySchema,
  navigationDestination,
  navigationMenuItems,
  navigationChangedFields,
  normalizeNavigationTree,
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
