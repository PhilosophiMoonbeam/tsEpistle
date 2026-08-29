import { describe, expect, it } from '../../server/test/bun-test.mts'
import {
  AGENT_ACTION_BY_TOOL_NAME,
  AGENT_ACTION_NAMES,
  AGENT_EVENT_TYPES,
  AGENT_TASK_KINDS,
  AGENT_FEATURE_FLAG_KEYS,
  AGENT_PERMISSION_KEYS,
  AGENT_TOOL_NAMES,
  agentProviderReasoningEfforts
} from './contracts.ts'

describe('frozen agent contracts', () => {
  it('keeps action, event, and feature identifiers unique', () => {
    expect(new Set(AGENT_ACTION_NAMES).size).toBe(AGENT_ACTION_NAMES.length)
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length)
    expect(new Set(AGENT_FEATURE_FLAG_KEYS).size).toBe(AGENT_FEATURE_FLAG_KEYS.length)
    expect(AGENT_ACTION_NAMES).not.toEqual(expect.arrayContaining(['pages.getOkf', 'pages.prepareImportOkf']))
    expect(AGENT_FEATURE_FLAG_KEYS).toContain('agents.orchestration.enabled')
    expect(AGENT_EVENT_TYPES).toEqual(expect.arrayContaining(['task.planCreated', 'task.created', 'subagent.started', 'subagent.completed', 'run.partial']))
    expect(AGENT_TASK_KINDS).toEqual(['source_scout', 'fact_check', 'conflict_check'])
  })

  it('uses one unique stable tool name for every action', () => {
    const toolNames = Object.values(AGENT_TOOL_NAMES)
    expect(new Set(toolNames).size).toBe(toolNames.length)
    expect(toolNames.every(name => name.startsWith('wiki_'))).toBe(true)
    expect(Object.keys(AGENT_TOOL_NAMES)).toEqual([...AGENT_ACTION_NAMES])
    expect(Object.keys(AGENT_ACTION_BY_TOOL_NAME)).toHaveLength(AGENT_ACTION_NAMES.length)
    expect(AGENT_TOOL_NAMES).toMatchObject({
      'pages.get': 'wiki_get_page',
      'pages.discover': 'wiki_discover_pages',
      'pages.prepareCreate': 'wiki_prepare_page_create',
      'memory.manage': 'wiki_manage_memory'
    })
    expect(toolNames).not.toEqual(expect.arrayContaining(['wiki_get_page_okf', 'wiki_prepare_okf_import']))
  })

  it('freezes least-privileged admission permissions', () => {
    expect(AGENT_PERMISSION_KEYS).toEqual(['use:agents', 'use:agent-browser', 'use:mcp'])
  })

  it('keeps protocol-specific reasoning effort values exact', () => {
    expect(agentProviderReasoningEfforts('openai-responses')).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(agentProviderReasoningEfforts('openresponses')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(agentProviderReasoningEfforts('anthropic-messages')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(agentProviderReasoningEfforts('gemini-api')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(agentProviderReasoningEfforts('legacy-completions')).toEqual([])
  })
})
