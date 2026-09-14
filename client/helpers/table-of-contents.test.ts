import { describe, expect, test } from '../../server/test/bun-test.mts'
import {
  flattenTableOfContents,
  normalizeTableOfContents,
  type TableOfContentsNode
} from './table-of-contents'

describe('flattenTableOfContents', () => {
  test('preserves document order and exposes every comparative heading depth', () => {
    const toc: TableOfContentsNode[] = [{
      anchor: '#chapter',
      title: 'Chapter',
      children: [{
        anchor: '#section',
        title: 'Section',
        children: [{
          anchor: '#detail',
          title: 'Detail',
          children: []
        }]
      }, {
        anchor: '#sibling',
        title: 'Sibling section',
        children: []
      }]
    }]

    expect(flattenTableOfContents(toc).map(({ title, depth }) => ({ title, depth }))).toEqual([
      { title: 'Chapter', depth: 0 },
      { title: 'Section', depth: 1 },
      { title: 'Detail', depth: 2 },
      { title: 'Sibling section', depth: 1 }
    ])
  })

  test('does not mutate the rendered table of contents tree', () => {
    const toc: TableOfContentsNode[] = [{ anchor: '#start', title: 'Start', children: [] }]

    flattenTableOfContents(toc)

    expect(toc).toEqual([{ anchor: '#start', title: 'Start', children: [] }])
  })

  test('normalizes the sidebar to the two highest comparative levels', () => {
    const toc: TableOfContentsNode[] = [{
      anchor: '#chapter',
      title: 'Chapter',
      children: [{
        anchor: '#section',
        title: 'Section',
        children: [{
          anchor: '#detail',
          title: 'Detail',
          children: [{
            anchor: '#note',
            title: 'Note',
            children: []
          }]
        }]
      }]
    }]

    expect(normalizeTableOfContents(toc).map(({ anchor, depth }) => ({ anchor, depth }))).toEqual([
      { anchor: '#chapter', depth: 0 },
      { anchor: '#section', depth: 1 }
    ])
  })
})
