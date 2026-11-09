import { createHash } from 'node:crypto'
import { z } from 'zod'
import { STORAGE_GIT_CONTENT_REVIEW_MAX_BYTES, StorageGitContentChoiceSchema, type StorageGitContentChoice, type StorageGitContentEntry, type StorageImportPreview } from '../../../../shared/utility-content-import.ts'
import { storageStableValue } from '../../../helpers/storage-configuration-key.ts'
import pageHelper from '../../../helpers/page.ts'
import type { StorageImportAdmission, StorageImportFile } from '../disk/common.ts'
import type { StorageRootHandle, StorageWalkEntry } from '../local-filesystem.ts'
import { ImportBudget, boundedImportAssetLimit } from '../import-budget.ts'
import { OKF_MAX_DOCUMENT_BYTES } from '../../../okf/format.ts'
import { assertGitPath, admitGitTree, streamGitNameStatus, type GitNativeCommand } from './admission.ts'
import { runBoundedProcess, GIT_NATIVE_DEADLINE_MS, GIT_NATIVE_STDOUT_LIMIT_BYTES } from './bounded-process.ts'

export const gitDotContentPath = (sourcePath: string): boolean => sourcePath.split('/').some(part => part.startsWith('.'))
export const gitContentDigest = (value: unknown): string => createHash('sha256').update(storageStableValue(value)).digest('hex')
export interface GitPreviousContent { readonly path: string; readonly bytes: Buffer; readonly revision: string; readonly destinationPath?: string; readonly retained?: boolean }
const previousContent = new WeakMap<StorageImportAdmission, readonly GitPreviousContent[]>()
const inspectionCommands = new WeakMap<StorageImportAdmission, GitNativeCommand>()
export const gitPreviousContent = (admission: StorageImportAdmission): readonly GitPreviousContent[] => previousContent.get(admission) ?? []
export const bindGitPreviousContent = (admission: StorageImportAdmission, sources: readonly GitPreviousContent[]): void => { previousContent.set(admission, sources) }
export const gitRetainedContentRef = (sourceKey: string, sourcePath: string): string =>
  `refs/wiki/content-retained/${gitContentDigest([sourceKey, sourcePath])}`

/** Visibility is deliberately downstream of complete descriptor admission and budgets. */
export async function collectGitContentEntries(root: StorageRootHandle, maxAssetBytes: number): Promise<StorageImportAdmission> {
  const budget = new ImportBudget()
  const entries: StorageWalkEntry[] = []
  const filesByPath = new Map<string, StorageWalkEntry>()
  const files: StorageImportFile[] = []
  const assetLimit = boundedImportAssetLimit(maxAssetBytes)
  for await (const entry of root.walk({ shouldSkip: name => name === '.git', admit: entry => {
    assertGitPath(entry.relativePath)
    budget.reserve(entry.kind === 'file' ? entry.identity.size : 0)
  } })) {
    entries.push(entry)
    if (entry.kind !== 'file') continue
    filesByPath.set(entry.relativePath, entry)
    const contentType = pageHelper.getContentType(entry.relativePath)
    const limit = contentType ? OKF_MAX_DOCUMENT_BYTES : assetLimit
    if (entry.identity.size > limit) throw new RangeError(`Git content exceeds ${limit} bytes: ${entry.relativePath}`)
    if (entry.identity.size < 1 || entry.relativePath.length <= 3) continue
    files.push({ file: { relPath: entry.relativePath, stats: entry.identity }, ...(contentType ? { contentType } : {}) })
  }
  return { root, budget, entries, filesByPath, files }
}

