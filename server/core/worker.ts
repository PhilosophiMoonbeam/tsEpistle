import path from 'node:path'
import yargs from 'yargs'
import errorTypes from '../helpers/error.ts'
import configService from './config.ts'
import loggerService from './logger.ts'

interface WorkerWiki { IS_DEBUG: boolean; ROOTPATH: string; SERVERPATH: string; Error: typeof errorTypes; configSvc: typeof configService; logger?: ReturnType<typeof loggerService.init>; [key: string]: unknown }
const hideBin = (argv: readonly string[]): string[] => {
  const isBundledElectronApp = Boolean(process.versions.electron) &&
    !('defaultApp' in process && process.defaultApp)
  return argv.slice(isBundledElectronApp ? 1 : 2)
}
const workerWiki: WorkerWiki = { IS_DEBUG: process.env.NODE_ENV === 'development', ROOTPATH: process.cwd(), SERVERPATH: path.join(process.cwd(), 'server'), Error: errorTypes, configSvc: configService }
globalThis.WIKI = workerWiki
configService.init()
workerWiki.logger = loggerService.init('JOB')
const args = await yargs(hideBin(process.argv)).option('job', { type: 'string', demandOption: true }).option('data', { type: 'string' }).parse()

try {
  // Job name is selected by the scheduler process at runtime.
  const job = await import(new URL(`../jobs/${args.job}.ts`, import.meta.url).href) as { default: (data: string | undefined) => Promise<unknown> }
  await job.default(args.data)
  process.exit(0)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  await new Promise<void>(resolve => { process.stderr.write(message, () => resolve()) })
  process.exit(1)
}
