import { describe, expect, it, vi } from 'vitest'
import { fetchContentExtensions } from './content-extensions-api.ts'

function jsonResponse (payload: unknown, ok = true) {
  return {
    ok,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null
    },
    json: async () => payload
  }
}

const qrStatus = {
  key: 'qr',
  version: 1,
  title: 'QR code',
  description: 'Encode text as a QR code.',
  icon: 'mdi-qrcode',
  isEnabled: true,
  compatible: true,
  diagnostic: null
}

describe('content extensions API', () => {
  it('loads and validates extension availability', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ hostVersion: 1, extensions: [qrStatus] }))

    await expect(fetchContentExtensions(fetchImpl)).resolves.toEqual({
      hostVersion: 1,
      extensions: [qrStatus]
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/content-extensions', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
  })

  it('rejects malformed status and surfaces server diagnostics', async () => {
    const malformedFetch = vi.fn().mockResolvedValue(jsonResponse({ hostVersion: 1, extensions: [{ ...qrStatus, compatible: 'yes' }] }))
    await expect(fetchContentExtensions(malformedFetch)).rejects.toThrow('Content extensions could not be loaded.')

    const failedFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'Extensions unavailable.' }, false))
    await expect(fetchContentExtensions(failedFetch)).rejects.toThrow('Extensions unavailable.')
  })
})
