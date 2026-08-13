const CleanCSS = require('clean-css')

const { ApplicationError } = require('./errors')

/* global WIKI */

const getConfig = () => ({
  theme: WIKI.config.theming.theme,
  iconset: WIKI.config.theming.iconset,
  darkMode: WIKI.config.theming.darkMode,
  tocPosition: WIKI.config.theming.tocPosition || 'left',
  injectCSS: new CleanCSS({ format: 'beautify' }).minify(WIKI.config.theming.injectCSS).styles,
  injectHead: WIKI.config.theming.injectHead,
  injectBody: WIKI.config.theming.injectBody
})

const updateConfig = async input => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.theme !== 'string' || typeof input.iconset !== 'string' || typeof input.darkMode !== 'boolean') {
    throw new ApplicationError('Invalid theme config payload', { code: 'INVALID_THEME_CONFIGURATION' })
  }
  for (const field of ['tocPosition', 'injectCSS', 'injectHead', 'injectBody']) {
    if (input[field] != null && typeof input[field] !== 'string') {
      throw new ApplicationError('Invalid theme config payload', { code: 'INVALID_THEME_CONFIGURATION' })
    }
  }
  const injectCSS = input.injectCSS ?
    new CleanCSS({ inline: false }).minify(input.injectCSS).styles :
    ''
  WIKI.config.theming = {
    ...WIKI.config.theming,
    theme: input.theme,
    iconset: input.iconset,
    darkMode: input.darkMode,
    tocPosition: input.tocPosition || 'left',
    injectCSS,
    injectHead: input.injectHead || '',
    injectBody: input.injectBody || ''
  }
  await WIKI.configSvc.saveToDb(['theming'])
}

module.exports = { getConfig, updateConfig }
