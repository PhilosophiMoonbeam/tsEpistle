import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { commitLocaleUninstall, reviewLocaleUninstall } from './locale-workspace-api.ts'

const reviewed = {
  code: 'fr',
  name: 'French',
  nativeName: 'Français',
  reason: 'Retire unused French interface',
  expiresAt: '2030-01-01T00:00:00.000Z',
  token: 'opaque-signed-review',
  catalogRetained: true,
  blockers: [{ source: 'pages.localeCode', count: 2 }]
}
afterEach(() => vi.restoreAllMocks())

describe('reviewed locale package removal client transport', () => {
  it('requests server reference checks with explicit code, current fingerprint and administrative reason', async () => {
    const fetch = vi.spyOn(window, 'fetch').mockResolvedValue(Response.json(reviewed))
    expect(await reviewLocaleUninstall('fr', 'workspace-fingerprint', reviewed.reason)).toEqual(reviewed)
    expect(fetch).toHaveBeenCalledWith(
      '/_api/locales/workspace/uninstall/review',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ code: 'fr', fingerprint: 'workspace-fingerprint', reason: reviewed.reason })
      })
    )
  })

  it('rejects malformed blockers and unconfirmed write outcomes instead of presenting successful removal', async () => {
    const fetch = vi.spyOn(window, 'fetch')
    fetch.mockResolvedValueOnce(Response.json({ ...reviewed, blockers: [{ source: 'pages.localeCode', count: '0' }] }))
    await expect(reviewLocaleUninstall('fr', 'workspace-fingerprint', reviewed.reason)).rejects.toThrow('could not be read')
    fetch.mockResolvedValueOnce(Response.json({ success: true }))
    await expect(commitLocaleUninstall(reviewed.token)).rejects.toThrow('unconfirmed')
  })

  it('confirms only signed intent and distinguishes committed removal needing runtime attention from a failed write', async () => {
    const fetch = vi.spyOn(window, 'fetch').mockResolvedValueOnce(Response.json({ activation: 'needs-attention' }))
    expect(await commitLocaleUninstall(reviewed.token)).toEqual({ activation: 'needs-attention' })
    expect(fetch).toHaveBeenCalledWith(
      '/_api/locales/workspace/uninstall/commit',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ token: reviewed.token })
      })
    )
    fetch.mockResolvedValueOnce(Response.json({ error: 'Private pages still reference this package.' }, { status: 409 }))
    await expect(commitLocaleUninstall(reviewed.token)).rejects.toMatchObject({ status: 409, message: 'Private pages still reference this package.' })
  })
})
