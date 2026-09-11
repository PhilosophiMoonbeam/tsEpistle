import { describe, expect, it } from '../bun-test.mts'

import { TOOL_DISCOVERY_CONTROL_NAME, type AgentActionName } from '../../../shared/agents/contracts.ts'
import type { ActionGroup } from '../../agents/actions/catalog.ts'
import type { AxHarnessFunction } from '../../agents/providers/session-harness.ts'
import { createToolDiscovery, deriveToolDiscovery, resolveToolDiscoveryCall } from '../../agents/providers/tool-discovery.ts'

const action = (name: AgentActionName, group: ActionGroup): AxHarnessFunction => ({
  name,
  title: name,
  description: `Description for ${name}`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  risk: group === 'authoring' ? 'proposal' : 'read',
  group
})

const allActions: readonly AxHarnessFunction[] = [
  action('pages.search', 'core'),
  action('pages.get', 'core'),
  action('skills.list', 'core'),
  action('skills.read', 'core'),
  action('memory.manage', 'core'),
  action('pages.searchTags', 'explore'),
  action('pages.listTags', 'explore'),
  action('pages.listHistory', 'history'),
  action('pages.getVersion', 'history'),
  action('pages.getOkf', 'canonical'),
  action('pages.prepareCreate', 'authoring'),
  action('browser.navigate', 'browser')
]

