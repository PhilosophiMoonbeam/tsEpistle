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
  explicitLocale: boolean
}

interface HashOptions {
  locale: string
  path: string
  visibility: 'public' | 'private'
  ownerId: number | null
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
  config: { lang: { code: string; namespaces?: string[] } }
  lang?: { localeCodes?: string[] }
  data: { reservedPaths: string[] }
}

const getWiki = (): WikiContext => WIKI as unknown as WikiContext

const localeSegmentRegex = /^[A-Z]{2}(-[A-Z]{2})?$/i
const localeSegment = (segment: string): string | undefined => {
  const wiki = getWiki()
  const known = [...(wiki.lang?.localeCodes ?? []), wiki.config.lang.code, ...(wiki.config.lang.namespaces ?? [])]
  return known.find(code => code.toLowerCase() === segment.toLowerCase()) ?? (localeSegmentRegex.test(segment) ? segment : undefined)
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the exact filesystem control ranges this guard rejects.
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
      locale: getWiki().config.lang.code,
      path: 'home',
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
    if (localePart && localeSegment(localePart)) {
      pathObj.locale = localeSegment(localePart)!
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
    const cacheIdentity = opts.visibility === 'private'
      ? `${opts.locale}|${opts.path}|private|${opts.ownerId}`
      : `${opts.locale}|${opts.path}`
    return crypto.createHash('sha1').update(cacheIdentity).digest('hex')
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
    } else if (localeSegment(firstSection)) {
      return true
    } else if (
      _.some(getWiki().data.reservedPaths, p => {
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
      locale: getWiki().config.lang.code,
      path: _.initial(fpath.split('.')).join('')
    }
    const [first, ...rest] = meta.path.split('/')
    const locale = first && rest.length ? localeSegment(first) : undefined
    if (locale) meta = { locale, path: rest.join('/') }

    return meta
  }
}

export default pageHelper
