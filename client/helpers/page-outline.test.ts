import { describe, expect, test } from 'bun:test'
import { activeOutlineIndex, filterOutline, overviewOutline } from './page-outline'

const outline = [
  { anchor: '#guide', title: 'Guide', depth: 0 },
  { anchor: '#setup', title: 'Setup', depth: 1 },
  { anchor: '#keys', title: 'API keys', depth: 2 },
  { anchor: '#search', title: 'Search', depth: 1 },
  { anchor: '#reference', title: 'Reference', depth: 0 },
  { anchor: '#api', title: 'API reference', depth: 1 }
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
  test('overview hides deep detail but retains the active heading and its ancestor chain', () => {
    expect(overviewOutline(outline, '').map(entry => entry.anchor)).toEqual(['#guide', '#setup', '#search', '#reference', '#api'])
    expect(overviewOutline(outline, '#keys')).toEqual(outline)
    const deep = [...outline.slice(0, 3), { anchor: '#rotation', title: 'Rotation', depth: 4 }, ...outline.slice(3)]
    expect(overviewOutline(deep, '#rotation')).toEqual(deep)
    expect(overviewOutline(deep, '#missing')).toEqual(overviewOutline(outline, ''))
    expect(overviewOutline([], '#missing')).toEqual([])
  })
  test('tracks the last heading crossed in either scroll direction, including boundaries', () => {
    const positions = [100, 260, 500, 910]
    expect(activeOutlineIndex(positions, 99)).toBe(-1)
    expect(activeOutlineIndex(positions, 260)).toBe(1)
    expect(activeOutlineIndex(positions, 1200)).toBe(3)
    expect(activeOutlineIndex(positions, 499)).toBe(1)
    expect(activeOutlineIndex([], 100)).toBe(-1)
  })
})
