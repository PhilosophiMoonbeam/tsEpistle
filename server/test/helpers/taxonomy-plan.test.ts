import { describe, expect, it } from '../bun-test.mts'
import { planTaxonomy, tagDefinition, tagName, tagNames, taxonomyInventory, type TaxonomySnapshot } from '../../helpers/taxonomy-plan.ts'
import { tagAliasMap, resolveTagName } from '../../helpers/tag-aliases.ts'
const snapshot = (): TaxonomySnapshot => ({
  tags: [
    {
      id: 1,
      tag: 'knowledge',
      title: 'Knowledge',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      redirectToId: null,
      isArchived: false
    },
    { id: 2, tag: 'memory', title: 'Memory', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', redirectToId: null, isArchived: false },
    {
      id: 3,
      tag: 'old-knowledge',
      title: 'Old knowledge',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      redirectToId: 1,
      isArchived: false
    },
    { id: 4, tag: 'unused', title: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', redirectToId: null, isArchived: false }
  ],
  assignments: [
    { pageId: 1, tagId: 1 },
    { pageId: 2, tagId: 2 },
    { pageId: 3, tagId: 1 },
    { pageId: 3, tagId: 2 },
    { pageId: 4, tagId: 1 }
  ],
  pages: [1, 2, 3, 4].map(id => ({
    id,
    title: `Page ${id}`,
    path: `p${id}`,
    locale: id === 3 ? 'fr' : 'en',
    visibility: id === 4 ? 'private' : 'public',
    sourceRevision: '1'
  })),
  groups: [
    {
      id: 1,
      name: 'Readers',
      permissions: ['read:pages'],
      pageRules: [
        { match: 'TAG', path: 'knowledge', deny: false, roles: ['read:pages'] },
        { match: 'TAG', path: 'memory', deny: true, roles: ['write:pages'], locales: ['en'] },
        { match: 'TAG', path: 'old-knowledge', deny: false, roles: ['read:pages'], locales: ['fr'] }
      ]
    }
  ],
  history: [
    { tagId: 1, count: 5 },
    { tagId: 3, count: 2 }
  ]
})
describe('taxonomy lifecycle impact', () => {
  it('includes unused names, inherited alias usage and immutable historical references in the inventory', () => {
    const inventory = taxonomyInventory(snapshot())
    expect(inventory.find(t => t.id === 1)).toMatchObject({ pageCount: 3, historyCount: 5, ruleCount: 2 })
    expect(inventory.find(t => t.id === 3)).toMatchObject({ pageCount: 3, historyCount: 2 })
    expect(inventory.find(t => t.id === 4)?.pageCount).toBe(0)
  })
  it('renames through a new canonical identity, keeps every historical name and preserves rule matches', () => {
    const original = snapshot()
    const { after, preview, changedPageIds } = planTaxonomy(original, { action: 'edit', tagId: 1, tag: '  Encyclopedia ', title: 'Reference' })
    expect(preview.accessChanges).toBe(false)
    expect(preview.rules.map(r => [r.before, r.after, r.added, r.removed])).toEqual([
      [2, 2, 0, 0],
      [1, 1, 0, 0]
    ])
    expect(changedPageIds).toEqual([1, 3, 4])
    expect(after.tags.find(t => t.id === 1)).toMatchObject({ tag: 'knowledge', redirectToId: -1 })
    expect(after.tags.find(t => t.id === 3)?.redirectToId).toBe(-1)
    expect(tagAliasMap(after.tags)['old-knowledge']).toBe('encyclopedia')
    expect(original).toEqual(snapshot())
    expect(after.history).toEqual(original.history)
  })
  it('deduplicates merged assignments and reviews public rule populations with locale restrictions', () => {
    const { after, preview } = planTaxonomy(snapshot(), { action: 'merge', tagId: 1, targetId: 2 })
    expect(after.assignments.filter(a => a.pageId === 3)).toEqual([{ pageId: 3, tagId: 2 }])
    expect(preview.accessChanges).toBe(true)
    expect(preview.rules).toEqual([
      expect.objectContaining({ path: 'knowledge', before: 2, after: 3, added: 1, removed: 0 }),
      expect.objectContaining({ path: 'memory', deny: true, before: 1, after: 2, added: 1, removed: 0 }),
      expect.objectContaining({ path: 'old-knowledge', before: 1, after: 1, added: 0, removed: 0 })
    ])
  })
  it('retires a canonical name and its aliases without deleting historical labels; restore does not reattach pages', () => {
    const { after, preview } = planTaxonomy(snapshot(), { action: 'archive', tagId: 1 })
    expect(after.tags.find(t => t.id === 3)?.isArchived).toBe(true)
    expect(after.assignments.some(a => a.tagId === 1)).toBe(false)
    expect(after.history).toEqual(snapshot().history)
    expect(preview.rules[0]).toMatchObject({ before: 2, after: 0, removed: 2 })
    expect(resolveTagName(tagAliasMap(after.tags), 'knowledge')).toBeNull()
    expect(() => planTaxonomy(after, { action: 'restore', tagId: 3 })).toThrow('Restore the canonical destination')
    const restored = planTaxonomy(after, { action: 'restore', tagId: 1 })
    expect(restored.changedPageIds).toEqual([])
    expect(restored.after.assignments).toEqual(after.assignments)
    expect(restored.after.tags.find(t => t.id === 3)?.isArchived).toBe(true)
  })
  it('reviews alias retirement and restoration as access changes without changing page assignments', () => {
    const { after, changedPageIds, preview } = planTaxonomy(snapshot(), { action: 'archive', tagId: 3 })
    expect(changedPageIds).toEqual([])
    expect(preview.accessChanges).toBe(true)
    expect(planTaxonomy(after, { action: 'restore', tagId: 3 }).preview.rules[0]).toMatchObject({ before: 0, after: 1, added: 1 })
  })
  it('rejects blank/reserved names, self merge, alias editing and no-op writes', () => {
    expect(() => tagDefinition({ tag: ' ', title: '' })).toThrow('tag name')
    expect(() => tagDefinition({ tag: 'hi\nthere', title: '' })).toThrow('tag name')
    expect(() => planTaxonomy(snapshot(), { action: 'edit', tagId: 1, tag: 'unused', title: '' })).toThrow('already reserved')
    expect(() => planTaxonomy(snapshot(), { action: 'merge', tagId: 1, targetId: 1 })).toThrow('different destination')
    expect(() => planTaxonomy(snapshot(), { action: 'edit', tagId: 3, tag: 'old', title: '' })).toThrow('canonical')
    expect(() => planTaxonomy(snapshot(), { action: 'edit', tagId: 1, tag: 'knowledge', title: 'Knowledge' })).toThrow('no changes')
  })
  it('expires a review when page revisions, group rules or taxonomy definitions change', () => {
    const data = snapshot(),
      change = { action: 'archive', tagId: 1 }
    const token = planTaxonomy(data, change).preview.fingerprint
    expect(planTaxonomy(snapshot(), change).preview.fingerprint).toBe(token)
    data.pages[0]!.sourceRevision = '2'
    expect(planTaxonomy(data, change).preview.fingerprint).not.toBe(token)
    const groups = snapshot()
    groups.groups[0]!.pageRules[0]!.deny = true
    expect(planTaxonomy(groups, change).preview.fingerprint).not.toBe(token)
  })
  it('fails closed on invalid alias graphs and never resolves archived cached labels', () => {
    expect(() => tagAliasMap([{ id: 1, tag: 'a', redirectToId: 1 }])).toThrow('cycle')
    expect(() => tagAliasMap([{ id: 1, tag: 'a', redirectToId: 2 }])).toThrow('destination')
    const map = tagAliasMap([
      { id: 1, tag: '__proto__' },
      { id: 2, tag: 'retired', isArchived: true }
    ])
    expect(resolveTagName(map, '__proto__')).toBe('__proto__')
    expect(resolveTagName(map, 'retired')).toBeNull()
  })
  it('normalizes scalar names and rejects invalid boundaries with client errors', () => {
    expect(tagName('  MiXeD Label  ')).toBe('mixed label')
    expect(tagName('x'.repeat(255))).toHaveLength(255)
    for (const value of ['', '   ', '\u0000', 'line\nbreak', '\u007f', 'x'.repeat(256), 42, null, undefined, ['tag']]) {
      expect(() => tagName(value)).toThrow('tag name')
    }
  })
  it('normalizes arrays in insertion order, deduplicates canonical names and enforces the raw limit', () => {
    expect(tagNames([])).toEqual([])
    expect(tagNames(['  Foo ', 'foo', 'BAR', ' bar '])).toEqual(['foo', 'bar'])
    expect(tagNames(Array.from({ length: 100 }, (_, index) => `tag-${index}`))).toHaveLength(100)
    expect(() => tagNames(Array.from({ length: 101 }, (_, index) => `tag-${index}`))).toThrow('100')
    expect(() => tagNames('tag')).toThrow('array')
    expect(() => tagNames(['valid', 1])).toThrow('tag name')
  })
})
