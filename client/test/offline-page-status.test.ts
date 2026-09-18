import { describe, expect, it } from '../../server/test/bun-test.mts'
import { offlineSavedPageState, offlineSavedPageStatus } from '../helpers/offline-page-status.ts'

const now = Date.parse('2026-09-18T12:00:00Z')
const snapshot = { savedRevision: '12', latestKnownRevision: '12', expiresAt: null, refreshFailed: false, now }

describe('saved page status', () => {
  it('does not call a saved page outdated merely because its latest refresh failed', () => {
    const state = offlineSavedPageState({ ...snapshot, refreshFailed: true })
    expect(state).toBe('sync-pending')
    expect(offlineSavedPageStatus(state, false, true)).toBe('A readable offline copy is saved on this device. Reconnect to check for updates.')
    expect(offlineSavedPageStatus(state, true, true)).toContain('The latest check for updates could not be completed.')
    expect(offlineSavedPageStatus(state, true, true)).not.toMatch(/stale|outdated|newer/iu)
  })

  it('reports a newer version only when a valid known server revision exceeds the saved revision', () => {
    expect(offlineSavedPageState({ ...snapshot, latestKnownRevision: '13' })).toBe('stale')
    expect(offlineSavedPageState({ ...snapshot, savedRevision: '99', latestKnownRevision: '100' })).toBe('stale')
    expect(offlineSavedPageState({ ...snapshot, savedRevision: '9007199254740992', latestKnownRevision: '9007199254740993' })).toBe('stale')
    for (const latestKnownRevision of ['', 'unknown', '012', '11', '12']) {
      expect(offlineSavedPageState({ ...snapshot, latestKnownRevision })).toBe('saved')
    }
    expect(offlineSavedPageState({ ...snapshot, savedRevision: '', latestKnownRevision: '13' })).toBe('saved')
    expect(offlineSavedPageStatus('stale', false, true)).toContain('A newer version was last seen online. Reconnect to update this copy.')
  })

  it('keeps real expiry warnings distinct from an unverified update check', () => {
    const state = offlineSavedPageState({ ...snapshot, expiresAt: '2026-09-19T12:00:00Z', refreshFailed: true })
    expect(state).toBe('expiring')
    expect(offlineSavedPageStatus(state, false, true)).toContain('expires soon. Reconnect to renew it.')
    expect(offlineSavedPageState({ ...snapshot, expiresAt: '2026-10-19T12:00:00Z' })).toBe('saved')
  })

  it('offers reconnection without asserting freshness and retains the continued-sync distinction online', () => {
    expect(offlineSavedPageStatus('saved', false, true)).toContain('Reconnect to check for updates.')
    expect(offlineSavedPageStatus('saved', true, false)).toContain('not included for continued sync')
  })
})
