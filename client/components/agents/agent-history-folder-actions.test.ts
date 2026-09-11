import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { AgentConversationFolderView } from '../../../shared/agents/contracts.ts'
import type { AgentSessionSummary } from '../../helpers/agents-api.ts'

interface Ref<T> {
  value: T
}

interface ActionsHarness {
  availableFolders: Ref<AgentConversationFolderView[]>
  canMove: Ref<boolean>
}

interface DragHarness {
  canDragSession: (session: AgentSessionSummary) => boolean
  hasRenderedDropDestination: (session: AgentSessionSummary) => boolean
}

const actionsPath = join(process.cwd(), 'client/components/agents/agent-history-session-actions.vue')
const actionsScript = readFileSync(actionsPath, 'utf8').match(/<script setup lang=["']ts["']>([\s\S]*?)<\/script>/)?.[1] ?? ''
const executableActionsScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(actionsScript.replace(/^import .*$/gm, ''))

const panelPath = join(process.cwd(), 'client/components/agents/agent-history-panel.vue')
const panelScript = readFileSync(panelPath, 'utf8').match(/<script setup lang=["']ts["']>([\s\S]*?)<\/script>/)?.[1] ?? ''
const dragHelpersScript = panelScript.match(/const hasRenderedDropDestination[\s\S]*?(?=const dropTargetKey)/)?.[0] ?? ''
const executableDragHelpersScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(dragHelpersScript)

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

const makeFolder = (id = '10000000-0000-4000-8000-000000000001', name = 'Roadmap'): AgentConversationFolderView => ({
  id,
  name,
  version: 1,
  createdAt: '2026-08-31T10:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z'
})

const loadActions = (session: AgentSessionSummary, folders: AgentConversationFolderView[]): ActionsHarness => {
  const evaluate = new Function(
    'computed',
    'ref',
    'useTemplateRef',
    'defineProps',
    'defineEmits',
    `${executableActionsScript}\nreturn { availableFolders, canMove }`
  ) as (...dependencies: unknown[]) => ActionsHarness
  return evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    <T>(value: T): Ref<T> => ({ value }),
    <T>(_key: string): Ref<T | null> => ({ value: null }),
    () => ({ session, folders, busy: false }),
    () => () => undefined
  )
}

const loadDragHelpers = (visibleFolderIds: readonly string[], busySessionIds: readonly string[] = [], mutationBusy = false, search = ''): DragHarness => {
  const evaluate = new Function(
    'visibleFolderGroups',
    'sessionBusy',
    'sessionMutationBusy',
    'normalizedSearch',
    `${executableDragHelpersScript}\nreturn { hasRenderedDropDestination, canDragSession }`
  ) as (...dependencies: unknown[]) => DragHarness
  return evaluate(
    { value: visibleFolderIds.map(id => ({ folder: { id } })) },
    (sessionId: string) => busySessionIds.includes(sessionId),
    { value: mutationBusy },
    { value: search }
  )
}

describe('Agent history folder actions', () => {
  it('offers New folder in Move even when no saved folder exists', () => {
    const actions = loadActions(makeSession(), [])

    expect(actions.availableFolders.value).toEqual([])
    expect(actions.canMove.value).toBe(true)
  })

  it('keeps the current folder out of destinations while retaining Recent and New folder', () => {
    const current = makeFolder()
    const other = makeFolder('10000000-0000-4000-8000-000000000002', 'Launch notes')
    const actions = loadActions(makeSession({ folderId: current.id, retention: 'saved' }), [current, other])

    expect(actions.canMove.value).toBe(true)
    expect(actions.availableFolders.value).toEqual([other])
  })

  it('enables dragging to the zero-folder empty destination without enabling filtered empties', () => {
    const recentSession = makeSession()
    const folder = makeFolder()

    expect(loadDragHelpers([]).hasRenderedDropDestination(recentSession)).toBe(true)
    expect(loadDragHelpers([]).canDragSession(recentSession)).toBe(true)
    expect(loadDragHelpers([], [], false, 'filtered').hasRenderedDropDestination(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id]).canDragSession(recentSession)).toBe(true)
    expect(loadDragHelpers([folder.id], [recentSession.id]).canDragSession(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id], [], true).canDragSession(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id]).canDragSession(makeSession({ folderId: folder.id, retention: 'saved' }))).toBe(true)
  })
})
