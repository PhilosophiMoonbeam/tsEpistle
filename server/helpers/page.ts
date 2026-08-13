import qs from 'node:querystring'
import crypto from 'node:crypto'
import path from 'node:path'
import _ from 'lodash'

interface ParsePathOptions {
  stripExt?: boolean
}

interface ParsedPath {
  locale: string
  path: string
  private: boolean
  privateNS: string
  explicitLocale: boolean
}

interface HashOptions {
  locale: string
  path: string
  privateNS: string
}

interface PageTag {
  tag: string
}

interface PageMetadata {
  title: string
  description: string
  isPublished: boolean
  updatedAt: string | Date
  tags?: PageTag[]
  editorKey: string
  createdAt: string | Date
  contentType: string
  content: string | Record<string, unknown>
}

interface WikiContext {
  config: { lang: { code: string } }
  data: { reservedPaths: string[] }
}

const wiki = WIKI as unknown as WikiContext

const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i
const localeFolderRegex = /^([a-z]{2}(?:-[a-z]{2})?\/)?(.*)/i
// eslint-disable-next-line no-control-regex
const unsafeCharsRegex = /[\x00-\x1f\x80-\x9f\\"|<>:*?]/

const contentToExt: Record<string, string> = {
  markdown: 'md',
  asciidoc: 'adoc',
  html: 'html'
}
const extToContent: Record<string, string> = _.invert(contentToExt)

const pageHelper = {
  /**
   * Parse raw url path and make it safe
   */
  parsePath (rawPath: string, opts: ParsePathOptions = {}): ParsedPath {
    const pathObj: ParsedPath = {
      locale: wiki.config.lang.code,
      path: 'home',
      private: false,
      privateNS: '',
      explicitLocale: false
    }

    // Clean Path
    rawPath = _.trim(qs.unescape(rawPath))
    if (_.startsWith(rawPath, '/')) { rawPath = rawPath.substring(1) }
    rawPath = rawPath.replace(unsafeCharsRegex, '')
    if (rawPath === '') { rawPath = 'home' }

    rawPath = rawPath.replace(/\\/g, '').replace(/\/\//g, '').replace(/\.\.+/ig, '')

    // Extract Info
    const pathParts = _.filter(_.split(rawPath, '/'), p => {
      p = _.trim(p)
      return !_.isEmpty(p) && p !== '..' && p !== '.'
    })
    const firstPart = pathParts[0]
    if (firstPart?.length === 1) {
      pathParts.shift()
    }
    const localePart = pathParts[0]
    if (localePart && localeSegmentRegex.test(localePart)) {
      pathObj.locale = localePart
      pathObj.explicitLocale = true
      pathParts.shift()
    }

    // Strip extension
    if (opts.stripExt && pathParts.length > 0) {
      const lastPart = _.last(pathParts)
      if (lastPart && lastPart.indexOf('.') > 0) {
        pathParts.pop()
        const lastPartMeta = path.parse(lastPart)
        pathParts.push(lastPartMeta.name)
      }
    }

    pathObj.path = _.join(pathParts, '/')
    return pathObj
  },
  /**
   * Generate unique hash from page
   */
  generateHash (opts: HashOptions): string {
    return crypto.createHash('sha1').update(`${opts.locale}|${opts.path}|${opts.privateNS}`).digest('hex')
  },
  /**
   * Inject Page Metadata
   */
  injectPageMetadata (page: PageMetadata): string | Record<string, unknown> {
    const meta: Array<[string, string]> = [
      ['title', page.title],
      ['description', page.description],
      ['published', page.isPublished.toString()],
      ['date', String(page.updatedAt)],
      ['tags', page.tags ? page.tags.map(t => t.tag).join(', ') : ''],
      ['editor', page.editorKey],
      ['dateCreated', String(page.createdAt)]
    ]
    switch (page.contentType) {
      case 'markdown':
        return '---\n' + meta.map(mt => `${mt[0]}: ${mt[1]}`).join('\n') + '\n---\n\n' + String(page.content)
      case 'html':
        return '<!--\n' + meta.map(mt => `${mt[0]}: ${mt[1]}`).join('\n') + '\n-->\n\n' + String(page.content)
      case 'json':
        return {
          ...(typeof page.content === 'object' && page.content !== null ? page.content : {}),
          _meta: _.fromPairs(meta)
        }
      default:
        return page.content
    }
  },
  /**
   * Check if path is a reserved path
   */
  isReservedPath (rawPath: string): boolean {
    const firstSection = _.head(rawPath.split('/'))
    if (!firstSection || firstSection.length <= 1) {
      return true
    } else if (localeSegmentRegex.test(firstSection)) {
      return true
    } else if (
      _.some(wiki.data.reservedPaths, p => {
        return p === firstSection
      })) {
      return true
    } else {
      return false
    }
  },
  /**
   * Get file extension from content type
   */
  getFileExtension (contentType: string): string {
    return contentToExt[contentType] ?? 'txt'
  },
  /**
   * Get content type from file extension
   */
  getContentType (filePath: string): string | false {
    const ext = _.last(filePath.split('.'))
    return ext ? extToContent[ext] ?? false : false
  },
  /**
   * Get Page Meta object from disk path
   */
  getPagePath (filePath: string): { locale: string, path: string } {
    let fpath = filePath
    if (process.platform === 'win32') {
      fpath = filePath.replace(/\\/g, '/')
    }
    let meta = {
      locale: wiki.config.lang.code,
      path: _.initial(fpath.split('.')).join('')
    }
    const result = localeFolderRegex.exec(meta.path)
    const localeFolder = result?.[1]
    const pagePath = result?.[2]
    if (localeFolder && pagePath !== undefined) {
      meta = {
        locale: localeFolder.replace('/', ''),
        path: pagePath
      }
    }
    return meta
  }
}

export default pageHelper
