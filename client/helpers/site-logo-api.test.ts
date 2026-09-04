import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { fetchSiteLogoStatus, retrySiteLogo, SiteLogoApiError, uploadSiteLogo } from './site-logo-api.ts'

const hash = 'a'.repeat(64)
const status = {
  active: { revisionId: 'active-revision', logoUrl: `/_site-logo/${hash}/logo.png` },
  candidate: { revisionId: 'candidate-revision', status: 'running', errorCode: null }
}

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload
  } as Response
}

describe('site logo API', () => {
  it('gets and validates the managed active and candidate status from the same-origin endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status))

    await expect(fetchSiteLogoStatus(fetchImpl)).resolves.toEqual(status)
    expect(fetchImpl).toHaveBeenCalledWith('/_api/site/logo', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: undefined
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

  it('retries only through the dedicated endpoint without a request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...status, statusUrl: '/_api/site/logo' }))

    await retrySiteLogo(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith('/_api/site/logo/retry', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: undefined
    })
  })

  it.each([
    ['upload', 'UNSUPPORTED_IMAGE'],
    ['upload', 'IMAGE_TOO_LARGE'],
    ['upload', 'ARTIFACT_TOO_LARGE'],
    ['retry', 'MANAGED_LOGO_CONFLICT']
  ] as const)('surfaces the allow-listed %s failure code %s', async (operation, code) => {
    const failure = vi.fn().mockResolvedValue(jsonResponse({ error: 'Request failed.', code }, false))
    const request = operation === 'upload' ? uploadSiteLogo(failure, new File(['image bytes'], 'mark.png', { type: 'image/png' })) : retrySiteLogo(failure)

    await expect(request).rejects.toMatchObject<Partial<SiteLogoApiError>>({ code })
  })

  it('falls back to null for unknown codes without treating server error text or legacy fields as codes', async () => {
    const failure = vi.fn().mockResolvedValue(jsonResponse({ error: 'UNSUPPORTED_IMAGE', code: 'decoder stack trace', errorCode: 'IMAGE_TOO_LARGE' }, false))

    await expect(retrySiteLogo(failure)).rejects.toMatchObject<Partial<SiteLogoApiError>>({ code: null })
  })

  it('accepts allow-listed errorCode values in candidate status payloads', async () => {
    const failedStatus = {
      ...status,
      candidate: { revisionId: 'candidate-revision', status: 'failed', errorCode: 'ARTIFACT_TOO_LARGE' }
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(failedStatus))

    await expect(fetchSiteLogoStatus(fetchImpl)).resolves.toEqual(failedStatus)
  })

  it('rejects untrusted response URLs', async () => {
    const invalidStatus = vi.fn().mockResolvedValue(
      jsonResponse({
        ...status,
        active: { revisionId: 'active-revision', logoUrl: 'https://example.com/logo.png' }
      })
    )

    await expect(fetchSiteLogoStatus(invalidStatus)).rejects.toBeInstanceOf(SiteLogoApiError)
  })
})
