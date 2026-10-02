import { describe, expect, it } from '../../server/test/bun-test.mts'
import {
  type OfflinePageControlInput,
  offlineIneligibilityIsQuiet,
  offlinePageControl,
  offlineSavedPageState,
  offlineSavedSourceDetail
} from '../helpers/offline-page-status.ts'

/** Returns the English default so tests read like the UI. */
const t = (_key: string, options: Record<string, unknown> = {}): string =>
  String(options.defaultValue ?? '').replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ''))

const now = Date.parse('2026-09-18T12:00:00Z')
const snapshot = { savedRevision: '12', latestKnownRevision: '12', expiresAt: null, refreshFailed: false, now }

describe('saved page status', () => {
  it('does not call a saved page outdated merely because its latest refresh failed', () => {
    const state = offlineSavedPageState({ ...snapshot, refreshFailed: true })
    expect(state).toBe('sync-pending')
  })

  it('reports a newer version only when a valid known server revision exceeds the saved revision', () => {
    expect(offlineSavedPageState({ ...snapshot, latestKnownRevision: '13' })).toBe('stale')
    expect(offlineSavedPageState({ ...snapshot, savedRevision: '99', latestKnownRevision: '100' })).toBe('stale')
    expect(offlineSavedPageState({ ...snapshot, savedRevision: '9007199254740992', latestKnownRevision: '9007199254740993' })).toBe('stale')
    for (const latestKnownRevision of ['', 'unknown', '012', '11', '12']) {
      expect(offlineSavedPageState({ ...snapshot, latestKnownRevision })).toBe('saved')
    }
    expect(offlineSavedPageState({ ...snapshot, savedRevision: '', latestKnownRevision: '13' })).toBe('saved')
  })

  it('keeps real expiry warnings distinct from an unverified update check', () => {
    const state = offlineSavedPageState({ ...snapshot, expiresAt: '2026-09-19T12:00:00Z', refreshFailed: true })
    expect(state).toBe('expiring')
    expect(offlineSavedPageState({ ...snapshot, expiresAt: '2026-10-19T12:00:00Z' })).toBe('saved')
  })

  it('reveals saved-tag provenance only when tag names may be disclosed', () => {
    const tag = { manual: false, automatic: false, tag: true, tagNames: ['docs'], revealTagNames: true }
    expect(offlineSavedSourceDetail(tag, t)).toBe('Saved with tag #docs.')
    expect(offlineSavedSourceDetail({ ...tag, tagNames: ['private-tag-sentinel'], revealTagNames: false }, t)).not.toContain('private-tag-sentinel')
  })
})

describe('ineligible page status', () => {
  const automaticDenial = {
    serverDenied: true,
    selected: false,
    hasSnapshot: false,
    excluded: false,
    localReason: ''
  }

  it('quietly presents an automatic-only server denial after selection and bodies are removed', () => {
    expect(offlineIneligibilityIsQuiet(automaticDenial)).toBe(true)
  })

  it('keeps explicit manual, tag, or mixed selection denials actionable', () => {
    expect(offlineIneligibilityIsQuiet({ ...automaticDenial, selected: true })).toBe(false)
  })

  it('does not hide retained bodies, local eligibility reasons, exclusions, or non-authoritative failures', () => {
    expect(offlineIneligibilityIsQuiet({ ...automaticDenial, hasSnapshot: true })).toBe(false)
    expect(offlineIneligibilityIsQuiet({ ...automaticDenial, localReason: 'Private pages cannot be saved offline.' })).toBe(false)
    expect(offlineIneligibilityIsQuiet({ ...automaticDenial, excluded: true })).toBe(false)
    expect(offlineIneligibilityIsQuiet({ ...automaticDenial, serverDenied: false })).toBe(false)
  })
  it('keeps authoritative private denials visible even when only automatic selection was attempted', () => {
    expect(offlineIneligibilityIsQuiet({ ...automaticDenial, privatePath: true })).toBe(false)
  })

})

