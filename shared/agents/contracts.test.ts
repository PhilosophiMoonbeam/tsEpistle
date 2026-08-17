import { describe, expect, it } from 'vitest'
import {
  AGENT_ACTION_NAMES,
  AGENT_EVENT_TYPES,
  AGENT_FEATURE_FLAG_KEYS,
  AGENT_PERMISSION_KEYS,
  MCP_ACTION_ALIASES
} from './contracts.ts'

describe('frozen agent contracts', () => {
  it('keeps action, event, and feature identifiers unique', () => {
    expect(new Set(AGENT_ACTION_NAMES).size).toBe(AGENT_ACTION_NAMES.length)
    expect(new Set(AGENT_EVENT_TYPES).size).toBe(AGENT_EVENT_TYPES.length)
    expect(new Set(AGENT_FEATURE_FLAG_KEYS).size).toBe(AGENT_FEATURE_FLAG_KEYS.length)
  })

  it('uses unique stable MCP aliases only for MCP actions', () => {
    const aliases = Object.values(MCP_ACTION_ALIASES)
    expect(new Set(aliases).size).toBe(aliases.length)
    expect(aliases.every(alias => alias.startsWith('wiki_'))).toBe(true)
    expect(Object.keys(MCP_ACTION_ALIASES).every(name => AGENT_ACTION_NAMES.includes(name as typeof AGENT_ACTION_NAMES[number]))).toBe(true)
  })

  it('freezes least-privileged admission permissions', () => {
    expect(AGENT_PERMISSION_KEYS).toEqual(['use:agents', 'use:agent-browser', 'use:mcp'])
  })
})
