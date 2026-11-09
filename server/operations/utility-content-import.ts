import { createHmac } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'

import type { StorageModuleDefinition, StorageOperationResult, StorageTargetDraft, StorageTargetView } from '../../shared/storage-workspace.ts'
import { StorageImportReviewSchema, type StorageImportPreview, type StorageImportReview, type StorageImportScope } from '../../shared/utility-content-import.ts'
import { principalId } from '../helpers/page-access.ts'
import { requireSystemAuthority } from '../helpers/system-authority.ts'
import { openStorageRoot } from '../modules/storage/local-filesystem.ts'
import { collectStorageEntries } from '../modules/storage/disk/common.ts'
import { buildStorageImportPreview, validateStorageImportReview, withStorageImportReview } from '../modules/storage/import-identity.ts'
import { collectGitContentEntries, inspectGitPreviousContent, serializeGitContentChoices } from '../modules/storage/git/content-visibility.ts'
import type { SystemRequester } from '../helpers/system-authority.ts'
import { storageConfigurationKey, storageStableValue } from '../helpers/storage-configuration-key.ts'
import { storageRecord, storageTargetView, type StorageConfigurationRow } from '../repositories/storage-configuration.ts'
import { storageOperationResult } from '../repositories/storage-operation-result.ts'
import Storage from '../models/storage.ts'
import { getStorageWorkspaceStore } from './storage-workspace-runtime.ts'
import type { StorageRuntimeTarget } from './storage-actions.ts'
import errors from './errors.ts'

const { ApplicationError } = errors

const diskInput = z.object({ mode: z.literal('disk'), path: z.string().trim().min(1).max(4096) }).loose()
const gitInput = z
  .object({
    mode: z.literal('git'),
    repoUrl: z.string().trim().min(1).max(4096),
    branch: z.string().trim().min(1).max(255),
    authType: z.enum(['ssh', 'basic']),
    privateKey: z.string().min(1).max(65536).optional(),
    username: z.string().trim().min(1).max(255).optional(),
    password: z.string().min(1).max(65536).optional(),
    defaultEmail: z.string().trim().min(1).max(254).optional(),
    defaultName: z.string().trim().min(1).max(255).optional(),
    localRepoPath: z.string().trim().min(1).max(4096),
    verifySSL: z.boolean(),
    clearDotContentReview: z.boolean().optional()
  })
  .loose()
const inputSchema = z.discriminatedUnion('mode', [diskInput, gitInput])
const reasonSchema = z.string().trim().min(3).max(1000)

type ConfigurationState = {
  rows: StorageConfigurationRow[]
  definitions: StorageModuleDefinition[]
  metadata: Record<string, unknown>
  fingerprint: string
}
type StorageConfiguration = {
  reviewState(transaction: Knex.Transaction, requester: SystemRequester['user'], lock?: boolean): Promise<ConfigurationState>
  save(
    requester: SystemRequester['user'],
    input: { targets: StorageTargetDraft[]; fingerprint: string; reason: string }
  ): Promise<{ revision: string; changedTargets: string[] }>
  saveImportReview(
    requester: SystemRequester['user'],
    input: { targets: StorageTargetDraft[]; fingerprint: string; reason: string },
    managedGitContent: string
  ): Promise<{ revision: string; changedTargets: string[] }>
}
type StorageExecutor = Pick<typeof Storage, 'performAdministrativeOperation' | 'executeAction'>
type StorageStore = { configuration: StorageConfiguration }

interface Dependencies {
  store(): StorageStore
  executor(): StorageExecutor
  readState(store: StorageStore, requester: SystemRequester, transaction?: Knex.Transaction): Promise<ConfigurationState>
  signingKey(): string
  preview(source: { path: string; ingestion: Record<string, unknown>; moduleName: 'DISK' | 'GIT' }, scope: StorageImportScope): Promise<StorageImportPreview>
}

