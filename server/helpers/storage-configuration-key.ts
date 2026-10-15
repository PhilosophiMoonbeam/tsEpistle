import { createHash } from 'node:crypto'
export const storageStableValue = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
/** Internal identity only. Never expose configuration digests as public credential observations. */
export const storageConfigurationKey = (target: { key: string; isEnabled: boolean; mode: string; syncInterval: string; config: unknown }): string =>
  createHash('sha256')
    .update(storageStableValue({ key: target.key, isEnabled: target.isEnabled, mode: target.mode, syncInterval: target.syncInterval, config: target.config }))
    .digest('hex')

const nativeGitOperationalFields: Record<string, true> = {
  basicPassword: true,
  sshPrivateKeyMode: true,
  sshPrivateKeyPath: true,
  sshPrivateKeyContent: true,
  sshKnownHosts: true,
  defaultName: true,
  defaultEmail: true
}

const nativeProviderOperationalFields: Record<string, Record<string, true>> = {
  git: nativeGitOperationalFields,
  azure: { accountKey: true },
  s3: { secretAccessKey: true },
  s3generic: { secretAccessKey: true },
  digitalocean: { secretAccessKey: true },
  sftp: { password: true, privateKey: true, passphrase: true, authMode: true }
}

/**
 * Canonical mutation destination identity, not an administrative/runtime review.
 * Only explicit native-provider credential repairs preserve destination identity.
 * Account names, pinned hosts, paths, and unknown fields remain destination-sensitive.
 */
export const nativeStorageMutationConfigurationKey = (target: {
  key: string
  isEnabled: boolean
  mode: string
  syncInterval: string
  config: unknown
}): string => {
  let config = target.config
  const operationalFields = Object.hasOwn(nativeProviderOperationalFields, target.key) ? nativeProviderOperationalFields[target.key] : undefined
  if (operationalFields && config && typeof config === 'object' && !Array.isArray(config)) {
    const endpoint = Reflect.get(config, 'endpoint')
    // AWS bucket names are global only on the native AWS endpoint. A saved
    // custom endpoint can resolve the same bucket differently for another account.
    const awsGlobalBucket = target.key === 's3' && (endpoint === undefined || endpoint === null)
    config = Object.fromEntries(Object.entries(config).filter(([key]) =>
      !Object.hasOwn(operationalFields, key) && !(awsGlobalBucket && key === 'accessKeyId')
    ))
  }
  return createHash('sha256')
    .update(storageStableValue({ key: target.key, isEnabled: target.isEnabled, mode: target.mode, config }))
    .digest('hex')
}
