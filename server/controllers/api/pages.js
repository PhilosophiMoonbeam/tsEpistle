const express = require('express')

const router = express.Router()

/* global WIKI */

const requireRecentPagesAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'read:pages'])) {
    res.status(403).json({ error: 'manage:system or read:pages is required' })
    return false
  }

  return true
}

router.get('/recent', async (req, res, next) => {
  if (!requireRecentPagesAccess(req, res)) {
    return
  }

  try {
    const pages = await WIKI.models.pages.query()
      .column(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt'])
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => {
        builder.select('tag')
      })
      .orderBy('updatedAt', 'desc')
      .limit(10)

    return res.json(pages.filter(page => WIKI.auth.checkAccess(req.user, ['read:pages'], {
      path: page.path,
      locale: page.locale,
      tags: page.tags
    })).map(page => ({
      id: page.id,
      locale: page.locale,
      path: page.path,
      title: page.title,
      updatedAt: page.updatedAt
    })))
  } catch (err) {
    return next(err)
  }
})

module.exports = router
