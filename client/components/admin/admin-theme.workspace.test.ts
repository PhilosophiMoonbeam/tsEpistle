import { describe, expect, test } from '../../../server/test/bun-test.mts'
import { ThemePolicySchema, themePolicyFromConfiguration, themeChangedFields, normalizeReaderLayout } from '../../../shared/theme-policy.ts'
import { contrastForeground, contrastRatio } from '../../helpers/theme.ts'
describe('Theme editing policy and preview calculations', () => {
  test('preserves custom source and repairs absent legacy palette and reader configuration', () => {
    const source = '/* keep formatting */\n.contents { color: red; }\n'
    const policy = themePolicyFromConfiguration({ theming: { injectCSS: source } })
    expect(policy.injectCSS).toBe(source)
    expect(ThemePolicySchema.safeParse(policy).success).toBe(true)
  })
  test('preserves an explicitly configured wide reading measure', () => {
    const reading = { textSize: 19, lineHeight: 1.8, copyWidth: 101 }
    expect(themePolicyFromConfiguration({ theming: { reading } }).reading).toEqual(reading)
  })
  test('requires an existing published palette and complete valid reading settings', () => {
    const policy = themePolicyFromConfiguration({})
    expect(ThemePolicySchema.safeParse({ ...policy, activePaletteId: 'missing' }).success).toBe(false)
    expect(ThemePolicySchema.safeParse({ ...policy, palettes: [] }).success).toBe(false)
    expect(ThemePolicySchema.safeParse({ ...policy, reading: { ...policy.reading, textSize: '19' } }).success).toBe(false)
    expect(ThemePolicySchema.safeParse({ ...policy, iconset: 'arbitrary' }).success).toBe(false)
    expect(normalizeReaderLayout({ textSize: 999 })).toEqual(policy.reading)
  })
  test('reports only the nested palette and reader areas that changed', () => {
    const saved = themePolicyFromConfiguration({}), draft = structuredClone(saved)
    draft.palettes[0].colors.light.primary = '#123456'
    draft.reading.copyWidth = 68
    expect(themeChangedFields(saved, draft)).toEqual(['palettes', 'reading'])
  })
  test('reports colored text contrast separately from filled control foreground', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21)
    expect(contrastRatio('#F9A134', '#F8F9FA')).toBeLessThan(4.5)
    const text = contrastForeground('#F9A134')
    expect(text).toBe('#000000')
    expect(contrastRatio(text, '#F9A134')).toBeGreaterThan(4.5)
  })
})
