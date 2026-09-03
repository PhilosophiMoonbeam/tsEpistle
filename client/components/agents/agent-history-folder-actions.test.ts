import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from '@vue/compiler-sfc'
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
const actionsSource = readFileSync(actionsPath, 'utf8')
const actionsComponent = parse(actionsSource, { filename: actionsPath })
const actionsTemplate = actionsComponent.descriptor.template?.content ?? ''
const actionsScript = actionsComponent.descriptor.scriptSetup?.content ?? ''
const executableActionsScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(actionsScript.replace(/^import .*$/gm, ''))

const panelPath = join(process.cwd(), 'client/components/agents/agent-history-panel.vue')
const panelSource = readFileSync(panelPath, 'utf8')
const panelComponent = parse(panelSource, { filename: panelPath })
const panelTemplate = panelComponent.descriptor.template?.content ?? ''
const panelScript = panelComponent.descriptor.scriptSetup?.content ?? ''
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
  const evaluate = new Function('computed', 'ref', 'defineProps', 'defineEmits', `${executableActionsScript}\nreturn { availableFolders, canMove }`) as (
    ...dependencies: unknown[]
  ) => ActionsHarness
  return evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    <T>(value: T): Ref<T> => ({ value }),
    () => ({ session, folders, busy: false }),
    () => () => undefined
  )
}

const loadDragHelpers = (visibleFolderIds: readonly string[], busySessionIds: readonly string[] = [], mutationBusy = false): DragHarness => {
  const evaluate = new Function(
    'visibleFolderGroups',
    'sessionBusy',
    'sessionMutationBusy',
    `${executableDragHelpersScript}\nreturn { hasRenderedDropDestination, canDragSession }`
  ) as (...dependencies: unknown[]) => DragHarness
  return evaluate({ value: visibleFolderIds.map(id => ({ folder: { id } })) }, (sessionId: string) => busySessionIds.includes(sessionId), {
    value: mutationBusy
  })
}

