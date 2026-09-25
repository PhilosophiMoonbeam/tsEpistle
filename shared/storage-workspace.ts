import { z } from 'zod'

export const StorageValueSchema = z.union([z.string().max(65536), z.boolean(), z.number().finite()])
export type StorageValue = z.infer<typeof StorageValueSchema>
export const isStorageHostKeyFingerprint = (value: string): boolean => /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=?$/.test(value)
export const StorageSecretChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('replace'), value: z.string().min(1).max(65536) }).strict()
])
export const StorageTargetDraftSchema = z
  .object({
    key: z.string().min(1).max(255),
    isEnabled: z.boolean(),
    mode: z.string().min(1).max(30),
    syncInterval: z.string().min(1).max(64),
    config: z.record(z.string().min(1).max(100), StorageValueSchema),
    secrets: z.record(z.string().min(1).max(100), StorageSecretChangeSchema)
  })
  .strict()
export type StorageTargetDraft = z.infer<typeof StorageTargetDraftSchema>
export interface StorageField {
  key: string
  title: string
  hint: string
  type: 'string' | 'boolean' | 'number'
  sensitive: boolean
  multiline: boolean
  default: StorageValue
  options: Array<{ value: string; title: string }>
  order: number
}
export interface StorageActionDefinition {
  handler: string
  title: string
  effect: string
  confirmation: string
  direction: 'outbound' | 'inbound' | 'bidirectional' | 'local'
}
export interface StorageModuleDefinition {
  key: string
  title: string
  description: string
  isAvailable: boolean
  modes: string[]
  defaultMode: string
  schedule: string | false
  internalSchedule: string | false
  fields: StorageField[]
  actions: StorageActionDefinition[]
}
export interface StorageTargetView extends StorageModuleDefinition {
  isEnabled: boolean
  mode: string
  syncInterval: string
  config: Record<string, StorageValue>
  secrets: Record<string, boolean>
  issues: string[]
}
export interface StorageConfigurationEvent {
  id: string
  createdAt: string
  actorId: number | null
  reason: string
  targets: Array<{ key: string; fields: string[] }>
}
export interface StorageConfigurationWorkspace {
  targets: StorageTargetView[]
  offline: boolean
  gitSyncAllowedWhileOffline?: boolean
  fingerprint: string
  revision: string
  observedAt: string
  history: StorageConfigurationEvent[]
}