/** Read only the pinned pending base, never a mutable remote ref or invented old bytes. */
export async function inspectGitPreviousContent(admission: StorageImportAdmission, ingestion: Record<string, unknown>, command?: GitNativeCommand): Promise<void> {
  const deadlineAt = Date.now() + GIT_NATIVE_DEADLINE_MS
  const native: GitNativeCommand = command ?? { run: (args, options = {}) => runBoundedProcess({
    command: typeof ingestion.gitBinaryPath === 'string' && ingestion.gitBinaryPath ? ingestion.gitBinaryPath : 'git',
    args, cwd: String(ingestion.localRepoPath), env: { GIT_TERMINAL_PROMPT: '0' },
    deadlineMs: Math.max(1, deadlineAt - Date.now()), maxStdoutBytes: options.maxStdoutBytes ?? GIT_NATIVE_STDOUT_LIMIT_BYTES,
    captureStdout: options.captureStdout ?? true, ...(options.onStdoutChunk ? { onStdoutChunk: options.onStdoutChunk } : {})
  }) }
  inspectionCommands.set(admission, native)
  const previous = [...(previousContent.get(admission) ?? [])]
  let bytes = previous.reduce((total, source) => total + source.bytes.byteLength, 0)
  const admittedRevisions = new Set<string>()
  if (!previousContent.has(admission)) {
    if (typeof ingestion.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ingestion.branch)) throw new Error('Git content branch is invalid')
    const refs = await native.run(['for-each-ref', '--format=%(objectname)', `refs/wiki/pending-import/${ingestion.branch}`], { maxStdoutBytes: 1024 })
    const base = refs.stdout.toString('utf8').trim()
    if (base) {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new Error('Git pending import base is invalid')
      const headResult = await native.run(['rev-parse', '--verify', 'HEAD^{commit}'], { maxStdoutBytes: 1024 })
      const head = headResult.stdout.toString('utf8').trim()
      await admitGitTree(native, base, { maxAssetBytes: admission.budget.maxBytes })
      await admitGitTree(native, head, { maxAssetBytes: admission.budget.maxBytes })
      admittedRevisions.add(base)
      const changes = await streamGitNameStatus(native, base, head)
      for (const change of changes) {
        if (change.status !== 'D' && change.status !== 'R') continue
        const result = await native.run(['show', `${base}:${change.oldPath}`], { maxStdoutBytes: admission.budget.maxBytes - bytes })
        bytes += result.stdout.byteLength
        if (bytes > admission.budget.maxBytes) throw new RangeError('Git previous content exceeds the import byte bound')
        previous.push({ path: change.oldPath, bytes: result.stdout, revision: base, ...(change.status === 'R' ? { destinationPath: change.path } : {}) })
      }
    }
  }
  const raw = ingestion.dotContentReview
  if (typeof raw === 'string' && raw !== '') {
    const stored = storedSchema.parse(JSON.parse(raw))
    for (const choice of stored.choices) {
      if (!choice.sourceRevision) continue
      const existing = previous.find(source => source.path === choice.sourcePath)
      if (existing !== undefined) {
        if (existing.revision !== choice.sourceRevision) throw new Error(`Retained Git source was reused at a different revision: ${choice.sourcePath}`)
        continue
      }
      assertGitPath(choice.sourcePath)
      const ref = gitRetainedContentRef(stored.sourceKey, choice.sourcePath)
      const pinned = await native.run(['for-each-ref', '--format=%(objectname)', ref], { maxStdoutBytes: 1024 })
      // Keep the record inspectable for explicit retention, but never promote
      // unavailable/mismatched old bytes into mutation authority.
      if (pinned.stdout.toString('utf8').trim() !== choice.sourceRevision) continue
      if (!admittedRevisions.has(choice.sourceRevision)) {
        await admitGitTree(native, choice.sourceRevision, { maxAssetBytes: admission.budget.maxBytes })
        admittedRevisions.add(choice.sourceRevision)
      }
      const result = await native.run(['show', `${choice.sourceRevision}:${choice.sourcePath}`], { maxStdoutBytes: admission.budget.maxBytes - bytes })
      bytes += result.stdout.byteLength
      if (bytes > admission.budget.maxBytes) throw new RangeError('Retained Git source bytes exceed the import bound')
      if (previous.length >= admission.budget.maxEntries) throw new RangeError('Retained Git source inventory exceeds its entry bound')
      previous.push({ path: choice.sourcePath, bytes: result.stdout, revision: choice.sourceRevision, retained: true })
    }
  }
  bindGitPreviousContent(admission, previous)
}

