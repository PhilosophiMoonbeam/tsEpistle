import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { StorageField, StorageModuleDefinition } from '../../../shared/storage-workspace.ts'
import { storageConfigurationKey } from '../../helpers/storage-configuration-key.ts'
import { type StorageConfigurationRow } from '../../repositories/storage-configuration.ts'
import { createUtilityContentImport } from '../../operations/utility-content-import.ts'

const requester = { user: { id: 1, authVersion: 0 } } as never
const formats = { okf: 0, legacyV1: 0, legacyWiki: 0, plain: 0, invalid: 0 }
const field = (key: string, type: StorageField['type'], defaultValue: StorageField['default'], sensitive = false): StorageField => ({
  key,
  title: key,
  hint: '',
  type,
  sensitive,
  multiline: sensitive,
  order: 1,
  default: defaultValue,
  options: []
})
const disk: StorageModuleDefinition = {
  key: 'disk',
  title: 'Disk',
  description: '',
  isAvailable: true,
  modes: ['push'],
  defaultMode: 'push',
  schedule: false,
  internalSchedule: false,
  fields: [field('path', 'string', ''), field('createDailyBackups', 'boolean', false)],
  actions: [{ handler: 'importAll', title: 'Import', effect: '', confirmation: 'IMPORT CONTENT', direction: 'inbound' }]
}
const git: StorageModuleDefinition = {
  key: 'git',
  title: 'Git',
  description: '',
  isAvailable: true,
  modes: ['sync', 'push'],
  defaultMode: 'sync',
  schedule: 'PT5M',
  internalSchedule: false,
  fields: [
    field('authType', 'string', 'ssh'),
    field('repoUrl', 'string', ''),
    field('branch', 'string', 'main'),
    field('sshPrivateKeyMode', 'string', 'contents'),
    field('sshPrivateKeyPath', 'string', ''),
    field('sshPrivateKeyContent', 'string', '', true),
    field('verifySSL', 'boolean', true),
    field('basicUsername', 'string', ''),
    field('basicPassword', 'string', '', true),
    field('defaultEmail', 'string', 'wiki@example.test'),
    field('defaultName', 'string', 'Wiki'),
    field('localRepoPath', 'string', '/tmp/git')
  ],
  actions: [{ handler: 'importAll', title: 'Import', effect: '', confirmation: 'IMPORT CONTENT', direction: 'inbound' }]
}
type State = { rows: StorageConfigurationRow[]; definitions: StorageModuleDefinition[]; metadata: Record<string, unknown>; fingerprint: string }
type SavedTarget = {
  key: string
  isEnabled: boolean
  mode: string
  syncInterval: string
  config: Record<string, unknown>
  secrets: Record<string, { action: string; value?: string }>
}
const fixture = () => {
  const state: State = {
    rows: [
      {
        key: 'disk',
        isEnabled: false,
        mode: 'push',
        syncInterval: 'P0D',
        config: { path: '/old', createDailyBackups: true, opaque: 'keep-disk' },
        state: { status: 'error' }
      },
      {
        key: 'git',
        isEnabled: true,
        mode: 'sync',
        syncInterval: 'P0D',
        config: {
          authType: 'ssh',
          repoUrl: 'https://old.example.test/repo.git',
          branch: 'main',
          sshPrivateKeyMode: 'contents',
          sshPrivateKeyPath: '',
          sshPrivateKeyContent: 'unselected-key',
          verifySSL: true,
          basicUsername: '',
          basicPassword: 'unselected-password',
          defaultEmail: 'old@example.test',
          defaultName: 'Old',
          localRepoPath: '/old/git',
          opaque: 'keep-git'
        },
        state: { status: 'operational' }
      }
    ],
    definitions: [disk, git],
    metadata: { revision: 'revision-1' },
    fingerprint: 'f'.repeat(64)
  }
  const changes = { afterSave: () => undefined }
  const saved = vi.fn(async (_user: unknown, input: { targets: SavedTarget[] }) => {
    for (const target of input.targets) {
      const row = state.rows.find(row => row.key === target.key)!,
        definition = state.definitions.find(definition => definition.key === target.key)!
      row.isEnabled = target.isEnabled
      row.mode = target.mode
      row.syncInterval = target.syncInterval
      for (const publicField of definition.fields.filter(field => !field.sensitive)) row.config[publicField.key] = target.config[publicField.key]
      for (const [key, action] of Object.entries(target.secrets)) {
        if (action.action === 'replace') row.config[key] = action.value!
        if (action.action === 'clear') row.config[key] = ''
      }
    }
    state.metadata.revision = 'revision-2'
    changes.afterSave()
    return { revision: 'revision-2', changedTargets: ['disk'] }
  })
  const executeAction = vi.fn(async () => ({
    targetKey: 'disk',
    handler: 'importAll',
    outcome: 'succeeded',
    total: 1,
    succeeded: 1,
    failed: 0,
    formats: { ...formats, okf: 1 },
    items: [{ kind: 'page', outcome: 'succeeded', format: 'okf', path: 'guide.md', message: null, diagnostics: [] }]
  }))
  const activated = { active: true, paused: false }
  const runtime = {
    performAdministrativeOperation: async (before: () => Promise<unknown>, after: (targets: unknown[]) => Promise<unknown>) => {
      await before()
      return after(
        state.rows.map(row => ({
          key: row.key,
          configurationKey: storageConfigurationKey(row),
          active: row.key === 'disk' ? activated.active : true,
          paused: row.key === 'disk' ? activated.paused : false
        }))
      )
    },
    executeAction
  }
  const run = createUtilityContentImport({
    store: () => ({ configuration: { save: saved } }) as never,
    executor: () => runtime as never,
    readState: async () => structuredClone(state) as never
  })
  return { state, saved, executeAction, activated, run, runtime, changes }
}

