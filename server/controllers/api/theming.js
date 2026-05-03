const express = require('express')
const CleanCSS = require('clean-css')

const router = express.Router()

/* global WIKI */

function canManageTheme (req) {
  return WIKI.auth.checkAccess(req.user, ['manage:theme', 'manage:system'])
}

router.get('/config', (req, res) => {
  if (!canManageTheme(req)) {
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

router.post('/config', async (req, res) => {
  if (!canManageTheme(req)) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  try {
    const body = req.body || {}
    if (typeof body.theme !== 'string' || typeof body.iconset !== 'string' || typeof body.darkMode !== 'boolean') {
      res.status(400).json({ error: 'Invalid theme config payload' })
      return
    }
    if (body.tocPosition != null && typeof body.tocPosition !== 'string') {
      res.status(400).json({ error: 'Invalid theme config payload' })
      return
    }
    if (body.injectCSS != null && typeof body.injectCSS !== 'string') {
      res.status(400).json({ error: 'Invalid theme config payload' })
      return
    }
    if (body.injectHead != null && typeof body.injectHead !== 'string') {
      res.status(400).json({ error: 'Invalid theme config payload' })
      return
    }
    if (body.injectBody != null && typeof body.injectBody !== 'string') {
      res.status(400).json({ error: 'Invalid theme config payload' })
      return
    }
    let injectCSS = body.injectCSS

    if (injectCSS) {
      injectCSS = new CleanCSS({
        inline: false
      }).minify(injectCSS).styles
    }

    WIKI.config.theming = {
      ...WIKI.config.theming,
      theme: body.theme,
      iconset: body.iconset,
      darkMode: body.darkMode,
      tocPosition: body.tocPosition || 'left',
      injectCSS: injectCSS || '',
      injectHead: body.injectHead || '',
      injectBody: body.injectBody || ''
    }

    await WIKI.configSvc.saveToDb(['theming'])

    res.json({ message: 'Theme config updated' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Theme config update failed' })
  }
})

module.exports = router