function fail(message: string, status = 400): never {
  throw new ApplicationError(message, { status })
}
const validateReview = (preview: StorageImportPreview, review: unknown): void => {
  try {
    validateStorageImportReview(preview, review)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'The content import review is invalid. Preview again.', 409)
  }
}
const targetDraft = (target: StorageTargetView): StorageTargetDraft => ({
  key: target.key,
  isEnabled: target.isEnabled,
  mode: target.mode,
  syncInterval: target.syncInterval,
  config: { ...target.config },
  secrets: Object.fromEntries(Object.keys(target.secrets).map(key => [key, { action: 'keep' as const }]))
})
const currentRevision = (state: ConfigurationState): string => (typeof state.metadata.revision === 'string' ? state.metadata.revision : '')
const sameValue = (left: unknown, right: unknown): boolean => storageStableValue(left) === storageStableValue(right)
const failedActivation = (): StorageOperationResult => ({
  outcome: 'failed',
  message: 'The selected storage target did not activate. No content was imported.',
  counts: null,
  items: [],
  targets: []
})
const selectedState = (
  state: ConfigurationState,
  key: string
): { row: StorageConfigurationRow; definition: StorageModuleDefinition; view: StorageTargetView } => {
  const row = state.rows.find(target => target.key === key),
    definition = state.definitions.find(target => target.key === key)
  if (!row || !definition) {
    fail('The selected storage target is no longer available. Reload and review the current storage configuration.', 409)
  }
  return { row, definition, view: storageTargetView(row, definition) }
}
const credentials = (state: ConfigurationState, key: string, input: z.infer<typeof inputSchema>): string[] => {
  const { row, definition } = selectedState(state, key),
    values = definition.fields
      .filter(field => field.sensitive)
      .map(field => storageRecord(row.config)[field.key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (input.mode === 'git') {
    if (input.privateKey) values.push(input.privateKey)
    if (input.password) values.push(input.password)
  }
  return [...new Set(values)]
}
const isUnchanged = (row: StorageConfigurationRow, view: StorageTargetView, draft: StorageTargetDraft): boolean => {
  if (row.isEnabled !== draft.isEnabled || row.mode !== draft.mode || row.syncInterval !== draft.syncInterval) return false
  if (Object.keys(view.config).some(key => !sameValue(view.config[key], draft.config[key]))) return false
  for (const [key, action] of Object.entries(draft.secrets)) {
    if (action.action === 'keep') continue
    const saved = storageRecord(row.config)[key],
      expected = action.action === 'clear' ? '' : action.value
    if (saved !== expected) return false
  }
  return true
}

const prepareImport = async (deps: Dependencies, requester: SystemRequester, payload: Record<string, unknown>) => {
    const parsedInput = inputSchema.safeParse(payload)
    if (!parsedInput.success) fail('Provide complete disk or Git content-import settings.')
    const input = parsedInput.data,
      store = deps.store(),
      executor = deps.executor(),
      targetKey = input.mode,
      initial = await deps.readState(store, requester),
      selected = selectedState(initial, targetKey)
    if (!selected.view.isAvailable || !selected.definition.actions.some(action => action.handler === 'importAll')) {
      fail(`The selected ${targetKey === 'git' ? 'Git' : 'disk'} storage target is unavailable in this deployment.`, 409)
    }

    const drafts = initial.rows.map(row => {
      const definition = initial.definitions.find(candidate => candidate.key === row.key)
      if (!definition) {
        fail('Storage configuration changed. Reload and review before importing.', 409)
      }
      return targetDraft(storageTargetView(row, definition))
    })
    const draft = drafts.find(target => target.key === targetKey)
    if (!draft) fail('Storage configuration changed. Reload and review before importing.', 409)
    draft.isEnabled = true
    draft.mode = targetKey === 'git' ? 'sync' : 'push'
    draft.syncInterval = 'P0D'
    if (input.mode === 'disk') {
      draft.config.path = input.path
    } else {
      draft.config.authType = input.authType
      draft.config.repoUrl = input.repoUrl
      draft.config.branch = input.branch
      draft.config.sshPrivateKeyMode = 'contents'
      draft.config.sshPrivateKeyPath = ''
      draft.config.verifySSL = input.verifySSL
      if (input.defaultEmail) draft.config.defaultEmail = input.defaultEmail
      if (input.defaultName) draft.config.defaultName = input.defaultName
      draft.config.localRepoPath = input.localRepoPath
      if (input.authType === 'ssh') {
        if (!input.privateKey) fail('Provide complete Git import credentials and repository settings.')
        draft.config.basicUsername = ''
        draft.secrets.sshPrivateKeyContent = { action: 'replace', value: input.privateKey }
        draft.secrets.basicPassword = { action: 'clear' }
      } else {
        if (!input.username || !input.password) fail('Provide complete Git import credentials and repository settings.')
        draft.config.basicUsername = input.username
        draft.secrets.sshPrivateKeyContent = { action: 'clear' }
        draft.secrets.basicPassword = { action: 'replace', value: input.password }
      }
    }

    const ingestion = { ...storageRecord(selected.row.config), ...draft.config }
    if (input.mode === 'git' && input.clearDotContentReview === true) ingestion.dotContentReview = ''
    for (const [key, action] of Object.entries(draft.secrets)) {
      if (action.action === 'replace') ingestion[key] = action.value
      if (action.action === 'clear') ingestion[key] = ''
    }
    const scope: StorageImportScope = {
      actorId: principalId(requester.user),
      apiKeyId: requester.apiKey?.id ?? null,
      targetKey: input.mode,
      configurationRevision: createHmac('sha256', deps.signingKey()).update(storageStableValue({
        actorId: principalId(requester.user), apiKeyId: requester.apiKey?.id ?? null,
        authVersion: requester.user && Reflect.get(requester.user, 'authVersion'), fingerprint: initial.fingerprint, revision: currentRevision(initial), drafts
      })).digest('hex')
    }
    const source = { path: input.mode === 'disk' ? input.path : input.localRepoPath, ingestion, moduleName: input.mode === 'disk' ? 'DISK' as const : 'GIT' as const }
    return { input, store, executor, targetKey, initial, selected, drafts, draft, scope, source }
}

/** Inspects a complete local source snapshot without saving settings, cloning or importing. */
export const createUtilityContentImportPreview = (deps: Dependencies) =>
  async (requester: SystemRequester, payload: Record<string, unknown>): Promise<StorageImportPreview> => {
    const prepared = await prepareImport(deps, requester, payload)
    const preview = await deps.preview(prepared.source, prepared.scope)
    if (payload.review !== undefined) validateReview(preview, payload.review)
    return preview
  }

/** Coordinates a one-off import through the reviewed storage configuration and runtime queue. */
export const createUtilityContentImport =
  (deps: Dependencies) =>
  async (requester: SystemRequester, payload: Record<string, unknown>, reason: string, guard: (transaction?: Knex.Transaction) => Promise<void>): Promise<StorageOperationResult> => {
    const parsedReason = reasonSchema.safeParse(reason)
    if (!parsedReason.success) fail('Provide a reviewed administrative reason for this content import.')
    const reviewedReason = parsedReason.data,
      prepared = await prepareImport(deps, requester, payload),
      { input, store, executor, targetKey, initial, selected, drafts, draft } = prepared
    const review = payload.review === undefined ? null : StorageImportReviewSchema.safeParse(payload.review)
    if (review && !review.success) fail(review.error.issues.find(issue => issue.code === 'custom')?.message ?? 'The content import identity review is incomplete. Preview the source again.', 409)
    await guard()
    const preview = await deps.preview(prepared.source, prepared.scope),
      acceptedReview: StorageImportReview = review?.success ? review.data : { scope: preview.scope, snapshot: preview.snapshot, mappings: [] }
    validateReview(preview, acceptedReview)
    let managedGitContent = input.mode === 'git' && input.clearDotContentReview === true ? '' : undefined
    if (input.mode === 'git' && acceptedReview.gitContent?.length) {
      const sourceKeys = new Set(preview.gitContent?.map(entry => entry.sourceKey))
      if (sourceKeys.size !== 1) fail('The reviewed Git content source is unavailable.', 409)
      managedGitContent = serializeGitContentChoices([...sourceKeys][0]!, acceptedReview.gitContent)
    }
    let savedRevision = currentRevision(initial)
    if (!isUnchanged(selected.row, selected.view, draft) ||
        managedGitContent !== undefined && storageRecord(selected.row.config).dotContentReview !== managedGitContent) {
      await guard()
      const publication = { targets: drafts, fingerprint: initial.fingerprint, reason: reviewedReason }
      const saved = managedGitContent === undefined
        ? await store.configuration.save(requester.user, publication)
        : await store.configuration.saveImportReview(requester.user, publication, managedGitContent)
      savedRevision = saved.revision
    }

    const saved = await deps.readState(store, requester),
      savedTarget = selectedState(saved, targetKey),
      savedConfigurationKey = storageConfigurationKey(savedTarget.row)
    if (currentRevision(saved) !== savedRevision) fail('Storage settings changed before the import could activate. No content was imported.', 409)

    return executor.performAdministrativeOperation(
      async () => {
        await guard()
        const current = await deps.readState(store, requester),
          target = selectedState(current, targetKey)
        if (currentRevision(current) !== savedRevision || storageConfigurationKey(target.row) !== savedConfigurationKey)
          fail('Storage settings changed before the import could activate. No content was imported.', 409)
        return { targetKey: null, handler: 'activate' }
      },
      async activation => {
        if (!Array.isArray(activation)) fail('Storage activation did not return its current target state.', 409)
        const runtimeTargets: StorageRuntimeTarget[] = activation,
          activated = runtimeTargets.find(target => target.key === targetKey)
        if (!activated?.active || activated.paused || activated.configurationKey !== savedConfigurationKey) return failedActivation()

        await guard()
        const current = await deps.readState(store, requester),
          target = selectedState(current, targetKey)
        if (currentRevision(current) !== savedRevision || storageConfigurationKey(target.row) !== savedConfigurationKey)
          fail('Storage settings changed after activation. No content was imported.', 409)
        validateReview(await deps.preview(prepared.source, prepared.scope), acceptedReview)
        const importGuard = async (transaction?: Knex.Transaction): Promise<void> => {
          await guard(transaction)
          const state = await deps.readState(store, requester, transaction),
            selected = selectedState(state, targetKey)
          if (currentRevision(state) !== savedRevision || storageConfigurationKey(selected.row) !== savedConfigurationKey)
            fail('Storage settings changed during the reviewed import. No further content was imported.', 409)
        }
        const raw = await withStorageImportReview(acceptedReview, importGuard,
          () => executor.executeAction(targetKey, 'importAll'), importGuard)
        return storageOperationResult('importAll', raw, credentials(current, targetKey, input))
      }
    )
  }

interface Runtime {
  models: { knex: Knex; storage: typeof Storage }
  config: { sessionSecret: string; uploads: { maxFileSize: number } }
}
const runtime = () => (globalThis as unknown as { WIKI: Runtime }).WIKI
const readState = async (store: StorageStore, requester: SystemRequester, current?: Knex.Transaction): Promise<ConfigurationState> => {
  if (current !== undefined) {
    await requireSystemAuthority(current, requester, true)
    return store.configuration.reviewState(current, requester.user)
  }
  const transaction = await runtime().models.knex.transaction({ isolationLevel: 'repeatable read', readOnly: true })
  try {
    await requireSystemAuthority(transaction, requester)
    const state = await store.configuration.reviewState(transaction, requester.user)
    await transaction.commit()
    return state
  } catch (error) {
    await transaction.rollback()
    throw error
  }
}

const dependencies: Dependencies = {
  store: () => ({ configuration: getStorageWorkspaceStore().configuration }),
  executor: () => runtime().models.storage,
  signingKey: () => runtime().config.sessionSecret,
  preview: async (source, scope) => {
    const root = await openStorageRoot(source.path)
    try {
      const admission = source.moduleName === 'GIT'
        ? await collectGitContentEntries(root, runtime().config.uploads.maxFileSize)
        : await collectStorageEntries(root, { maxAssetBytes: runtime().config.uploads.maxFileSize })
      if (source.moduleName === 'GIT') await inspectGitPreviousContent(admission, source.ingestion)
      return await buildStorageImportPreview(admission, source.ingestion, source.moduleName, scope)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The storage source cannot be previewed safely.', 409)
    } finally {
      await root.close()
    }
  },
  readState
}
export const previewUtilityContentImport = createUtilityContentImportPreview(dependencies)
export const runUtilityContentImport = createUtilityContentImport(dependencies)
