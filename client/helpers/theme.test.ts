import { describe, expect, test } from '../../server/test/bun-test.mts'
import type { ThemeInstance } from 'vuetify'
import { cloneThemeColors, DEFAULT_THEME_COLORS } from '../../shared/theme-colors.ts'
import { createAppVuetify } from './app-vuetify.ts'
import { applyWikiThemeColors, createWikiThemes, resolveThemeName } from './theme.ts'

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

// WCAG 2 sRGB luminance, independent of the production contrast helpers.
const luminanceForTest = (color: unknown): number => {
  expect(color).toMatch(/^#[0-9A-F]{6}$/i)
  const rgb = Number.parseInt(String(color).slice(1), 16)
  const linear = (channel: number): number => {
    const srgb = channel / 255
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(rgb >> 16) + 0.7152 * linear((rgb >> 8) & 255) + 0.0722 * linear(rgb & 255)
}

const contrastForTest = (foreground: unknown, background: unknown): number => {
  const luminances = [luminanceForTest(foreground), luminanceForTest(background)].sort((a, b) => a - b)
  return (luminances[1] + 0.05) / (luminances[0] + 0.05)
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
    colors.light.background = '#F5F0E8'
    colors.light.surface = '#EEECE4'
    colors.dark.background = '#111922'
    colors.dark.surface = '#202C3A'

    const themes = createWikiThemes(colors)
    expect(themes).toMatchObject({
      light: {
        dark: false,
        colors: {
          primary: '#F9A134',
          'on-primary': '#000000',
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
          'on-surface-variant': '#FFFFFF',
          focus: '#FFFFFF'
        }
      }
    })

    for (const mode of ['light', 'dark'] as const) {
      const runtime = themes[mode].colors!
      for (const surface of ['surface-bright', 'surface-light', 'surface-variant']) {
        expect(runtime[surface]).toMatch(/^#[0-9A-F]{6}$/)
        expect(contrastForTest(runtime['on-surface-variant'], runtime[surface])).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrastForTest(runtime.focus, runtime.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrastForTest(runtime.focus, runtime.surface)).toBeGreaterThanOrEqual(4.5)
      for (const role of ['primary', 'secondary', 'info']) {
        expect(contrastForTest(runtime[`on-${role}`], runtime[role])).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('derives palette variations for every configurable semantic color', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    Object.assign(colors.light, {
      primary: '#416B91', secondary: '#775A8A', accent: '#846647', info: '#357B75',
      success: '#587B45', warning: '#8A702B', error: '#8B4C5F'
    })
    Object.assign(colors.dark, {
      primary: '#83A7C9', secondary: '#B29BC5', accent: '#C3A486', info: '#86BFB8',
      success: '#A0C48B', warning: '#C8B36A', error: '#C78F9F'
    })
    const changed = { light: { ...colors.dark }, dark: { ...colors.light } }
    const previousSiteConfig = Object.getOwnPropertyDescriptor(globalThis, 'siteConfig')
    let initialCleanup: (() => void) | undefined
    let updatedCleanup: (() => void) | undefined
    try {
      Object.defineProperty(globalThis, 'siteConfig', {
        configurable: true, value: { lang: 'en', rtl: false, darkMode: false, themeColors: colors }
      })
      const initialInstance = createAppVuetify()
      initialCleanup = initialInstance.unmount
      const initial = initialInstance.theme.computedThemes.value
      Object.defineProperty(globalThis, 'siteConfig', {
        configurable: true, value: { lang: 'en', rtl: false, darkMode: false, themeColors: changed }
      })
      const updatedInstance = createAppVuetify()
      updatedCleanup = updatedInstance.unmount
      const updated = updatedInstance.theme.computedThemes.value

      for (const mode of ['light', 'dark'] as const) {
        for (const role of ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'] as const) {
          expect(initial[mode].colors[role]).toBe(colors[mode][role])
          expect(updated[mode].colors[role]).toBe(changed[mode][role])
          for (const [runtime, palette] of [[initial[mode].colors, colors[mode]], [updated[mode].colors, changed[mode]]] as const) {
            expect(luminanceForTest(runtime[`${role}-lighten-1`])).toBeGreaterThan(luminanceForTest(palette[role]))
            expect(luminanceForTest(runtime[`${role}-darken-1`])).toBeLessThan(luminanceForTest(palette[role]))
          }
          expect(updated[mode].colors[`${role}-lighten-1`]).not.toBe(initial[mode].colors[`${role}-lighten-1`])
          expect(updated[mode].colors[`${role}-darken-1`]).not.toBe(initial[mode].colors[`${role}-darken-1`])
        }
      }
    } finally {
      initialCleanup?.()
      updatedCleanup?.()
      if (previousSiteConfig) Object.defineProperty(globalThis, 'siteConfig', previousSiteConfig)
      else Reflect.deleteProperty(globalThis, 'siteConfig')
    }
  })

  test('derives WCAG-readable disabled primary ink for raised and sunken composites in both modes', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#E7B34A'
    colors.dark.primary = '#ABCDEF'

    const themes = createWikiThemes(colors)
    for (const mode of ['light', 'dark'] as const) {
      const themeColors = themes[mode].colors! as Record<string, string>
      const surfaceRaised = mixHexForTest(themeColors.surface, themeColors['surface-bright'], 0.06)
      const raisedComposite = mixHexForTest(surfaceRaised, themeColors.primary, 0.8)
      const sunkenSurface = mixHexForTest(themeColors.background, themeColors.surface, 0.28)
      const sunkenComposite = mixHexForTest(sunkenSurface, themeColors.primary, 0.8)
      const raisedInk = themeColors['on-primary-disabled-raised']
      const sunkenInk = themeColors['on-primary-disabled-sunken']

      expect(contrastForTest(raisedInk, raisedComposite)).toBeGreaterThanOrEqual(4.5)
      expect(contrastForTest(sunkenInk, sunkenComposite)).toBeGreaterThanOrEqual(4.5)
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
      const themeColors = themes[mode].colors! as Record<string, string>
      const surfaceRaised = mixHexForTest(themeColors.surface, themeColors['surface-bright'], 0.06)
      // These seven purpose tokens are consumed independently in base.scss.
      for (const purpose of ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral']) {
        const ink = themeColors[`purpose-${purpose}-ink`]
        const fill = themeColors[`purpose-${purpose}-fill`]

        expect(ink).toMatch(/^#[0-9A-F]{6}$/)
        expect(fill).toMatch(/^#[0-9A-F]{6}$/)
        expect(contrastForTest(ink, themeColors.surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastForTest(ink, surfaceRaised)).toBeGreaterThanOrEqual(4.5)
        expect(contrastForTest(ink, fill)).toBeGreaterThanOrEqual(4.5)
      }

      expect(themeColors['purpose-neutral-ink']).toBe(mode === 'light' ? '#000000' : '#FFFFFF')
    }
  })

  test('updates configured and derived colors without discarding unrelated Vuetify-only colors', () => {
    const oldColors = cloneThemeColors(DEFAULT_THEME_COLORS)
    Object.assign(oldColors.light, { primary: '#27405A', background: '#FFF9EE', surface: '#F4EEE3' })
    Object.assign(oldColors.dark, { primary: '#EDCC84', background: '#181F2A', surface: '#303B4C' })
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    Object.assign(colors.light, { primary: '#E7B34A', background: '#F3F0E8', surface: '#EEECE4' })
    Object.assign(colors.dark, { primary: '#244264', background: '#101722', surface: '#202C3A' })
    const theme = {
      themes: {
        value: {
          light: {
            dark: false,
            colors: { ...oldColors.light, 'on-primary': '#FFFFFF', 'surface-bright': '#000000', outline: '#DDDDDD' },
            variables: {}
          },
          dark: {
            dark: true,
            colors: { ...oldColors.dark, 'on-primary': '#000000', 'surface-bright': '#FFFFFF', outline: '#333333' },
            variables: {}
          }
        }
      }
    } as unknown as ThemeInstance

    applyWikiThemeColors(theme, colors)

    for (const mode of ['light', 'dark'] as const) {
      const runtime = theme.themes.value[mode].colors
      expect(runtime.primary).toBe(colors[mode].primary)
      expect(runtime.background).toBe(colors[mode].background)
      expect(runtime.surface).toBe(colors[mode].surface)
      expect(runtime['on-primary']).toBe(mode === 'light' ? '#000000' : '#FFFFFF')
      expect(contrastForTest(runtime['on-primary'], runtime.primary)).toBeGreaterThanOrEqual(4.5)
      expect(runtime['surface-bright']).not.toBe(mode === 'light' ? '#000000' : '#FFFFFF')
      expect(luminanceForTest(runtime['surface-bright'])).toBeGreaterThan(luminanceForTest(runtime.surface))
      expect(contrastForTest(runtime['on-surface'], runtime['surface-bright'])).toBeGreaterThanOrEqual(4.5)
      expect(contrastForTest(runtime.focus, runtime.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrastForTest(runtime.focus, runtime.surface)).toBeGreaterThanOrEqual(4.5)
      expect(runtime.outline).toBe(mode === 'light' ? '#DDDDDD' : '#333333')
    }
  })
})
