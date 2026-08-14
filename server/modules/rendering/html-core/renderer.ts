import { wiki } from '../../types.ts'
import _ from 'lodash'
import { load } from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import { isTag, isText } from 'domhandler'
import type { AnyNode } from 'domhandler'
import uslug from 'uslug'
import pageHelper from '../../../helpers/page.ts'
import { scopePageQueryForOwner, type PageVisibility } from '../../../helpers/page-access.ts'
import { URL } from 'node:url'

const mustacheRegExp = /(\{|&#x7b;?){2}(.+?)(\}|&#x7d;?){2}/i

interface RendererConfig {
  absoluteLinks: boolean
  openExternalLinkNewTab: boolean
  relAttributeExternalLink: string
}

interface RendererChild {
  config: unknown
  key: string
  order?: number
  step?: 'pre' | 'post'
}

interface PageReference {
  localeCode: string
  path: string
}

interface StoredPageLink extends PageReference {
  id: number
}

interface PageLinkInsert extends PageReference {
  pageId: number
}

interface ParsedPagePath {
  locale: string
  path: string
}

interface RendererPage {
  id: number
  localeCode: string
  path: string
  visibility: PageVisibility
  ownerId: number | null
  $relatedQuery(relation: 'links'): Promise<unknown>
}

interface RendererContext {
  children: RendererChild[]
  config: RendererConfig
  input: string
  page: RendererPage
}

interface PageQueryFilter {
  orWhere(reference: PageReference): PageQueryFilter
  where(reference: PageReference): PageQueryFilter
}


function isPageReference (value: unknown): value is PageReference {
  return typeof value === 'object' && value !== null &&
    'localeCode' in value && typeof value.localeCode === 'string' &&
    'path' in value && typeof value.path === 'string'
}

function isStoredPageLink (value: unknown): value is StoredPageLink {
  return isPageReference(value) && 'id' in value && typeof value.id === 'number'
}

function requirePageReferences (value: unknown): PageReference[] {
  if (!Array.isArray(value) || !value.every(isPageReference)) {
    throw new TypeError('Page reference query returned invalid data')
  }
  return value
}

function requireStoredPageLinks (value: unknown): StoredPageLink[] {
  if (!Array.isArray(value) || !value.every(isStoredPageLink)) {
    throw new TypeError('Related page links query returned invalid data')
  }
  return value
}

async function invokeRenderer (moduleValue: unknown, input: CheerioAPI | string, config: unknown): Promise<unknown> {
  if (typeof moduleValue !== 'object' || moduleValue === null || !('default' in moduleValue) ||
    typeof moduleValue.default !== 'object' || moduleValue.default === null) {
    throw new TypeError('Invalid renderer module')
  }
  const renderer = moduleValue.default
  const init = 'init' in renderer ? renderer.init : undefined
  if (typeof init !== 'function') {
    throw new TypeError('Renderer module does not export an init function')
  }
  return await Reflect.apply(init, renderer, [input, config])
}

async function insertPageLinks (rows: PageLinkInsert[]): Promise<void> {
  const query: unknown = wiki.models.pageLinks.query()
  if (typeof query !== 'object' || query === null || !('insert' in query) || typeof query.insert !== 'function') {
    throw new TypeError('Page links query does not support inserts')
  }
  await Reflect.apply(query.insert, query, [rows])
}

function requireBodyHtml ($: CheerioAPI): string {
  const html = $.html('body')
  if (html === null) {
    throw new TypeError('Rendered document does not contain a body')
  }
  return html
}


const plugin = {
  async render (this: RendererContext): Promise<string> {
    let $ = load(this.input)

    if ($.root().children().length < 1) {
      return ''
    }

    // --------------------------------
    // STEP: PRE
    // --------------------------------

    for (const child of _.reject(this.children, ['step', 'post'])) {
      const rendererModule: unknown = await import(`../${_.kebabCase(child.key)}/renderer.ts`)
      await invokeRenderer(rendererModule, $, child.config)
    }

    // --------------------------------
    // Detect internal / external links
    // --------------------------------

    const internalRefs: PageReference[] = []
    const reservedPrefixes = /^\/[a-z]\//i
    const exactReservedPaths = /^\/[a-z]$/i

    const isHostSet = wiki.config.host.length > 7 && wiki.config.host !== 'http://'
    if (!isHostSet) {
      wiki.logger.warn('Host is not set. You must set the Site Host under General in the Administration Area!')
    }

    $('a').each((i, elm) => {
      let href = $(elm).attr('href')

      // -> Ignore empty / anchor links, e-mail addresses, and telephone numbers
      if (!href || href.length < 1 || href.indexOf('#') === 0 ||
        href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) {
        return
      }

      // -> Strip host from local links
      if (isHostSet && href.indexOf(`${wiki.config.host}/`) === 0) {
        href = href.replace(wiki.config.host, '')
      }

      // -> Assign local / external tag
      if (href.indexOf('://') < 0) {
        // -> Remove trailing slash
        if (_.endsWith('/')) {
          href = href.slice(0, -1)
        }

        // -> Check for system prefix
        if (reservedPrefixes.test(href) || exactReservedPaths.test(href)) {
          $(elm).addClass(`is-system-link`)
        } else if (href.indexOf('.') >= 0) {
          $(elm).addClass(`is-asset-link`)
        } else {
          let pagePath: ParsedPagePath

          // -> Add locale prefix if using namespacing
          if (wiki.config.lang.namespacing) {
            // -> Reformat paths
            if (href.indexOf('/') !== 0) {
              if (this.config.absoluteLinks) {
                href = `/${this.page.localeCode}/${href}`
              } else {
                href = (this.page.path === 'home') ? `/${this.page.localeCode}/${href}` : `/${this.page.localeCode}/${this.page.path}/${href}`
              }
            } else if (href.charAt(3) !== '/') {
              href = `/${this.page.localeCode}${href}`
            }

            try {
              const parsedUrl = new URL(`http://x${href}`)
              pagePath = pageHelper.parsePath(parsedUrl.pathname)
            } catch {
              return
            }
          } else {
            // -> Reformat paths
            if (href.indexOf('/') !== 0) {
              if (this.config.absoluteLinks) {
                href = `/${href}`
              } else {
                href = (this.page.path === 'home') ? `/${href}` : `/${this.page.path}/${href}`
              }
            }

            try {
              const parsedUrl = new URL(`http://x${href}`)
              pagePath = pageHelper.parsePath(parsedUrl.pathname)
            } catch {
              return
            }
          }
          // -> Save internal references
          internalRefs.push({
            localeCode: pagePath.locale,
            path: pagePath.path
          })

          $(elm).addClass(`is-internal-link`)
        }
      } else {
        $(elm).addClass(`is-external-link`)
        if (this.config.openExternalLinkNewTab) {
          $(elm).attr('target', '_blank')
          $(elm).attr('rel', this.config.relAttributeExternalLink)
        }
      }

      // -> Update element
      $(elm).attr('href', href)
    })

    // --------------------------------
    // Detect internal link states
    // --------------------------------

    const pastLinks = requireStoredPageLinks(await this.page.$relatedQuery('links'))

    if (internalRefs.length > 0) {
      // -> Find matching pages
      const pageQuery = wiki.models.pages.query().column('id', 'path', 'localeCode').where((builder: PageQueryFilter) => {
        internalRefs.forEach((ref, idx) => {
          if (idx < 1) {
            builder.where(ref)
          } else {
            builder.orWhere(ref)
          }
        })
      })
      scopePageQueryForOwner(pageQuery, this.page.visibility === 'private' ? this.page.ownerId : null)
      const queryResult: unknown = await pageQuery
      const results = requirePageReferences(queryResult)

      // -> Apply tag to internal links for found pages
      $('a.is-internal-link').each((i, elm) => {
        const href = $(elm).attr('href')
        let hrefObj: ParsedPagePath
        try {
          const parsedUrl = new URL(`http://x${href}`)
          hrefObj = pageHelper.parsePath(parsedUrl.pathname)
        } catch {
          return
        }
        if (_.some(results, r => {
          return r.localeCode === hrefObj.locale && r.path === hrefObj.path
        })) {
          $(elm).addClass(`is-valid-page`)
        } else {
          $(elm).addClass(`is-invalid-page`)
        }
      })

      // -> Add missing links
      const missingLinks = _.differenceWith(internalRefs, pastLinks, (nLink, pLink) => {
        return nLink.localeCode === pLink.localeCode && nLink.path === pLink.path
      })
      if (missingLinks.length > 0) {
        if (wiki.config.db.type === 'postgres') {
          await insertPageLinks(missingLinks.map(lnk => ({
            pageId: this.page.id,
            path: lnk.path,
            localeCode: lnk.localeCode
          })))
        } else {
          for (const lnk of missingLinks) {
            await wiki.models.pageLinks.query().insert({
              pageId: this.page.id,
              path: lnk.path,
              localeCode: lnk.localeCode
            })
          }
        }
      }
    }

    // -> Remove outdated links
    if (pastLinks) {
      const outdatedLinks = _.differenceWith(pastLinks, internalRefs, (nLink, pLink) => {
        return nLink.localeCode === pLink.localeCode && nLink.path === pLink.path
      })
      if (outdatedLinks.length > 0) {
        await wiki.models.pageLinks.query().delete().whereIn('id', _.map(outdatedLinks, 'id'))
      }
    }

    // --------------------------------
    // Add header handles
    // --------------------------------

    const headers: string[] = []
    $('h1,h2,h3,h4,h5,h6').each((i, elm) => {
      let headerSlug = uslug($(elm).text())
      // -> If custom ID is defined, try to use that instead
      const customId = $(elm).attr('id')
      if (customId) {
        headerSlug = customId
      }

      // -> Cannot start with a number (CSS selector limitation)
      if (headerSlug.match(/^\d/)) {
        headerSlug = `h-${headerSlug}`
      }

      // -> Make sure header is unique
      if (headers.indexOf(headerSlug) >= 0) {
        let isUnique = false
        let hIdx = 1
        while (!isUnique) {
          const headerSlugTry = `${headerSlug}-${hIdx}`
          if (headers.indexOf(headerSlugTry) < 0) {
            isUnique = true
            headerSlug = headerSlugTry
          }
          hIdx++
        }
      }

      // -> Add anchor
      $(elm).attr('id', headerSlug).addClass('toc-header')
      $(elm).prepend(`<a class="toc-anchor" href="#${headerSlug}">&#xB6;</a> `)

      headers.push(headerSlug)
    })

    // --------------------------------
    // Wrap non-empty root text nodes
    // --------------------------------

    $('body').contents().toArray().forEach(item => {
      if (isText(item) && item.parent && isTag(item.parent) && item.parent.name === 'body' && item.data !== `\n` && item.data !== `\r`) {
        $(item).wrap('<div></div>')
      }
    })

    // --------------------------------
    // Wrap root table nodes
    // --------------------------------

    $('body').contents().toArray().forEach(item => {
      if (isTag(item) && item.parent && isTag(item.parent) && item.name === 'table' && item.parent.name === 'body') {
        $(item).wrap('<div class="table-container"></div>')
      }
    })

    // --------------------------------
    // STEP: POST
    // --------------------------------

    let output = decodeEscape(requireBodyHtml($).replace('<body>', '').replace('</body>', ''))

    for (const child of _.sortBy(_.filter(this.children, ['step', 'post']), ['order'])) {
      const rendererModule: unknown = await import(`../${_.kebabCase(child.key)}/renderer.ts`)
      const renderedOutput = await invokeRenderer(rendererModule, output, child.config)
      if (typeof renderedOutput !== 'string') {
        throw new TypeError(`Renderer ${child.key} returned a non-string result`)
      }
      output = renderedOutput
    }

    // --------------------------------
    // Escape mustache expresions
    // --------------------------------

    $ = load(output)

    function iterateMustacheNodes (nodes: Cheerio<AnyNode>): void {
      nodes.contents().each((idx, item) => {
        if (isText(item)) {
          const rawText = $(item).text().replace(/\r?\n|\r/g, '')
          if (mustacheRegExp.test(rawText)) {
            if (!item.parent || (isTag(item.parent) && item.parent.name === 'body')) {
              $(item).wrap($('<p>').attr('v-pre', 'true'))
            } else {
              $(item).parent().attr('v-pre', 'true')
            }
          }
        } else {
          iterateMustacheNodes($(item))
        }
      })
    }
    iterateMustacheNodes($.root())

    $('pre').each((idx, elm) => {
      $(elm).attr('v-pre', 'true')
    })

    return decodeEscape(requireBodyHtml($).replace('<body>', '').replace('</body>', ''))
  }
}

function decodeEscape (value: string): string {
  return value.replace(/&#x([0-9a-f]{1,6});/ig, (entity: string, code: string) => {
    const codePoint = Number.parseInt(code, 16)

    // Don't unescape ASCII characters, assuming they're encoded for a good reason
    if (codePoint < 0x80) return entity

    return String.fromCodePoint(codePoint)
  })
}

export default plugin
