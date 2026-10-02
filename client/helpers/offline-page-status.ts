export type OfflineSavedPageState = 'saved' | 'expiring' | 'sync-pending' | 'stale'
export type OfflinePageAccessState = 'setup-required' | 'locked'
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

/** Editors whose pages the server can turn into an offline snapshot (see server/helpers/offline-page.ts). */
export const OFFLINE_SUPPORTED_EDITORS: ReadonlySet<string> = new Set(['markdown', 'visual-markdown', 'asciidoc'])

export type OfflineLocalIneligibility = '' | 'no-selector' | 'unpublished' | 'protected' | 'editor'
export type OfflinePageControlState =
  | 'checking'
  | 'downloading'
  | 'removing'
  | 'setup-required'
  | 'locked'
  | 'off'
  | 'pending'
  | 'saved'
  | 'expiring'
  | 'stale'
  | 'sync-pending'
  | 'error'
  | 'unavailable'
  | 'ineligible'
/** Each tone maps to one color: warm = saved, warning = needs sync, error = failed, muted = cannot save, action = needs setup. */
export type OfflinePageControlTone = 'neutral' | 'saved' | 'warning' | 'error' | 'muted' | 'action'
export type OfflinePageControlAction = 'save' | 'remove' | 'setup' | 'unlock' | 'none'
export type OfflineTranslate = (key: string, options?: Record<string, unknown>) => string

export interface OfflinePageControlInput {
  /** The page component's resolved offline state. */
  readonly state: string
  readonly accessState: OfflinePageAccessState | null
  readonly selected: boolean
  readonly hasSnapshot: boolean
  readonly hasValidBody: boolean
  readonly excluded: boolean
  readonly manual: boolean
  readonly automatic: boolean
  readonly tag: boolean
  readonly tagNames: readonly string[]
  readonly revealTagNames: boolean
  /** The server refused a copy of a page the reader did not pick. */
  readonly quietIneligibility: boolean
  readonly localReason: OfflineLocalIneligibility
  /** The server connection is verified. */
  readonly connected: boolean
  /** Another offline change for this page is still running. */
  readonly busy: boolean
  /** Optional failure detail for error states. */
  readonly errorDetail?: string
}

export interface OfflinePageControl {
  readonly state: OfflinePageControlState
  readonly tone: OfflinePageControlTone
  readonly icon: string
  readonly action: OfflinePageControlAction
  /** True when activation does nothing; the reason is in `detail`. */
  readonly blocked: boolean
  /** Accessible name; it names the action. */
  readonly label: string
  /** Short tooltip headline; it names the state. */
  readonly title: string
  /** One short sentence: why, or what activation does. */
  readonly detail: string
  readonly pressed: boolean | undefined
}

const tr = (t: OfflineTranslate, key: string, defaultValue: string, params: Record<string, unknown> = {}): string =>
  t(`common:offline.page.${key}`, { defaultValue, ...params, interpolation: { escapeValue: false } })

const LOCAL_REASONS: Record<Exclude<OfflineLocalIneligibility, ''>, [string, string]> = {
  'no-selector': ['reasonNoSelector', 'This page cannot be saved offline.'],
  unpublished: ['reasonUnpublished', 'Unpublished pages cannot be saved offline.'],
  protected: ['reasonProtected', 'Password-protected pages cannot be saved offline.'],
  editor: ['reasonEditor', 'Pages from this editor cannot be saved offline.']
}

/** Short source text for a saved page. Tag names stay hidden on locked private paths. */
export const offlineSavedSourceDetail = (input: Pick<OfflinePageControlInput, 'manual' | 'automatic' | 'tag' | 'tagNames' | 'revealTagNames'>, t: OfflineTranslate): string => {
  if (input.manual) return tr(t, 'sourceManual', 'You saved this page.')
  if (input.tag) {
    const names = input.revealTagNames ? input.tagNames.filter(Boolean) : []
    return names.length > 0
      ? tr(t, 'sourceTagNamed', 'Saved with tag #{{tags}}.', { tags: names.join(', #') })
      : tr(t, 'sourceTag', 'Saved with a tag you save offline.')
  }
  if (input.automatic) return tr(t, 'sourceAutomatic', 'Saved automatically. Remove it to stop saving it automatically.')
  return ''
}

/**
 * One cloud toggle for the page. Selection source does not change what the toggle does:
 * a saved or selected page is removed (and excluded from automatic saving), any other page is saved.
 */