describe('flat Wiki tool discovery', () => {
  it('keeps every admitted core action visible and derives a compact non-core index', () => {
    const discovery = createToolDiscovery(allActions)
    const turn = discovery.beginTurn()

    expect(turn.activeFunctions.map(item => item.name)).toEqual(['pages.search', 'pages.get', 'skills.list', 'skills.read', 'memory.manage'])
    expect(turn.categoryIndex).toEqual([
      {
        category: 'explore',
        tools: [
          { name: 'pages.searchTags', description: 'Description for pages.searchTags' },
          { name: 'pages.listTags', description: 'Description for pages.listTags' }
        ]
      },
      {
        category: 'history',
        tools: [
          { name: 'pages.listHistory', description: 'Description for pages.listHistory' },
          { name: 'pages.getVersion', description: 'Description for pages.getVersion' }
        ]
      },
      { category: 'canonical', tools: [{ name: 'pages.getOkf', description: 'Description for pages.getOkf' }] },
      { category: 'authoring', tools: [{ name: 'pages.prepareCreate', description: 'Description for pages.prepareCreate' }] },
      { category: 'browser', tools: [{ name: 'browser.navigate', description: 'Description for browser.navigate' }] }
    ])
    expect(turn.control?.name).toBe(TOOL_DISCOVERY_CONTROL_NAME)
    expect(turn.control?.parameters).toMatchObject({
      type: 'object',
      required: ['category'],
      additionalProperties: false,
      properties: { category: { type: 'string', enum: ['explore', 'history', 'canonical', 'authoring', 'browser'] } }
    })
  })

  it('applies a successful category enable on the next turn and returns only admitted tools', () => {
    const discovery = createToolDiscovery(allActions)
    const firstTurn = discovery.beginTurn()
    const enabled = discovery.enable('explore')

    expect(enabled).toEqual({
      category: 'explore',
      enabled: true,
      tools: [
        { name: 'pages.searchTags', description: 'Description for pages.searchTags' },
        { name: 'pages.listTags', description: 'Description for pages.listTags' }
      ]
    })
    expect(firstTurn.activeFunctions.map(item => item.name)).not.toContain('pages.searchTags')
    expect(resolveToolDiscoveryCall(firstTurn, 'pages.searchTags', {})).toBeNull()

    const nextTurn = discovery.beginTurn()
    expect(nextTurn.activeFunctions.map(item => item.name)).toContain('pages.searchTags')
    expect(resolveToolDiscoveryCall(nextTurn, 'pages.searchTags', {})).toEqual({ kind: 'action', name: 'pages.searchTags' })
    expect(resolveToolDiscoveryCall(nextTurn, TOOL_DISCOVERY_CONTROL_NAME, { category: 'explore' })).toEqual({
      kind: 'control',
      name: TOOL_DISCOVERY_CONTROL_NAME,
      category: 'explore'
    })
  })

  it('omits empty or revoked categories and does not let selected-skill admission broaden them', () => {
    const selectedActions = createToolDiscovery([action('pages.search', 'core'), action('pages.get', 'core'), action('pages.searchTags', 'explore')])
    const selectedTurn = selectedActions.beginTurn()

    expect(selectedTurn.categoryIndex.map(entry => entry.category)).toEqual(['explore'])
    expect(selectedActions.enable('history')).toBeNull()
    expect(selectedActions.enable('canonical')).toBeNull()
    expect(selectedActions.enable('authoring')).toBeNull()
    expect(selectedActions.enable('browser')).toBeNull()
    expect(selectedTurn.activeFunctions.map(item => item.name)).toEqual(['pages.search', 'pages.get'])
    expect(resolveToolDiscoveryCall(selectedTurn, 'pages.getVersion', {})).toBeNull()
    expect(resolveToolDiscoveryCall(selectedTurn, 'pages.prepareCreate', {})).toBeNull()

    const revoked = createToolDiscovery([action('pages.search', 'core'), action('pages.get', 'core')])
    const revokedTurn = revoked.beginTurn()
    expect(revokedTurn.control).toBeNull()
    expect(revoked.categoryIndex).toEqual([])
    expect(revoked.enable('explore')).toBeNull()
  })

  it('fails closed for hidden direct calls and malformed controls while deferring canonical activation to the next turn', () => {
    const discovery = createToolDiscovery(allActions)
    const firstTurn = discovery.beginTurn()
    discovery.enable('explore')
    discovery.enable('canonical')

    expect(resolveToolDiscoveryCall(firstTurn, 'pages.searchTags', {})).toBeNull()
    expect(resolveToolDiscoveryCall(firstTurn, 'pages.getOkf', {})).toBeNull()
    expect(resolveToolDiscoveryCall(firstTurn, 'pages.prepareCreate', {})).toBeNull()
    expect(resolveToolDiscoveryCall(firstTurn, 'wiki_unknown', {})).toBeNull()
    expect(resolveToolDiscoveryCall(firstTurn, TOOL_DISCOVERY_CONTROL_NAME, { category: 'explore', extra: true })).toBeNull()
    expect(resolveToolDiscoveryCall(firstTurn, TOOL_DISCOVERY_CONTROL_NAME, { category: 'unknown' })).toBeNull()
    expect(resolveToolDiscoveryCall(firstTurn, TOOL_DISCOVERY_CONTROL_NAME, { category: 'canonical' })).toEqual({
      kind: 'control',
      name: TOOL_DISCOVERY_CONTROL_NAME,
      category: 'canonical'
    })

    const nextTurn = discovery.beginTurn()
    expect(nextTurn.activeFunctions.map(item => item.name)).toContain('pages.getOkf')
    expect(resolveToolDiscoveryCall(nextTurn, 'pages.getOkf', {})).toEqual({ kind: 'action', name: 'pages.getOkf' })
  })

  it('restricts child views to the existing read-only subagent intersection', () => {
    const discovery = createToolDiscovery(allActions, { child: true })
    const turn = discovery.beginTurn()

    expect(turn.activeFunctions.map(item => item.name)).toEqual(['pages.search', 'pages.get'])
    expect(turn.categoryIndex.map(entry => entry.category)).toEqual(['explore', 'history'])
    expect(discovery.enable('canonical')).toBeNull()
    expect(discovery.enable('authoring')).toBeNull()
    expect(discovery.enable('browser')).toBeNull()
    expect(resolveToolDiscoveryCall(turn, 'skills.list', {})).toBeNull()
    expect(resolveToolDiscoveryCall(turn, 'memory.manage', {})).toBeNull()
    expect(resolveToolDiscoveryCall(turn, 'pages.prepareCreate', {})).toBeNull()
    expect(resolveToolDiscoveryCall(turn, TOOL_DISCOVERY_CONTROL_NAME, { category: 'authoring' })).toBeNull()
  })

  it('is idempotent and does not leak enabled categories between executions', () => {
    const first = createToolDiscovery(allActions)
    first.beginTurn()
    const firstEnable = first.enable('history')
    const secondEnable = first.enable('history')
    expect(secondEnable).toEqual(firstEnable)
    expect(first.beginTurn().activeFunctions.map(item => item.name)).toContain('pages.listHistory')

    const second = createToolDiscovery(allActions)
    expect(second.beginTurn().activeFunctions.map(item => item.name)).not.toContain('pages.listHistory')
    expect(second.beginTurn().activeFunctions.map(item => item.name)).not.toContain('pages.searchTags')
  })

  it('derives an ephemeral view without carrying a prior execution state', () => {
    const enabled = deriveToolDiscovery(allActions, ['canonical'])
    const fresh = deriveToolDiscovery(allActions)

    expect(enabled.activeFunctions.map(item => item.name)).toContain('pages.getOkf')
    expect(fresh.activeFunctions.map(item => item.name)).not.toContain('pages.getOkf')
    expect(enabled.visibleNames).toEqual(enabled.activeFunctions.map(item => item.name))
  })
  it('previews pending and candidate categories without activating the candidate', () => {
    const discovery = createToolDiscovery(allActions)
    const firstTurn = discovery.beginTurn()
    discovery.enable('explore')
    discovery.enable('canonical')

    const pending = discovery.previewNextTurn()
    expect(pending.activeFunctions.map(item => item.name)).toEqual([
      'pages.search',
      'pages.get',
      'skills.list',
      'skills.read',
      'memory.manage',
      'pages.searchTags',
      'pages.listTags',
      'pages.getOkf'
    ])
    const candidate = discovery.previewNextTurn('authoring')
    expect(candidate.activeFunctions.map(item => item.name)).toContain('pages.prepareCreate')
    expect(firstTurn.activeFunctions.map(item => item.name)).not.toContain('pages.searchTags')
    expect(firstTurn.activeFunctions.map(item => item.name)).not.toContain('pages.getOkf')
    expect(firstTurn.activeFunctions.map(item => item.name)).not.toContain('pages.prepareCreate')
    expect(discovery.beginTurn().activeFunctions.map(item => item.name)).not.toContain('pages.prepareCreate')
  })
})
