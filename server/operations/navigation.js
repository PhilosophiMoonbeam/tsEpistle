const _ = require('lodash')

const { ApplicationError } = require('./errors')

/* global WIKI */

const validModes = ['NONE', 'TREE', 'MIXED', 'STATIC']

const validItem = item => {
  if (!item || !_.isPlainObject(item) || !_.isString(item.id) || item.id.length < 1 || !_.isString(item.kind) || item.kind.length < 1) return false
  for (const field of ['label', 'icon', 'targetType', 'target', 'visibilityMode']) {
    if (!_.isNil(item[field]) && !_.isString(item[field])) return false
  }
  return _.isNil(item.visibilityGroups) || (Array.isArray(item.visibilityGroups) && item.visibilityGroups.every(Number.isInteger))
}

const validTree = tree => Array.isArray(tree) && tree.every(row => row && _.isPlainObject(row) && _.isString(row.locale) && row.locale.length > 0 && Array.isArray(row.items) && row.items.every(validItem))

const serializeItem = item => _.pick(item, ['id', 'kind', 'label', 'icon', 'targetType', 'target', 'visibilityMode', 'visibilityGroups'])

const get = async () => {
  const tree = await WIKI.models.navigation.getTree({ cache: false, locale: 'all', bypassAuth: true })
  return {
    config: { mode: WIKI.config.nav.mode },
    tree: tree.map(row => ({
      locale: row.locale,
      items: row.items.map(serializeItem)
    }))
  }
}

const update = async ({ tree, mode }) => {
  if (!validTree(tree)) {
    throw new ApplicationError('tree must be an array of locale navigation trees with valid navigation items', { code: 'INVALID_NAVIGATION_TREE' })
  }
  if (!validModes.includes(mode)) {
    throw new ApplicationError('mode must be a valid navigation mode', { code: 'INVALID_NAVIGATION_MODE' })
  }
  await WIKI.models.navigation.query().patch({ config: tree }).where('key', 'site')
  for (const row of tree) {
    await WIKI.cache.set(`nav:sidebar:${row.locale}`, row.items, 300)
  }
  WIKI.config.nav = { mode }
  await WIKI.configSvc.saveToDb(['nav'])
}

module.exports = { get, update }
