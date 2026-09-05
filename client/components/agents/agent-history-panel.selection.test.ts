import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'

interface Ref<T> {
  value: T
}

interface PanelAgents {
  error?: string
  openSession: (sessionId: string) => Promise<boolean>
  cancelSessionTransition: () => void
  moveSessionToFolder?: (sessionId: string, folderId: string | null) => Promise<unknown>
  renameSession?: (sessionId: string, title: string) => Promise<unknown>
  removeSession?: (sessionId: string) => Promise<boolean>
  deleteFolder?: (folderId: string) => Promise<unknown>
}

type PanelEmit = (event: 'close' | 'clear') => void

interface PanelHarness {
  activeDropTarget: Ref<string | null>
  beginRenameSession: (session: AgentSessionSummary, restoreTarget: HTMLElement | null) => void
  beginDeleteSession: (session: AgentSessionSummary, restoreTarget: HTMLElement | null) => void
  beginRemoveFolder: (folder: AgentConversationFolderView) => void
  beginSessionDrag: (event: DragEvent, session: AgentSessionSummary) => void
  canDropTo: (folderId: string | null) => boolean
  clearHistoryDisabled: Ref<boolean>
  closeHistory: () => void
  dragStatus: Ref<string>
  draggedSessionId: Ref<string | null>
  dropSession: (event: DragEvent, folderId: string | null) => Promise<void>
  deleteFolder: () => Promise<void>
  deleteSession: () => Promise<void>
  deletingSession: Ref<AgentSessionSummary | null>
  emit: PanelEmit
  finishSessionDrag: () => void
  localError: Ref<string>
  moveSession: (session: AgentSessionSummary, folderId: string | null) => Promise<boolean>
  sessionMutationBusy: Ref<boolean>
  saveSessionTitle: () => Promise<void>
  searchQuery: Ref<string | null>
  sessionEditorOpen: Ref<boolean>
  sessionRenameTitle: Ref<string>
  removingFolder: Ref<AgentConversationFolderView | null>
  requestClear: () => void
  openSession: (sessionId: string) => Promise<void>
  setDropTarget: (event: DragEvent, folderId: string | null) => void
  unmount: () => void
}

type WatchCleanup = () => void
type WatchCallback = (value: unknown, previous: unknown, onCleanup: (cleanup: WatchCleanup) => void) => void

interface ReactiveRef<T> extends Ref<T> {
  subscribe: (callback: WatchCallback) => void
}

class HarnessElement {
  constructor(readonly focusable = true) {}
  isConnected = true
  visible = true
  disabled = false
  ariaDisabled = false
  hiddenByAncestor = false
  focusTarget: HarnessElement | null = null
  readonly focus = vi.fn()
  getClientRects(): { length: number } {
    return { length: this.visible ? 1 : 0 }
  }

  matches(selector: string): boolean {
    if (selector === ':disabled, [aria-disabled="true"]') return this.disabled || this.ariaDisabled
    return this.focusable
  }

  closest(): HarnessElement | null {
    return this.hiddenByAncestor ? this : null
  }

  querySelector(): HarnessElement | null {
    return this.focusTarget
  }
}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-history-panel.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-history-panel.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

