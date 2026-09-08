import { describe, expect, test } from '../../server/test/bun-test.mts'
import {
  activeOutlineIndex,
  buildOutlineTree,
  filterOutline,
  filterOutlineTree,
  getAncestorAnchors,
  getInitialExpandedAnchors,
  getSearchExpandedAnchors,
  isBranchEffectivelyExpanded,
  outlineSublistId
} from './page-outline'

const outline = [
  { anchor: '#guide', title: 'Guide', depth: 0 },
  { anchor: '#setup', title: 'Setup', depth: 1 },
  { anchor: '#keys', title: 'API keys', depth: 2 },
  { anchor: '#search', title: 'Search', depth: 1 },
  { anchor: '#reference', title: 'Reference', depth: 0 },
  { anchor: '#api', title: 'API reference', depth: 1 },
  { anchor: '#standalone', title: 'Standalone leaf', depth: 0 }
]

describe('document outline', () => {
  test('keeps only matching headings and their own ancestor chains', () => {
    expect(filterOutline(outline, '  API ').map(entry => entry.anchor)).toEqual(['#guide', '#setup', '#keys', '#reference', '#api'])
    expect(filterOutline(outline, 'search').map(entry => entry.anchor)).toEqual(['#guide', '#search'])
  })

  test('restores the original outline when the filter is cleared and handles no matches', () => {
    expect(filterOutline(outline, '  ')).toBe(outline)
    expect(filterOutline(outline, 'missing')).toEqual([])
    expect(filterOutline([], 'api')).toEqual([])
  })

  test('builds a hierarchical outline tree preserving arbitrary depths', () => {
    const tree = buildOutlineTree(outline)
    expect(tree).toHaveLength(3) // #guide, #reference, #standalone
    expect(tree[0].anchor).toBe('#guide')
    expect(tree[0].parentAnchor).toBeNull()
    expect(tree[0].children).toHaveLength(2) // #setup, #search

    expect(tree[0].children[0].anchor).toBe('#setup')
    expect(tree[0].children[0].parentAnchor).toBe('#guide')
    expect(tree[0].children[0].children).toHaveLength(1) // #keys

    expect(tree[0].children[0].children[0].anchor).toBe('#keys')
    expect(tree[0].children[0].children[0].parentAnchor).toBe('#setup')
    expect(tree[0].children[0].children[0].children).toHaveLength(0)

    expect(tree[0].children[1].anchor).toBe('#search')
    expect(tree[0].children[1].parentAnchor).toBe('#guide')

    expect(tree[1].anchor).toBe('#reference')
    expect(tree[1].children).toHaveLength(1)
    expect(tree[1].children[0].anchor).toBe('#api')

    expect(tree[2].anchor).toBe('#standalone')
    expect(tree[2].children).toHaveLength(0)
  })

  test('filters outline tree retaining matching paths and ancestor context', () => {
    const tree = buildOutlineTree(outline)
    const filtered = filterOutlineTree(tree, 'API keys')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].anchor).toBe('#guide')
    expect(filtered[0].children).toHaveLength(1)
    expect(filtered[0].children[0].anchor).toBe('#setup')
    expect(filtered[0].children[0].children).toHaveLength(1)
    expect(filtered[0].children[0].children[0].anchor).toBe('#keys')

    expect(filterOutlineTree(tree, '   ')).toBe(tree)
    expect(filterOutlineTree(tree, 'missing')).toEqual([])
  })

  test('resolves ancestor anchors for deep links and active headings', () => {
    expect(getAncestorAnchors(outline, '#keys')).toEqual(['#guide', '#setup'])
    expect(getAncestorAnchors(outline, '#setup')).toEqual(['#guide'])
    expect(getAncestorAnchors(outline, '#guide')).toEqual([])
    expect(getAncestorAnchors(outline, '#standalone')).toEqual([])
    expect(getAncestorAnchors(outline, '#nonexistent')).toEqual([])
  })

  test('determines initial expanded branches: top-level open, second-level closed', () => {
    const defaultExpanded = getInitialExpandedAnchors(outline)
    expect(defaultExpanded.has('#guide')).toBe(true)
    expect(defaultExpanded.has('#reference')).toBe(true)
    expect(defaultExpanded.has('#setup')).toBe(false) // second-level branch closed initially
    expect(defaultExpanded.has('#standalone')).toBe(false) // leaf never advertises expansion
  })

  test('determines search expanded anchors so matching paths are visible', () => {
    const searchExpanded = getSearchExpandedAnchors(outline, 'keys')
    expect(searchExpanded.has('#guide')).toBe(true)
    expect(searchExpanded.has('#setup')).toBe(true)
    expect(searchExpanded.has('#reference')).toBe(false)

    expect(getSearchExpandedAnchors(outline, '  ').size).toBe(0)
    expect(getSearchExpandedAnchors(outline, 'unknown').size).toBe(0)
  })

  test('tracks the last heading crossed in either scroll direction, including boundaries', () => {
    const positions = [100, 260, 500, 910]
    expect(activeOutlineIndex(positions, 99)).toBe(-1)
    expect(activeOutlineIndex(positions, 260)).toBe(1)
    expect(activeOutlineIndex(positions, 1200)).toBe(3)
    expect(activeOutlineIndex(positions, 499)).toBe(1)
    expect(activeOutlineIndex([], 100)).toBe(-1)
  })

  test('generates deterministic collision-free DOM IDs from anchors for sublists', () => {
    const dot = outlineSublistId('#a.b')
    const colon = outlineSublistId('#a:b')
    const underscore = outlineSublistId('#a_b')
    const hyphen = outlineSublistId('#a-b')
    const bare = outlineSublistId('a.b')
    const empty = outlineSublistId('#')
    const literalRoot = outlineSublistId('#root')
    const bareEmpty = outlineSublistId('')

    expect(dot).not.toEqual(colon)
    expect(dot).not.toEqual(underscore)
    expect(colon).not.toEqual(underscore)
    expect(underscore).not.toEqual(hyphen)
    expect(bare).toBe(dot)
    expect(empty).toBe('page-toc-sub-_empty_')
    expect(bareEmpty).toBe('page-toc-sub-_empty_')
    expect(literalRoot).toBe('page-toc-sub-root')
    expect(empty).not.toEqual(literalRoot)
    expect(outlineSublistId('#section-1')).toBe('page-toc-sub-section-1')
  })

  test('evaluates effective branch expansion with baseline, search, and user overrides', () => {
    const baseline = new Set(['#guide'])
    // 1. Without search or overrides, baseline controls
    expect(isBranchEffectivelyExpanded('#guide', baseline)).toBe(true)
    expect(isBranchEffectivelyExpanded('#setup', baseline)).toBe(false)

    // 2. Search forces branch open even if not in baseline
    const searchExpanded = new Set(['#setup'])
    expect(isBranchEffectivelyExpanded('#setup', baseline, searchExpanded)).toBe(true)

    // 3. User override during search can explicitly collapse the search-expanded branch (first toggle succeeds)
    const overrides = new Map([['#setup', false]])
    expect(isBranchEffectivelyExpanded('#setup', baseline, searchExpanded, overrides)).toBe(false)

    // 4. User override can explicitly expand a non-matching branch
    overrides.set('#reference', true)
    expect(isBranchEffectivelyExpanded('#reference', baseline, searchExpanded, overrides)).toBe(true)

    // 5. Clearing search/overrides restores baseline
    expect(isBranchEffectivelyExpanded('#setup', baseline, null, null)).toBe(false)
    expect(isBranchEffectivelyExpanded('#guide', baseline, null, null)).toBe(true)
  })
})
