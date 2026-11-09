import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { StorageField, StorageModuleDefinition } from '../../../shared/storage-workspace.ts'
import { storageConfigurationKey, nativeStorageMutationConfigurationKey } from '../../helpers/storage-configuration-key.ts'
import { storageModuleDefinition, storageTargetView, type StorageConfigurationRow } from '../../repositories/storage-configuration.ts'
import { createUtilityContentImport, createUtilityContentImportPreview } from '../../operations/utility-content-import.ts'
import type { StorageImportPreview, StorageImportReview, StorageImportScope, StorageGitContentEntry } from '../../../shared/utility-content-import.ts'
import { currentStorageImportReview } from '../../modules/storage/import-identity.ts'
import { createStorageConfigurationStore } from '../../operations/storage-configuration.ts'

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
  const sourceState = {
    snapshot: 'a'.repeat(64),
    pages: [{
      sourcePath: 'guide.md', sourceSha256: 'b'.repeat(64), contentType: 'markdown', locale: 'en', path: 'guide',
      format: 'plain_markdown', owned: false, existingPageId: null, expectedSourceRevision: null, diagnostics: []
    }] as StorageImportPreview['pages'],
    destinations: [] as StorageImportPreview['destinations'],
    gitContent: [] as StorageGitContentEntry[]
  }
  const preview = vi.fn(async (_source: unknown, scope: StorageImportScope): Promise<StorageImportPreview> => ({
    scope, snapshot: sourceState.snapshot, locales: ['en'],
    entries: sourceState.pages.map(page => ({ sourcePath: page.sourcePath, sourceSha256: page.sourceSha256, kind: 'file' as const })),
    pages: structuredClone(sourceState.pages), destinations: structuredClone(sourceState.destinations),
    ...(scope.targetKey === 'git' ? { gitContent: structuredClone(sourceState.gitContent) } : {})
  }))
  const executedReviews: Array<StorageImportReview | undefined> = []
  const saved = vi.fn(async (_user: unknown, input: { targets: SavedTarget[] }, managedGitContent?: string) => {
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
    if (managedGitContent !== undefined) state.rows.find(row => row.key === 'git')!.config.dotContentReview = managedGitContent
    state.metadata.revision = 'revision-2'
    changes.afterSave()
    return { revision: 'revision-2', changedTargets: ['disk'] }
  })
  const executeAction = vi.fn(async () => {
    executedReviews.push(currentStorageImportReview())
    return {
    targetKey: 'disk',
    handler: 'importAll',
    outcome: 'succeeded',
    total: 1,
    succeeded: 1,
    failed: 0,
    formats: { ...formats, okf: 1 },
    items: [{ kind: 'page', outcome: 'succeeded', format: 'okf', path: 'guide.md', message: null, diagnostics: [] }]
    }
  })
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
  const dependencies = {
    store: () => ({ configuration: { save: saved,
      saveImportReview: (user: unknown, input: { targets: SavedTarget[] }, value: string) => saved(user, input, value)
    } }) as never,
    executor: () => runtime as never,
    signingKey: () => 'fixture-review-signing-secret',
    preview,
    readState: async () => structuredClone(state) as never
  }
  const run = createUtilityContentImport(dependencies)
  const inspect = createUtilityContentImportPreview(dependencies)
  return { state, saved, executeAction, activated, run, inspect, runtime, changes, sourceState, preview, executedReviews }
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
    expect(subject.state.rows.find(row => row.key === 'disk')).toMatchObject({
      isEnabled: true,
      mode: 'push',
      syncInterval: 'P0D',
      config: { path: '/migration-source', createDailyBackups: true, opaque: 'keep-disk' }
    })
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

  const payload = { mode: 'disk', path: '/migration-source' }
  const reviewed = (preview: StorageImportPreview): StorageImportReview => ({
    scope: preview.scope, snapshot: preview.snapshot,
    mappings: preview.pages.map(page => ({
      sourcePath: page.sourcePath, sourceSha256: page.sourceSha256, locale: page.locale, path: page.path,
      existingPageId: page.existingPageId, expectedSourceRevision: page.expectedSourceRevision
    }))
  })

  it('previews the complete source without publishing configuration or starting import', async () => {
    const before = structuredClone(subject.state)
    const preview = await subject.inspect(requester, payload)
    expect(preview).toMatchObject({
      scope: { actorId: 1, apiKeyId: null, targetKey: 'disk' },
      entries: [{ sourcePath: 'guide.md', kind: 'file', sourceSha256: 'b'.repeat(64) }]
    })
    expect(subject.state).toEqual(before)
    expect(subject.saved).not.toHaveBeenCalled()
    expect(subject.executeAction).not.toHaveBeenCalled()
    expect(JSON.stringify(preview)).not.toContain('unselected-key')
  })

  it('rejects unsupported unreviewed names before settings or content writes, then imports an explicit native mapping', async () => {
    subject.sourceState.pages[0]!.sourcePath = 'a.b.md'
    subject.sourceState.pages[0]!.path = 'a.b'
    const before = structuredClone(subject.state)
    await expect(subject.run(requester, payload, 'Review dotted source', async () => undefined)).rejects.toMatchObject({ status: 409 })
    expect(subject.state).toEqual(before)
    expect(subject.saved).not.toHaveBeenCalled()
    expect(subject.executeAction).not.toHaveBeenCalled()
    const review = reviewed(await subject.inspect(requester, payload))
    review.mappings[0]!.path = 'a-b'
    await subject.run(requester, { ...payload, review }, 'Review dotted source', async () => undefined)
    expect(subject.executedReviews).toEqual([review])
  })

  it('requires explicit legacy destination association with the current page revision', async () => {
    Object.assign(subject.sourceState.pages[0]!, { existingPageId: 41, expectedSourceRevision: '7' })
    subject.sourceState.destinations.push({ id: 41, locale: 'en', path: 'guide', sourceRevision: '7' })
    await expect(subject.run(requester, payload, 'Review legacy association', async () => undefined)).rejects.toMatchObject({ status: 409 })
    expect(subject.saved).not.toHaveBeenCalled()
    const review = reviewed(await subject.inspect(requester, payload))
    await subject.run(requester, { ...payload, review }, 'Review legacy association', async () => undefined)
    expect(subject.executedReviews[0]?.mappings[0]).toMatchObject({ existingPageId: 41, expectedSourceRevision: '7' })
  })

  it('binds review to the current actor, source snapshot, configuration and chosen mapping without partial settings writes', async () => {
    for (const change of ['actor', 'snapshot', 'configuration', 'destination', 'mapping'] as const) {
      subject = fixture()
      const review = reviewed(await subject.inspect(requester, payload))
      let actor = requester
      if (change === 'actor') actor = { user: { id: 3, authVersion: 0 } } as never
      if (change === 'snapshot') subject.sourceState.snapshot = 'c'.repeat(64)
      if (change === 'configuration') subject.state.metadata.revision = 'concurrent-revision'
      if (change === 'destination') subject.sourceState.destinations.push({ id: 9, locale: 'en', path: 'guide', sourceRevision: '2' })
      if (change === 'mapping') review.mappings[0]!.sourceSha256 = 'c'.repeat(64)
      const before = structuredClone(subject.state)
      await expect(subject.run(actor, { ...payload, review }, 'Review current inventory', async () => undefined)).rejects.toMatchObject({ status: 409 })
      expect(subject.state).toEqual(before)
      expect(subject.saved).not.toHaveBeenCalled()
      expect(subject.executeAction).not.toHaveBeenCalled()
    }
  })

  it('refuses duplicate reviewed destinations before publishing settings or mutating an asset', async () => {
    subject.sourceState.pages.push({ ...subject.sourceState.pages[0]!, sourcePath: 'second.md', path: 'second' })
    const review = reviewed(await subject.inspect(requester, payload))
    review.mappings[1]!.path = 'GUIDE'
    await expect(subject.run(requester, { ...payload, review }, 'Review identity collision', async () => undefined)).rejects.toMatchObject({ status: 409 })
    expect(subject.saved).not.toHaveBeenCalled()
    expect(subject.executeAction).not.toHaveBeenCalled()
  })

  it('publishes only exact source-bound Git dot choices through the existing configuration and execution review fence', async () => {
    const gitPayload = {
      mode: 'git', repoUrl: 'git@reviewed.example.test:wiki.git', branch: 'main', authType: 'ssh',
      privateKey: 'reviewed-private-key', localRepoPath: '/reviewed/git', verifySSL: true
    }
    subject.sourceState.pages = []
    subject.sourceState.gitContent = [{
      sourcePath: '.legacy.bin', sourceSha256: 'c'.repeat(64), sourceKey: 'd'.repeat(64),
      hidden: true, previous: false, sourceAvailable: true, automatic: false, kind: 'asset', diagnostics: [],
      owner: { kind: 'asset', id: 42, path: '.legacy.bin', locale: '', revision: 'e'.repeat(64), sha256: 'c'.repeat(64), sourceOwned: false }
    }]
    const preview = await subject.inspect(requester, gitPayload)
    const entry = preview.gitContent![0]!
    const review: StorageImportReview = {
      scope: preview.scope, snapshot: preview.snapshot, mappings: [],
      gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: entry.owner, action: 'retain' }]
    }
    await subject.run(requester, { ...gitPayload, review }, 'Retain the exact legacy Git asset association', async () => {})
    expect(subject.saved).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(String(subject.state.rows.find(row => row.key === 'git')!.config.dotContentReview))
    expect(persisted).toEqual({ sourceKey: 'd'.repeat(64), choices: review.gitContent })
    expect(subject.executedReviews).toEqual([review])
    expect(subject.state.rows.find(row => row.key === 'disk')!.config.path).toBe('/old')
  })
  it('keeps managed review bytes out of ordinary configuration views while binding full fingerprints, not export destinations', () => {
    const definition = storageModuleDefinition({ key: 'git', isAvailable: true, supportedModes: ['pull'],
      props: { branch: { type: 'String', default: 'main' }, dotContentReview: { type: 'String', default: '' } } })
    const row = subject.state.rows.find(row => row.key === 'git')!
    row.config.dotContentReview = 'managed-private-inventory'.repeat(4096)
    const before = storageConfigurationKey(row)
    const destinationBefore = nativeStorageMutationConfigurationKey(row)
    const view = storageTargetView(row, definition)
    expect(definition.fields.some(field => field.key === 'dotContentReview')).toBe(false)
    expect(view.config).not.toHaveProperty('dotContentReview')
    expect(JSON.stringify(view)).not.toContain('managed-private-inventory')
    row.config.dotContentReview = 'replacement-reviewed-policy'
    expect(storageConfigurationKey(row)).not.toBe(before)
    expect(nativeStorageMutationConfigurationKey(row)).toBe(destinationBefore)
  })

  it('rejects managed-field injection and oversized trusted choices before acquiring a database connection', async () => {
    const transaction = vi.fn(() => { throw new Error('Unexpected database connection before managed-field validation') })
    const store = createStorageConfigurationStore({ db: { transaction }, definitions: () => [], reviewKey: 'review-secret', offline: () => false } as never)
    const target = { key: 'git', isEnabled: true, mode: 'pull', syncInterval: 'P0D', config: {}, secrets: {} }
    const input = { targets: [target], fingerprint: 'a'.repeat(64), reason: 'Review exact managed policy' }
    await expect(store.save(requester, { ...input, targets: [{ ...target, config: { dotContentReview: '{}' } }] }))
      .rejects.toThrow('server-managed')
    await expect(store.save(requester, { ...input, targets: [{ ...target, secrets: { dotContentReview: { action: 'replace', value: '{}' } } }] }))
      .rejects.toThrow('server-managed')
    await expect(store.saveImportReview(requester, input, 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow('exceed 2 MiB')
    expect(transaction).not.toHaveBeenCalled()
  })

  it('refuses an oversized per-revision Git review before publishing settings or running content effects', async () => {
    const gitPayload = { mode: 'git', repoUrl: 'git@reviewed.example.test:wiki.git', branch: 'main', authType: 'ssh',
      privateKey: 'reviewed-private-key', localRepoPath: '/reviewed/git', verifySSL: true }
    const preview = await subject.inspect(requester, gitPayload)
    const longPath = Array.from({ length: 9 }, () => 'a'.repeat(200)).join('/')
    const review: StorageImportReview = { scope: preview.scope, snapshot: preview.snapshot, mappings: [],
      gitContent: Array.from({ length: 1200 }, (_, index) => ({
        sourcePath: `.batch-${index}/${longPath}.bin`, sourceSha256: 'c'.repeat(64), owner: null, action: 'retain' as const
      })) }
    const before = structuredClone(subject.state)
    await expect(subject.run(requester, { ...gitPayload, review }, 'Review bounded exact choices', async () => {}))
      .rejects.toThrow('exceed 2 MiB')
    expect(subject.state).toEqual(before)
    expect(subject.saved).not.toHaveBeenCalled()
    expect(subject.executeAction).not.toHaveBeenCalled()
  })
})
