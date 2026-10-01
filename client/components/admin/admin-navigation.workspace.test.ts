import { describe, expect, test } from '../../../server/test/bun-test.mts'
import { NavigationPolicySchema, navigationDestination, navigationMenuItems, navigationChangedFields, normalizeNavigationTree, type NavigationItem } from '../../../shared/navigation-policy.ts'
const link = (id = 'guide'): NavigationItem => ({ id, kind: 'link', label: 'Guide', icon: 'mdi-link', targetType: 'page', target: '/en/guide', visibilityMode: 'all', visibilityGroups: [] })
describe('Navigation policy and shared audience preview', () => {
  test('allows useful destinations and rejects executable or cross-origin workspace paths', () => {
    for (const target of ['/en/guide#usage', '/en/guide?view=source', '/_private/en/notes']) expect(navigationDestination('page', target)).toBe(target)
    for (const target of ['https://example.com/docs', 'mailto:help@example.com', 'tel:+15550123']) expect(navigationDestination('externalblank', target)).toBe(target)
    for (const target of ['javascript:alert(1)', 'data:text/html,test', 'https://user:secret@example.com', 'https://example.com/\npath']) expect(navigationDestination('external', target)).toBe('')
    for (const target of ['//example.com', '/\\example.com', 'https://example.com']) expect(navigationDestination('page', target)).toBe('')
  })
  test('normalizes audience groups and detects actual locale and order changes', () => {
    const policy = { mode: 'MIXED', expandParent: true, tree: [{ locale: 'fr', items: [{ ...link(), visibilityMode: 'restricted', visibilityGroups: [3, 1, 3] }] }, { locale: 'en', items: [link('a'), link('b')] }] }
    const parsed = NavigationPolicySchema.parse(policy)
    expect(parsed.tree.map(tree => tree.locale)).toEqual(['en', 'fr']); expect(parsed.tree[1].items[0].visibilityGroups).toEqual([1, 3])
    const draft = structuredClone(parsed); draft.tree[0].items.reverse(); expect(navigationChangedFields(parsed, draft)).toEqual(['locale:en'])
    expect(parsed.tree[0].items[0].id).toBe('a')
  })
  test('requires unique items and locale structures, meaningful labels and bounded menus', () => {
    const policy = { mode: 'STATIC', expandParent: true, tree: [{ locale: 'en', items: [link()] }] }
    expect(NavigationPolicySchema.safeParse({ ...policy, tree: [policy.tree[0], policy.tree[0]] }).success).toBe(false)
    expect(NavigationPolicySchema.safeParse({ ...policy, tree: [{ locale: 'en', items: [link(), link()] }] }).success).toBe(false)
    expect(NavigationPolicySchema.safeParse({ ...policy, tree: [{ locale: 'en', items: [{ ...link(), label: '' }] }] }).success).toBe(false)
    expect(NavigationPolicySchema.safeParse({ ...policy, tree: [{ locale: 'en', items: Array.from({ length: 201 }, (_, i) => link(String(i))) }] }).success).toBe(false)
  })
  test('fails closed for a restricted link with an empty audience', () => {
    const privateLink = { ...link('restricted'), visibilityMode: 'restricted' as const, visibilityGroups: [7] }
    expect(navigationMenuItems([{ ...privateLink, visibilityGroups: [] }], [7])).toEqual([])
  })
  test('retains legacy menus while removing the duplicated built-in home link', () => {
    const rows = normalizeNavigationTree([{ ...link('home'), targetType: 'home' }, link()])
    expect(rows[0].locale).toBe('en'); expect(rows[0].items.map(item => item.id)).toEqual(['guide'])
  })
})