describe('Agent history folder actions', () => {
  it('shows no move destination when an unfiled conversation has no folders', () => {
    const actions = loadActions(makeSession(), [])

    expect(actions.availableFolders.value).toEqual([])
    expect(actions.canMove.value).toBe(false)
    expect(actionsTemplate).toContain('<v-menu v-if="canMove" location="end" submenu>')
    expect(actionsTemplate).toContain('<v-divider v-if="canMove"')
    expect(actionsTemplate).toContain('title="Delete"')
  })

  it('offers one compact Move submenu without repeating folders at the root', () => {
    const current = makeFolder()
    const other = makeFolder('10000000-0000-4000-8000-000000000002', 'Launch notes')
    const actions = loadActions(makeSession({ folderId: current.id, retention: 'saved' }), [current, other])

    expect(actions.canMove.value).toBe(true)
    expect(actions.availableFolders.value).toEqual([other])
    expect(actionsTemplate.match(/title="Move"/g)).toHaveLength(1)
    expect(actionsTemplate.match(/v-for="folder in availableFolders"/g)).toHaveLength(1)
    expect(actionsTemplate).toContain('title="Recent"')
    expect(actionsTemplate).not.toContain('<v-list-subheader')
  })

  it('keeps Recent available when it is the only destination for a filed conversation', () => {
    const current = makeFolder()
    const actions = loadActions(makeSession({ folderId: current.id, retention: 'saved' }), [current])

    expect(actions.availableFolders.value).toEqual([])
    expect(actions.canMove.value).toBe(true)
    expect(actionsTemplate).toContain('v-if="session.folderId !== null"')
    expect(actionsTemplate).toContain('@click="emit(\'move\', null)"')
  })

  it('preserves three-dot deletion management and keyboard submenu semantics', () => {
    expect(actionsComponent.errors).toEqual([])
    expect(actionsTemplate).toContain('icon="mdi-dots-horizontal"')
    expect(actionsTemplate).toContain('submenu')
    expect(actionsTemplate).toContain('v-bind="moveMenuProps"')
    expect(actionsTemplate).toContain('@click="emit(\'move\', folder.id)"')
    expect(actionsTemplate).toContain('@click="requestRemove"')
  })

  it('enables dragging only when a non-busy conversation has a different rendered destination', () => {
    const recentSession = makeSession()
    const folder = makeFolder()

    expect(loadDragHelpers([]).hasRenderedDropDestination(recentSession)).toBe(false)
    expect(loadDragHelpers([]).canDragSession(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id]).canDragSession(recentSession)).toBe(true)
    expect(loadDragHelpers([folder.id], [recentSession.id]).canDragSession(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id], [], true).canDragSession(recentSession)).toBe(false)
    expect(loadDragHelpers([folder.id]).canDragSession(makeSession({ folderId: folder.id, retention: 'saved' }))).toBe(true)
  })

  it('keeps drag targets, valid row affordances, and accessible keyboard instructions together', () => {
    expect(panelComponent.errors).toEqual([])
    expect(panelTemplate.match(/:draggable="canDragSession\(session\)"/g)).toHaveLength(2)
    expect(panelTemplate).toContain('@drop="dropSession($event, null)"')
    expect(panelTemplate).toContain('@drop="dropSession($event, group.folder.id)"')
    expect(panelTemplate).toContain("'agent-history__drop-target--available': canDropTo(null)")
    expect(panelTemplate).toContain("'agent-history__drop-target--active': isActiveDropTarget(group.folder.id)")
    expect(panelTemplate).toContain('id="agent-history-drag-instructions"')
    expect(panelTemplate).toContain('Use its actions menu to move it with a keyboard.')
    expect(panelScript).toContain('if (!canDragSession(session))')
    expect(panelSource).toContain('.agent-history__session--dragging')
    expect(panelSource).toContain('.agent-history__drop-target--active')
  })

  it('keeps clear-history scope, retention, and folder-exemption copy truthful', () => {
    expect(panelTemplate).toContain('aria-label="Clear Recent history; saved folders are preserved"')
    expect(panelTemplate).toContain('Clear history')
    expect(panelTemplate).toContain('@click="requestClear"')
    expect(panelTemplate).toContain('Clears only Recent, unfiled conversations. Saved folders and their conversations are preserved.')
    expect(panelTemplate).toContain(':disabled="clearHistoryDisabled"')
    expect(panelTemplate).toContain('class="agent-history__clear"')
    expect(panelTemplate).toContain('color="error"')
    expect(panelTemplate).toContain('prepend-icon="mdi-delete-sweep-outline"')
    expect(panelTemplate).toContain('size="small"')
    expect(panelTemplate).toContain('variant="tonal"')
    expect(panelTemplate.indexOf('class="agent-history__new-folder"')).toBeLessThan(
      panelTemplate.indexOf('class="agent-history__clear"')
    )
    expect(panelScript).toContain("defineEmits<{ close: []; clear: [] }>()")
    expect(panelScript).not.toContain('reset')
    expect(panelTemplate).toContain('Unfiled conversations · retained for 90 days')
    expect(panelTemplate).toContain('Filed conversations do not expire')
    expect(panelTemplate).toContain('Chats in a folder are exempt from the 90-day history window.')
    expect(panelTemplate).toContain('each starts a fresh 90-day timer. No conversations are deleted.')
  })

  it('keeps Recent and Saved folders in independently scrolling regions', () => {
    expect(panelTemplate.indexOf('class="agent-history__section-heading"')).toBeLessThan(
      panelTemplate.indexOf('class="agent-history__recent-scroll"')
    )
    expect(panelTemplate.indexOf('agent-history__section-heading--folders')).toBeLessThan(
      panelTemplate.indexOf('class="agent-history__folders-scroll"')
    )
    expect(panelTemplate.indexOf('class="agent-history__pagination"')).toBeLessThan(
      panelTemplate.indexOf('class="agent-history__folders"')
    )
    expect(panelSource).toContain('.agent-history__body {\n  display: flex;')
    expect(panelSource).toContain('overflow: hidden;\n  padding: 0 var(--wiki-space-3) var(--wiki-space-4);')
    expect(panelSource).toContain('.agent-history__recent-scroll {')
    expect(panelSource).toContain('.agent-history__folders-scroll {')
    expect(panelSource).toContain('max-height: calc(')
    expect(panelSource.match(/overflow-y: auto;/g)).toHaveLength(2)
    expect(panelTemplate).toContain('v-model="searchQuery"')
    expect(panelTemplate.match(/@move="folderId => moveSession\(session, folderId\)"/g)).toHaveLength(2)
    expect(panelTemplate.match(/@rename="restoreTarget => beginRenameSession\(session, restoreTarget\)"/g)).toHaveLength(2)
    expect(panelTemplate.match(/@remove="restoreTarget => beginDeleteSession\(session, restoreTarget\)"/g)).toHaveLength(2)
    expect(panelTemplate).toContain('@click="beginRenameFolder(group.folder)"')
    expect(panelTemplate).toContain('@click="beginRemoveFolder(group.folder)"')
    expect(panelTemplate).toContain('@click="loadMoreSessions"')
  })

  it('keeps destructive history controls disabled when the shared session mutation lock is occupied', () => {
    expect(panelTemplate).toContain(':persistent="deleting || sessionMutationBusy"')
    expect(panelTemplate).toContain(':disabled="deleting || sessionMutationBusy" @click="deleteSession"')
    expect(panelTemplate).toContain(':disabled="loading || deleting || sessionMutationBusy" @click="deleteFolder"')
    expect(panelTemplate).toContain(
      'title="Remove folder" subtitle="Conversations return to Recent" :disabled="loading || refreshingHistory || sessionsReloading || savingFolder || deleting || sessionMutationBusy"'
    )
    expect(panelScript).toContain('if (loading.value || sessionMutationBusy.value) return')
    expect(panelScript).toContain('if (!session || deleting.value || savingFolder.value || sessionMutationBusy.value) return')
    expect(panelScript).toContain('if (!folder || loading.value || deleting.value || savingFolder.value || sessionMutationBusy.value) return')
  })
})
