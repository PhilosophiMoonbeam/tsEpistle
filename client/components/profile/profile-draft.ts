import type { Profile } from '../../helpers/users-api.ts'

/** Fields saved through `PATCH /_api/users/profile`. */
export const PROFILE_DETAIL_FIELDS = ['name', 'handle', 'location', 'jobTitle', 'timezone', 'dateFormat', 'timeFormat', 'appearance'] as const
/** Fields saved through `PATCH /_api/users/profile/preferences`. */
export const PROFILE_PREFERENCE_FIELDS = ['reduceMotion', 'underlineLinks', 'contentTextSize', 'communicationLocale'] as const

export type ProfileDetailField = (typeof PROFILE_DETAIL_FIELDS)[number]
export type ProfilePreferenceField = (typeof PROFILE_PREFERENCE_FIELDS)[number]
export type ProfileDraftField = ProfileDetailField | ProfilePreferenceField
export type ProfileDraft = Pick<Profile, ProfileDraftField>
export type ProfileDraftIssue = 'nameRequired' | 'nameTooLong' | 'handleInvalid'

const DRAFT_FIELDS: readonly ProfileDraftField[] = [...PROFILE_DETAIL_FIELDS, ...PROFILE_PREFERENCE_FIELDS]
const NAME_MAX_LENGTH = 255
// Mirrors the server rule in `server/models/users.ts` before lowercasing.
const MENTION_HANDLE = /^[A-Za-z0-9_-]{3,32}$/

export const snapshotProfileDraft = (profile: ProfileDraft): ProfileDraft => ({
  name: profile.name,
  handle: profile.handle,
  location: profile.location,
  jobTitle: profile.jobTitle,
  timezone: profile.timezone,
  dateFormat: profile.dateFormat,
  timeFormat: profile.timeFormat,
  appearance: profile.appearance,
  reduceMotion: profile.reduceMotion,
  underlineLinks: profile.underlineLinks,
  contentTextSize: profile.contentTextSize,
  communicationLocale: profile.communicationLocale
})

/** Lists draft fields whose current value differs from the saved value, in display order. */
export const changedProfileFields = (saved: ProfileDraft, current: ProfileDraft): ProfileDraftField[] =>
  DRAFT_FIELDS.filter(field => saved[field] !== current[field])

/** Restores one field from the saved snapshot. Returns false when nothing changed. */
export const restoreProfileField = (target: ProfileDraft, saved: ProfileDraft, field: ProfileDraftField): boolean => {
  if (target[field] === saved[field]) return false
  Object.assign(target, { [field]: saved[field] })
  return true
}

/** Restores every draft field from the saved snapshot. */
export const restoreProfileDraft = (target: ProfileDraft, saved: ProfileDraft): void => {
  Object.assign(target, snapshotProfileDraft(saved))
}

export const profileDraftIssues = (draft: Pick<ProfileDraft, 'name' | 'handle'>): Partial<Record<'name' | 'handle', ProfileDraftIssue>> => {
  const issues: Partial<Record<'name' | 'handle', ProfileDraftIssue>> = {}
  const name = draft.name.trim()
  if (!name) issues.name = 'nameRequired'
  else if (name.length > NAME_MAX_LENGTH) issues.name = 'nameTooLong'
  const handle = draft.handle.trim()
  if (handle && !MENTION_HANDLE.test(handle)) issues.handle = 'handleInvalid'
  return issues
}

export type TimezoneOption = { title: string; value: string }

const offsetMinutes = (label: string): number => {
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(label)
  if (!match) return 0
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return match[1] === '-' ? -minutes : minutes
}

const formatOffset = (minutes: number): string => {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `GMT${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

const describeTimezone = (zone: string, now: Date): { option: TimezoneOption; offset: number } | null => {
  try {
    const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find(part => part.type === 'timeZoneName')?.value
    const offset = offsetMinutes(label ?? 'GMT')
    return { offset, option: { value: zone, title: `(${formatOffset(offset)}) ${zone.replace(/_/g, ' ')}` } }
  } catch {
    return null
  }
}

const supportedTimezones = (): string[] => {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
  try {
    return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : []
  } catch {
    return []
  }
}

/**
 * Builds searchable IANA time-zone options sorted by current UTC offset.
 * The saved zone stays selectable even when the runtime lists only its canonical alias.
 */
export const timezoneOptions = (current: string, now = new Date()): TimezoneOption[] => {
  const zones = new Set(supportedTimezones())
  zones.add('UTC')
  if (current) zones.add(current)
  return [...zones]
    .map(zone => describeTimezone(zone, now))
    .filter((entry): entry is { option: TimezoneOption; offset: number } => entry !== null)
    .sort((left, right) => left.offset - right.offset || left.option.value.localeCompare(right.option.value))
    .map(entry => entry.option)
}
