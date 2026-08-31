import _ from 'lodash'

import errors from './errors.ts'
import { normalizeNavigationItems } from '../models/navigation.ts'

const { ApplicationError } = errors

interface NavigationItem extends Record<string, unknown> {
  id: string
  kind: string
  label?: string
  icon?: string
  targetType?: string
  target?: string
  visibilityMode?: string
  visibilityGroups?: number[]
}

interface NavigationRow {
  locale: string
  items: NavigationItem[]
}

interface NavigationModel {
  getTree(options: Record<string, unknown>): Promise<NavigationRow[]>
  query(): { patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> } }
}

const validModes = ['NONE', 'TREE', 'MIXED', 'STATIC']
const navigationModel = (WIKI.models as { navigation: NavigationModel }).navigation
const config = WIKI.config as { nav: { mode: string; expandParent?: boolean } }
const cache = WIKI.cache as { set(key: string, value: unknown, ttl: number): Promise<unknown> }
const configService = WIKI.configSvc as { saveToDb(keys: string[]): Promise<unknown> }

const validItem = (item: unknown): item is NavigationItem => {
  if (
    !item ||
    !_.isPlainObject(item) ||
    !_.isString(Reflect.get(item, 'id')) ||
    Reflect.get(item, 'id').length < 1 ||
    !_.isString(Reflect.get(item, 'kind')) ||
    Reflect.get(item, 'kind').length < 1
  )
    return false
  for (const field of ['label', 'icon', 'targetType', 'target', 'visibilityMode']) {
    const value = Reflect.get(item, field)
    if (!_.isNil(value) && !_.isString(value)) return false
  }
  const visibilityGroups = Reflect.get(item, 'visibilityGroups')
  return _.isNil(visibilityGroups) || (Array.isArray(visibilityGroups) && visibilityGroups.every(Number.isInteger))
}

const validTree = (tree: unknown): tree is NavigationRow[] =>
  Array.isArray(tree) &&
  tree.every(
    row =>
      row &&
      _.isPlainObject(row) &&
      _.isString(Reflect.get(row, 'locale')) &&
      Reflect.get(row, 'locale').length > 0 &&
      Array.isArray(Reflect.get(row, 'items')) &&
      Reflect.get(row, 'items').every(validItem)
  )

const serializeItem = (item: NavigationItem): Partial<NavigationItem> =>
  _.pick(item, ['id', 'kind', 'label', 'icon', 'targetType', 'target', 'visibilityMode', 'visibilityGroups'])

const get = async () => {
  const tree = await navigationModel.getTree({ cache: false, locale: 'all', bypassAuth: true })
  return {
    config: {
      mode: config.nav.mode,
      expandParent: config.nav.expandParent !== false
    },
    tree: tree.map(row => ({ locale: row.locale, items: normalizeNavigationItems(row.items).map(serializeItem) }))
  }
}

const update = async (input: { tree: unknown; mode: unknown; expandParent: unknown }): Promise<void> => {
  const { tree, mode, expandParent } = input
  if (!validTree(tree)) {
    throw new ApplicationError('tree must be an array of locale navigation trees with valid navigation items', { code: 'INVALID_NAVIGATION_TREE' })
  }
  if (typeof mode !== 'string' || !validModes.includes(mode)) {
    throw new ApplicationError('mode must be a valid navigation mode', { code: 'INVALID_NAVIGATION_MODE' })
  }
  if (typeof expandParent !== 'boolean') {
    throw new ApplicationError('expandParent must be a boolean', { code: 'INVALID_NAVIGATION_EXPANSION' })
  }
  const normalizedTree = tree.map(row => ({
    ...row,
    items: normalizeNavigationItems(row.items)
  }))
  await navigationModel.query().patch({ config: normalizedTree }).where('key', 'site')
  for (const row of normalizedTree) {
    await cache.set(`nav:sidebar:${row.locale}`, row.items, 300)
  }
  config.nav = { mode, expandParent }
  await configService.saveToDb(['nav'])
}

export default { get, update }