const loadPanel = (
  agents: PanelAgents,
  compact = true,
  sessionFixtures: AgentSessionSummary[] = [],
  folderFixtures: AgentConversationFolderView[] = [],
  focusControls: { searchRoot?: HarnessElement; close?: HarnessElement } = {}
): PanelHarness => {
  const emit = vi.fn()
  const unmountCallbacks: Array<() => void> = []
  let currentCleanupRegistrar: ((cleanup: WatchCleanup) => void) | null = null
  const onWatcherCleanup = (cleanup: WatchCleanup): void => {
    currentCleanupRegistrar?.(cleanup)
  }
  const ref = <T>(initialValue: T): ReactiveRef<T> => {
    let value = initialValue
    const watchers: Array<{ callback: WatchCallback; cleanup?: WatchCleanup }> = []
    return {
      get value() {
        return value
      },
      set value(nextValue: T) {
        const previous = value
        value = nextValue
        for (const watcher of watchers) {
          watcher.cleanup?.()
          watcher.cleanup = undefined
          currentCleanupRegistrar = cleanup => {
            watcher.cleanup = cleanup
          }
          try {
            void watcher.callback(nextValue, previous, cleanup => {
              watcher.cleanup = cleanup
            })
          } finally {
            currentCleanupRegistrar = null
          }
        }
      },
      subscribe: callback => watchers.push({ callback })
    }
  }
  const templateRefs: Record<string, HarnessElement | null> = {
    historyCloseButton: focusControls.close ?? null,
    historySearchField: focusControls.searchRoot ?? null
  }
  const useTemplateRef = <T>(name: string): ReactiveRef<T | null> => ref((templateRefs[name] ?? null) as T | null)
  const thread = ref({ session: { id: '00000000-0000-4000-8000-000000000001' } })
  const evaluate = new Function(
    'computed',
    'nextTick',
    'onBeforeUnmount',
    'onWatcherCleanup',
    'ref',
    'shallowRef',
    'useTemplateRef',
    'watch',
    'storeToRefs',
    'defineEmits',
    'useAgentsStore',
    'createModalFocusScope',
    'window',
    'document',
    'HTMLElement',
    `${executableScript}\nreturn {
      activeDropTarget,
      beginDeleteSession,
      beginRemoveFolder,
      beginSessionDrag,
      canDropTo,
      clearHistoryDisabled,
      closeHistory,
      beginRenameSession,
      dragStatus,
      draggedSessionId,
      dropSession,
      finishSessionDrag,
      deleteFolder,
      deleteSession,
      deletingSession,
      localError,
      moveSession,
      openSession,
      sessionMutationBusy,
      saveSessionTitle,
      searchQuery,
      sessionEditorOpen,
      sessionRenameTitle,
      removingFolder,
      requestClear,
      setDropTarget
    }`
  ) as (...dependencies: unknown[]) => Omit<PanelHarness, 'emit' | 'unmount'>
  const panel = evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    () => Promise.resolve(),
    (callback: () => void) => unmountCallbacks.push(callback),
    onWatcherCleanup,
    ref,
    ref,
    useTemplateRef,
    (source: unknown, callback: WatchCallback, options?: { immediate?: boolean }) => {
      if (source && typeof (source as ReactiveRef<unknown>).subscribe === 'function') {
        ;(source as ReactiveRef<unknown>).subscribe(callback)
      }
      if (options?.immediate) callback((source as Ref<unknown>)?.value, undefined, () => {})
    },
    () => ({
      folders: ref(folderFixtures),
      loading: ref(false),
      sessionMutationBusy: ref(false),
      sessions: ref(sessionFixtures),
      sessionsLoadMoreError: ref(''),
      sessionsLoadingMore: ref(false),
      sessionsNextCursor: ref<string | null>(null),
      sessionsReloading: ref(false),
      thread
    }),
    () => emit,
    () => agents,
    vi.fn(),
    { matchMedia: () => ({ matches: compact }) },
    { activeElement: null, querySelector: () => null },
    HarnessElement
  )
  return {
    ...panel,
    emit,
    unmount: () => {
      for (const callback of unmountCallbacks) callback()
    }
  }
}

const makeSession = (overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Release planning',
  retention: 'temporary',
  folderId: null,
  executionMode: 'agent',
  version: 1,
  providerProfileId: null,
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
  lastActivityAt: '2026-08-31T10:00:00.000Z',
  expiresAt: '2026-11-29T10:00:00.000Z',
  deletedAt: null,
  ...overrides
})

const makeFolder = (overrides: Partial<AgentConversationFolderView> = {}): AgentConversationFolderView => ({
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Roadmap',
  version: 1,
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
  ...overrides
})

