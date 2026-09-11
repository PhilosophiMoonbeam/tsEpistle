import { describe, expect, test } from '../../server/test/bun-test.mts'
import type { ThemeInstance } from 'vuetify'
import { cloneThemeColors, DEFAULT_THEME_COLORS } from '../../shared/theme-colors.ts'
import {
  applyWikiThemeColors,
  contrastForeground,
  contrastRatio,
  createWikiThemes,
  resolveThemeName,
  WIKI_PURPOSE_KEYS,
  WIKI_THEME_VARIATIONS
} from './theme.ts'

const mixHexForTest = (base: string, mix: string, amount: number): string => {
  const channels = [1, 3, 5].map(index => {
    const baseChannel = Number.parseInt(base.slice(index, index + 2), 16)
    const mixChannel = Number.parseInt(mix.slice(index, index + 2), 16)
    return Math.round(baseChannel + (mixChannel - baseChannel) * amount)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`.toUpperCase()
}

describe('frontend theme helpers', () => {
  test('defaults unset, blank, and invalid user appearance to the device preference', () => {
    expect(resolveThemeName(undefined, false)).toBe('system')
    expect(resolveThemeName(null, true)).toBe('system')
    expect(resolveThemeName('', false)).toBe('system')
    expect(resolveThemeName('', true)).toBe('system')
    expect(resolveThemeName('invalid', true)).toBe('system')
  })

  test('preserves every explicit user appearance regardless of the configured site mode', () => {
    expect(resolveThemeName('light', true)).toBe('light')
    expect(resolveThemeName('dark', false)).toBe('dark')
    expect(resolveThemeName('system', false)).toBe('system')
    expect(resolveThemeName('system', true)).toBe('system')
  })

  test('creates independent light and dark Vuetify definitions', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#F9A134'
    colors.dark.primary = '#ABCDEF'
    colors.dark.secondary = '#A6A8AA'
    colors.dark.info = '#73ADD3'

    expect(createWikiThemes(colors)).toMatchObject({
      light: {
        dark: false,
        colors: {
          primary: '#F9A134',
          'on-primary': '#000000',
          'surface-bright': '#F8F9FA',
          'surface-light': '#F1F2F3',
          'surface-variant': '#F8F8F8',
          'on-surface-variant': '#000000',
          focus: '#000000'
        }
      },
      dark: {
        dark: true,
        colors: {
          primary: '#ABCDEF',
          secondary: '#A6A8AA',
          info: '#73ADD3',
          'on-primary': '#000000',
          'on-secondary': '#000000',
          'on-info': '#000000',
          'surface-bright': '#3E4144',
          'surface-light': '#313437',
          'surface-variant': '#1E2123',
          'on-surface-variant': '#FFFFFF',
          focus: '#FFFFFF'
        }
      }
    })
  })

  test('derives palette variations for every configurable semantic color', () => {
    expect(WIKI_THEME_VARIATIONS).toEqual({
      colors: ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'],
      lighten: 1,
      darken: 1
    })
  })

  test('derives WCAG-readable disabled primary ink for raised and sunken composites in both modes', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#E7B34A'
    colors.dark.primary = '#ABCDEF'

    const themes = createWikiThemes(colors)
    for (const mode of ['light', 'dark'] as const) {
      const themeColors = themes[mode].colors
      const surfaceBright = mixHexForTest(themeColors.surface, '#FFFFFF', mode === 'dark' ? 0.12 : 0.04)
      const surfaceRaised = mixHexForTest(themeColors.surface, surfaceBright, 0.06)
      const raisedComposite = mixHexForTest(surfaceRaised, themeColors.primary, 0.8)
      const sunkenSurface = mixHexForTest(themeColors.background, themeColors.surface, 0.28)
      const sunkenComposite = mixHexForTest(sunkenSurface, themeColors.primary, 0.8)
      const raisedInk = themeColors['on-primary-disabled-raised']
      const sunkenInk = themeColors['on-primary-disabled-sunken']

      expect(raisedInk).toBe(contrastForeground(raisedComposite))
      expect(sunkenInk).toBe(contrastForeground(sunkenComposite))
      expect(contrastRatio(raisedInk, raisedComposite)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(sunkenInk, sunkenComposite)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('derives readable purpose ink against each runtime surface', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#E7B34A'
    colors.light.info = '#216B98'
    colors.dark.success = '#68B98A'
    colors.dark.error = '#D56D79'

    const themes = createWikiThemes(colors)
    for (const mode of ['light', 'dark'] as const) {
      const themeColors = themes[mode].colors
      for (const purpose of WIKI_PURPOSE_KEYS) {
        const ink = themeColors[`purpose-${purpose}-ink`]
        const fill = themeColors[`purpose-${purpose}-fill`]

        expect(ink).toMatch(/^#[0-9A-F]{6}$/)
        expect(fill).toMatch(/^#[0-9A-F]{6}$/)
        expect(contrastRatio(ink, themeColors.surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(ink, fill)).toBeGreaterThanOrEqual(4.5)
      }

      expect(themeColors['purpose-neutral-ink']).toBe(contrastForeground(themeColors.surface))
    }
  })

  test('updates configured and derived colors without discarding unrelated Vuetify-only colors', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#F9A134'
    const theme = {
      themes: {
        value: {
          light: {
            dark: false,
            colors: { ...DEFAULT_THEME_COLORS.light, 'on-primary': '#FFFFFF', 'surface-bright': '#EEEEEE', outline: '#DDDDDD' },
            variables: {}
          },
          dark: { dark: true, colors: { ...DEFAULT_THEME_COLORS.dark, 'on-primary': '#000000', outline: '#333333' }, variables: {} }
        }
      }
    } as unknown as ThemeInstance

    applyWikiThemeColors(theme, colors)

    expect(theme.themes.value.light.colors.primary).toBe('#F9A134')
    expect(theme.themes.value.light.colors['on-primary']).toBe('#000000')
    expect(theme.themes.value.dark.colors.background).toBe(DEFAULT_THEME_COLORS.dark.background)
    expect(theme.themes.value.light.colors['surface-bright']).toBe('#F8F9FA')
    expect(theme.themes.value.light.colors.outline).toBe('#DDDDDD')
    expect(theme.themes.value.dark.colors['on-primary']).toBe('#000000')
    expect(theme.themes.value.dark.colors.outline).toBe('#333333')
  })
})
