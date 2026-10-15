import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { fetchAccount, saveAccountProfile } from './account-api.ts'

const account = () => ({
  id: 7,
  name: 'Alex',
  email: 'alex@example.test',
  isActive: true,
  groups: [{ id: 3, name: 'Authors' }],
  fingerprint: 'reviewed-account',
  profile: { name: 'Alex', email: 'alex@example.test', location: 'Tallinn', jobTitle: 'Editor', pronouns: 'they/them', timezone: 'UTC', groups: [3] },
  availableGroups: [],
  capabilities: { actions: [] },
  history: [],
  contributionCounts: {}
})

afterEach(() => vi.unstubAllGlobals())

describe('account profile DTO boundary', () => {
  it.each([undefined, null, false, [], 'x'.repeat(256)])('refuses malformed pronouns instead of constructing a lossy edit draft (%s)', async pronouns => {
    const payload = account()
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...payload, profile: { ...payload.profile, pronouns } }) })
    vi.stubGlobal('window', { fetch })
    await expect(fetchAccount(7)).rejects.toThrow('The account response could not be read.')
  })

  it('preserves all profile fields and the review fingerprint when saving an explicit pronouns clear', async () => {
    const initial = account()
    const next = { ...initial, fingerprint: 'next-account', profile: { ...initial.profile, pronouns: '' } }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initial })
      .mockResolvedValueOnce({ ok: true, json: async () => next })
    vi.stubGlobal('window', { fetch })
    const loaded = await fetchAccount(7)
    const draft = { ...loaded.profile, pronouns: '' }
    const saved = await saveAccountProfile(7, draft, 'Review pronouns', loaded.fingerprint)
    expect(saved.profile).toEqual(next.profile)
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body as string)).toEqual({ profile: draft, reason: 'Review pronouns', fingerprint: initial.fingerprint })
    expect(loaded.profile.pronouns).toBe('they/them')
  })
})
