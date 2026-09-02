import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-memory-manager.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-memory-manager.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

const loadManager = (view, overrides = {}) => {
  let mounted = true
  const subscriptions = new WeakMap()
  const beforeUnmount = []
  const ref = initialValue => {
    let value = initialValue
    const reactiveRef = {
      get value() {
        return value
      },
      set value(nextValue) {
        const previousValue = value
        value = nextValue
        if (mounted && nextValue !== previousValue) {
          for (const subscriber of subscriptions.get(reactiveRef) ?? []) subscriber(nextValue, previousValue)
        }
      }
    }
    return reactiveRef
  }
  class TestHTMLElement {}
  const templateRefs = {
    clearDialogCard: ref(new TestHTMLElement()),
    memoryHeading: ref(new TestHTMLElement()),
    removeDialogCard: ref(new TestHTMLElement())
  }
  const useTemplateRef = name => templateRefs[name] ?? ref(null)
  const getAgentMemories = overrides.getAgentMemories ?? vi.fn().mockResolvedValue(view)
  const clearAgentMemories = overrides.clearAgentMemories ?? vi.fn()
  const removeAgentMemory = overrides.removeAgentMemory ?? vi.fn()
  const createModalFocusScope = overrides.createModalFocusScope ?? vi.fn(() => ({ deactivate: vi.fn() }))
  const emittedBusy = []
  const emit = (event, busy) => {
    if (event === 'update:busy') emittedBusy.push(busy)
  }
  const watch = (watched, callback, options) => {
    const watchedRefs = Array.isArray(watched) ? watched : [watched]
    let previousValues = watchedRefs.map(item => item.value)
    let cleanup
    const notify = () => {
      cleanup?.()
      cleanup = undefined
      const values = watchedRefs.map(item => item.value)
      const previous = previousValues
      previousValues = values
      callback(Array.isArray(watched) ? values : values[0], Array.isArray(watched) ? previous : previous[0], nextCleanup => {
        cleanup = nextCleanup
      })
    }
    for (const watchedRef of watchedRefs) {
      const subscribers = subscriptions.get(watchedRef) ?? []
      subscribers.push(notify)
      subscriptions.set(watchedRef, subscribers)
    }
    if (options?.immediate) notify()
  }
  const evaluate = new Function(
    'computed',
    'nextTick',
    'onBeforeUnmount',
    'defineEmits',
    'ref',
    'shallowRef',
    'useTemplateRef',
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
    `${executableScript}\nreturn { loaded, memories, sections, memoryCountLabel, canAddMemory, addMemoryDisabledReason, clearMemoryDisabledReason, open, actionBusy, removing, clearing, beginRemove, beginClear, remove, clear, requestClose }`
  )
  const manager = evaluate(
    getter => ({
      get value() {
        return getter()
      }
    }),
    () => Promise.resolve(),
    callback => beforeUnmount.push(callback),
    () => emit,
    ref,
    ref,
    useTemplateRef,
    watch,
    () => ({ csrfToken: 'csrf-token' }),
    () => ref(true),
    clearAgentMemories,
    vi.fn(),
    getAgentMemories,
    removeAgentMemory,
    vi.fn(),
    createModalFocusScope,
    { fetch: vi.fn() },
    TestHTMLElement
  )
  return {
    clearAgentMemories,
    createModalFocusScope,
    emittedBusy,
    getAgentMemories,
    manager,
    removeAgentMemory,
    dispose: () => {
      for (const callback of beforeUnmount) callback()
      mounted = false
    }
  }
}
const memoryEntry = {
  id: 'memory-1',
  target: 'user',
  content: 'Prefers concise answers',
  version: 3,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z'
}
const populatedView = () => ({
  agent: { entries: [], characters: 0, limit: 2_200 },
  user: { entries: [memoryEntry], characters: memoryEntry.content.length, limit: 1_375 }
})
const deferred = () => {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Agent memory manager initial loading', () => {
  it('loads an already-open panel on mount and exposes every memory section', async () => {
    const { emittedBusy, getAgentMemories, manager } = loadManager({
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
    expect(emittedBusy).toEqual([false])
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

  it('keeps close blocked and stops busy updates after disposal during a mutation', async () => {
    const { dispose, emittedBusy, manager } = loadManager({
      agent: { entries: [], characters: 0, limit: 2_200 },
      user: { entries: [], characters: 0, limit: 1_375 }
    })

    await Promise.resolve()
    await Promise.resolve()

    manager.actionBusy.value = 'save'
    manager.requestClose()

    expect(manager.open.value).toBe(true)
    expect(emittedBusy).toEqual([false, true])

    dispose()
    manager.actionBusy.value = ''

    expect(emittedBusy).toEqual([false, true])
  })
})

describe('Agent memory manager destructive dialog lifetime', () => {
  it('keeps both teleported dialogs and backdrop handling subordinate to the panel', () => {
    const dialogTags = source.split('\n').filter(line => line.includes('<v-dialog '))
    const removeDialog = dialogTags.find(line => line.includes("'remove'"))
    const clearDialog = dialogTags.find(line => line.includes("'clear'"))

    expect(removeDialog).toMatch(/:model-value="(?=[^"]*\bopen\b)(?=[^"]*\bremoving\b)[^"]+"/)
    expect(removeDialog).toMatch(/:persistent="(?=[^"]*\bopen\b)(?=[^"]*\bactionBusy\b)[^"]+"/)
    expect(removeDialog).toMatch(/@update:model-value="(?=[^"]*\bopen\b)[^"]+"/)
    expect(clearDialog).toMatch(/:model-value="(?=[^"]*\bopen\b)(?=[^"]*\bclearing\b)[^"]+"/)
    expect(clearDialog).toMatch(/:persistent="(?=[^"]*\bopen\b)(?=[^"]*\bactionBusy\b)[^"]+"/)
    expect(clearDialog).toMatch(/@update:model-value="(?=[^"]*\bopen\b)[^"]+"/)
    expect(script).toMatch(/onEscape:\s*\(\)\s*=>\s*\{[\s\S]{0,120}if\s*\(\s*!open\.value\b/)
  })

  it('backgrounds an in-flight remove while its mounted manager retains ownership', async () => {
    const mutation = deferred()
    const focusScope = { deactivate: vi.fn() }
    const createModalFocusScope = vi.fn(() => focusScope)
    const removeAgentMemory = vi.fn(() => mutation.promise)
    const view = populatedView()
    const { emittedBusy, getAgentMemories, manager } = loadManager(view, {
      createModalFocusScope,
      removeAgentMemory
    })

    await Promise.resolve()
    await Promise.resolve()
    manager.beginRemove(memoryEntry, { currentTarget: null })
    await Promise.resolve()

    expect(createModalFocusScope).toHaveBeenCalledTimes(1)

    const completion = manager.remove()
    manager.open.value = false
    expect(manager.memories.value).toBe(view)

    expect(manager.actionBusy.value).toBe('remove')
    expect(manager.removing.value).toBe(memoryEntry)
    expect(removeAgentMemory).toHaveBeenCalledTimes(1)
    expect(focusScope.deactivate).toHaveBeenCalledWith({ restoreFocus: false })

    mutation.resolve({ characters: 0, limit: 1_375 })
    await completion

    expect(manager.removing.value).toBeNull()
    expect(manager.actionBusy.value).toBe('')
    expect(getAgentMemories).toHaveBeenCalledTimes(2)
    expect(emittedBusy).toEqual([false, true, false])
  })

  it('backgrounds an in-flight clear while its mounted manager retains ownership', async () => {
    const mutation = deferred()
    const focusScope = { deactivate: vi.fn() }
    const createModalFocusScope = vi.fn(() => focusScope)
    const clearAgentMemories = vi.fn(() => mutation.promise)
    const view = populatedView()
    const { emittedBusy, getAgentMemories, manager } = loadManager(view, {
      clearAgentMemories,
      createModalFocusScope
    })

    await Promise.resolve()
    await Promise.resolve()
    manager.beginClear({ currentTarget: null })
    await Promise.resolve()

    expect(createModalFocusScope).toHaveBeenCalledTimes(1)

    const completion = manager.clear()
    manager.open.value = false
    expect(manager.memories.value).toBe(view)

    expect(manager.actionBusy.value).toBe('clear')
    expect(manager.clearing.value).toBe(true)
    expect(clearAgentMemories).toHaveBeenCalledTimes(1)
    expect(focusScope.deactivate).toHaveBeenCalledWith({ restoreFocus: false })

    mutation.resolve()
    await completion

    expect(manager.clearing.value).toBe(false)
    expect(manager.actionBusy.value).toBe('')
    expect(getAgentMemories).toHaveBeenCalledTimes(2)
    expect(emittedBusy).toEqual([false, true, false])
  })

  it('ignores both destructive completions once the owning manager is disposed', async () => {
    const removeMutation = deferred()
    const clearMutation = deferred()
    const removeHarness = loadManager(populatedView(), {
      removeAgentMemory: vi.fn(() => removeMutation.promise)
    })
    const clearHarness = loadManager(populatedView(), {
      clearAgentMemories: vi.fn(() => clearMutation.promise)
    })

    await Promise.resolve()
    await Promise.resolve()
    removeHarness.manager.beginRemove(memoryEntry, { currentTarget: null })
    clearHarness.manager.beginClear({ currentTarget: null })
    await Promise.resolve()

    const removeCompletion = removeHarness.manager.remove()
    const clearCompletion = clearHarness.manager.clear()
    removeHarness.manager.open.value = false
    clearHarness.manager.open.value = false
    const removeMemories = removeHarness.manager.memories.value
    const clearMemories = clearHarness.manager.memories.value

    removeHarness.dispose()
    clearHarness.dispose()
    removeMutation.resolve({ characters: 0, limit: 1_375 })
    clearMutation.resolve()
    await Promise.all([removeCompletion, clearCompletion])

    expect(removeHarness.manager.memories.value).toBe(removeMemories)
    expect(removeHarness.manager.removing.value).toBe(memoryEntry)
    expect(removeHarness.manager.actionBusy.value).toBe('remove')
    expect(removeHarness.getAgentMemories).toHaveBeenCalledTimes(1)
    expect(removeHarness.emittedBusy).toEqual([false, true])
    expect(clearHarness.manager.memories.value).toBe(clearMemories)
    expect(clearHarness.manager.clearing.value).toBe(true)
    expect(clearHarness.manager.actionBusy.value).toBe('clear')
    expect(clearHarness.getAgentMemories).toHaveBeenCalledTimes(1)
    expect(clearHarness.emittedBusy).toEqual([false, true])
  })
})
