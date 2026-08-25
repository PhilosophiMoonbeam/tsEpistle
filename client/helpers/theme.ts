import type { ThemeDefinition, ThemeInstance } from 'vuetify'
import { THEME_COLOR_KEYS, type ThemeColors, type ThemeModeColors } from '../../shared/theme-colors.ts'

export type WikiThemeName = 'light' | 'dark' | 'system'

export const resolveThemeName = (appearance: string, siteDarkMode: boolean): WikiThemeName => {
  if (appearance === 'dark' || appearance === 'light' || appearance === 'system') return appearance
  return siteDarkMode ? 'dark' : 'light'
}

export const WIKI_THEME_VARIATIONS = {
  colors: ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'],
  lighten: 1,
  darken: 1
}

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const contrastForeground = (background: string): '#000000' | '#FFFFFF' => {
  const luminance = relativeLuminance(background)
  const blackContrast = (luminance + 0.05) / 0.05
  const whiteContrast = 1.05 / (luminance + 0.05)
  return blackContrast >= whiteContrast ? '#000000' : '#FFFFFF'
}

const createThemeColorMap = (colors: ThemeModeColors): Record<string, string> => {
  const colorMap: Record<string, string> = { ...colors }
  for (const key of THEME_COLOR_KEYS) colorMap[`on-${key}`] = contrastForeground(colors[key])
  return colorMap
}

export const createWikiThemes = (colors: ThemeColors): Record<'light' | 'dark', ThemeDefinition> => ({
  light: {
    dark: false,
    colors: createThemeColorMap(colors.light)
  },
  dark: {
    dark: true,
    colors: createThemeColorMap(colors.dark)
  }
})

export const applyWikiThemeColors = (theme: ThemeInstance, colors: ThemeColors): void => {
  Object.assign(theme.themes.value.light.colors, createThemeColorMap(colors.light))
  Object.assign(theme.themes.value.dark.colors, createThemeColorMap(colors.dark))
}
