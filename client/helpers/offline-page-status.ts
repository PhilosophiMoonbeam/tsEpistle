export type OfflineSavedPageState = 'saved' | 'expiring' | 'sync-pending' | 'stale'
export type OfflinePageAccessState = 'setup-required' | 'locked'
export const offlineSelectionSources = (input: {
  manual: boolean
  automatic: boolean
  tag: boolean
  tagNames?: readonly string[]
  revealTagNames?: boolean
}): string => {
  const sources: string[] = []
  if (input.manual) sources.push('Manual')
  if (input.automatic) sources.push('Automatic')
  if (input.tag) {
    const tags = input.tagNames ?? []
    sources.push(input.revealTagNames !== false && tags.length > 0 ? `Followed tag${tags.length > 1 ? 's' : ''} #${tags.join(', #')}` : 'Followed tag')
  }
  return sources.join(' + ')
}

export const offlinePrivateAccessStatus = (state: OfflinePageAccessState): string =>
  state === 'setup-required'
    ? 'This page needs one-time account setup for private reading before it can be saved offline.'
    : 'Private offline reading is locked. Unlock your account to save this page.'

export const offlineIneligibilityIsQuiet = (input: {
  serverDenied: boolean
  selected: boolean
  hasSnapshot: boolean
  excluded: boolean
  localReason: string
  /** Private authority denials are actionable and must not be collapsed to Guest copy. */
  privatePath?: boolean
}): boolean => input.serverDenied && !input.privatePath && !input.selected && !input.hasSnapshot && !input.excluded && input.localReason === ''

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
  if (state === 'stale')
    return `${saved} A newer version was last seen online. ${connected ? 'Use Retry offline sync to update this copy.' : 'Reconnect to update this copy.'}`
  if (state === 'expiring') return `${saved} A readable offline copy is saved on this device, but expires soon.${connected ? '' : ' Reconnect to renew it.'}`
  if (!connected) return `${saved} Reconnect to check for updates.`
  if (state === 'sync-pending') return `${saved} The latest check for updates could not be completed. Use Retry offline sync.`
  return selected ? saved : 'A readable offline copy is saved on this device, but this page is not included for continued sync.'
}
