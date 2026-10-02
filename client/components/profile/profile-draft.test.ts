import { describe, expect, test } from '../../../server/test/bun-test.mts'
import type { Profile } from '../../helpers/users-api.ts'
import {
  changedProfileFields,
  profileDraftIssues,
  restoreProfileDraft,
  restoreProfileField,
  snapshotProfileDraft,
  timezoneOptions
} from './profile-draft.ts'

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  id: 1, email: 'reader@example.test', name: 'Reader', handle: 'reader', providerKey: 'local',
  providerName: 'Local', pictureUrl: null, isSystem: false, isVerified: true, location: '', jobTitle: '',
  timezone: 'UTC', dateFormat: '', timeFormat: 'locale', appearance: 'light', reduceMotion: false,
  underlineLinks: false, contentTextSize: 'default', communicationLocale: null,
  createdAt: '', updatedAt: '', lastLoginAt: '', groups: [], pagesTotal: 0, ...overrides
})

describe('profile draft model', () => {
  test('snapshots only editable fields and lists changes in display order', () => {
    const current = profile()
    const saved = snapshotProfileDraft(current)
    expect(Object.keys(saved)).not.toContain('email')
    current.underlineLinks = true
    current.name = 'Renamed'
    current.communicationLocale = 'fr'
    expect(changedProfileFields(saved, current)).toEqual(['name', 'underlineLinks', 'communicationLocale'])
    // The snapshot is a copy, not a view of the live record.
    expect(saved.name).toBe('Reader')
  })

  test('restores one field or the whole draft from the saved snapshot', () => {
    const current = profile()
    const saved = snapshotProfileDraft(current)
    current.appearance = 'dark'
    current.jobTitle = 'Archivist'
    expect(restoreProfileField(current, saved, 'location')).toBe(false)
    expect(restoreProfileField(current, saved, 'appearance')).toBe(true)
    expect(changedProfileFields(saved, current)).toEqual(['jobTitle'])
    restoreProfileDraft(current, saved)
    expect(changedProfileFields(saved, current)).toEqual([])
    expect(current.email).toBe('reader@example.test')
  })

  test('mirrors the server name and mention-handle rules', () => {
    expect(profileDraftIssues({ name: 'Reader', handle: '' })).toEqual({})
    expect(profileDraftIssues({ name: '  ', handle: ' Mixed_Case-1 ' })).toEqual({ name: 'nameRequired' })
    expect(profileDraftIssues({ name: 'x'.repeat(256), handle: 'ab' })).toEqual({ name: 'nameTooLong', handle: 'handleInvalid' })
    expect(profileDraftIssues({ name: 'Reader', handle: 'no spaces' })).toEqual({ handle: 'handleInvalid' })
    expect(profileDraftIssues({ name: 'Reader', handle: 'x'.repeat(33) })).toEqual({ handle: 'handleInvalid' })
  })

  test('lists searchable IANA time zones by UTC offset and keeps a saved legacy alias', () => {
    const winter = new Date('2026-01-15T12:00:00Z')
    const options = timezoneOptions('Asia/Saigon', winter)
    const values = options.map(option => option.value)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain('UTC')
    expect(values).toContain('Asia/Saigon')
    expect(options.find(option => option.value === 'America/Los_Angeles')?.title).toBe('(GMT-08:00) America/Los Angeles')
    expect(options.find(option => option.value === 'Asia/Kolkata')?.title).toBe('(GMT+05:30) Asia/Kolkata')
    expect(options.find(option => option.value === 'UTC')?.title).toBe('(GMT+00:00) UTC')
    const offsets = options.map(option => option.title.slice(1, 10))
    const minutes = offsets.map(label => (label[3] === '-' ? -1 : 1) * (Number(label.slice(4, 6)) * 60 + Number(label.slice(7, 9))))
    expect(minutes).toEqual([...minutes].sort((left, right) => left - right))
    expect(timezoneOptions('Not/AZone', winter).some(option => option.value === 'Not/AZone')).toBe(false)
  })
})
