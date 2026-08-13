import createDOMPurify from 'dompurify'
import fs from 'fs-extra'
import jsdom from 'jsdom'

const { JSDOM } = jsdom
interface WikiContext { logger: { info(message: string): void, error(message: string): void } }
const wiki = WIKI as unknown as WikiContext

export default async function sanitizeSvg (svgPath: string): Promise<void> {
  wiki.logger.info('Sanitizing SVG file upload...')
  try {
    const svgContents = await fs.readFile(svgPath, 'utf8')
    const window = new JSDOM('').window
    const DOMPurify = createDOMPurify(window)
    await fs.writeFile(svgPath, DOMPurify.sanitize(svgContents))
    wiki.logger.info('Sanitized SVG file upload: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Failed to sanitize SVG file upload: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? error.message : String(error))
    throw error
  }
}
