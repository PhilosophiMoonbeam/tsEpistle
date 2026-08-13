import fs from 'fs-extra'
import path from 'node:path'

interface Extension { check(): Promise<boolean> }
interface WikiContext {
  SERVERPATH: string
  extensions: ExtensionService
  logger: { info(message: string): void }
}
interface ExtensionService { ext: Record<string, Extension>; init(): Promise<void> }

const wiki = WIKI as unknown as WikiContext
const extensions: ExtensionService = {
  ext: {},
  async init() {
    const extDirs = (await fs.readdir(path.join(wiki.SERVERPATH, 'modules/extensions'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    wiki.logger.info('Checking for installed optional extensions...')
    for (const dir of extDirs) {
      const moduleUrl = new URL(`../modules/extensions/${dir}/ext.ts`, import.meta.url)
      const loaded = await import(moduleUrl.href) as { default: Extension }
      wiki.extensions.ext[dir] = loaded.default
      const isInstalled = await wiki.extensions.ext[dir].check()
      wiki.logger.info(isInstalled
        ? `Optional extension ${dir} is installed. [ OK ]`
        : `Optional extension ${dir} was not found on this system. [ SKIPPED ]`)
    }
  }
}

export default extensions
