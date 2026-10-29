import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { translateEnglish } from '../../test/english-translate.mts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-memory-manager.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-memory-manager.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

let nextMemoryId = 0
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
  const props = {
    csrfToken: 'csrf-token',
    headingId: 'agent-memory-title',
    descriptionId: 'agent-memory-description'
  }
  const model = ref(true)
  const useId = () => `v-test-memory-${++nextMemoryId}`

  const getAgentMemories = overrides.getAgentMemories ?? vi.fn().mockResolvedValue(view)
  const clearAgentMemories = overrides.clearAgentMemories ?? vi.fn()
  const removeAgentMemory = overrides.removeAgentMemory ?? vi.fn()
  const createAgentMemory = overrides.createAgentMemory ?? vi.fn().mockResolvedValue({ changed: false, receipt: null })
  const updateAgentMemory = overrides.updateAgentMemory ?? vi.fn().mockResolvedValue({ changed: false, receipt: null })
  const capture = { ownerId: 1, sessionId: 'session-current', generation: 1, ownerGeneration: 0, selectionVersion: 1 }
  const agents = overrides.agents ?? {
    captureMemoryMutationContext: () => capture,
    isMemoryMutationContextCurrent: () => true,
    consumeManualMemoryReceipt: vi.fn(),
    invalidateSavedMemory: vi.fn()
  }
  const createModalFocusScope = overrides.createModalFocusScope ?? vi.fn(() => ({ deactivate: vi.fn() }))
  const emittedBusy = []
  const emit = (event, busy) => {
    if (event === 'update:busy') emittedBusy.push(busy)
  }
  let currentCleanupRegistrar = null
  const onWatcherCleanup = cleanup => {
    currentCleanupRegistrar?.(cleanup)
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
      currentCleanupRegistrar = nextCleanup => {
        cleanup = nextCleanup
      }
      try {
        callback(Array.isArray(watched) ? values : values[0], Array.isArray(watched) ? previous : previous[0], nextCleanup => {
          cleanup = nextCleanup
        })
      } finally {
        currentCleanupRegistrar = null
      }
    }
    for (const watchedRef of watchedRefs) {
      const subscribers = subscriptions.get(watchedRef) ?? []
      subscribers.push(notify)
      subscriptions.set(watchedRef, subscribers)
    }
    if (options?.immediate) notify()
  }
  const exposed = {}
  const evaluate = new Function(
    'computed',
    'useTranslate',
    'nextTick',
    'onBeforeUnmount',
    'onWatcherCleanup',
    'defineEmits',
    'ref',
    'shallowRef',
    'useTemplateRef',
    'useId',
    'watch',
    'defineProps',
    'defineModel',
    'defineExpose',
    'clearAgentMemories',
    'createAgentMemory',
    'getAgentMemories',
    'removeAgentMemory',
    'updateAgentMemory',
    'createModalFocusScope',
    'useAgentsStore',
    'AGENT_MEMORY_CHARACTER_LIMITS',
    'window',
    'HTMLElement',
    `${executableScript}\nreturn { loaded, memories, sections, searchQuery, visibleSections, memorySearchStatus, memoryCount, memoryCountLabel, canAddTo, clearMemoryDisabledReason, open, actionBusy, removing, clearing, clearReviewCount, clearError, draftTarget, draftContent, editing, draftConflict, error, beginAdd, beginEdit, beginRemove, beginClear, cancelClear, cancelEditOnEscape, keepDraftAfterRefresh, load, remove, clear, requestClose, save, saveShortcut }`
  )
  const manager = evaluate(
    getter => ({
      get value() {
        return getter()
      }
    }),
    () => overrides.translate ?? translateEnglish,
    () => Promise.resolve(),
    callback => beforeUnmount.push(callback),
    onWatcherCleanup,
    () => emit,
    ref,
    ref,
    useTemplateRef,
    useId,
    watch,
    () => props,
    () => model,
    publicApi => Object.assign(exposed, publicApi),
    clearAgentMemories,
    createAgentMemory,
    getAgentMemories,
    removeAgentMemory,
    updateAgentMemory,
    createModalFocusScope,
    () => agents,
    { user: 1375, agent: 2200 },
    { fetch: vi.fn() },
    TestHTMLElement
  )
  return {
    agents,
    clearAgentMemories,
    createAgentMemory,
    createModalFocusScope,
    emittedBusy,
    exposed,
    getAgentMemories,
    manager,
    removeAgentMemory,
    updateAgentMemory,
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
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('Agent memory manager initial loading', () => {
  it('loads an already-open panel on mount, enables add, and reports an empty store', async () => {
    const { emittedBusy, getAgentMemories, manager } = loadManager({
      agent: { entries: [], characters: 0, limit: 2_200 },
      user: { entries: [], characters: 0, limit: 1_375 }
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(getAgentMemories).toHaveBeenCalledTimes(1)
    expect(manager.loaded.value).toBe(true)
    expect(Number.parseInt(manager.memoryCountLabel.value, 10)).toBe(0)
    expect(manager.canAddTo('user')).toBe(true)
    expect(manager.canAddTo('agent')).toBe(true)
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

    expect(Number.parseInt(manager.memoryCountLabel.value, 10)).toBe(3)
  })

  it('keeps target selection state aligned with the requested memory section', async () => {
    const { manager } = loadManager(populatedView())

    await Promise.resolve()
    await Promise.resolve()
    manager.beginAdd('agent')

    expect(manager.draftTarget.value).toBe('agent')
    expect(manager.draftContent.value).toBe('')

    manager.beginAdd('user')
    expect(manager.draftTarget.value).toBe('user')
  })
})

describe('Agent memory draft retention and input methods', () => {
  it('keeps a draft and its conflict when the manager hides and reopens', async () => {
    const view = populatedView()
    const refreshedView = {
      ...view,
      user: { ...view.user, entries: [{ ...memoryEntry, content: 'Updated elsewhere', version: 4 }] }
    }
    const getAgentMemories = vi.fn().mockResolvedValueOnce(view).mockResolvedValue(refreshedView)
    const { manager } = loadManager(view, { getAgentMemories })
    await Promise.resolve()
    await Promise.resolve()
    manager.beginEdit(memoryEntry)
    manager.draftContent.value = 'My unsaved revision'
    await manager.load()
    manager.requestClose()
    expect(manager.open.value).toBe(false)
    expect(manager.draftContent.value).toBe('My unsaved revision')
    expect(manager.draftConflict.value?.latest?.version).toBe(4)

    manager.open.value = true
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.editing.value).toEqual({ id: memoryEntry.id, version: memoryEntry.version })
    expect(manager.draftContent.value).toBe('My unsaved revision')
    expect(manager.draftConflict.value?.kind).toBe('changed')
  })

  it.each(['ctrlKey', 'metaKey'])('does not save or intercept %s+Enter while an input method is composing', async modifier => {
    const { manager, createAgentMemory, updateAgentMemory } = loadManager(populatedView())
    await Promise.resolve()
    await Promise.resolve()
    manager.beginAdd('agent')
    manager.draftContent.value = '入力中のメモ'
    const preventDefault = vi.fn()
    const event = { ctrlKey: false, metaKey: false, [modifier]: true, isComposing: true, preventDefault }
    manager.saveShortcut(event)
    await Promise.resolve()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(createAgentMemory).not.toHaveBeenCalled()
    expect(updateAgentMemory).not.toHaveBeenCalled()
    expect(manager.draftContent.value).toBe('入力中のメモ')

    manager.saveShortcut({ ...event, isComposing: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(createAgentMemory).toHaveBeenCalledTimes(1)
    expect(manager.editing.value).toBeNull()
  })
})


describe('Agent memory manager destructive dialog lifetime', () => {
  it('backgrounds an in-flight remove while its mounted manager retains ownership', async () => {
    const mutation = deferred()
    const focusScope = { deactivate: vi.fn() }
    const createModalFocusScope = vi.fn(() => focusScope)
    const removeAgentMemory = vi.fn(() => mutation.promise)
    const view = populatedView()
    const reload = deferred()
    const removedView = {
      agent: structuredClone(view.agent),
      user: { entries: [], characters: 0, limit: 1_375 }
    }
    const getAgentMemories = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockImplementationOnce(() => reload.promise)
    const { emittedBusy, manager } = loadManager(view, {
      createModalFocusScope,
      getAgentMemories,
      removeAgentMemory
    })

    await Promise.resolve()
    await Promise.resolve()
    manager.beginRemove(memoryEntry, { currentTarget: null })
    await Promise.resolve()

    expect(createModalFocusScope).toHaveBeenCalledTimes(1)

    const completion = manager.remove()
    manager.requestClose()
    expect(manager.open.value).toBe(true)
    expect(emittedBusy).toEqual([false, true])
    manager.open.value = false
    expect(manager.memories.value).toBe(view)

    expect(manager.actionBusy.value).toBe('remove')
    expect(manager.removing.value).toBe(memoryEntry)
    expect(removeAgentMemory).toHaveBeenCalledTimes(1)
    expect(focusScope.deactivate).toHaveBeenCalledWith({ restoreFocus: false })

    mutation.resolve({ characters: 0, limit: 1_375 })
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.memories.value.user).toEqual({ entries: [], characters: 0, limit: 1_375 })
    expect(manager.memories.value.agent).toEqual(view.agent)
    expect(manager.actionBusy.value).toBe('remove')
    reload.resolve(removedView)
    await completion

    expect(manager.removing.value).toBeNull()
    expect(manager.actionBusy.value).toBe('')
    expect(getAgentMemories).toHaveBeenCalledTimes(2)
    expect(manager.memories.value).toEqual(removedView)
    expect(emittedBusy).toEqual([false, true, false])
  })

  it('backgrounds an in-flight clear while its mounted manager retains ownership', async () => {
    const mutation = deferred()
    const focusScope = { deactivate: vi.fn() }
    const createModalFocusScope = vi.fn(() => focusScope)
    const clearAgentMemories = vi.fn(() => mutation.promise)
    const view = populatedView()
    view.agent = {
      entries: [{ ...memoryEntry, id: 'agent-memory', target: 'agent', content: 'Project context' }],
      characters: 'Project context'.length,
      limit: 2_200
    }
    const reload = deferred()
    const clearedView = {
      agent: { entries: [], characters: 0, limit: view.agent.limit },
      user: { entries: [], characters: 0, limit: view.user.limit }
    }
    const getAgentMemories = vi
      .fn()
      .mockResolvedValueOnce(view)
      .mockImplementationOnce(() => reload.promise)
    const { emittedBusy, manager } = loadManager(view, {
      clearAgentMemories,
      createModalFocusScope,
      getAgentMemories
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
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.memories.value).toEqual(clearedView)
    expect(manager.actionBusy.value).toBe('clear')
    reload.resolve(clearedView)
    await completion

    expect(manager.clearing.value).toBe(false)
    expect(manager.actionBusy.value).toBe('')
    expect(getAgentMemories).toHaveBeenCalledTimes(2)
    expect(manager.memories.value).toEqual(clearedView)
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
    const removeMemories = structuredClone(removeHarness.manager.memories.value)
    const clearMemories = structuredClone(clearHarness.manager.memories.value)

    removeHarness.dispose()
    clearHarness.dispose()
    removeMutation.resolve({ characters: 0, limit: 1_375 })
    clearMutation.resolve()
    await Promise.all([removeCompletion, clearCompletion])

    expect(removeHarness.manager.memories.value).toEqual(removeMemories)
    expect(removeHarness.manager.removing.value).toBe(memoryEntry)
    expect(removeHarness.manager.actionBusy.value).toBe('remove')
    expect(removeHarness.getAgentMemories).toHaveBeenCalledTimes(1)
    expect(clearHarness.manager.memories.value).toEqual(clearMemories)
    expect(clearHarness.manager.clearing.value).toBe(true)
    expect(clearHarness.manager.actionBusy.value).toBe('clear')
    expect(clearHarness.getAgentMemories).toHaveBeenCalledTimes(1)
  })
})

describe('Agent memory filtering', () => {
  it('finds notes across both stores without changing stored entries or capacity', async () => {
    const view = {
      user: { entries: [{ id: 'user-note', target: 'user', content: 'Prefer concise SOURCES', version: 1 }], characters: 22, limit: 1375 },
      agent: { entries: [{ id: 'agent-note', target: 'agent', content: 'Project sources live in the Wiki', version: 1 }], characters: 31, limit: 2200 }
    }
    const originalView = structuredClone(view)
    const { manager } = loadManager(view)
    await new Promise(resolve => setTimeout(resolve, 0))
    manager.searchQuery.value = ' sources '
    expect(manager.visibleSections.value.map(section => section.entries[0].id)).toEqual(['user-note', 'agent-note'])
    expect(Number.parseInt(manager.memorySearchStatus.value, 10)).toBe(2)
    manager.searchQuery.value = 'project'
    expect(manager.visibleSections.value.map(section => section.target)).toEqual(['agent'])
    manager.searchQuery.value = 'no matching phrase'
    expect(manager.visibleSections.value).toEqual([])
    expect(manager.memories.value).toEqual(originalView)
    expect(manager.canAddTo('user')).toBe(true)
    expect(manager.canAddTo('agent')).toBe(true)
    manager.searchQuery.value = null
    expect(manager.visibleSections.value.map(section => ({ target: section.target, entries: section.entries }))).toEqual([
      { target: 'user', entries: originalView.user.entries },
      { target: 'agent', entries: originalView.agent.entries }
    ])
    expect(manager.memories.value).toEqual(originalView)
  })
})

describe('Agent manual memory receipt forwarding', () => {
  it.each(['changed', 'no-op', 'failure', 'switched'])('forwards only actual current changed add responses: %s', async outcome => {
    const mutation = deferred()
    const capture = { ownerId: 1, sessionId: 'session-current', generation: 3, ownerGeneration: 2, selectionVersion: 4 }
    let current = true
    const agents = {
      captureMemoryMutationContext: () => capture,
      isMemoryMutationContextCurrent: candidate => current && candidate === capture,
      consumeManualMemoryReceipt: vi.fn(),
      invalidateSavedMemory: vi.fn()
    }
    const createAgentMemory = vi.fn(() => mutation.promise)
    const { manager, getAgentMemories } = loadManager(populatedView(), { agents, createAgentMemory })
    await Promise.resolve()
    await Promise.resolve()
    expect(agents.consumeManualMemoryReceipt).not.toHaveBeenCalled()
    manager.beginAdd('agent')
    manager.draftContent.value = 'Explicitly saved note'
    const completion = manager.save()
    expect(createAgentMemory.mock.calls[0][2]).toEqual({
      target: 'agent', content: 'Explicitly saved note', context: { sessionId: capture.sessionId }
    })
    expect(agents.consumeManualMemoryReceipt).not.toHaveBeenCalled()
    const receipt = {
      schemaVersion: 1, origin: 'manual', ownerId: 1, sessionId: capture.sessionId,
      runId: null, attempt: null, snapshotId: null, entryId: 'entry-new', entryVersion: 1, operation: 'add', changed: true,
      targets: [{ target: 'agent', characters: 21, limit: 2200, snapshotId: 'a'.repeat(64) }]
    }
    if (outcome === 'switched') current = false
    if (outcome === 'failure') mutation.reject(new Error('Memory changed concurrently.'))
    else mutation.resolve({ changed: outcome !== 'no-op', receipt: outcome === 'no-op' ? null : receipt })
    await completion
    if (outcome === 'changed') {
      expect(agents.consumeManualMemoryReceipt).toHaveBeenCalledWith(capture, receipt, { entryId: null, entryVersion: 1, target: 'agent' })
      expect(getAgentMemories).toHaveBeenCalledTimes(2)
    } else {
      expect(agents.consumeManualMemoryReceipt).not.toHaveBeenCalled()
      expect(getAgentMemories).toHaveBeenCalledTimes(outcome === 'no-op' ? 2 : 1)
    }
  })

  it('correlates an optimistic replacement response without treating a list refresh as its receipt', async () => {
    const receipt = {
      schemaVersion: 1, origin: 'manual', ownerId: 1, sessionId: 'session-current',
      runId: null, attempt: null, snapshotId: null, entryId: memoryEntry.id, entryVersion: memoryEntry.version + 1,
      operation: 'replace', changed: true,
      targets: [
        { target: 'user', characters: 0, limit: 1375, snapshotId: 'b'.repeat(64) },
        { target: 'agent', characters: 24, limit: 2200, snapshotId: 'c'.repeat(64) }
      ]
    }
    const updateAgentMemory = vi.fn().mockResolvedValue({ changed: true, receipt })
    const { agents, manager } = loadManager(populatedView(), { updateAgentMemory })
    await Promise.resolve()
    await Promise.resolve()
    manager.beginEdit(memoryEntry)
    manager.draftTarget.value = 'agent'
    manager.draftContent.value = 'Updated project context'
    await manager.save()
    expect(updateAgentMemory.mock.calls[0].slice(2)).toEqual([memoryEntry.id, {
      expectedVersion: memoryEntry.version, target: 'agent', content: 'Updated project context', context: { sessionId: 'session-current' }
    }])
    expect(agents.consumeManualMemoryReceipt).toHaveBeenCalledTimes(1)
    expect(agents.consumeManualMemoryReceipt.mock.calls[0].slice(1)).toEqual([receipt, {
      entryId: memoryEntry.id, entryVersion: memoryEntry.version + 1, target: 'agent'
    }])
  })

  it.each(['remove', 'clear'])('invalidates saved metadata without forwarding a reward for %s', async operation => {
    const { agents, manager } = loadManager(populatedView(), {
      removeAgentMemory: vi.fn().mockResolvedValue({ changed: true, characters: 0, limit: 1375 }),
      clearAgentMemories: vi.fn().mockResolvedValue(1)
    })
    await Promise.resolve()
    await Promise.resolve()
    if (operation === 'remove') {
      manager.beginRemove(memoryEntry, { currentTarget: null })
      await manager.remove()
    } else {
      manager.beginClear({ currentTarget: null })
      await manager.clear()
    }
    expect(agents.consumeManualMemoryReceipt).not.toHaveBeenCalled()
    expect(agents.invalidateSavedMemory).toHaveBeenCalledTimes(1)
    expect(agents.invalidateSavedMemory.mock.calls[0][1]).toEqual(operation === 'remove' ? ['user'] : ['user', 'agent'])
  })
})
