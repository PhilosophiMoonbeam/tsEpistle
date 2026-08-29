import { describe, expect, test } from '../../server/test/bun-test.mts'
import { pathFromTagSelection, tagSelectionFromPath } from './tag-navigation'

describe('tag navigation', () => {
  test('treats the tags route itself as an empty selection', () => {
    expect(tagSelectionFromPath('/t')).toEqual([])
    expect(tagSelectionFromPath('/t/')).toEqual([])
  })

  test('round-trips selected tag slugs beneath the tags route', () => {
    const selection = ['agent-skill', 'customer success']
    const path = pathFromTagSelection(selection)

    expect(path).toBe('/t/agent-skill/customer%20success')
    expect(tagSelectionFromPath(path)).toEqual(selection)
  })
})