describe('offline page toggle', () => {
  const base: OfflinePageControlInput = {
    state: 'eligible',
    accessState: null,
    selected: false,
    hasSnapshot: false,
    hasValidBody: false,
    excluded: false,
    manual: false,
    automatic: false,
    tag: false,
    tagNames: [],
    revealTagNames: true,
    quietIneligibility: false,
    localReason: '',
    connected: true,
    busy: false
  }
  const saved = { ...base, state: 'saved', selected: true, hasSnapshot: true, hasValidBody: true }

  it('saves an unsaved page and removes a saved page the same way for every selection source', () => {
    const off = offlinePageControl(base, t)
    expect(off).toMatchObject({ state: 'off', tone: 'neutral', action: 'save', blocked: false, pressed: false, label: 'Save offline' })
    for (const source of [{ manual: true }, { automatic: true }, { tag: true, tagNames: ['docs'] }]) {
      const control = offlinePageControl({ ...saved, ...source }, t)
      expect(control).toMatchObject({ state: 'saved', tone: 'saved', icon: 'mdi-cloud-check', action: 'remove', blocked: false, pressed: true, label: 'Save offline' })
    }
    expect(offlinePageControl({ ...saved, automatic: true }, t).detail).toContain('stop saving it automatically')
  })

  it('offers to save an excluded page again and says why it is not saved', () => {
    const control = offlinePageControl({ ...base, state: 'ineligible', excluded: true }, t)
    expect(control).toMatchObject({ state: 'off', action: 'save', blocked: false })
    expect(control.detail).toContain('You removed this page')
  })

  it('uses one tone per meaning so saved, needs-sync, failed and cannot-save look different', () => {
    expect(offlinePageControl({ ...saved, state: 'stale' }, t).tone).toBe('warning')
    expect(offlinePageControl({ ...saved, state: 'sync-pending' }, t).tone).toBe('warning')
    expect(offlinePageControl({ ...saved, state: 'expiring' }, t).tone).toBe('saved')
    expect(offlinePageControl({ ...base, state: 'error' }, t).tone).toBe('error')
    expect(offlinePageControl({ ...base, state: 'unavailable' }, t).tone).toBe('error')
    expect(offlinePageControl({ ...base, localReason: 'unpublished' }, t).tone).toBe('muted')
    expect(offlinePageControl({ ...base, accessState: 'locked' }, t)).toMatchObject({ tone: 'action', action: 'unlock' })
    expect(offlinePageControl({ ...base, accessState: 'setup-required' }, t)).toMatchObject({ tone: 'action', action: 'setup' })
  })

  it('explains a page that cannot be saved instead of only disabling the toggle', () => {
    const control = offlinePageControl({ ...base, state: 'ineligible', localReason: 'protected' }, t)
    expect(control).toMatchObject({ state: 'ineligible', action: 'none', blocked: true, title: 'Cannot save offline' })
    expect(control.detail).toBe('Password-protected pages cannot be saved offline.')
    expect(offlinePageControl({ ...base, localReason: 'editor' }, t).detail).toBe('Pages from this editor cannot be saved offline.')
    // A held copy can still be removed when a new save is not allowed.
    expect(offlinePageControl({ ...saved, localReason: 'unpublished' }, t)).toMatchObject({ action: 'remove', blocked: false })
    // A server refusal keeps the toggle usable to try again and says what happened.
    const denied = offlinePageControl({ ...base, state: 'ineligible', quietIneligibility: true }, t)
    expect(denied).toMatchObject({ action: 'save', blocked: false })
    expect(denied.detail).toContain('does not allow an offline copy')
  })

  it('names the server refusal reason when the last sync stored one', () => {
    const renderPending = offlinePageControl({ ...base, state: 'ineligible', serverReason: 'render-pending' }, t)
    expect(renderPending).toMatchObject({ state: 'ineligible', tone: 'muted', action: 'save', blocked: false })
    expect(renderPending.detail).toBe('The wiki has not rendered the latest version of this page yet. Select to try again.')
    const held = offlinePageControl({ ...base, state: 'ineligible', selected: true, manual: true, serverReason: 'custom-content' }, t)
    expect(held).toMatchObject({ action: 'remove', pressed: true })
    expect(held.detail).toBe('Pages with scripts or custom content cannot be saved offline. Select to remove it from your saved pages.')
    expect(offlinePageControl({ ...base, state: 'ineligible', serverReason: 'too-large' }, t).detail).toContain('too large')
    // Without a reason the general sentence stays; an excluded page still explains the exclusion.
    expect(offlinePageControl({ ...base, state: 'ineligible', serverReason: null }, t).detail).toContain('not available offline for your account')
    expect(offlinePageControl({ ...base, state: 'ineligible', excluded: true, serverReason: 'editor' }, t).detail).toContain('You removed this page')
  })

  it('blocks a second change while one runs and shows the failure detail', () => {
    const busy = offlinePageControl({ ...saved, busy: true }, t)
    expect(busy).toMatchObject({ action: 'remove', blocked: true, detail: 'Wait for the current offline change to finish.' })
    expect(offlinePageControl({ ...base, state: 'downloading' }, t)).toMatchObject({ blocked: true, tone: 'warning' })
    expect(offlinePageControl({ ...base, state: 'error', errorDetail: 'Quota exceeded.' }, t).detail).toBe('Quota exceeded.')
    expect(offlinePageControl({ ...base, state: 'error', connected: false }, t).detail).toBe('Reconnect to update it.')
  })

  it('reports a selected page without a copy as waiting, not saved', () => {
    const pending = offlinePageControl({ ...base, selected: true }, t)
    expect(pending).toMatchObject({ state: 'pending', tone: 'warning', action: 'remove' })
    expect(offlinePageControl({ ...base, selected: true, connected: false }, t).detail).toBe('The copy is saved when you reconnect.')
  })
})
