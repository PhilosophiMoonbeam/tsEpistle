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
  const data: unknown = args.data === undefined ? undefined : JSON.parse(args.data)
  // Runtime scheduler registry selects the job; a static import cannot identify it ahead of time.
  const job = await import(new URL(`../jobs/${args.job}.ts`, import.meta.url).href) as { default: (data: unknown) => Promise<unknown> }
  await job.default(data)
  process.exitCode = 0
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const { promise, resolve } = Promise.withResolvers<void>()
  process.stderr.write(message, () => resolve())
  await promise
  process.exitCode = 1
} finally {
  if (process.connected) process.disconnect?.()
}
