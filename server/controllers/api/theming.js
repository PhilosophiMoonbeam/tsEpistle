const express = require('express')
const CleanCSS = require('clean-css')

const router = express.Router()

/* global WIKI */

router.get('/config', (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:theme', 'manage:system'])) {
    res.sendStatus(403)
    return
  }

  res.set('Cache-Control', 'no-store')
  res.json({
    theme: WIKI.config.theming.theme,
    iconset: WIKI.config.theming.iconset,
    darkMode: WIKI.config.theming.darkMode,
    tocPosition: WIKI.config.theming.tocPosition || 'left',
    injectCSS: new CleanCSS({ format: 'beautify' }).minify(WIKI.config.theming.injectCSS).styles,
    injectHead: WIKI.config.theming.injectHead,
    injectBody: WIKI.config.theming.injectBody
  })
})

module.exports = router
