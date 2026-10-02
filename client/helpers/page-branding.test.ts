import { describe, expect, it } from '../../server/test/bun-test.mts'
import {
  brandingDuplicatesSiteLogo,
  normalizePageBrandingView,
  normalizeSiteLogoSourceSha256,
  pageBrandingIdentity,
  resolvePageBrandingStyle
} from './page-branding.ts'
import type { PageBrandingView } from '../../shared/page-branding.ts'

const sourceSha256 = 'a'.repeat(64)
const baseBranding = {
  assetId: 7,
  imageUrl: `/assets/page-branding/logo.png?v=${sourceSha256}`,
  sourceSha256,
  width: 320,
  height: 180
}

type BrandingInput = Record<string, unknown>
const withoutAccent: BrandingInput = { ...baseBranding }

const withBranding = (overrides: BrandingInput = {}): BrandingInput => ({
  ...baseBranding,
  accent: '#0c2238',
  ...overrides
})

describe('page branding client helper', () => {
  it('keeps a valid image when accent is absent, null, or malformed and resolves no style', () => {
    const inputs: BrandingInput[] = [
      withoutAccent,
      withBranding({ accent: undefined }),
      withBranding({ accent: null }),
      withBranding({ accent: 'not-a-color' }),
      withBranding({ accent: { red: 12 } })
    ]

    for (const input of inputs) {
      const normalized = normalizePageBrandingView(input)
      expect(normalized).not.toBeNull()
      expect(normalized).toMatchObject({
        assetId: baseBranding.assetId,
        imageUrl: baseBranding.imageUrl,
        sourceSha256: baseBranding.sourceSha256,
        width: baseBranding.width,
        height: baseBranding.height,
        accent: null
      })
      expect(resolvePageBrandingStyle(normalized)).toEqual({})
    }
  })

  it('rejects descriptors with an invalid identity, URL digest, or dimensions', () => {
    const invalidDescriptors: BrandingInput[] = [
      withBranding({ assetId: 0 }),
      withBranding({ assetId: '7' }),
      withBranding({ sourceSha256: 'not-a-sha256' }),
      withBranding({ imageUrl: `/assets/page-branding/logo.png?v=${'b'.repeat(64)}` }),
      withBranding({ width: 0 }),
      withBranding({ height: -1 }),
      withBranding({ width: 1.5 }),
      withBranding({ height: 4_097 })
    ]

    for (const descriptor of invalidDescriptors) {
      expect(normalizePageBrandingView(descriptor)).toBeNull()
    }
  })

  it('emits accent RGB channels with translucent CSS alpha in both color modes', () => {
    const normalized = normalizePageBrandingView(withBranding())
    expect(normalized).not.toBeNull()

    for (const dark of [false, true]) {
      const style = resolvePageBrandingStyle(normalized, null, dark)
      expect(style['--page-branding-rgb']).toBe('12 34 56')
      const alpha = Number(style['--page-branding-alpha'])
      expect(Number.isFinite(alpha)).toBe(true)
      expect(alpha).toBeGreaterThan(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('suppresses style only when the current branding identity has failed', () => {
    const normalized = normalizePageBrandingView(withBranding()) as PageBrandingView
    const identity = pageBrandingIdentity(normalized)

    expect(resolvePageBrandingStyle(normalized, identity)).toEqual({})

    const changedDigest = 'b'.repeat(64)
    const refreshed = normalizePageBrandingView(withBranding({
      sourceSha256: changedDigest,
      imageUrl: `/assets/page-branding/logo.png?v=${changedDigest}`
    })) as PageBrandingView
    const differentAsset = normalizePageBrandingView(withBranding({ assetId: 8 })) as PageBrandingView

    for (const changed of [refreshed, differentAsset]) {
      expect(changed).not.toBeNull()
      expect(pageBrandingIdentity(changed)).not.toBe(identity)
      expect(resolvePageBrandingStyle(changed, identity)['--page-branding-rgb']).toBe('12 34 56')
    }
  })
})

describe('brandingDuplicatesSiteLogo', () => {
  const branding = (imageUrl: string, sha = sourceSha256) => ({ imageUrl, sourceSha256: sha })

  it('matches the same file regardless of version query strings', () => {
    expect(brandingDuplicatesSiteLogo(branding('/assets/logo.png?v=abc'), { logoUrl: '/assets/logo.png' })).toBe(true)
    expect(brandingDuplicatesSiteLogo(branding('/assets/a%20b.png?v=1'), { logoUrl: '/assets/a b.png?v=2' })).toBe(true)
  })

  it('matches the processed site logo by its uploaded source digest', () => {
    const site = { logoUrl: `/_site-logo/${'c'.repeat(64)}/logo.png`, logoSourceSha256: sourceSha256 }
    expect(brandingDuplicatesSiteLogo(branding(`/assets/home-mark.png?v=${sourceSha256}`), site)).toBe(true)
    expect(brandingDuplicatesSiteLogo(branding(`/assets/other.png?v=${'d'.repeat(64)}`, 'd'.repeat(64)), site)).toBe(false)
  })

  it('keeps distinct or missing images', () => {
    expect(brandingDuplicatesSiteLogo(branding('/assets/page.png?v=abc'), { logoUrl: '/_site-logo/abc/logo.png' })).toBe(false)
    expect(brandingDuplicatesSiteLogo(undefined, { logoUrl: '/assets/logo.png', logoSourceSha256: sourceSha256 })).toBe(false)
    expect(brandingDuplicatesSiteLogo(branding('/assets/logo.png'), { logoUrl: '' })).toBe(false)
    expect(brandingDuplicatesSiteLogo(branding('/assets/logo.png'), null)).toBe(false)
    // A malformed site digest never matches, even when it equals the branding value.
    expect(brandingDuplicatesSiteLogo(branding('/a.png', 'not-a-sha'), { logoUrl: '/b.png', logoSourceSha256: 'not-a-sha' })).toBe(false)
  })

  it('accepts only a well-formed site logo source digest', () => {
    expect(normalizeSiteLogoSourceSha256(sourceSha256)).toBe(sourceSha256)
    for (const value of [undefined, null, '', 'A'.repeat(64), 'a'.repeat(63), 42]) expect(normalizeSiteLogoSourceSha256(value)).toBeNull()
  })
})
