import { cloneThemeColors, DEFAULT_THEME_COLORS } from './theme-colors.ts'
import {
  createDefaultThemePalette,
  isThemePalettes,
  normalizeThemePalettes,
  resolveThemePaletteId,
  ThemePalettesSchema
} from './theme-palettes.ts'

describe('theme palette collections', () => {
  test('migrates legacy color-only configuration into the editable Luminous Archive theme', () => {
    const legacyColors = cloneThemeColors(DEFAULT_THEME_COLORS)
    legacyColors.light.primary = '#123456'
    legacyColors.dark.primary = '#ABCDEF'

    const palettes = normalizeThemePalettes(undefined, legacyColors)

    expect(palettes).toEqual([{ id: 'luminous-archive', name: 'Luminous Archive', colors: legacyColors }])
    expect(palettes[0].colors).not.toBe(legacyColors)

    palettes[0].colors.light.primary = '#654321'
    palettes[0].colors.dark.primary = '#FEDCBA'
    expect(legacyColors.light.primary).toBe('#123456')
    expect(legacyColors.dark.primary).toBe('#ABCDEF')
  })

  test('requires unique stable identifiers and at least one theme', () => {
    const palette = createDefaultThemePalette()
    expect(isThemePalettes([palette])).toBe(true)
    expect(ThemePalettesSchema.safeParse([]).success).toBe(false)
    expect(ThemePalettesSchema.safeParse([palette, palette]).success).toBe(false)
  })

  test('falls back to the first available theme when the saved selection is stale', () => {
    const palettes = [
      createDefaultThemePalette(),
      { ...createDefaultThemePalette(), id: 'custom-theme-2', name: 'Custom theme 2' }
    ]

    expect(resolveThemePaletteId('custom-theme-2', palettes)).toBe('custom-theme-2')
    expect(resolveThemePaletteId('deleted-theme', palettes)).toBe('luminous-archive')

    const customPalettes = [
      { ...createDefaultThemePalette(), id: 'custom-theme-1', name: 'Custom theme 1' },
      { ...createDefaultThemePalette(), id: 'custom-theme-2', name: 'Custom theme 2' }
    ]
    expect(resolveThemePaletteId('deleted-theme', customPalettes)).toBe('custom-theme-1')
  })
})
