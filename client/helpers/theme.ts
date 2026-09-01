import type { ThemeDefinition, ThemeInstance } from 'vuetify'
import { THEME_COLOR_KEYS, type ThemeColors, type ThemeModeColors } from '../../shared/theme-colors.ts'

export type WikiThemeName = 'light' | 'dark' | 'system'

export const resolveThemeName = (appearance: string | null | undefined, _siteDarkMode: boolean): WikiThemeName => {
  if (appearance === 'dark' || appearance === 'light' || appearance === 'system') return appearance
  return 'system'
}

export const WIKI_THEME_VARIATIONS = {
  colors: ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'],
  lighten: 1,
  darken: 1
}

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5]
    .map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const contrastRatio = (foreground: string, background: string): number => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

const contrastForeground = (background: string): '#000000' | '#FFFFFF' => {
  const luminance = relativeLuminance(background)
  const blackContrast = (luminance + 0.05) / 0.05
  const whiteContrast = 1.05 / (luminance + 0.05)
  return blackContrast >= whiteContrast ? '#000000' : '#FFFFFF'
}

const contrastForegroundForSurfaces = (background: string, surface: string): '#000000' | '#FFFFFF' => {
  const candidates = ['#000000', '#FFFFFF'] as const
  return candidates.reduce((best, candidate) => {
    const candidateContrast = Math.min(contrastRatio(candidate, background), contrastRatio(candidate, surface))
    const bestContrast = Math.min(contrastRatio(best, background), contrastRatio(best, surface))
    return candidateContrast > bestContrast ? candidate : best
  })
}

const mixHex = (base: string, mix: string, amount: number): string => {
  const channels = [1, 3, 5].map(index => {
    const baseChannel = Number.parseInt(base.slice(index, index + 2), 16)
    const mixChannel = Number.parseInt(mix.slice(index, index + 2), 16)
    return Math.round(baseChannel + (mixChannel - baseChannel) * amount)
      .toString(16)
      .padStart(2, '0')
  })
  return `#${channels.join('')}`.toUpperCase()
}

const createThemeColorMap = (colors: ThemeModeColors, dark: boolean): Record<string, string> => {
  const surfaceVariant = mixHex(colors.background, colors.surface, 0.5)
  const colorMap: Record<string, string> = {
    ...colors,
    'surface-bright': mixHex(colors.surface, '#FFFFFF', dark ? 0.12 : 0.04),
    'surface-light': mixHex(colors.surface, dark ? '#FFFFFF' : '#000000', dark ? 0.06 : 0.03),
    'surface-variant': surfaceVariant,
    'on-surface-variant': contrastForeground(surfaceVariant),
    // A neutral focus role is selected against both root surfaces, not the site accent.
    focus: contrastForegroundForSurfaces(colors.background, colors.surface)
  }
  for (const key of THEME_COLOR_KEYS) colorMap[`on-${key}`] = contrastForeground(colors[key])
  return colorMap
}
export const createWikiThemes = (colors: ThemeColors): Record<'light' | 'dark', ThemeDefinition> => ({
  light: {
    dark: false,
    colors: createThemeColorMap(colors.light, false)
  },
  dark: {
    dark: true,
    colors: createThemeColorMap(colors.dark, true)
  }
})

export const applyWikiThemeColors = (theme: ThemeInstance, colors: ThemeColors): void => {
  Object.assign(theme.themes.value.light.colors, createThemeColorMap(colors.light, false))
  Object.assign(theme.themes.value.dark.colors, createThemeColorMap(colors.dark, true))
}
