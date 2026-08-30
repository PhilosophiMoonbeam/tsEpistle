import { wiki, type QueryBuilder as WikiQueryBuilder, type SearchPlugin, type WikiPage } from '../../types.ts'

type WikiPageQuery = WikiQueryBuilder<WikiPage>

interface RelatedQuery {
  select(...columns: string[]): RelatedQuery
}

interface PageWhereQuery {
  andWhere(...args: unknown[]): PageWhereQuery
  orWhere(...args: unknown[]): PageWhereQuery
  where(...args: unknown[]): PageWhereQuery
}

interface ObjectionPageQuery extends WikiPageQuery {
  modifyGraph(relation: string, modifier: (builder: RelatedQuery) => void): ObjectionPageQuery
  withGraphJoined(relation: string): ObjectionPageQuery
}

const isObjectionPageQuery = (query: WikiPageQuery): query is ObjectionPageQuery =>
  'withGraphJoined' in query && typeof query.withGraphJoined === 'function' && 'modifyGraph' in query && typeof query.modifyGraph === 'function'

const escapedLikeTerm = (value: string): string => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

const escapedPathPrefix = (value: string): string => `${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`

const plugin: SearchPlugin = {
  async activate() {
    // not used
  },
  async deactivate() {
    // not used
  },
  /**
   * INIT
   */
  async init() {
    // not used
  },
  /**
   * QUERY
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q, opts) {
    const pageQuery = wiki.models.pages.query()
    if (!isObjectionPageQuery(pageQuery)) {
      throw new Error('Database search requires an Objection query builder')
    }
    pageQuery.column('pages.id', 'title', 'description', 'path', 'localeCode as locale')
    pageQuery.withGraphJoined('tags') // Adding page tags since they can be used to check resource access permissions
    pageQuery.modifyGraph('tags', (builder: RelatedQuery) => {
      builder.select('tag')
    })
    pageQuery.where('visibility', 'public')
    pageQuery.where((builder: PageWhereQuery) => {
      builder.where('isPublished', true)
      if (opts.locale) {
        builder.andWhere('localeCode', opts.locale)
      }
      const path = opts.path
      if (path) {
        builder.andWhere((pathBuilder: PageWhereQuery) => {
          pathBuilder.where('path', path)
          pathBuilder.orWhere('path', 'like', escapedPathPrefix(path))
        })
      }
      builder.andWhere((builderSub: PageWhereQuery) => {
        const term = escapedLikeTerm(q)
        const pathTerm = escapedLikeTerm(q.toLowerCase())
        if (wiki.config.db.type === 'postgres') {
          builderSub.where('title', 'ILIKE', term)
          builderSub.orWhere('description', 'ILIKE', term)
          builderSub.orWhere('path', 'ILIKE', pathTerm)
        } else {
          builderSub.where('title', 'LIKE', term)
          builderSub.orWhere('description', 'LIKE', term)
          builderSub.orWhere('path', 'LIKE', pathTerm)
        }
      })
    })
    const results = await pageQuery.limit(wiki.config.search.maxHits)
    return {
      results,
      suggestions: [],
      totalHits: results.length
    }
  },
  /**
   * CREATE
   *
   * @param {Object} page Page to create
   */
  async created(_page) {
    void _page
    // not used
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(_page) {
    void _page
    // not used
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(_page) {
    void _page
    // not used
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(_page) {
    void _page
    // not used
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    // not used
  }
}

export default plugin
