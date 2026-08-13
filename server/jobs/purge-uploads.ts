import fs from 'fs-extra'
import moment from 'moment'
import path from 'node:path'

interface WikiContext {
  ROOTPATH: string
  config: { dataPath: string }
  logger: { info(message: string): void, error(message: string): void }
}
const wiki = WIKI as unknown as WikiContext

export default async function purgeUploads (): Promise<void> {
  wiki.logger.info('Purging orphaned upload files...')
  try {
    const uploadPath = path.resolve(wiki.ROOTPATH, wiki.config.dataPath, 'uploads')
    await fs.ensureDir(uploadPath)
    const filenames = await fs.readdir(uploadPath)
    const fifteenMinutesAgo = moment().subtract(15, 'minutes')
    const entries = await Promise.all(filenames.map(async filename => ({
      filename,
      stat: await fs.stat(path.join(uploadPath, filename))
    })))
    const expiredFiles = entries.filter(entry => entry.stat.isFile() && moment(entry.stat.ctime).isBefore(fifteenMinutesAgo, 'minute'))
    await Promise.all(expiredFiles.map(entry => fs.unlink(path.join(uploadPath, entry.filename))))
    wiki.logger.info('Purging orphaned upload files: [ COMPLETED ]')
  } catch (error) {
    wiki.logger.error('Purging orphaned upload files: [ FAILED ]')
    wiki.logger.error(error instanceof Error ? error.message : String(error))
  }
}
