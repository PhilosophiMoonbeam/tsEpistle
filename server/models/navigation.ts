import { Model } from 'objection'
import _ from 'lodash'

interface NavigationItem extends Record<string, unknown> {
  visibilityMode: string
  visibilityGroups: number[]
}

interface NavigationTree {
  locale: string
  items: NavigationItem[]
}

export default class Navigation extends Model {
  declare key: string
  declare config: NavigationTree[]

  static override get tableName () { return 'navigation' }
  static override get idColumn () { return 'key' }

  static override get jsonSchema () {
    return {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        config: { type: 'array', items: { type: 'object' } }
      }
    }
  }

  static async getTree ({ cache = false, locale = 'en', groups = [], bypassAuth = false }: { cache?: boolean, locale?: string, groups?: number[], bypassAuth?: boolean } = {}): Promise<NavigationItem[] | NavigationTree[]> {
    if (cache) {
      const cachedTree = await wiki.cache.get(`nav:sidebar:${locale}`)
      if (cachedTree) return bypassAuth ? cachedTree : wiki.models.navigation.getAuthorizedItems(cachedTree, groups)
    }
    const navigation = await wiki.models.navigation.query().findOne('key', 'site')
    if (!navigation) {
      wiki.logger.warn('Site Navigation is missing or corrupted.')
      return []
    }
    if (_.has(navigation.config[0], 'kind')) {
      navigation.config = [{
        locale: 'en',
        items: (navigation.config as unknown as NavigationItem[]).map(item => ({ ...item, visibilityMode: 'all', visibilityGroups: [] }))
      }]
    }
    for (const tree of navigation.config) {
      if (cache) await wiki.cache.set(`nav:sidebar:${tree.locale}`, tree.items, 300)
    }
    if (locale === 'all') {
      return bypassAuth ? navigation.config : navigation.config.map(tree => ({ ...tree, items: wiki.models.navigation.getAuthorizedItems(tree.items, groups) }))
    }
    const tree = await wiki.cache.get(`nav:sidebar:${locale}`)
    return bypassAuth ? tree : wiki.models.navigation.getAuthorizedItems(tree, groups)
  }

  static getAuthorizedItems (tree: NavigationItem[] = [], groups: number[] = []): NavigationItem[] {
    return _.filter(tree, leaf => leaf.visibilityMode === 'all' || _.intersection(leaf.visibilityGroups, groups).length > 0)
  }
}

const wiki = WIKI as unknown as {
  cache: {
    get: (key: string) => Promise<NavigationItem[]>
    set: (key: string, value: NavigationItem[], ttl: number) => Promise<void>
  }
  logger: { warn: (message: string) => void }
  models: { navigation: typeof Navigation }
}
