import { startMailCheck, fetchMailCheck, saveMailWorkspace, fetchMailPreview } from './mail-workspace-api.ts'
const json = (payload, status = 200) => ({ ok: status < 400, status, headers: { has: () => false }, json: async () => payload })
let fetch
beforeEach(() => {
  fetch = vi.fn()
  vi.stubGlobal('window', { fetch })
})
describe('Mail workspace requests and recovery', () => {
  it('does not automatically replay a test after a lost response', async () => {
    fetch.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(
      startMailCheck({ id: 'check-id', kind: 'test', fingerprint: 'review', recipient: 'recipient@example.test', confirmSend: true })
    ).rejects.toThrow('Connection lost')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe('/_api/mail/checks')
    expect(request.method).toBe('POST')
    expect(JSON.parse(request.body)).toMatchObject({ id: 'check-id', confirmSend: true })
  })
  it('recovers an existing receipt with a read-only request and checks its identity', async () => {
    fetch.mockResolvedValueOnce(json({ id: 'known-id', state: 'uncertain', summary: 'Check the recipient mailbox.' }))
    expect((await fetchMailCheck('known-id')).state).toBe('uncertain')
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin' })
    expect(fetch.mock.calls[0][1].body).toBeUndefined()
    fetch.mockResolvedValueOnce(json({ id: 'wrong-id', state: 'succeeded', summary: 'Accepted' }))
    await expect(fetchMailCheck('known-id')).rejects.toThrow('could not be confirmed')
  })
  it('distinguishes saved-but-unapplied settings, preserves conflict status and rejects malformed previews', async () => {
    fetch.mockResolvedValueOnce(json({ revision: 'saved-revision', applied: false }))
    expect(await saveMailWorkspace({})).toEqual({ revision: 'saved-revision', applied: false })
    fetch.mockResolvedValueOnce(json({ error: 'Settings changed' }, 409))
    await expect(saveMailWorkspace({})).rejects.toMatchObject({ status: 409, message: 'Settings changed' })
    fetch.mockResolvedValueOnce(json({ key: 'test', html: '<p>Preview</p>' }))
    await expect(fetchMailPreview('test')).rejects.toThrow('could not be loaded')
  })
})
