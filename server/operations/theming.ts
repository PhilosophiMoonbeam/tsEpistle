import CleanCSS from 'clean-css'
import { isThemeColors, normalizeThemeColors } from '../../shared/theme-colors.ts'
import {
  isPageGutterCustomCss,
  isPageGutterStyle,
  normalizePageGutterCustomCss,
  normalizePageGutterStyle
} from '../../shared/page-gutters.ts'

import errors from './errors.ts'

const { ApplicationError } = errors

interface ThemingConfig extends Record<string, unknown> {
  theme: string
  iconset: string
  darkMode: boolean
  colors?: unknown
  tocPosition?: string
  gutterStyle?: unknown
  gutterCustomCss?: unknown
  injectCSS: string
  injectHead: string
  injectBody: string
}

const config = WIKI.config as { theming: ThemingConfig }
const configService = WIKI.configSvc as { saveToDb(keys: string[]): Promise<unknown> }

const getConfig = () => ({
  theme: config.theming.theme,
  iconset: config.theming.iconset,
  darkMode: config.theming.darkMode,
  colors: normalizeThemeColors(config.theming.colors),
  tocPosition: config.theming.tocPosition || 'left',
  gutterStyle: normalizePageGutterStyle(config.theming.gutterStyle),
  gutterCustomCss: normalizePageGutterCustomCss(config.theming.gutterCustomCss),
  injectCSS: new CleanCSS({ format: 'beautify' }).minify(config.theming.injectCSS).styles,
  injectHead: config.theming.injectHead,
  injectBody: config.theming.injectBody
})

const isThemingConfig = (input: unknown): input is ThemingConfig => Boolean(
  input && typeof input === 'object' && !Array.isArray(input) &&
  typeof Reflect.get(input, 'theme') === 'string' &&
  typeof Reflect.get(input, 'iconset') === 'string' &&
  typeof Reflect.get(input, 'darkMode') === 'boolean'
)

const updateConfig = async (input: unknown): Promise<void> => {
  if (!isThemingConfig(input)) {
    throw new ApplicationError('Invalid theme config payload', { code: 'INVALID_THEME_CONFIGURATION' })
  }
  for (const field of ['tocPosition', 'gutterCustomCss', 'injectCSS', 'injectHead', 'injectBody']) {
    if (input[field] != null && typeof input[field] !== 'string') {
      throw new ApplicationError('Invalid theme config payload', { code: 'INVALID_THEME_CONFIGURATION' })
    }
  }
  if (input.gutterStyle !== undefined && !isPageGutterStyle(input.gutterStyle)) {
    throw new ApplicationError('Invalid page gutter style', { code: 'INVALID_THEME_CONFIGURATION', status: 400 })
  }
  if (input.gutterCustomCss !== undefined && !isPageGutterCustomCss(input.gutterCustomCss)) {
    throw new ApplicationError('Custom page gutter CSS must contain no more than 4000 characters of declarations without selectors or at-rules', { code: 'INVALID_THEME_CONFIGURATION', status: 400 })
  }
  if (input.colors !== undefined && !isThemeColors(input.colors)) {
    throw new ApplicationError('Invalid theme color configuration', { code: 'INVALID_THEME_CONFIGURATION', status: 400 })
  }
  const injectCSS = input.injectCSS
    ? new CleanCSS({ inline: false }).minify(input.injectCSS).styles
    : ''
  config.theming = {
    ...config.theming,
    theme: input.theme,
    iconset: input.iconset,
    darkMode: input.darkMode,
    colors: normalizeThemeColors(input.colors ?? config.theming.colors),
    tocPosition: input.tocPosition || 'left',
    gutterStyle: normalizePageGutterStyle(input.gutterStyle ?? config.theming.gutterStyle),
    gutterCustomCss: normalizePageGutterCustomCss(input.gutterCustomCss ?? config.theming.gutterCustomCss),
    injectCSS,
    injectHead: input.injectHead || '',
    injectBody: input.injectBody || ''
  }
  await configService.saveToDb(['theming'])
}

export default { getConfig, updateConfig }