describe('reviewed legacy content import', () => {
  let subject = fixture()
  beforeEach(() => {
    subject = fixture()
  })

  it('changes only the selected disk source and leaves unselected Git values and secrets untouched', async () => {
    const before = structuredClone(subject.state.rows.find(row => row.key === 'git')!)
    await subject.run(requester, { mode: 'disk', path: '/migration-source' }, 'Import the approved migration folder', async () => undefined)
    expect(subject.state.rows.find(row => row.key === 'git')).toEqual(before)
    const gitDraft = subject.saved.mock.calls[0]![1].targets.find((target: SavedTarget) => target.key === 'git')!
    expect(gitDraft.secrets).toEqual({ sshPrivateKeyContent: { action: 'keep' }, basicPassword: { action: 'keep' } })
    expect(subject.executeAction).toHaveBeenCalledWith('disk', 'importAll')
  })

  it('imports from an unchanged selected source without trying to republish storage configuration', async () => {
    const diskRow = subject.state.rows.find(row => row.key === 'disk')!
    diskRow.isEnabled = true
    diskRow.config.path = '/migration-source'
    await subject.run(requester, { mode: 'disk', path: '/migration-source' }, 'Import the approved migration folder', async () => undefined)
    expect(subject.saved).not.toHaveBeenCalled()
    expect(subject.executeAction).toHaveBeenCalledWith('disk', 'importAll')
  })

  it('permits its reviewed storage publication while phase fences still reject unrelated changes', async () => {
    const revisions = { storageAdministration: 'storage-1', unrelated: 'utilities-1' }
    let firstGuard = true
    const guard = vi.fn(async () => {
      if (revisions.unrelated !== 'utilities-1' || (firstGuard && revisions.storageAdministration !== 'storage-1')) {
        const error = Error('Utilities review changed.')
        Object.assign(error, { status: 409 })
        throw error
      }
      firstGuard = false
    })
    subject.changes.afterSave = () => {
      revisions.storageAdministration = 'storage-2'
    }
    await subject.run(requester, { mode: 'disk', path: '/migration-source' }, 'Import the approved migration folder', guard)
    expect(guard).toHaveBeenCalledTimes(3)
    revisions.storageAdministration = 'storage-1'
    revisions.unrelated = 'utilities-1'
    expect(subject.executeAction).toHaveBeenCalledWith('disk', 'importAll')

    subject = fixture()
    firstGuard = true
    subject.changes.afterSave = () => {
      revisions.storageAdministration = 'storage-2'
      revisions.unrelated = 'utilities-2'
    }
    await expect(subject.run(requester, { mode: 'disk', path: '/migration-source' }, 'Import the approved migration folder', guard)).rejects.toMatchObject({
      status: 409
    })
    expect(subject.executeAction).not.toHaveBeenCalled()
  })

  it('refuses import when current activation does not expose the exact selected target', async () => {
    subject.activated.active = false
    const result = await subject.run(requester, { mode: 'disk', path: '/migration-source' }, 'Import the approved migration folder', async () => undefined)
    expect(result).toMatchObject({ outcome: 'failed', counts: null })
    expect(subject.executeAction).not.toHaveBeenCalled()
  })

  it('refuses import when storage changes after its approved source was saved', async () => {
    subject.runtime.performAdministrativeOperation = async (before: () => Promise<unknown>, after: (targets: unknown[]) => Promise<unknown>) => {
      await before()
      subject.state.metadata.revision = 'concurrent-storage-change'
      return after(subject.state.rows.map(row => ({ key: row.key, configurationKey: storageConfigurationKey(row), active: true, paused: false })))
    }
    await expect(
      subject.run(requester, { mode: 'disk', path: '/migration-source' }, 'Import the approved migration folder', async () => undefined)
    ).rejects.toMatchObject({ status: 409 })
    expect(subject.executeAction).not.toHaveBeenCalled()
  })

  it('returns failed and partial storage outcomes with their true item counts', async () => {
    for (const [outcome, total, succeeded, failed] of [
      ['failed', 2, 0, 2],
      ['partial', 2, 1, 1]
    ] as const) {
      subject = fixture()
      subject.executeAction.mockResolvedValueOnce({
        targetKey: 'disk',
        handler: 'importAll',
        outcome,
        total,
        succeeded,
        failed,
        formats: { ...formats, okf: succeeded, invalid: failed },
        items: [
          {
            kind: 'page',
            outcome: succeeded ? 'succeeded' : 'failed',
            format: succeeded ? 'okf' : 'invalid',
            path: 'guide.md',
            message: 'Rejected document',
            diagnostics: []
          },
          { kind: 'page', outcome: 'failed', format: 'invalid', path: 'bad.md', message: 'Rejected document', diagnostics: [] }
        ]
      })
      const result = await subject.run(requester, { mode: 'disk', path: '/migration-source' }, 'Import the approved migration folder', async () => undefined)
      expect(result).toMatchObject({ outcome, counts: { total, succeeded, failed } })
    }
  })
})
