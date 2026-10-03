import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import { agentConversationFolderNameKey, cleanAgentConversationFolderName } from '../../../shared/agents/conversation-folders.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'
import type { AgentRefreshResult } from '../../store/agents.ts'

import { translateEnglish } from '../../test/english-translate.mts'
globalThis.useTranslate = () => translateEnglish
interface Ref<T> {
  value: T
}
interface PanelAgents {
  error?: string
  openSession: (sessionId: string) => Promise<boolean>
  cancelSessionReadTransition: () => void
  reloadSessions?: () => Promise<AgentRefreshResult>
  reloadFolders?: () => Promise<AgentRefreshResult>
  createFolder?: (name: string) => Promise<unknown>
  moveSessionToFolder?: (sessionId: string, folderId: string | null) => Promise<unknown>
  renameSession?: (sessionId: string, title: string) => Promise<unknown>
  removeSession?: (sessionId: string) => Promise<boolean>
  deleteFolder?: (folderId: string, expectedVersion: number) => Promise<boolean>
}

interface PanelHarness {
  activeDropTarget: Ref<string | null>
  beginCreateFolderForSession: (session: AgentSessionSummary, restoreTarget: HTMLElement | null) => void
  beginRenameFolder: (folder: AgentConversationFolderView) => void
  beginRenameSession: (session: AgentSessionSummary, restoreTarget: HTMLElement | null) => void
  beginDeleteSession: (session: AgentSessionSummary, restoreTarget: HTMLElement | null) => void
  beginRemoveFolder: (folder: AgentConversationFolderView) => void
  beginSessionDrag: (event: DragEvent, session: AgentSessionSummary) => void
  canDropTo: (folderId: string | null) => boolean
  clearHistoryDisabled: Ref<boolean>
  closeHistory: () => void
  dialogError: Ref<string>
  displaySessions: Ref<readonly AgentSessionSummary[]>
  dragStatus: Ref<string>
  draggedSessionId: Ref<string | null>
  dropSession: (event: DragEvent, folderId: string | null) => Promise<void>
  deleteFolder: () => Promise<void>
  deleteSession: () => Promise<void>
  deletingSession: Ref<AgentSessionSummary | null>
  emit: PanelEmit
  finishSessionDrag: () => void
  folderEditorOpen: Ref<boolean>
  folderEditorRestoreTarget: Ref<HTMLElement | null>
  folderName: Ref<string>
  folderWorkflowState: Ref<string>
  foldersRefreshError: Ref<string>
  initialRefreshPending: Ref<boolean>
  folders: Ref<AgentConversationFolderView[]>
  loading: Ref<boolean>
  localError: Ref<string>
  moveSession: (session: AgentSessionSummary, folderId: string | null) => Promise<boolean>
  openFolderIds: Ref<string[]>
  ownerContext: Ref<{ ownerId: number | null; ownerGeneration: number; workspaceVersion: number }>
  refreshFolders: () => Promise<boolean>
  refreshHistory: () => Promise<boolean>
  refreshSessions: () => Promise<boolean>
  refreshingHistory: Ref<boolean>
  sessionMutationBusy: Ref<boolean>
  saveFolder: () => Promise<void>
  saveSessionTitle: () => Promise<void>
  searchQuery: Ref<string | null>
  sessions: Ref<AgentSessionSummary[]>
  sessionsNextCursor: Ref<string | null>
  showLoadedHistorySearchScope: Ref<boolean>
  sessionEditorOpen: Ref<boolean>
  sessionRenameTitle: Ref<string>
  removingFolder: Ref<AgentConversationFolderView | null>
  requestClear: () => void
  openSession: (sessionId: string) => Promise<void>
  sessionsRefreshError: Ref<string>
  setDropTarget: (event: DragEvent, folderId: string | null) => void
  thread: Ref<{ session: { id: string } }>
  updateOpenFolderIds: (ids: string[]) => void
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
interface FocusControls {
  searchRoot?: HarnessElement
  close?: HarnessElement
  folderActivator?: HarnessElement
  activeElement?: HarnessElement
  mount?: boolean
  initialLoading?: boolean
  initialMutationBusy?: boolean
}

const loadPanel = (
  agents: PanelAgents,
  compact = true,
  sessionFixtures: AgentSessionSummary[] = [],
  folderFixtures: AgentConversationFolderView[] = [],
  focusControls: FocusControls = {}
): PanelHarness => {
  const emit = vi.fn()
  const unmountCallbacks: Array<() => void> = []
  let currentCleanupRegistrar: ((cleanup: WatchCleanup) => void) | null = null
  let collectingDependencies: Set<ReactiveRef<unknown>> | null = null
  const onWatcherCleanup = (cleanup: WatchCleanup): void => {
    currentCleanupRegistrar?.(cleanup)
  }
  const ref = <T>(initialValue: T): ReactiveRef<T> => {
    let value = initialValue
    const watchers: Array<{ callback: WatchCallback; cleanup?: WatchCleanup }> = []
    return {
      get value() {
        collectingDependencies?.add(this as ReactiveRef<unknown>)
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
  const folders = ref(folderFixtures)
  const loading = ref(focusControls.initialLoading ?? false)
  const sessionMutationBusy = ref(focusControls.initialMutationBusy ?? false)
  const sessions = ref(sessionFixtures)
  const sessionsLoadMoreError = ref('')
  const sessionsLoadingMore = ref(false)
  const sessionsNextCursor = ref<string | null>(null)
  const sessionsReloading = ref(false)
  const thread = ref({ session: { id: '00000000-0000-4000-8000-000000000001' } })
  const ownerContext = ref({ ownerId: 1 as number | null, ownerGeneration: 0, workspaceVersion: 0 })
  const store = {
    reloadSessions: vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult),
    reloadFolders: vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult),
    ...agents
  }
  Object.defineProperties(store, {
    pinOwnerId: { get: () => ownerContext.value.ownerId },
    ownerGeneration: { get: () => ownerContext.value.ownerGeneration },
    workspaceVersion: { get: () => ownerContext.value.workspaceVersion }
  })
  const evaluate = new Function(
    'computed',
    'nextTick',
    'onBeforeUnmount',
    'onMounted',
    'onWatcherCleanup',
    'ref',
    'shallowRef',
    'useTemplateRef',
    'watch',
    'storeToRefs',
    'defineProps',
    'defineEmits',
    'useAgentsStore',
    'agentConversationFolderNameKey',
    'cleanAgentConversationFolderName',
    'createModalFocusScope',
    'window',
    'document',
    'HTMLElement',
    `${executableScript}\nreturn {
      activeDropTarget,
      beginCreateFolderForSession,
      beginDeleteSession,
      beginRemoveFolder,
      beginRenameFolder,
      beginSessionDrag,
      canDropTo,
      clearHistoryDisabled,
      closeHistory,
      beginRenameSession,
      dialogError,
      displaySessions,
      dragStatus,
      draggedSessionId,
      dropSession,
      finishSessionDrag,
      deleteFolder,
      deleteSession,
      deletingSession,
      folderEditorOpen,
      folderEditorRestoreTarget,
      folderName,
      folderWorkflowState,
      foldersRefreshError,
      initialRefreshPending,
      loading,
      localError,
      moveSession,
      openFolderIds,
      openSession,
      refreshFolders,
      refreshHistory,
      refreshSessions,
      refreshingHistory,
      saveFolder,
      sessionMutationBusy,
      saveSessionTitle,
      searchQuery,
      sessions,
      sessionsNextCursor,
      showLoadedHistorySearchScope,
      sessionEditorOpen,
      sessionRenameTitle,
      removingFolder,
      requestClear,
      sessionsRefreshError,
      setDropTarget,
      updateOpenFolderIds
    }`
  ) as (...dependencies: unknown[]) => Omit<PanelHarness, 'emit' | 'unmount' | 'folders' | 'ownerContext' | 'thread'>
  const panel = evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    () => Promise.resolve(),
    (callback: () => void) => unmountCallbacks.push(callback),
    (callback: () => void) => {
      if (focusControls.mount) callback()
    },
    onWatcherCleanup,
    ref,
    ref,
    useTemplateRef,
    (source: unknown, callback: WatchCallback, options?: { immediate?: boolean }) => {
      const isArraySource = Array.isArray(source)
      const sources = isArraySource ? source : [source]
      const readSource = (candidate: unknown): unknown =>
        typeof candidate === 'function' ? (candidate as () => unknown)() : (candidate as Ref<unknown>)?.value
      const readValue = (): unknown => (isArraySource ? sources.map(readSource) : readSource(sources[0]))
      const dependencies = new Set<ReactiveRef<unknown>>()
      collectingDependencies = dependencies
      let previous = readValue()
      collectingDependencies = null
      const notify = (): void => {
        const value = readValue()
        const changed = isArraySource
          ? (value as unknown[]).some((item, index) => !Object.is(item, (previous as unknown[])[index]))
          : !Object.is(value, previous)
        if (!changed) return
        const oldValue = previous
        previous = value
        callback(value, oldValue, () => {})
      }
      for (const dependency of dependencies) dependency.subscribe(notify)
      if (options?.immediate) callback(previous, undefined, () => {})
    },
    () => ({
      folders,
      loading,
      sessionMutationBusy,
      sessions,
      sessionsLoadMoreError,
      sessionsLoadingMore,
      sessionsNextCursor,
      sessionsReloading,
      thread
    }),
    () => ({
      headingId: 'agent-history-title',
      descriptionId: 'agent-history-description'
    }),
    () => emit,
    () => store,
    agentConversationFolderNameKey,
    cleanAgentConversationFolderName,
    vi.fn(),
    { matchMedia: () => ({ matches: compact }) },
    {
      activeElement: focusControls.activeElement ?? null,
      querySelector: (selector: string) =>
        selector === '.agent-history__folder-actions[aria-expanded="true"]' ? (focusControls.folderActivator ?? null) : null
    },
    HarnessElement
  )
  return {
    ...panel,
    emit,
    folders,
    ownerContext,
    thread,
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

  it('reveals search matches and restores the prior compact folder layout after clearing', () => {
    const roadmap = makeFolder()
    const release = makeFolder({ id: 'release', name: 'Release archive' })
    const support = makeFolder({ id: 'support', name: 'Support archive' })
    const panel = loadPanel(
      {
        openSession: vi.fn().mockResolvedValue(false),
        cancelSessionReadTransition: vi.fn()
      },
      true,
      [makeSession({ folderId: release.id })],
      [roadmap, release, support]
    )
    panel.updateOpenFolderIds([roadmap.id])

    panel.searchQuery.value = 'Release'
    expect(panel.openFolderIds.value).toEqual([roadmap.id, release.id])
    panel.searchQuery.value = 'Support'
    expect(panel.openFolderIds.value).toContain(support.id)
    panel.searchQuery.value = null
    expect(panel.openFolderIds.value).toEqual([roadmap.id])

    panel.searchQuery.value = 'Release'
    panel.searchQuery.value = '   '
    expect(panel.openFolderIds.value).toEqual([roadmap.id])
  })

  it('preserves manual folder choices across search refinements and clearing', () => {
    const active = makeFolder({ name: 'Roadmap archive' })
    const release = makeFolder({ id: 'release', name: 'Release archive' })
    const panel = loadPanel(
      {
        openSession: vi.fn().mockResolvedValue(false),
        cancelSessionReadTransition: vi.fn()
      },
      true,
      [makeSession({ id: '00000000-0000-4000-8000-000000000001', folderId: active.id })],
      [active, release]
    )
    panel.searchQuery.value = 'archive'
    panel.updateOpenFolderIds([release.id])
    panel.updateOpenFolderIds([])
    panel.updateOpenFolderIds([release.id])
    panel.searchQuery.value = 'Release'
    panel.searchQuery.value = ''
    expect(panel.openFolderIds.value).toEqual([release.id])
    panel.searchQuery.value = 'archive'
    panel.searchQuery.value = null
    expect(panel.openFolderIds.value).toEqual([release.id])
  })

  it('does not reopen a search folder manually collapsed before refining the query', () => {
    const release = makeFolder({ name: 'Release archive' })
    const panel = loadPanel(
      {
        openSession: vi.fn().mockResolvedValue(false),
        cancelSessionReadTransition: vi.fn()
      },
      true,
      [],
      [release]
    )
    panel.searchQuery.value = 'Release'
    panel.updateOpenFolderIds([])
    panel.searchQuery.value = 'archive'
    expect(panel.openFolderIds.value).toEqual([])
    panel.searchQuery.value = ''
    expect(panel.openFolderIds.value).toEqual([])
  })

  it('drops deleted folders from the restored layout and reveals the newly active folder', () => {
    const deleted = makeFolder()
    const release = makeFolder({ id: 'release', name: 'Release archive' })
    const panel = loadPanel(
      {
        openSession: vi.fn().mockResolvedValue(false),
        cancelSessionReadTransition: vi.fn()
      },
      true,
      [makeSession({ folderId: release.id })],
      [deleted, release]
    )
    panel.updateOpenFolderIds([deleted.id])
    panel.searchQuery.value = 'Release'
    panel.folders.value = [release]
    panel.thread.value = { session: { id: makeSession().id } }
    panel.searchQuery.value = ''
    expect(panel.openFolderIds.value).toEqual([release.id])
  })

  it.each([
    { ownerId: 2, ownerGeneration: 0, workspaceVersion: 0 },
    { ownerId: 1, ownerGeneration: 1, workspaceVersion: 0 },
    { ownerId: 1, ownerGeneration: 0, workspaceVersion: 1 }
  ])('does not restore prior search expansion across an owner/workspace change: %j', context => {
    const roadmap = makeFolder()
    const release = makeFolder({ id: 'release', name: 'Release archive' })
    const panel = loadPanel(
      {
        openSession: vi.fn().mockResolvedValue(false),
        cancelSessionReadTransition: vi.fn()
      },
      true,
      [],
      [roadmap, release]
    )
    panel.updateOpenFolderIds([roadmap.id])
    panel.searchQuery.value = 'Release'
    panel.ownerContext.value = context
    panel.searchQuery.value = ''
    expect(panel.openFolderIds.value).toEqual([])
  })

  it('offers older-history search guidance only while searching with an unexhausted cursor', () => {
    const panel = loadPanel({
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn()
    })
    panel.sessionsNextCursor.value = 'next-page'
    expect(panel.showLoadedHistorySearchScope.value).toBe(false)
    panel.searchQuery.value = 'Release'
    expect(panel.showLoadedHistorySearchScope.value).toBe(true)
    panel.sessionsNextCursor.value = null
    expect(panel.showLoadedHistorySearchScope.value).toBe(false)
  })

  it('does nothing when choosing the displayed session', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(true),
      cancelSessionReadTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000001')

    expect(agents.cancelSessionReadTransition).not.toHaveBeenCalled()
    expect(agents.openSession).not.toHaveBeenCalled()
    expect(panel.emit).not.toHaveBeenCalled()
  })
  it('keeps the panel open with an error when the newest transition fails', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockRejectedValue(new Error('Session unavailable')),
      cancelSessionReadTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000002')

    expect(panel.emit).not.toHaveBeenCalled()
    expect(panel.localError.value).toBe('Session unavailable')
  })

