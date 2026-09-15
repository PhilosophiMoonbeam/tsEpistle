import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { fetchSiteLogoStatus, retrySiteLogo, SiteLogoApiError, uploadSiteLogo } from './site-logo-api.ts'

const hash = 'a'.repeat(64)
const logoUrl = `/_site-logo/${hash}/logo.png`
const iconUrl = `/_site-logo/${hash}/icon.png`
const faviconIcoUrl = `/_site-logo/${hash}/favicon.ico`
const status = {
  active: {
    revisionId: 'active-revision',
    logoUrl,
    logoIcons: {
      favicon16Url: iconUrl,
      favicon32Url: iconUrl,
      tile150Url: iconUrl,
      apple180Url: iconUrl,
      app192Url: iconUrl,
      app512Url: iconUrl,
      maskable512Url: iconUrl,
      faviconIcoUrl
    },
    enhancement: { status: 'ready', reason: null }
  },
  candidate: { revisionId: 'candidate-revision', status: 'running', errorCode: null }
} as const

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload
  } as Response
}

describe('site logo API', () => {
  it('gets an immutable shared-contract status with the complete v6 active bundle', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status))

    const received = await fetchSiteLogoStatus(fetchImpl)

    expect(received).toEqual(status)
    expect(Object.isFrozen(received)).toBe(true)
    expect(Object.isFrozen(received.active)).toBe(true)
    expect(Object.isFrozen(received.active?.logoIcons)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('/_api/site/logo', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: undefined
    })
  })

  it('accepts a historical active logo with nullable icons while retaining the shared enhancement shape', async () => {
    const historical = {
      active: { revisionId: 'legacy', logoUrl },
      candidate: null
    }
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ...historical,
        active: { ...historical.active, logoIcons: null, enhancement: { status: 'ready', reason: null } }
      })
    )

    await expect(fetchSiteLogoStatus(fetchImpl)).resolves.toMatchObject({ active: { logoIcons: null } })
  })

  it('accepts a published ordinary logo when the optional enhancement is unavailable', async () => {
    const ordinaryOnly = {
      ...status,
      candidate: null,
      active: { ...status.active, enhancement: { status: 'unavailable', reason: 'UNSUITABLE_LOGO' } }
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(ordinaryOnly))

    await expect(fetchSiteLogoStatus(fetchImpl)).resolves.toMatchObject({
      active: { enhancement: { status: 'unavailable', reason: 'UNSUITABLE_LOGO' } }
    })
  })

  it('uploads exactly one image as multipart without overriding the browser content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...status, statusUrl: '/_api/site/logo' }))
    const file = new File(['image bytes'], 'mark.png', { type: 'image/png' })

    await uploadSiteLogo(fetchImpl, file)

    const [url, request] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/_api/site/logo')
    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
    expect(request.headers).not.toHaveProperty('Content-Type')
    expect(request.body).toBeInstanceOf(FormData)
    expect(Array.from((request.body as FormData).keys())).toEqual(['image'])
    const uploaded = (request.body as FormData).get('image') as File
    expect(uploaded).toBeInstanceOf(File)
    expect(uploaded.name).toBe('mark.png')
    expect(uploaded.type).toBe('image/png')
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(new TextEncoder().encode('image bytes'))
  })

  it('retries only through the dedicated endpoint without replaying the selected upload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...status, statusUrl: '/_api/site/logo' }))

    await retrySiteLogo(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/site/logo/retry', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: undefined
    })
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body).toBeUndefined()
  })

  it.each([
    ['upload', 'UNSUPPORTED_IMAGE'],
    ['upload', 'IMAGE_TOO_LARGE'],
    ['upload', 'ARTIFACT_TOO_LARGE'],
    ['retry', 'PROCESSING_FAILED']
  ] as const)('surfaces the allow-listed %s failure code %s', async (operation, code) => {
    const failure = vi.fn().mockResolvedValue(jsonResponse({ error: 'Request failed.', code }, false))
    const request = operation === 'upload' ? uploadSiteLogo(failure, new File(['image bytes'], 'mark.png', { type: 'image/png' })) : retrySiteLogo(failure)

    await expect(request).rejects.toMatchObject({ code })
  })

  it('falls back to null for unknown codes without treating server error text or legacy fields as codes', async () => {
    const failure = vi.fn().mockResolvedValue(jsonResponse({ error: 'UNSUPPORTED_IMAGE', code: 'decoder stack trace', errorCode: 'IMAGE_TOO_LARGE' }, false))

    await expect(retrySiteLogo(failure)).rejects.toMatchObject({ code: null })
  })

  it('rejects malformed shared status objects and untrusted public artifact URLs', async () => {
    const invalidStatuses = [
      { ...status, active: { ...status.active, logoUrl: 'https://example.com/logo.png' } },
      { ...status, active: { ...status.active, logoIcons: { ...status.active.logoIcons, app512Url: 'https://example.com/icon.png' } } },
      { ...status, active: { ...status.active, enhancement: { status: 'unavailable', reason: null } } },
      { ...status, candidate: { ...status.candidate, status: 'unknown' } }
    ]

    for (const invalidStatus of invalidStatuses) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(invalidStatus))
      await expect(fetchSiteLogoStatus(fetchImpl)).rejects.toBeInstanceOf(SiteLogoApiError)
    }
  })
})
