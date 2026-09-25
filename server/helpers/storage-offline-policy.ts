export interface StorageOfflinePolicy {
  offline?: boolean
  allowGitSyncWhileOffline?: boolean
}

export const storageTargetPausedOffline = (config: StorageOfflinePolicy | undefined, key: string): boolean =>
  Boolean(config?.offline) && key !== 'disk' && !(key === 'git' && config?.allowGitSyncWhileOffline === true)
