// Accessibility contracts for exported palette colors, independent of CSS selectors.
// Browser qualification owns the cascade, opacity, and component-local color mixes.
import { createVuetify } from 'vuetify'
import { describe, expect, test } from '../../server/test/bun-test.mts'
import type { ThemeColors } from '../../shared/theme-colors.ts'
import { cloneThemeColors, DEFAULT_THEME_COLORS, THEME_COLOR_KEYS } from '../../shared/theme-colors.ts'
import { createDefaultThemePalette } from '../../shared/theme-palettes.ts'
import { contrastRatio, createWikiThemes, WIKI_INK_KEYS, WIKI_PURPOSE_KEYS, WIKI_THEME_VARIATIONS } from '../helpers/theme.ts'

const MODES = ['light', 'dark'] as const
const TEXT_CONTRAST = 4.5
const UI_CONTRAST = 3

// Independent WCAG 2 sRGB measurement: the production selection algorithm must
// not supply its own oracle. Reject missing/invalid tokens rather than skipping them.
const channels = (color: unknown): number[] => {
  expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  const rgb = Number.parseInt(String(color).slice(1), 16)
  return [rgb >> 16, (rgb >> 8) & 255, rgb & 255]
}
const luminance = (color: unknown): number => {
  const [r, g, b] = channels(color).map(channel => {
    const srgb = channel / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (foreground: unknown, background: unknown): number => {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

// Tonal controls composite their ink over the surface at Vuetify's runtime
// activated opacity. This is a consumer backdrop, not a copied stylesheet token.
const tonalBackdrop = (surface: unknown, ink: unknown, opacity: number): string => {
  const backdrop = channels(surface)
  return '#' + channels(ink).map((channel, index) =>
    Math.round(channel * opacity + backdrop[index] * (1 - opacity)).toString(16).padStart(2, '0')
  ).join('')
}

interface Measurement { name: string, ratio: number, minimum: number }
const measure = (colors: ThemeColors): Measurement[] => {
  const vuetify = createVuetify({ theme: { themes: createWikiThemes(colors), variations: WIKI_THEME_VARIATIONS } })
  const themes = vuetify.theme.computedThemes.value
  const rows: Measurement[] = []
  const add = (name: string, ink: unknown, background: unknown, minimum: number): void => {
    rows.push({ name, ratio: contrast(ink, background), minimum })
  }

  for (const mode of MODES) {
    const runtime = themes[mode].colors
    const opacity = Number(themes[mode].variables['activated-opacity'])
    expect(Number.isFinite(opacity)).toBe(true)
    expect(opacity).toBeGreaterThan(0)
    expect(opacity).toBeLessThan(1)

    for (const key of WIKI_INK_KEYS) {
      const ink = runtime[`${key}-ink`]
      for (const surface of ['background', 'surface'] as const) {
        add(`${mode} ${key}-ink on ${surface}`, ink, runtime[surface], TEXT_CONTRAST)
      }
      add(`${mode} ${key}-ink on tonal fill`, ink, tonalBackdrop(runtime.surface, ink, opacity), TEXT_CONTRAST)
    }
    for (const key of THEME_COLOR_KEYS) {
      add(`${mode} on-${key} on ${key}`, runtime[`on-${key}`], runtime[key], TEXT_CONTRAST)
    }
    for (const key of WIKI_PURPOSE_KEYS) {
      const ink = runtime[`purpose-${key}-ink`]
      add(`${mode} purpose-${key}-ink on surface`, ink, runtime.surface, TEXT_CONTRAST)
      add(`${mode} purpose-${key}-ink on its fill`, ink, runtime[`purpose-${key}-fill`], TEXT_CONTRAST)
    }
    for (const surface of ['background', 'surface'] as const) {
      add(`${mode} focus on ${surface}`, runtime.focus, runtime[surface], UI_CONTRAST)
    }
  }
  return rows
}
const failures = (rows: Measurement[]): string[] => rows
  .filter(row => row.ratio < row.minimum)
  .map(row => `${row.name}: ${row.ratio.toFixed(2)}:1 (needs ${row.minimum}:1)`)

// Raw colors deliberately fail as text: pale accents on light surfaces and
// deep accents on dark surfaces exercise both directions of adaptation.
const pastelAndDeep = (): ThemeColors => {
  const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
  Object.assign(colors.light, { primary: '#FFD54F', secondary: '#B0BEC5', accent: '#CE93D8', info: '#4FC3F7', success: '#81C784', warning: '#FFB74D', error: '#E57373' })
  Object.assign(colors.dark, { primary: '#1A237E', secondary: '#37474F', accent: '#4A148C', info: '#0D47A1', success: '#1B5E20', warning: '#8D3B00', error: '#7F1D1D' })
  return colors
}

describe('palette contrast contract', () => {
  test('measures WCAG AA boundaries without rounding a failure into a pass', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21)
    expect(contrastRatio('#FFFFFF', '#000000')).toBe(21)
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(contrast('#767676', '#FFFFFF'), 10)
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(TEXT_CONTRAST)
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(TEXT_CONTRAST)
    expect(contrastRatio('#949494', '#FFFFFF')).toBeGreaterThanOrEqual(UI_CONTRAST)
    expect(contrastRatio('#959595', '#FFFFFF')).toBeLessThan(UI_CONTRAST)
    expect(contrastRatio('#F8F9FA', '#F8F9FA')).toBe(1)
  })

  const palette = createDefaultThemePalette()
  test(`${palette.name} exported text and focus colors meet WCAG AA in both modes`, () => {
    expect(failures(measure(palette.colors))).toEqual([])
  })

  test('adapts custom palette inks when the raw colors fail WCAG AA', () => {
    const colors = pastelAndDeep()
    for (const mode of MODES) {
      for (const key of WIKI_INK_KEYS) {
        expect(contrast(colors[mode][key], colors[mode].surface)).toBeLessThan(TEXT_CONTRAST)
      }
    }
    expect(failures(measure(colors))).toEqual([])
  })

  test('preserves palette hues that already read as text', () => {
    const themes = createWikiThemes(DEFAULT_THEME_COLORS)
    expect(themes.dark.colors!['primary-ink']).toBe(DEFAULT_THEME_COLORS.dark.primary)
    expect(themes.light.colors!['secondary-ink']).toBe(DEFAULT_THEME_COLORS.light.secondary)
  })

  test('does not claim AA for a custom palette with incompatible focus backdrops', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    for (const mode of MODES) {
      colors[mode].background = '#000000'
      colors[mode].surface = '#FFFFFF'
    }
    const themes = createWikiThemes(colors)
    for (const mode of MODES) {
      const focus = themes[mode].colors!.focus
      // The exported focus role is monochrome. Neither supported foreground
      // can distinguish itself from both a black and a white root surface.
      expect(['#000000', '#FFFFFF']).toContain(focus)
      expect(Math.min(contrast(focus, colors[mode].background), contrast(focus, colors[mode].surface))).toBe(1)
    }
    const focusFailures = failures(measure(colors)).filter(failure => failure.includes(' focus on '))
    expect(focusFailures).toHaveLength(MODES.length)
  })
})
