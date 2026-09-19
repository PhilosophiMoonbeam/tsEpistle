export type OfflineSavedPageState = 'saved' | 'expiring' | 'sync-pending' | 'stale'

export const offlineIneligibilityIsQuiet = (input: {
  serverDenied: boolean
  selected: boolean
  hasSnapshot: boolean
  excluded: boolean
  localReason: string
}): boolean => input.serverDenied &&
  !input.selected &&
  !input.hasSnapshot &&
  !input.excluded &&
  input.localReason === ''

export const offlineSavedPageState = (input: {
  savedRevision: string
  latestKnownRevision: string
  expiresAt: string | null
  refreshFailed: boolean
  now?: number
}): OfflineSavedPageState => {
  const validRevision = (value: string): boolean => value.length <= 512 && /^[1-9][0-9]*$/u.test(value)
  const saved = input.savedRevision
  const known = input.latestKnownRevision
  // Revisions are positive decimal strings, potentially larger than Number.MAX_SAFE_INTEGER.
  if (validRevision(saved) && validRevision(known) && (known.length > saved.length || (known.length === saved.length && known > saved))) return 'stale'
  const now = input.now ?? Date.now()
  const expiry = input.expiresAt ? Date.parse(input.expiresAt) : Number.NaN
  if (Number.isFinite(expiry) && expiry > now && expiry - now <= 7 * 24 * 60 * 60 * 1_000) return 'expiring'
  return input.refreshFailed ? 'sync-pending' : 'saved'
}

export const offlineSavedPageStatus = (state: OfflineSavedPageState, connected: boolean, selected: boolean): string => {
  const saved = 'A readable offline copy is saved on this device.'
  if (state === 'stale') return `${saved} A newer version was last seen online. ${connected ? 'Use Retry offline sync to update this copy.' : 'Reconnect to update this copy.'}`
  if (state === 'expiring') return `A readable offline copy is saved on this device, but expires soon.${connected ? '' : ' Reconnect to renew it.'}`
  if (!connected) return `${saved} Reconnect to check for updates.`
  if (state === 'sync-pending') return `${saved} The latest check for updates could not be completed. Use Retry offline sync.`
  return selected ? saved : 'A readable offline copy is saved on this device, but this page is not included for continued sync.'
}