  it('cancels only its pending read before closing the history workspace', async () => {
    let resolveOpen!: (value: boolean) => void
    const agents: PanelAgents = {
      openSession: vi.fn().mockImplementation(
        () =>
          new Promise<boolean>(resolve => {
            resolveOpen = resolve
          })
      ),
      cancelSessionReadTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    const opening = panel.openSession('00000000-0000-4000-8000-000000000002')
    panel.closeHistory()

    expect(agents.cancelSessionReadTransition).toHaveBeenCalledTimes(1)
    expect(panel.emit).toHaveBeenCalledWith('close')

    resolveOpen(false)
    await opening
  })

  it('serializes reads and leaves closing to the parent after a later selection commits', async () => {
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
      cancelSessionReadTransition: vi.fn()
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

    expect(panel.emit).not.toHaveBeenCalled()
  })

  it('cancels a pending read when its parent removes the workspace', async () => {
    let resolveOpen!: (value: boolean) => void
    const agents: PanelAgents = {
      openSession: vi.fn().mockImplementation(
        () =>
          new Promise<boolean>(resolve => {
            resolveOpen = resolve
          })
      ),
      cancelSessionReadTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    const opening = panel.openSession('00000000-0000-4000-8000-000000000002')
    panel.unmount()

    expect(agents.cancelSessionReadTransition).toHaveBeenCalledTimes(1)
    resolveOpen(false)
    await opening
  })
  it('clears only when at least one unfiled conversation is available', () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn()
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
    const deleteFolder = vi.fn().mockResolvedValue(true)
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
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
  it('reconciles a lost create response by canonical folder name without a duplicate create or wrong-folder move', async () => {
    const source = makeSession()
    const committedFolder = makeFolder({
      id: '10000000-0000-4000-8000-000000000002',
      name: 'Release archive'
    })
    const distinctFolder = makeFolder({
      id: '10000000-0000-4000-8000-000000000003',
      name: 'Release archives'
    })
    const sessions = [source]
    const folders: AgentConversationFolderView[] = []
    const createFolder = vi.fn().mockRejectedValue(new TypeError('The create response was lost'))
    const reloadFolders = vi.fn().mockImplementation(async () => {
      folders.splice(0, folders.length, committedFolder, distinctFolder)
      return { accepted: true, current: true } satisfies AgentRefreshResult
    })
    const moveSessionToFolder = vi.fn().mockImplementation(async (_sessionId: string, folderId: string | null) => {
      source.folderId = folderId
      source.retention = folderId ? 'saved' : 'temporary'
      return source
    })
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      createFolder,
      reloadFolders,
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, sessions, folders)

    panel.beginCreateFolderForSession(source, null)
    panel.folderName.value = '  Ｒｅｌｅａｓｅ\u00a0  \t archive  '
    await panel.saveFolder()

    expect(createFolder).toHaveBeenCalledTimes(1)
    expect(moveSessionToFolder).toHaveBeenCalledTimes(1)
    expect(moveSessionToFolder).toHaveBeenCalledWith(source.id, committedFolder.id)
    expect(panel.openFolderIds.value).toEqual([committedFolder.id])
    expect(panel.folderEditorOpen.value).toBe(false)
    expect(panel.folderWorkflowState.value).toBe('idle')
  })

  it('does not adopt a canonically different folder after a lost create response', async () => {
    const source = makeSession()
    const distinctFolder = makeFolder({
      id: '10000000-0000-4000-8000-000000000003',
      name: 'Release archives'
    })
    const sessions = [source]
    const folders: AgentConversationFolderView[] = []
    const createFolder = vi.fn().mockRejectedValue(new TypeError('The create response was lost'))
    const reloadFolders = vi.fn().mockImplementation(async () => {
      folders.splice(0, folders.length, distinctFolder)
      return { accepted: true, current: true } satisfies AgentRefreshResult
    })
    const moveSessionToFolder = vi.fn()
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      createFolder,
      reloadFolders,
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, sessions, folders)

    panel.beginCreateFolderForSession(source, null)
    panel.folderName.value = '  Ｒｅｌｅａｓｅ\u00a0  \t archive  '
    await panel.saveFolder()

    expect(createFolder).toHaveBeenCalledTimes(1)
    expect(moveSessionToFolder).not.toHaveBeenCalled()
    expect(source.folderId).toBeNull()
    expect(panel.folderEditorOpen.value).toBe(true)
    expect(panel.folderWorkflowState.value).toBe('creating')
  })

  it('accepts a lost create-folder move only when an authoritative refresh shows the created folder', async () => {
    const source = makeSession()
    const folder = makeFolder()
    const refreshedSource = makeSession({ folderId: folder.id, retention: 'saved', version: 2 })
    const sessions = [source]
    const activator = new HarnessElement()
    const createFolder = vi.fn().mockResolvedValue(folder)
    const moveSessionToFolder = vi.fn().mockRejectedValue(new TypeError('The move response was lost'))
    const reloadSessions = vi.fn().mockImplementation(async () => {
      sessions.splice(0, sessions.length, refreshedSource)
      return { accepted: true, current: true } satisfies AgentRefreshResult
    })
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      createFolder,
      moveSessionToFolder,
      reloadSessions
    }
    const panel = loadPanel(agents, true, sessions, [folder])

    panel.beginCreateFolderForSession(source, activator as unknown as HTMLElement)
    panel.folderName.value = folder.name
    await panel.saveFolder()
    await Promise.resolve()

    expect(createFolder).toHaveBeenCalledTimes(1)
    expect(moveSessionToFolder).toHaveBeenCalledTimes(1)
    expect(panel.folderEditorOpen.value).toBe(false)
    expect(panel.folderWorkflowState.value).toBe('idle')
    expect(panel.openFolderIds.value).toEqual([folder.id])
    expect(panel.dragStatus.value).toContain(source.title)
    expect(panel.dragStatus.value).toMatch(new RegExp(`\\b(?:to|into)\\s+${folder.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\W|$)`, 'i'))
    expect(panel.dragStatus.value).toMatch(/\b(?:moved|completed)\b/i)
    expect(panel.dragStatus.value).not.toMatch(/\b(?:moving|dragging|cancelled|canceled|failed|unable)\b|could not/i)
    expect(panel.localError.value).toBe('')
    expect(activator.focus).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      label: 'a different folder',
      refreshedSessions: (source: AgentSessionSummary): AgentSessionSummary[] => [
        makeSession({ id: source.id, folderId: '20000000-0000-4000-8000-000000000001', retention: 'saved', version: 2 })
      ]
    },
    {
      label: 'a missing conversation',
      refreshedSessions: (_source: AgentSessionSummary): AgentSessionSummary[] => []
    }
  ])('keeps create-folder move retry for $label after authoritative refresh', async ({ refreshedSessions }) => {
    const source = makeSession()
    const folder = makeFolder()
    const sessions = [source]
    const createFolder = vi.fn().mockResolvedValue(folder)
    const moveSessionToFolder = vi.fn().mockRejectedValue(new TypeError('The move response was lost'))
    const reloadSessions = vi.fn().mockImplementation(async () => {
      sessions.splice(0, sessions.length, ...refreshedSessions(source))
      return { accepted: true, current: true } satisfies AgentRefreshResult
    })
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      createFolder,
      moveSessionToFolder,
      reloadSessions
    }
    const panel = loadPanel(agents, true, sessions, [folder])

    panel.beginCreateFolderForSession(source, null)
    panel.folderName.value = folder.name
    await panel.saveFolder()

    expect(createFolder).toHaveBeenCalledTimes(1)
    expect(moveSessionToFolder).toHaveBeenCalledTimes(1)
    expect(panel.folderEditorOpen.value).toBe(true)
    expect(panel.folderWorkflowState.value).toBe('move-retry')
    expect(panel.openFolderIds.value).toEqual([])
  })

  it('keeps create-folder move retry when the authoritative refresh fails', async () => {
    const source = makeSession()
    const folder = makeFolder()
    const sessions = [source]
    const createFolder = vi.fn().mockResolvedValue(folder)
    const moveSessionToFolder = vi.fn().mockRejectedValue(new TypeError('The move response was lost'))
    const reloadSessions = vi.fn().mockRejectedValue(new Error('Conversations unavailable'))
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      createFolder,
      moveSessionToFolder,
      reloadSessions
    }
    const panel = loadPanel(agents, true, sessions, [folder])

    panel.beginCreateFolderForSession(source, null)
    panel.folderName.value = folder.name
    await panel.saveFolder()

    expect(createFolder).toHaveBeenCalledTimes(1)
    expect(moveSessionToFolder).toHaveBeenCalledTimes(1)
    expect(panel.folderEditorOpen.value).toBe(true)
    expect(panel.folderWorkflowState.value).toBe('move-retry')
    expect(panel.sessionsRefreshError.value).toContain('Conversations unavailable')
  })

  it('refreshes a stale folder delete and reopens confirmation with the renewed version', async () => {
    const folder = makeFolder()
    const renewedFolder = makeFolder({ version: 2, updatedAt: '2026-09-01T10:00:00.000Z' })
    const session = makeSession({ folderId: folder.id, retention: 'saved' })
    const folders = [folder]
    const deleteFolder = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Folder changed'), { status: 409 }))
      .mockResolvedValueOnce(true)
    const reloadFolders = vi.fn().mockImplementation(async () => {
      folders.splice(0, folders.length, renewedFolder)
      return { accepted: true, current: true } satisfies AgentRefreshResult
    })
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      deleteFolder,
      reloadFolders
    }
    const panel = loadPanel(agents, true, [session], folders)

    panel.beginRemoveFolder(folder)
    await panel.deleteFolder()

    expect(deleteFolder).toHaveBeenCalledTimes(1)
    expect(deleteFolder).toHaveBeenCalledWith(folder.id, folder.version)
    expect(panel.removingFolder.value).toEqual(renewedFolder)
    expect(panel.displaySessions.value.find(candidate => candidate.id === session.id)?.folderId).toBe(folder.id)
    expect(panel.dragStatus.value).toBe('')

    await panel.deleteFolder()

    expect(deleteFolder).toHaveBeenCalledTimes(2)
    expect(deleteFolder).toHaveBeenLastCalledWith(renewedFolder.id, renewedFolder.version)
    expect(panel.removingFolder.value).toBeNull()
  })

  it('does not announce or project a folder delete when the store reports no commit', async () => {
    const folder = makeFolder()
    const session = makeSession({ folderId: folder.id, retention: 'saved' })
    const deleteFolder = vi.fn().mockResolvedValue(false)
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      deleteFolder
    }
    const panel = loadPanel(agents, true, [session], [folder])

    panel.beginRemoveFolder(folder)
    await panel.deleteFolder()

    expect(deleteFolder).toHaveBeenCalledWith(folder.id, folder.version)
    expect(panel.removingFolder.value).toBe(folder)
    expect(panel.dragStatus.value).toBe('')
    expect(panel.displaySessions.value.find(candidate => candidate.id === session.id)?.folderId).toBe(folder.id)
  })

  it('restores focus to the conversation action trigger when rename is cancelled', async () => {
    const trigger = new HarnessElement()
    const searchRoot = new HarnessElement(false)
    const searchInput = new HarnessElement()
    searchRoot.focusTarget = searchInput
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn()
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
      cancelSessionReadTransition: vi.fn(),
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
      cancelSessionReadTransition: vi.fn()
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
      cancelSessionReadTransition: vi.fn(),
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
    expect(panel.dragStatus.value).toContain(session.title)
    expect(panel.dragStatus.value).toMatch(new RegExp(`\\b(?:to|into)\\s+${folder.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\W|$)`, 'i'))
    expect(panel.dragStatus.value).toMatch(/\b(?:moved|completed)\b/i)
    expect(panel.dragStatus.value).not.toMatch(/\b(?:moving|dragging|cancelled|canceled|failed|unable)\b|could not/i)
  })

  it('uses Recent as a drop destination for a filed conversation', async () => {
    const folder = makeFolder()
    const session = makeSession({ folderId: folder.id, retention: 'saved' })
    const moveSessionToFolder = vi.fn().mockResolvedValue({})
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, [session], [folder])
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)
    expect(panel.canDropTo(folder.id)).toBe(false)
    expect(panel.canDropTo(null)).toBe(true)

    await panel.dropSession(drag.event, null)

    expect(moveSessionToFolder).toHaveBeenCalledWith(session.id, null)
    expect(panel.dragStatus.value).toContain(session.title)
    expect(panel.dragStatus.value).toMatch(/\b(?:to|into)\s+Recent\b/i)
    expect(panel.dragStatus.value).toMatch(/\b(?:moved|completed)\b/i)
    expect(panel.dragStatus.value).not.toMatch(/\b(?:moving|dragging|cancelled|canceled|failed|unable)\b|could not/i)
  })

  it('clears drag state and leaves the conversation in place when a move fails', async () => {
    const session = makeSession()
    const folder = makeFolder()
    const moveSessionToFolder = vi.fn().mockRejectedValue(new Error('Folder version changed'))
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      moveSessionToFolder
    }
    const panel = loadPanel(agents, true, [session], [folder])
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)
    panel.setDropTarget(drag.event, folder.id)
    await panel.dropSession(drag.event, folder.id)

    expect(panel.displaySessions.value.find(candidate => candidate.id === session.id)?.folderId).toBeNull()
    expect(panel.draggedSessionId.value).toBeNull()
    expect(panel.activeDropTarget.value).toBeNull()
    expect(panel.localError.value).toBe('Folder version changed')
    expect(panel.dragStatus.value).toContain(session.title)
    expect(panel.dragStatus.value).toContain('Recent')
    expect(panel.dragStatus.value).toMatch(/could not|failed|unable/i)
  })

  it('clears pointer drag state and announces cancellation when dragging ends outside a target', () => {
    const session = makeSession()
    const folder = makeFolder()
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn()
    }
    const panel = loadPanel(agents, true, [session], [folder])
    const drag = makeDragEvent()

    panel.beginSessionDrag(drag.event, session)
    expect(panel.draggedSessionId.value).toBe(session.id)
    panel.finishSessionDrag()

    expect(panel.draggedSessionId.value).toBeNull()
    expect(panel.activeDropTarget.value).toBeNull()
    expect(panel.dragStatus.value).toMatch(/\bcancel(?:led|ed|lation)\b/i)
    expect(panel.dragStatus.value).toMatch(/\b(?:conversation|move|drag)\b/i)
  })

  it('blocks rename and folder-move controls while the shared session mutation lock is held', async () => {
    const session = makeSession()
    const folder = makeFolder()
    const renameSession = vi.fn().mockResolvedValue({})
    const moveSessionToFolder = vi.fn().mockResolvedValue({})
    const agents: PanelAgents = {
      error: '',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
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
  it('restores folder action focus to the exact activator after a rename closes', async () => {
    const folder = makeFolder()
    const activator = new HarnessElement()
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn()
    }
    const panel = loadPanel(agents, true, [], [folder], { folderActivator: activator })

    panel.beginRenameFolder(folder)
    expect(panel.folderEditorOpen.value).toBe(true)
    panel.folderEditorOpen.value = false
    await Promise.resolve()

    expect(activator.focus).toHaveBeenCalledTimes(1)
  })

  it('defers one initial archive refresh until workspace loading settles', () => {
    const reloadSessions = vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult)
    const reloadFolders = vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult)
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      reloadSessions,
      reloadFolders
    }
    const panel = loadPanel(agents, true, [], [], { mount: true, initialLoading: true })

    expect(panel.initialRefreshPending.value).toBe(true)
    expect(reloadSessions).not.toHaveBeenCalled()
    expect(reloadFolders).not.toHaveBeenCalled()

    panel.loading.value = false

    expect(reloadSessions).toHaveBeenCalledTimes(1)
    expect(reloadFolders).toHaveBeenCalledTimes(1)
    expect(panel.initialRefreshPending.value).toBe(false)

    panel.loading.value = true
    panel.loading.value = false
    expect(reloadSessions).toHaveBeenCalledTimes(1)
    expect(reloadFolders).toHaveBeenCalledTimes(1)
  })

  it('defers one initial archive refresh until the session mutation lock clears', () => {
    const reloadSessions = vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult)
    const reloadFolders = vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult)
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      reloadSessions,
      reloadFolders
    }
    const panel = loadPanel(agents, true, [], [], { mount: true, initialMutationBusy: true })

    expect(reloadSessions).not.toHaveBeenCalled()
    expect(reloadFolders).not.toHaveBeenCalled()

    panel.sessionMutationBusy.value = false

    expect(reloadSessions).toHaveBeenCalledTimes(1)
    expect(reloadFolders).toHaveBeenCalledTimes(1)
    panel.sessionMutationBusy.value = true
    panel.sessionMutationBusy.value = false
    expect(reloadSessions).toHaveBeenCalledTimes(1)
    expect(reloadFolders).toHaveBeenCalledTimes(1)
  })

  it('discards a deferred initial refresh when history unmounts first', () => {
    const reloadSessions = vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult)
    const reloadFolders = vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult)
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      reloadSessions,
      reloadFolders
    }
    const panel = loadPanel(agents, true, [], [], { mount: true, initialLoading: true })

    panel.unmount()
    panel.loading.value = false

    expect(panel.initialRefreshPending.value).toBe(false)
    expect(reloadSessions).not.toHaveBeenCalled()
    expect(reloadFolders).not.toHaveBeenCalled()
  })

  it('does not loop a failed initial refresh and preserves unrelated workspace errors', async () => {
    const reloadSessions = vi.fn().mockRejectedValue(new Error('Sessions unavailable'))
    const reloadFolders = vi.fn().mockRejectedValue(new Error('Folders unavailable'))
    const agents: PanelAgents = {
      error: 'Proposal failed',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      reloadSessions,
      reloadFolders
    }
    const panel = loadPanel(agents, true, [], [], { mount: true, initialLoading: true })

    panel.loading.value = false
    await Promise.resolve()
    await Promise.resolve()

    expect(reloadSessions).toHaveBeenCalledTimes(1)
    expect(reloadFolders).toHaveBeenCalledTimes(1)
    expect(agents.error).toBe('Proposal failed')
    expect(panel.sessionsRefreshError.value).toContain('Sessions unavailable')
    expect(panel.foldersRefreshError.value).toContain('Folders unavailable')

    panel.loading.value = true
    panel.loading.value = false
    expect(reloadSessions).toHaveBeenCalledTimes(1)
    expect(reloadFolders).toHaveBeenCalledTimes(1)
  })

  it('keeps workspace errors through an explicit archive retry', async () => {
    const reloadSessions = vi
      .fn()
      .mockResolvedValueOnce({ accepted: true, current: true } satisfies AgentRefreshResult)
      .mockRejectedValueOnce(new Error('Retry unavailable'))
    const reloadFolders = vi.fn().mockResolvedValue({ accepted: true, current: true } satisfies AgentRefreshResult)
    const agents: PanelAgents = {
      error: 'Send failed',
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionReadTransition: vi.fn(),
      reloadSessions,
      reloadFolders
    }
    const panel = loadPanel(agents, true, [], [], { mount: true, initialLoading: true })

    panel.loading.value = false
    await Promise.resolve()
    await panel.refreshSessions()

    expect(reloadSessions).toHaveBeenCalledTimes(2)
    expect(agents.error).toBe('Send failed')
    expect(panel.sessionsRefreshError.value).toContain('Retry unavailable')
  })
})
