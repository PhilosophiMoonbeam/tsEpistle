import { applyLoggingWorkspace, fetchLoggingWorkspace, saveLoggingWorkspace } from './logging-workspace-api.ts'

const json = (payload, status = 200) => ({ ok: status < 400, status, headers: { has: () => false }, json: async () => payload })
const workspace = () => ({
  fingerprint: 'f'.repeat(64),
  revision: 'revision-1',
  observedAt: '2026-02-01T00:00:00.000Z',
  console: { level: 'info', format: 'default' },
  destinations: [
    {
      key: 'sentry',
      title: 'Sentry',
      isEnabled: false,
      availability: 'available',
      level: 'warn',
      fields: [],
      config: {},
      secrets: {},
      runtime: { state: 'inactive', message: null }
    }
  ],
  runtime: { settingsCurrent: false, state: 'unapplied' },
  history: [],
  liveTrail: { enabled: true, maxLines: 500, maxBytes: 262144, maxConnectionEvents: 1000, message: 'ephemeral' }
})
const draft = () => ({
  fingerprint: 'f'.repeat(64),
  reason: 'Review logging policy',
  console: { level: 'info', format: 'default' },
  destinations: [{ key: 'sentry', isEnabled: false, level: 'warn', config: {}, secrets: {} }]
})

let fetch
beforeEach(() => {
  fetch = vi.fn()
  vi.stubGlobal('window', { fetch })
})

describe('Logging workspace requests and recovery', () => {
  it('validates the workspace shape before allowing an administrative draft', async () => {
    fetch.mockResolvedValueOnce(json({ ...workspace(), runtime: { settingsCurrent: 'yes' } }))
    await expect(fetchLoggingWorkspace()).rejects.toThrow('workspace response is invalid')
  })

  it('classifies local draft validation as a confirmed editable rejection', async () => {
    const invalid = draft()
    invalid.destinations[0].secrets = { key: { action: 'replace', value: '   ' } }

    await expect(saveLoggingWorkspace(invalid)).rejects.toMatchObject({
      status: 400,
      confirmed: true,
      message: 'Review the complete logging configuration before saving.'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not replay an unconfirmed reviewed save', async () => {
    fetch.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(saveLoggingWorkspace(draft())).rejects.toThrow('Connection lost')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]).toEqual(['/_api/logging/workspace', expect.objectContaining({ method: 'PUT', credentials: 'same-origin' })])
  })

  it('preserves a 5xx publication status for recovery handling', async () => {
    fetch.mockResolvedValueOnce(json({ error: 'Logging administration is unavailable.' }, 503))
    await expect(applyLoggingWorkspace('f'.repeat(64))).rejects.toMatchObject({ status: 503 })
  })

  it('keeps a conflict observable and applies only a saved fingerprint', async () => {
    fetch.mockResolvedValueOnce(json({ error: 'Logging settings changed' }, 409))
    await expect(applyLoggingWorkspace('f'.repeat(64))).rejects.toMatchObject({ status: 409, message: 'Logging settings changed' })
    fetch.mockResolvedValueOnce(json(workspace()))
    await expect(fetchLoggingWorkspace()).resolves.toMatchObject({ fingerprint: 'f'.repeat(64), runtime: { settingsCurrent: false } })
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'GET', credentials: 'same-origin' })
  })
})