const makeDragEvent = (): {
  dataTransfer: { dropEffect: string; effectAllowed: string; setData: (format: string, data: string) => void }
  event: DragEvent
  preventDefault: () => void
} => {
  const preventDefault = vi.fn()
  const dataTransfer = { dropEffect: 'none', effectAllowed: 'none', setData: vi.fn() }
  return {
    dataTransfer,
    event: { dataTransfer, preventDefault } as unknown as DragEvent,
    preventDefault
  }
}

describe('Agent history session selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('closes the compact history panel only after an applied transition', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000002')
    expect(panel.emit).not.toHaveBeenCalled()

    await panel.openSession('00000000-0000-4000-8000-000000000003')
    expect(panel.emit).toHaveBeenCalledTimes(1)
    expect(panel.emit).toHaveBeenCalledWith('close')
  })

  it('treats choosing the displayed session as the latest selection', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(true),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000001')

    expect(agents.cancelSessionTransition).toHaveBeenCalledTimes(1)
    expect(agents.openSession).not.toHaveBeenCalled()
    expect(panel.emit).not.toHaveBeenCalled()
  })

  it('keeps the panel open with an error when the newest transition fails', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockRejectedValue(new Error('Session unavailable')),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000002')

    expect(panel.emit).not.toHaveBeenCalled()
    expect(panel.localError.value).toBe('Session unavailable')
  })

  it('cancels a pending transition before closing the history workspace', () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    panel.closeHistory()

    expect(agents.cancelSessionTransition).toHaveBeenCalledTimes(1)
    expect(panel.emit).toHaveBeenCalledWith('close')
  })

  it('serializes transitions and closes only after the subsequent selection is committed', async () => {
    let resolveFirst!: (value: boolean) => void
    let resolveSecond!: (value: boolean) => void
    const agents: PanelAgents = {
      openSession: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>(resolve => {
              resolveFirst = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise<boolean>(resolve => {
              resolveSecond = resolve
            })
        ),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    const first = panel.openSession('00000000-0000-4000-8000-000000000002')
    const concurrentSelection = panel.openSession('00000000-0000-4000-8000-000000000003')

    await concurrentSelection
    expect(agents.openSession).toHaveBeenCalledTimes(1)
    expect(agents.openSession).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000002')
    expect(panel.emit).not.toHaveBeenCalled()

    resolveFirst(false)
    await first

    const subsequentSelection = panel.openSession('00000000-0000-4000-8000-000000000003')
    expect(agents.openSession).toHaveBeenCalledTimes(2)
    expect(agents.openSession).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000003')
    resolveSecond(true)
    await subsequentSelection

    expect(panel.emit).toHaveBeenCalledTimes(1)
    expect(panel.emit).toHaveBeenCalledWith('close')
  })

  it('also cancels a pending transition when its parent removes the workspace', () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    panel.unmount()

    expect(agents.cancelSessionTransition).toHaveBeenCalledTimes(1)
  })

  it('clears only when at least one unfiled conversation is available', () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const folder = makeFolder()
    const filedSession = makeSession({ folderId: folder.id, retention: 'saved' })
    const filedPanel = loadPanel(agents, true, [filedSession], [folder])

    expect(filedPanel.clearHistoryDisabled.value).toBe(true)
    filedPanel.requestClear()
    expect(filedPanel.emit).not.toHaveBeenCalled()

    const recentPanel = loadPanel(agents, true, [makeSession()], [folder])

    expect(recentPanel.clearHistoryDisabled.value).toBe(false)
    recentPanel.requestClear()
    expect(recentPanel.emit).toHaveBeenCalledWith('clear')
  })

  it('guards remove, clear, and folder deletion entry points and already-open confirmations with the shared mutation lock', async () => {
    const session = makeSession()
    const folder = makeFolder()
    const removeSession = vi.fn().mockResolvedValue(true)
    const deleteFolder = vi.fn().mockResolvedValue(undefined)
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn(),
      removeSession,
      deleteFolder
    }

    const lockedEntryPanel = loadPanel(agents, true, [session], [folder])
    lockedEntryPanel.sessionMutationBusy.value = true
    lockedEntryPanel.beginDeleteSession(session, null)
    lockedEntryPanel.beginRemoveFolder(folder)
    lockedEntryPanel.requestClear()

    expect(lockedEntryPanel.deletingSession.value).toBeNull()
    expect(lockedEntryPanel.removingFolder.value).toBeNull()
    expect(lockedEntryPanel.emit).not.toHaveBeenCalled()

    const openSessionConfirmation = loadPanel(agents, true, [session], [folder])
    openSessionConfirmation.beginDeleteSession(session, null)
    expect(openSessionConfirmation.deletingSession.value).toBe(session)
    openSessionConfirmation.sessionMutationBusy.value = true
    await openSessionConfirmation.deleteSession()

    const openFolderConfirmation = loadPanel(agents, true, [session], [folder])
    openFolderConfirmation.beginRemoveFolder(folder)
    expect(openFolderConfirmation.removingFolder.value).toBe(folder)
    openFolderConfirmation.sessionMutationBusy.value = true
    await openFolderConfirmation.deleteFolder()

    expect(removeSession).not.toHaveBeenCalled()
    expect(deleteFolder).not.toHaveBeenCalled()
  })

  it('restores focus to the conversation action trigger when rename is cancelled', async () => {
    const trigger = new HarnessElement()
    const searchRoot = new HarnessElement(false)
    const searchInput = new HarnessElement()
    searchRoot.focusTarget = searchInput
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents, true, [makeSession()], [], { searchRoot })

    panel.beginRenameSession(makeSession(), trigger as unknown as HTMLElement)
    panel.sessionEditorOpen.value = false
    await Promise.resolve()

    expect(trigger.focus).toHaveBeenCalledTimes(1)
    expect(searchInput.focus).not.toHaveBeenCalled()
  })

  it('focuses history search when a filtered rename removes the source row', async () => {
    const trigger = new HarnessElement()
    const searchRoot = new HarnessElement(false)
    const searchInput = new HarnessElement()
    const session = makeSession()
    const sessions = [session]
    searchRoot.focusTarget = searchInput
    const renameSession = vi.fn().mockImplementation(async () => {
      sessions.splice(0)
      trigger.isConnected = false
    })
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn(),
      renameSession
    }
    const panel = loadPanel(agents, true, sessions, [], { searchRoot })
    panel.searchQuery.value = session.title
    panel.beginRenameSession(session, trigger as unknown as HTMLElement)
    panel.sessionRenameTitle.value = 'Shipped roadmap'

    await panel.saveSessionTitle()
    await Promise.resolve()

    expect(renameSession).toHaveBeenCalledWith(session.id, 'Shipped roadmap')
    expect(trigger.focus).not.toHaveBeenCalled()
    expect(searchInput.focus).toHaveBeenCalledTimes(1)
  })

  it('focuses the history close control when neither the source nor search is visible', async () => {
    const trigger = new HarnessElement()
    trigger.isConnected = false
    const searchRoot = new HarnessElement(false)
    const searchInput = new HarnessElement()
    searchInput.visible = false
    searchRoot.focusTarget = searchInput
    const close = new HarnessElement()
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents, true, [makeSession()], [], { searchRoot, close })

    panel.beginRenameSession(makeSession(), trigger as unknown as HTMLElement)
    panel.sessionEditorOpen.value = false
    await Promise.resolve()

    expect(searchInput.focus).not.toHaveBeenCalled()
    expect(close.focus).toHaveBeenCalledTimes(1)
  })

  it('moves a pointer-dragged recent conversation through the existing folder action', async () => {
    const session = makeSession()
    const folder = makeFolder()
    const moveSessionToFolder = vi.fn().mockResolvedValue({})
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn(),
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, [session], [folder])
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)

    expect(drag.dataTransfer.effectAllowed).toBe('move')
    expect(drag.dataTransfer.setData).toHaveBeenCalledWith('text/plain', session.id)
    expect(panel.draggedSessionId.value).toBe(session.id)
    expect(panel.canDropTo(null)).toBe(false)
    expect(panel.canDropTo(folder.id)).toBe(true)

    panel.setDropTarget(drag.event, folder.id)
    expect(drag.preventDefault).toHaveBeenCalled()
    expect(drag.dataTransfer.dropEffect).toBe('move')
    expect(panel.activeDropTarget.value).toBe(folder.id)

    await panel.dropSession(drag.event, folder.id)

    expect(moveSessionToFolder).toHaveBeenCalledTimes(1)
    expect(moveSessionToFolder).toHaveBeenCalledWith(session.id, folder.id)
    expect(panel.draggedSessionId.value).toBeNull()
    expect(panel.activeDropTarget.value).toBeNull()
    expect(panel.dragStatus.value).toBe('Moved Release planning to Roadmap.')
  })

  it('uses Recent as a drop destination for a filed conversation', async () => {
    const folder = makeFolder()
    const session = makeSession({ folderId: folder.id, retention: 'saved' })
    const moveSessionToFolder = vi.fn().mockResolvedValue({})
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn(),
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, [session], [folder])
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)
    expect(panel.canDropTo(folder.id)).toBe(false)
    expect(panel.canDropTo(null)).toBe(true)

    await panel.dropSession(drag.event, null)

    expect(moveSessionToFolder).toHaveBeenCalledWith(session.id, null)
    expect(panel.dragStatus.value).toBe('Moved Release planning to Recent.')
  })

  it('clears drag state and leaves the conversation in place when a move fails', async () => {
    const session = makeSession()
    const folder = makeFolder()
    const moveSessionToFolder = vi.fn().mockRejectedValue(new Error('Folder version changed'))
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn(),
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, [session], [folder])
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)
    panel.setDropTarget(drag.event, folder.id)
    await panel.dropSession(drag.event, folder.id)

    expect(session.folderId).toBeNull()
    expect(panel.draggedSessionId.value).toBeNull()
    expect(panel.activeDropTarget.value).toBeNull()
    expect(panel.localError.value).toBe('Folder version changed')
    expect(panel.dragStatus.value).toBe('Release planning could not be moved. It remains in Recent.')
  })

  it('announces cancellation when pointer dragging ends outside a target', () => {
    const session = makeSession()
    const folder = makeFolder()
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents, true, [session], [folder])
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)
    expect(panel.draggedSessionId.value).toBe(session.id)
    panel.finishSessionDrag()

    expect(panel.draggedSessionId.value).toBeNull()
    expect(panel.activeDropTarget.value).toBeNull()
    expect(panel.dragStatus.value).toBe('Conversation move cancelled.')
  })

  it('blocks rename and folder-move controls while the shared session mutation lock is held', async () => {
    const session = makeSession()
    const folder = makeFolder()
    const renameSession = vi.fn().mockResolvedValue({})
    const moveSessionToFolder = vi.fn().mockResolvedValue({})
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn(),
      renameSession,
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, [session], [folder])
    panel.sessionMutationBusy.value = true
    panel.beginRenameSession(session, null)
    expect(panel.sessionEditorOpen.value).toBe(false)

    panel.sessionMutationBusy.value = false
    panel.beginRenameSession(session, null)
    panel.sessionRenameTitle.value = 'Renamed after retention'
    panel.sessionMutationBusy.value = true
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)
    await Promise.all([panel.saveSessionTitle(), panel.moveSession(session, folder.id)])

    expect(drag.preventDefault).toHaveBeenCalledTimes(1)
    expect(panel.draggedSessionId.value).toBeNull()
    expect(renameSession).not.toHaveBeenCalled()
    expect(moveSessionToFolder).not.toHaveBeenCalled()

    panel.sessionMutationBusy.value = false
    await panel.saveSessionTitle()
    await panel.moveSession(session, folder.id)

    expect(renameSession).toHaveBeenCalledWith(session.id, 'Renamed after retention')
    expect(moveSessionToFolder).toHaveBeenCalledWith(session.id, folder.id)
  })
})
