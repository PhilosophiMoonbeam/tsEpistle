import { describe, expect, it } from '../../server/test/bun-test.mts'
import { normalizePageBrandingView, pageBrandingIdentity, resolvePageBrandingStyle } from './page-branding.ts'
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

  it('emits accent RGB channels with the light and dark alpha values', () => {
    const normalized = normalizePageBrandingView(withBranding())
    expect(normalized).not.toBeNull()

    expect(resolvePageBrandingStyle(normalized, null, false)).toEqual({
      '--page-branding-rgb': '12 34 56',
      '--page-branding-alpha': '0.28'
    })
    expect(resolvePageBrandingStyle(normalized, null, true)).toEqual({
      '--page-branding-rgb': '12 34 56',
      '--page-branding-alpha': '0.24'
    })
  })

  it('suppresses style only when the current branding identity has failed', () => {
    const normalized = normalizePageBrandingView(withBranding()) as PageBrandingView
    const identity = pageBrandingIdentity(normalized)

    expect(identity).toBe(`${baseBranding.assetId}:${baseBranding.sourceSha256}`)
    expect(resolvePageBrandingStyle(normalized, identity)).toEqual({})
    expect(resolvePageBrandingStyle(normalized, 'different:identity')).toEqual({
      '--page-branding-rgb': '12 34 56',
      '--page-branding-alpha': '0.28'
    })
  })
})
