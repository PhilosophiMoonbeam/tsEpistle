import fs from 'fs-extra'
import moment from 'moment'
import { opendir } from 'node:fs/promises'
import path from 'node:path'

interface WikiContext {
  ROOTPATH: string
  config: { dataPath: string }
  logger: { info(message: string): void; error(message: string): void }
}
const wiki = WIKI as unknown as WikiContext

export default async function purgeUploads(): Promise<void> {
  wiki.logger.info('Purging orphaned upload files...')
  try {
    const uploadPath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'uploads')
    await fs.ensureDir(uploadPath)
    const entries = await opendir(uploadPath, { bufferSize: 32 })
    const fifteenMinutesAgo = moment().subtract(15, 'minutes')
    for await (const entry of entries) {
      const filename = path.join(uploadPath, entry.name)
      const stat = await fs.stat(filename)
      if (stat.isFile() && moment(stat.ctime).isBefore(fifteenMinutesAgo, 'minute')) {
        await fs.unlink(filename)
      }
    }
    wiki.logger.info('Purging orphaned upload files: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Purging orphaned upload files: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? error.message : String(error))
  }
}
