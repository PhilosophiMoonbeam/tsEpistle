const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const VALID_NAVIGATION_MODES = ['NONE', 'TREE', 'MIXED', 'STATIC']

const requireNavigationAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:navigation', 'manage:system'])) {
    res.status(403).json({ error: 'manage:navigation or manage:system is required' })
    return false
  }

  return true
}

const validateNavigationItem = (item) => {
  if (!item || !_.isPlainObject(item) || !_.isString(item.id) || item.id.length < 1 || !_.isString(item.kind) || item.kind.length < 1) {
    return false
  }

  for (const field of ['label', 'icon', 'targetType', 'target', 'visibilityMode']) {
    if (!_.isNil(item[field]) && !_.isString(item[field])) {
      return false
    }
  }

  return _.isNil(item.visibilityGroups) || (Array.isArray(item.visibilityGroups) && item.visibilityGroups.every(groupId => Number.isInteger(groupId)))
}

const validateNavigationTree = (tree) => {
  return Array.isArray(tree) && tree.every(row => row && _.isPlainObject(row) && _.isString(row.locale) && row.locale.length > 0 && Array.isArray(row.items) && row.items.every(validateNavigationItem))
}

const navigationItemResponse = (item) => ({
  id: item.id,
  kind: item.kind,
  label: item.label,
  icon: item.icon,
  targetType: item.targetType,
  target: item.target,
  visibilityMode: item.visibilityMode,
  visibilityGroups: item.visibilityGroups
})

const navigationTreeResponse = (tree) => tree.map(row => ({
  locale: row.locale,
  items: row.items.map(navigationItemResponse)
}))

router.get('/', async (req, res, next) => {
  if (!requireNavigationAccess(req, res)) {
    return
  }

  try {
    const tree = await WIKI.models.navigation.getTree({ cache: false, locale: 'all', bypassAuth: true })
    res.json({
      config: {
        mode: WIKI.config.nav.mode
      },
      tree: navigationTreeResponse(tree)
    })
  } catch (err) {
    return next(err)
  }
})

router.put('/', async (req, res) => {
  if (!requireNavigationAccess(req, res)) {
    return
  }

  const tree = _.get(req, 'body.tree')
  const mode = _.get(req, 'body.mode')

  if (!validateNavigationTree(tree)) {
    return res.status(400).json({ error: 'tree must be an array of locale navigation trees with valid navigation items' })
  }
  if (!VALID_NAVIGATION_MODES.includes(mode)) {
    return res.status(400).json({ error: 'mode must be a valid navigation mode' })
  }

  try {
    await WIKI.models.navigation.query().patch({
      config: tree
    }).where('key', 'site')

    for (const row of tree) {
      await WIKI.cache.set(`nav:sidebar:${row.locale}`, row.items, 300)
    }

    WIKI.config.nav = { mode }
    await WIKI.configSvc.saveToDb(['nav'])

    res.json({ message: 'Navigation saved successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Navigation save failed' })
  }
})

module.exports = router
