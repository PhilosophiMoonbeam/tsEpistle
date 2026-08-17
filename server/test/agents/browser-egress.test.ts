import { describe, expect, it } from 'vitest'
import { assertPublicBrowserTarget, type BrowserDnsResolver } from '../../agents/browser/egress.ts'

const resolver = (v4: readonly string[], v6: readonly string[] = []): BrowserDnsResolver => ({ async resolve4() { return v4 }, async resolve6() { return v6 } })

describe('browser egress DNS guard', () => {
  it('allows a hostname only when every resolution is globally routable', async () => {
    await expect(assertPublicBrowserTarget('https://example.com/', resolver(['93.184.216.34']))).resolves.toBeUndefined()
    await expect(assertPublicBrowserTarget('https://example.com/', resolver([], ['2606:4700::6810:85e5']))).resolves.toBeUndefined()
    await expect(assertPublicBrowserTarget('https://example.com/', resolver(['93.184.216.34', '169.254.169.254']))).rejects.toMatchObject({ code: 'BROWSER_EGRESS_DENIED' })
  })
  it.each(['https://127.0.0.1/', 'https://10.0.0.1/', 'https://[::1]/', 'https://[fc00::1]/'])('rejects literal private and local targets: %s', async url => {
    await expect(assertPublicBrowserTarget(url, resolver([]))).rejects.toMatchObject({ code: 'BROWSER_EGRESS_DENIED' })
  })
  it('fails closed when DNS has no address', async () => {
    await expect(assertPublicBrowserTarget('https://example.com/', resolver([]))).rejects.toMatchObject({ code: 'BROWSER_DNS_FAILED' })
  })
})