/** Native provenance makes retained pins discoverable after a reviewed policy replacement. */
export async function refreshGitRetainedSources(admission: StorageImportAdmission, sourceKey: string, sources: readonly { sourcePath: string; sourceSha256: string }[]): Promise<void> {
  const command = inspectionCommands.get(admission)
  if (command === undefined) return
  const candidates = new Map<string, { sourcePath: string; sourceSha256: string }>()
  for (const source of sources) {
    assertGitPath(source.sourcePath)
    const ref = gitRetainedContentRef(sourceKey, source.sourcePath)
    const prior = candidates.get(ref)
    if (prior !== undefined && prior.sourceSha256 !== source.sourceSha256) throw new Error('Native Git retained source ownership is ambiguous')
    candidates.set(ref, source)
  }
  if (candidates.size > admission.budget.maxEntries) throw new RangeError('Native Git retained source inventory exceeds its entry bound')
  const refs = [...candidates.keys()]
  const previous = new Map(gitPreviousContent(admission).map(source => [source.path, source]))
  let bytes = [...previous.values()].reduce((total, source) => total + source.bytes.byteLength, 0)
  const revisions = new Set<string>()
  for (let offset = 0; offset < refs.length; offset += 128) {
    const result = await command.run(['for-each-ref', '--format=%(refname) %(objectname)', ...refs.slice(offset, offset + 128)], { maxStdoutBytes: 128 * 256 })
    for (const line of result.stdout.toString('utf8').split('\n')) {
      if (!line) continue
      const [ref, revision, extra] = line.split(' ')
      const source = ref === undefined ? undefined : candidates.get(ref)
      if (source === undefined || extra !== undefined || revision === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('Native Git retained source ref is invalid')
      const existing = previous.get(source.sourcePath)
      if (existing?.revision === revision && createHash('sha256').update(existing.bytes).digest('hex') === source.sourceSha256) {
        previous.set(source.sourcePath, { ...existing, retained: true })
        continue
      }
      if (!revisions.has(revision)) {
        await admitGitTree(command, revision, { maxAssetBytes: admission.budget.maxBytes })
        revisions.add(revision)
      }
      const old = await command.run(['show', `${revision}:${source.sourcePath}`], { maxStdoutBytes: admission.budget.maxBytes - bytes })
      bytes += old.stdout.byteLength
      if (bytes > admission.budget.maxBytes || previous.size >= admission.budget.maxEntries && !previous.has(source.sourcePath)) throw new RangeError('Native Git retained source bytes/entries exceed their bound')
      if (createHash('sha256').update(old.stdout).digest('hex') !== source.sourceSha256) throw new Error(`Native Git retained source pin no longer matches its owner: ${source.sourcePath}`)
      previous.set(source.sourcePath, { path: source.sourcePath, bytes: old.stdout, revision, retained: true })
    }
  }
  bindGitPreviousContent(admission, [...previous.values()])
}


const storedSchema = z.object({ sourceKey: z.string().regex(/^[a-f0-9]{64}$/), choices: z.array(StorageGitContentChoiceSchema).max(10000) }).strict()
export function gitContentChoices(ingestion: unknown, sourceKey: string, reviewed?: readonly StorageGitContentChoice[]): readonly StorageGitContentChoice[] {
  if (reviewed !== undefined) return reviewed
  const raw = typeof ingestion === 'object' && ingestion !== null ? Reflect.get(ingestion, 'dotContentReview') : undefined
  if (raw === undefined || raw === '') return []
  if (typeof raw !== 'string') throw new Error('Git dot-content review configuration is invalid')
  if (Buffer.byteLength(raw, 'utf8') > STORAGE_GIT_CONTENT_REVIEW_MAX_BYTES) throw new RangeError('Saved Git content choices exceed 2 MiB; replace them with a smaller reviewed batch.')
  const parsed = storedSchema.parse(JSON.parse(raw))
  if (parsed.sourceKey !== sourceKey) throw new Error('Git dot-content review belongs to a different source/root')
  return parsed.choices
}
export const serializeGitContentChoices = (sourceKey: string, choices: readonly StorageGitContentChoice[]): string => {
  const serialized = JSON.stringify({ sourceKey, choices })
  if (Buffer.byteLength(serialized, 'utf8') > STORAGE_GIT_CONTENT_REVIEW_MAX_BYTES) throw new RangeError('Exact Git content choices exceed 2 MiB. Review fewer sources in this batch; native provenance preserves earlier associations. No settings or content have changed.')
  return serialized
}

export function resolveGitContentChoices(preview: StorageImportPreview, choices: readonly StorageGitContentChoice[]): ReadonlyMap<string, StorageGitContentChoice> {
  const entries = new Map((preview.gitContent ?? []).map(entry => [entry.sourcePath, entry]))
  const current = new Map(preview.entries.filter(source => source.kind === 'file').map(source => [source.sourcePath, source.sourceSha256]))
  const resolved = new Map<string, StorageGitContentChoice>()
  for (const choice of choices) {
    assertGitPath(choice.sourcePath)
    if (resolved.has(choice.sourcePath)) throw new Error(`Duplicate Git content choice: ${choice.sourcePath}`)
    const entry = entries.get(choice.sourcePath)
    const owner = entry?.owner
    const reviewedOwner = choice.owner
    const matchingOwner = owner === null ? reviewedOwner === null : owner !== undefined && reviewedOwner !== null &&
      owner.id === reviewedOwner.id && owner.kind === reviewedOwner.kind && owner.path === reviewedOwner.path &&
      owner.locale === reviewedOwner.locale && owner.revision === reviewedOwner.revision && owner.sha256 === reviewedOwner.sha256 &&
      (owner.sourceSha256 ?? owner.sha256) === (reviewedOwner.sourceSha256 ?? reviewedOwner.sha256)
    if (entry === undefined || entry.sourceSha256 !== choice.sourceSha256 ||
        (entry.sourceRevision ?? null) !== (choice.sourceRevision ?? null) ||
        entry.sourceAvailable !== (choice.sourceAvailable ?? true) || !matchingOwner) {
      throw new Error(`Git content review is stale or source ownership changed: ${choice.sourcePath}`)
    }
    if (!entry.sourceAvailable && choice.action !== 'retain') throw new Error(`Actual old Git content is unavailable; retain the canonical record: ${choice.sourcePath}`)
    if (choice.action === 'remove' || choice.action === 'remap') {
      if (entry.owner === null || !entry.owner.sourceOwned) throw new Error(`Git content removal/remap requires exact native source ownership: ${choice.sourcePath}`)
      if ((entry.owner.sourceSha256 ?? entry.owner.sha256) !== entry.sourceSha256) throw new Error(`Actual old Git source is stale for its native owner: ${choice.sourcePath}`)
    }
    if (choice.action === 'remap') {
      if (!choice.destinationPath) throw new Error(`Git remap requires an exact destination: ${choice.sourcePath}`)
      assertGitPath(choice.destinationPath)
      if (gitDotContentPath(choice.destinationPath)) throw new Error('Git remap must select visible content')
    } else if (choice.destinationPath !== undefined) throw new Error('Only a Git remap may select a destination')
    if (choice.action === 'include' && !entry.hidden && (entry.kind !== 'asset' || entry.previous || entry.owner === null)) {
      throw new Error('Reviewed native replacement requires an exact current asset owner')
    }
    if (choice.action === 'include' && current.get(choice.sourcePath) !== choice.sourceSha256) {
      throw new Error(`Git compatibility inclusion requires exact current source bytes: ${choice.sourcePath}`)
    }
    resolved.set(choice.sourcePath, choice)
  }
  return resolved
}

export function gitContentAction(entry: StorageGitContentEntry, choices: ReadonlyMap<string, StorageGitContentChoice>): 'include' | 'retain' | 'remove' | 'remap' | 'ignore' | 'conflict' {
  const reviewed = choices.get(entry.sourcePath)
  if (reviewed !== undefined) return reviewed.action
  if (entry.automatic && entry.sourceAvailable && entry.kind === 'page' && entry.previous) return 'include'
  if (entry.automatic && entry.sourceAvailable && (entry.owner === null && !entry.previous ||
      entry.owner?.kind === 'asset' && entry.owner.sourceOwned && entry.owner.path === entry.sourcePath)) return 'include'
  if (entry.owner !== null || !entry.sourceAvailable || !entry.hidden && entry.previous) return 'conflict'
  return entry.hidden ? 'ignore' : 'include'
}
