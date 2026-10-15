import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { fetchAccount, saveAccountProfile } from './account-api.ts'

const account = () => ({
  id: 7,
  name: 'Alex',
  email: 'alex@example.test',
  isActive: true,
  groups: [{ id: 3, name: 'Authors' }],
  fingerprint: 'reviewed-account',
  profile: { name: 'Alex', email: 'alex@example.test', location: 'Tallinn', jobTitle: 'Editor', timezone: 'UTC', groups: [3] },
  availableGroups: [],
  capabilities: { actions: [] },
  history: [],
  contributionCounts: {}
})

afterEach(() => vi.unstubAllGlobals())

describe('account profile DTO boundary', () => {
  it('preserves all profile fields and the review fingerprint when saving an explicit location clear', async () => {
    const initial = account()
    const next = { ...initial, fingerprint: 'next-account', profile: { ...initial.profile, location: '' } }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initial })
      .mockResolvedValueOnce({ ok: true, json: async () => next })
    vi.stubGlobal('window', { fetch })
    const loaded = await fetchAccount(7)
    const draft = { ...loaded.profile, location: '' }
    const saved = await saveAccountProfile(7, draft, 'Review location', loaded.fingerprint)
    expect(saved.profile).toEqual(next.profile)
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body as string)).toEqual({ profile: draft, reason: 'Review location', fingerprint: initial.fingerprint })
    expect(loaded.profile.location).toBe('Tallinn')
  })
})