export const offlinePageControl = (input: OfflinePageControlInput, t: OfflineTranslate): OfflinePageControl => {
  // A toggle keeps one name; aria-pressed tells whether the page is saved.
  const saveLabel = tr(t, 'toggleLabel', 'Save offline')
  const removeLabel = saveLabel
  const holdsCopy = input.selected || input.hasSnapshot
  const result = (
    state: OfflinePageControlState,
    tone: OfflinePageControlTone,
    icon: string,
    action: OfflinePageControlAction,
    title: string,
    detail: string,
    label?: string
  ): OfflinePageControl => {
    const waiting = input.busy && (action === 'save' || action === 'remove')
    return {
      state,
      tone,
      icon,
      action,
      blocked: action === 'none' || waiting,
      label: label ?? (action === 'remove' ? removeLabel : action === 'save' ? saveLabel : title),
      title,
      detail: waiting ? tr(t, 'busyDetail', 'Wait for the current offline change to finish.') : detail,
      pressed: action === 'save' ? false : action === 'remove' ? true : undefined
    }
  }

  if (input.accessState === 'setup-required')
    return result('setup-required', 'action', 'mdi-cloud-lock-outline', 'setup', tr(t, 'setupTitle', 'Set up offline reading'), tr(t, 'setupDetail', 'This page needs private offline reading. Set it up once on this device.'), tr(t, 'setupLabel', 'Set up private offline reading'))
  if (input.accessState === 'locked')
    return result('locked', 'action', 'mdi-cloud-lock-outline', 'unlock', tr(t, 'lockedTitle', 'Offline reading is locked'), tr(t, 'lockedDetail', 'Unlock private offline reading to save this page.'), tr(t, 'lockedLabel', 'Unlock private offline reading'))
  if (input.state === 'downloading')
    return result('downloading', 'warning', 'mdi-cloud-sync-outline', 'none', tr(t, 'savingTitle', 'Saving offline…'), tr(t, 'savingDetail', 'The copy is not ready yet.'), tr(t, 'savingLabel', 'Saving offline copy'))
  if (input.state === 'removing')
    return result('removing', 'neutral', 'mdi-cloud-sync-outline', 'none', tr(t, 'removingTitle', 'Removing offline copy…'), tr(t, 'removingDetail', 'The page will not be saved automatically again.'), tr(t, 'removingLabel', 'Removing offline copy'))
  if (input.state === 'checking')
    return result('checking', 'neutral', 'mdi-cloud-search-outline', 'none', tr(t, 'checkingTitle', 'Checking offline copy…'), tr(t, 'checkingDetail', 'Try again in a moment.'), tr(t, 'checkingLabel', 'Checking offline copy'))

  if (input.localReason) {
    const [key, fallback] = LOCAL_REASONS[input.localReason]
    // A copy that is already held can still be removed, even when a new save is not allowed.
    return result('ineligible', 'muted', 'mdi-cloud-off-outline', holdsCopy ? 'remove' : 'none', tr(t, 'ineligibleTitle', 'Cannot save offline'), tr(t, key, fallback), holdsCopy ? removeLabel : saveLabel)
  }

  const reconnect = tr(t, 'reconnectDetail', 'Reconnect to update it.')
  const syncAgain = tr(t, 'syncAgainDetail', 'Use Sync now in the account menu to try again.')
  const failure = (input.errorDetail ?? '').trim().slice(0, 240)

  if (input.state === 'error')
    return result('error', 'error', 'mdi-cloud-alert-outline', holdsCopy ? 'remove' : 'save', tr(t, 'errorTitle', 'Offline copy failed'), failure || (input.connected ? syncAgain : reconnect))
  if (input.state === 'unavailable')
    return result('unavailable', 'error', 'mdi-cloud-alert-outline', holdsCopy ? 'remove' : 'none', tr(t, 'unavailableTitle', 'Offline saving is unavailable'), failure || tr(t, 'unavailableDetail', 'This browser cannot store offline pages right now.'))

  if (input.state === 'ineligible') {
    if (input.excluded && !holdsCopy)
      return result('off', 'neutral', 'mdi-cloud-download-outline', 'save', tr(t, 'excludedTitle', 'Not saved offline'), tr(t, 'excludedDetail', 'You removed this page, so it is not saved automatically. Select to save it.'))
    if (holdsCopy)
      return result('ineligible', 'muted', 'mdi-cloud-off-outline', 'remove', tr(t, 'ineligibleTitle', 'Cannot save offline'), tr(t, 'deniedSelectedDetail', 'The wiki does not allow an offline copy of this page. Select to remove it from your saved pages.'))
    return result('ineligible', 'muted', 'mdi-cloud-off-outline', 'save', tr(t, 'ineligibleTitle', 'Cannot save offline'), input.quietIneligibility
      ? tr(t, 'deniedDetail', 'The wiki does not allow an offline copy of this page now. Select to try again.')
      : tr(t, 'deniedPrivateDetail', 'This page is not available offline for your account. Select to try again.'))
  }

  const source = offlineSavedSourceDetail(input, t)
  if (input.selected && input.hasValidBody) {
    if (input.state === 'stale')
      return result('stale', 'warning', 'mdi-cloud-refresh-outline', 'remove', tr(t, 'staleTitle', 'Saved offline · out of date'), input.connected ? syncAgain : reconnect)
    if (input.state === 'sync-pending' && input.connected)
      return result('sync-pending', 'warning', 'mdi-cloud-refresh-outline', 'remove', tr(t, 'syncPendingTitle', 'Saved offline · update check failed'), syncAgain)
    if (input.state === 'expiring')
      return result('expiring', 'saved', 'mdi-cloud-clock-outline', 'remove', tr(t, 'expiringTitle', 'Saved offline · expires soon'), input.connected ? source : tr(t, 'expiringOfflineDetail', 'Reconnect to renew it.'))
    return result('saved', 'saved', 'mdi-cloud-check', 'remove', tr(t, 'savedTitle', 'Saved offline'), input.connected || input.state !== 'sync-pending' ? source : tr(t, 'savedOfflineDetail', 'Reconnect to check for updates.'))
  }
  if (input.selected)
    return result('pending', 'warning', 'mdi-cloud-arrow-down-outline', 'remove', tr(t, 'pendingTitle', 'Waiting to save offline'), input.connected ? tr(t, 'pendingDetail', 'The copy is saved at the next sync.') : tr(t, 'pendingOfflineDetail', 'The copy is saved when you reconnect.'))
  if (input.hasSnapshot)
    return result('saved', 'saved', 'mdi-cloud-check', 'remove', tr(t, 'savedTitle', 'Saved offline'), tr(t, 'unselectedCopyDetail', 'A copy is on this device but no longer kept up to date.'))
  return result('off', 'neutral', 'mdi-cloud-download-outline', 'save', tr(t, 'offTitle', 'Save offline'), tr(t, 'offDetail', 'Keep a copy on this device to read without a connection.'))
}
