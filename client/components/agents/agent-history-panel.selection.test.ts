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
}

type PanelEmit = (event: 'close' | 'reset') => void

interface PanelHarness {
  activeDropTarget: Ref<string | null>
  beginSessionDrag: (event: DragEvent, session: AgentSessionSummary) => void
  canDropTo: (folderId: string | null) => boolean
  closeHistory: () => void
  dragStatus: Ref<string>
  draggedSessionId: Ref<string | null>
  dropSession: (event: DragEvent, folderId: string | null) => Promise<void>
  emit: PanelEmit
  finishSessionDrag: () => void
  localError: Ref<string>
  moveSession: (session: AgentSessionSummary, folderId: string | null) => Promise<boolean>
  openSession: (sessionId: string) => Promise<void>
  setDropTarget: (event: DragEvent, folderId: string | null) => void
  unmount: () => void
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
  folderFixtures: AgentConversationFolderView[] = []
): PanelHarness => {
  const emit = vi.fn()
  const unmountCallbacks: Array<() => void> = []
  const ref = <T>(value: T): Ref<T> => ({ value })
  const useTemplateRef = <T>(_name: string): Ref<T | null> => ref<T | null>(null)
  class HarnessElement {}
  const thread = ref({ session: { id: '00000000-0000-4000-8000-000000000001' } })
  const evaluate = new Function(
    'computed',
    'nextTick',
    'onBeforeUnmount',
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
      beginSessionDrag,
      canDropTo,
      closeHistory,
      dragStatus,
      draggedSessionId,
      dropSession,
      finishSessionDrag,
      localError,
      moveSession,
      openSession,
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
    ref,
    ref,
    useTemplateRef,
    (_source: unknown, callback: () => void, options?: { immediate?: boolean }) => {
      if (options?.immediate) callback()
    },
    () => ({
      folders: ref(folderFixtures),
      loading: ref(false),
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

  it('only closes after the latest selection is committed', async () => {
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
    const second = panel.openSession('00000000-0000-4000-8000-000000000003')
    resolveFirst(false)
    await first
    expect(panel.emit).not.toHaveBeenCalled()
    resolveSecond(true)
    await second

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
})
