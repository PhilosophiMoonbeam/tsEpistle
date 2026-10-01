import { describe, expect, it } from '../bun-test.mts'
import { AGENT_FEATURE_FLAG_KEYS, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { buildAgentAdminTools } from '../../agents/admin-tools.ts'

const enabled = Object.fromEntries(AGENT_FEATURE_FLAG_KEYS.map(key => [key, true])) as unknown as AgentFeatureFlags

describe('administration tool eligibility', () => {
  it('separates MCP from provider inference and keeps personal memory agent-only', () => {
    const tools = buildAgentAdminTools({ ...enabled, 'agents.provider.enabled': false })
    const read = tools.find(tool => tool.name === 'pages.get')!
    expect(read.agentBlockers).toEqual(['agents.provider.enabled'])
    expect(read.mcpBlockers).toEqual([])
    expect(read.requiredPermissions).toContain('read:pages')
    const memory = tools.find(tool => tool.name === 'memory.manage')!
    expect(memory.exposure).toEqual({ agent: true, mcp: false })
  })

  it('reports parent write and proposal switches even when a specific write is enabled', () => {
    const tools = buildAgentAdminTools({ ...enabled, 'agents.proposals.enabled': false, 'agents.writes.enabled': false })
    const patch = tools.find(tool => tool.name === 'pages.preparePatch')!
    expect(patch.agentBlockers).toContain('agents.proposals.enabled')
    expect(patch.agentBlockers).toContain('agents.writes.enabled')
    expect(patch.mcpBlockers).toContain('agents.writes.enabled')
    expect(tools.find(tool => tool.name === 'pages.get')!.agentBlockers).toEqual([])
  })

  it('blocks every interface when the parent agent feature is disabled', () => {
    const disabledTools = buildAgentAdminTools({ ...enabled, 'agents.enabled': false })
    expect(new Set(disabledTools.map(tool => tool.name))).toEqual(new Set(buildAgentAdminTools(enabled).map(tool => tool.name)))
    for (const tool of disabledTools) {
      expect(tool.agentBlockers).toContain('agents.enabled')
      expect(tool.mcpBlockers).toContain('agents.enabled')
    }
  })
})