/** Literal branch names; previous-checkout shorthand is unsuitable for saved configuration. */
export const isStorageGitBranchName = (value: string): boolean =>
  Boolean(value) &&
  !value.startsWith('-') &&
  !value.includes('..') &&
  !value.includes('@{') &&
  !value.endsWith('.') &&
  !Array.from(value).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) &&
  !/[~^:?*[\\]/.test(value) &&
  value.split('/').every(part => Boolean(part) && !part.startsWith('.') && !part.endsWith('.lock'))

export const storageActionDefinition = (key: string, handler: string): StorageActionDefinition | null => {
  if (handler === 'exportAll' && ['s3', 's3generic', 'digitalocean', 'azure', 'sftp'].includes(key))
    return {
      handler,
      title: 'Export shared content',
      direction: 'outbound',
      confirmation: 'EXPORT CONTENT',
      effect: 'Write shared pages and assets from the database to this target. Existing destination files with matching names can be overwritten.'
    }
  if (key === 'disk' && handler === 'dump')
    return {
      handler,
      title: 'Export shared content',
      direction: 'outbound',
      confirmation: 'EXPORT CONTENT',
      effect: 'Write shared pages and assets from the database into the configured storage folder. Existing files with matching names can be overwritten.'
    }
  if (key === 'disk' && handler === 'backup')
    return {
      handler,
      title: 'Archive the storage folder',
      direction: 'local',
      confirmation: 'CREATE ARCHIVE',
      effect:
        'Create a compressed archive of the files currently in this storage folder. This action does not first refresh files from the database and does not include the workspace database or configuration.'
    }
  if (['disk', 'git'].includes(key) && handler === 'importAll')
    return {
      handler,
      title: 'Import folder content',
      direction: 'inbound',
      confirmation: 'IMPORT CONTENT',
      effect:
        'Read page documents and assets from the configured local folder into the wiki. Existing import conflict and document validation rules apply. This action does not restore users, settings or the workspace database.'
    }
  if (key === 'git' && handler === 'syncUntracked')
    return {
      handler,
      title: 'Export shared content to Git',
      direction: 'outbound',
      confirmation: 'EXPORT CONTENT',
      effect:
        'Write shared pages and assets from the database into the Git working copy and commit them locally. Existing matching files can be overwritten. Review the saved direction before synchronization.'
    }
  if (key === 'git' && handler === 'sync')
    return {
      handler,
      title: 'Synchronize now',
      direction: 'bidirectional',
      confirmation: 'SYNC CONTENT',
      effect:
        'Run Git synchronization using the saved push, pull or bidirectional setting. It can change the working copy, remote repository and wiki content according to that direction.'
    }
  if (key === 'git' && handler === 'purge')
    return {
      handler,
      title: 'Recreate the working copy',
      direction: 'bidirectional',
      confirmation: 'RECREATE WORKING COPY',
      effect:
        'Empty the configured Git working copy, initialize it again and synchronize using the saved direction. Local-only changes can be lost; the ensuing synchronization can affect the remote repository and wiki content.'
    }
  return null
}

/** Readiness describes configuration only; activation and operation results are separate observations. */
export const storageConfigurationIssues = (target: Pick<StorageTargetView, 'key' | 'config' | 'secrets'>): string[] => {
  const config = target.config,
    issues: string[] = [],
    text = (key: string) => (typeof config[key] === 'string' ? String(config[key]).trim() : ''),
    present = (key: string) => target.secrets[key] === true || Boolean(text(key)),
    required = (key: string, label: string) => {
      if (!present(key)) issues.push(`${label} is required.`)
    }
  if (target.key === 'disk') required('path', 'Storage folder')
  if (['s3', 's3generic', 'digitalocean'].includes(target.key)) {
    required('bucket', 'Bucket')
    if (target.key === 's3') required('region', 'Region')
    else required('endpoint', 'Endpoint')
    if (present('accessKeyId') !== present('secretAccessKey'))
      issues.push('Provide both an access key ID and secret access key, or leave both empty to use the runtime credential provider.')
  }
  if (target.key === 'azure') {
    required('accountName', 'Account name')
    required('accountKey', 'Account key')
    required('containerName', 'Container name')
  }
  if (target.key === 'sftp') {
    required('host', 'Host')
    required('username', 'Username')
    required('basePath', 'Remote folder')
    if (!isStorageHostKeyFingerprint(text('hostKeyFingerprint'))) issues.push('Provide the server’s verified SHA256 host-key fingerprint.')
    if (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535) issues.push('SSH port must be an integer from 1 to 65535.')
    if (config.authMode === 'password') required('password', 'Password')
    else required('privateKey', 'Private key')
  }
  if (target.key === 'git') {
    required('repoUrl', 'Repository address')
    required('branch', 'Branch')
    required('localRepoPath', 'Working-copy folder')
    required('defaultName', 'Fallback author name')
    required('defaultEmail', 'Fallback author email')
    if (config.authType === 'ssh') {
      if (config.sshPrivateKeyMode === 'contents') required('sshPrivateKeyContent', 'Private key')
      else required('sshPrivateKeyPath', 'Private-key path')
      if (/["`$\r\n\0]/.test(text('sshPrivateKeyPath'))) issues.push('The private-key path contains unsupported command characters.')
    } else if (text('repoUrl')) {
      try {
        const url = new URL(text('repoUrl').includes('://') ? text('repoUrl') : `https://${text('repoUrl')}`)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
          issues.push('Use an HTTP(S) repository address without embedded credentials, query or fragment.')
      } catch {
        issues.push('Enter a valid HTTP(S) repository address.')
      }
    }
    const branch = typeof config.branch === 'string' ? config.branch : ''
    if (branch && !isStorageGitBranchName(branch)) issues.push('Enter a valid Git branch name.')
  }
  for (const key of ['path', 'basePath', 'localRepoPath', 'sshPrivateKeyPath', 'gitBinaryPath', 'repoUrl', 'endpoint', 'host', 'region'])
    if (typeof config[key] === 'string' && /[\0\r\n]/.test(String(config[key]))) issues.push(`${key} must not contain control characters.`)
  if (text('endpoint')) {
    try {
      const endpoint = new URL(text('endpoint').includes('://') ? text('endpoint') : `https://${text('endpoint')}`)
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        issues.push('Use an HTTP(S) endpoint without embedded credentials, query or fragment.')
    } catch {
      issues.push('Enter a valid storage endpoint.')
    }
  }
  return issues
}

export const StorageOperationStateSchema = z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'interrupted', 'cancelled', 'resolved'])
export type StorageOperationState = z.infer<typeof StorageOperationStateSchema>
const StorageItemFormatSchema = z.enum(['okf', 'legacyV1', 'legacyWiki', 'plain', 'invalid'])
export const StorageOperationResultSchema = z
  .object({
    outcome: z.enum(['succeeded', 'partial', 'failed']),
    message: z.string().max(512),
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        formats: z.object({
          okf: z.number().int().nonnegative(),
          legacyV1: z.number().int().nonnegative(),
          legacyWiki: z.number().int().nonnegative(),
          plain: z.number().int().nonnegative(),
          invalid: z.number().int().nonnegative()
        })
      })
      .nullable(),
    items: z
      .array(
        z.object({
          kind: z.enum(['page', 'asset']),
          path: z.string().max(512),
          outcome: z.enum(['succeeded', 'failed', 'conflict']),
          format: StorageItemFormatSchema.nullable(),
          message: z.string().max(512).nullable(),
          diagnostics: z.array(z.string().max(512)).max(8)
        })
      )
      .max(50),
    targets: z.array(z.object({ key: z.string().max(255), active: z.boolean(), paused: z.boolean() })).max(100)
  })
  .strict()
  .refine(
    result =>
      result.counts === null
        ? result.items.length === 0
        : result.counts.succeeded + result.counts.failed === result.counts.total &&
          result.items.length <= result.counts.total &&
          Object.values(result.counts.formats).reduce((sum, count) => sum + count, 0) <= result.counts.total,
    'Reported item totals must agree.'
  )
export type StorageOperationResult = z.infer<typeof StorageOperationResultSchema>
export interface StorageOperationView {
  id: string
  jobId: string
  targetKey: string | null
  handler: string
  title: string
  effect: string
  state: StorageOperationState
  actorId: number | null
  reason: string
  configurationRevision: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  result: StorageOperationResult | null
  resolution: { actorId: number | null; reason: string; createdAt: string } | null
  canCancel: boolean
  canResolve: boolean
}

export interface StorageTargetObservation {
  key: string
  state: 'disabled' | 'pending' | 'active' | 'paused' | 'failed' | 'outdated'
  active: boolean
  matchesSaved: boolean
  lastAttempt: string | null
  lastOutcome: 'operational' | 'pending' | 'warning' | 'error' | 'paused' | null
}
export interface StorageWorkspace extends StorageConfigurationWorkspace {
  runtime: StorageTargetObservation[]
  operations: StorageOperationView[]
}
