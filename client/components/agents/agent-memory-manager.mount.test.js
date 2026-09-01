import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-memory-manager.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-memory-manager.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

const loadManager = view => {
  const ref = value => ({ value })
  const getAgentMemories = vi.fn().mockResolvedValue(view)
  const evaluate = new Function(
    'computed',
    'nextTick',
    'onBeforeUnmount',
    'ref',
    'watch',
    'defineProps',
    'defineModel',
    'clearAgentMemories',
    'createAgentMemory',
    'getAgentMemories',
    'removeAgentMemory',
    'updateAgentMemory',
    'createModalFocusScope',
    'window',
    'HTMLElement',
    `${executableScript}\nreturn { loaded, memories, sections, memoryCountLabel, canAddMemory, addMemoryDisabledReason, clearMemoryDisabledReason }`
  )
  const manager = evaluate(
    getter => ({
      get value() {
        return getter()
      }
    }),
    () => Promise.resolve(),
    () => undefined,
    ref,
    (watched, callback, options) => {
      if (options?.immediate && !Array.isArray(watched)) callback(watched.value)
    },
    () => ({ csrfToken: 'csrf-token' }),
    () => ref(true),
    vi.fn(),
    vi.fn(),
    getAgentMemories,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    { fetch: vi.fn() },
    class HTMLElement {}
  )
  return { getAgentMemories, manager }
}

describe('Agent memory manager initial loading', () => {
  it('loads an already-open panel on mount and exposes every memory section', async () => {
    const { getAgentMemories, manager } = loadManager({
      agent: { entries: [], characters: 0, limit: 2_200 },
      user: { entries: [], characters: 0, limit: 1_375 }
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(getAgentMemories).toHaveBeenCalledTimes(1)
    expect(manager.loaded.value).toBe(true)
    expect(manager.sections.value.map(section => section.title)).toEqual(['You', 'Agent'])
    expect(manager.memoryCountLabel.value).toBe('0 saved records')
    expect(manager.canAddMemory.value).toBe(true)
    expect(manager.addMemoryDisabledReason.value).toBeUndefined()
    expect(manager.clearMemoryDisabledReason.value).toBe('No saved memory to clear')
  })

  it('reports one accurate saved-record count across both sections', async () => {
    const entry = (id, target) => ({
      id,
      target,
      content: `Memory ${id}`,
      version: 1,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z'
    })
    const { manager } = loadManager({
      agent: { entries: [entry('agent-1', 'agent'), entry('agent-2', 'agent')], characters: 30, limit: 2_200 },
      user: { entries: [entry('user-1', 'user')], characters: 13, limit: 1_375 }
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(manager.memoryCountLabel.value).toBe('3 saved records')
  })
})
