import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { fetchContentExtensions, type ContentExtensionStatus } from './content-extensions-api.ts'

function jsonResponse (payload: unknown, ok = true) {
  return {
    ok,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null
    },
    json: async () => payload
  }
}

const qrStatus: ContentExtensionStatus = {
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

    expect(await fetchContentExtensions(fetchImpl)).toEqual({
      hostVersion: 1,
      extensions: [qrStatus]
    })
  })

  it('rejects malformed availability and failed responses', async () => {
    const malformedFetch = vi.fn().mockResolvedValue(jsonResponse({ hostVersion: 1, extensions: [{ ...qrStatus, compatible: 'yes' }] }))
    await expect(Promise.resolve(fetchContentExtensions(malformedFetch))).rejects.toThrow()

    const failedFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'Extensions unavailable.' }, false))
    await expect(Promise.resolve(fetchContentExtensions(failedFetch))).rejects.toThrow()
  })
})
