import type { NextFunction, Request, Response } from 'express'
import _ from 'lodash'

interface SeoWikiContext {
  config: {
    host: string
  }
}

const wiki = WIKI as unknown as SeoWikiContext

export default function seoMiddleware (req: Request, res: Response, next: NextFunction): void {
  if (req.path.length > 1 && _.endsWith(req.path, '/')) {
    const query = req.url.slice(req.path.length) || ''
    res.redirect(301, req.path.slice(0, -1) + query)
  } else {
    _.set(res.locals, 'pageMeta.url', `${wiki.config.host}${req.path}`)
    next()
  }
}
