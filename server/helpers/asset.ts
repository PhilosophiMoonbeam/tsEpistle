import { createHash } from 'node:crypto'
import { parse, type ParsedPath } from 'node:path'

const assetHelper = {
  generateHash (assetPath: string): string {
    return createHash('sha1').update(assetPath).digest('hex')
  },
  getPathInfo (assetPath: string): ParsedPath {
    return parse(assetPath.toLowerCase())
  }
}

export default assetHelper
