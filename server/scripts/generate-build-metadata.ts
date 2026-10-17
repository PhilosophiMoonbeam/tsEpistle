import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createProductMetadata } from '../core/product.ts'

const rootPath = process.cwd()
const outputPath = path.join(rootPath, 'server', '.build-metadata.json')

const runGit = (args: string[]): string =>
  execFileSync('git', args, {
    cwd: rootPath,
    encoding: 'utf8'
  }).trim()
if (!process.env.WIKI_BUILD_REVISION && runGit(['status', '--porcelain']).length > 0) {
  throw new Error('Refusing to embed a Git revision for a dirty working tree. Commit the build inputs first.')
}

const revision = process.env.WIKI_BUILD_REVISION || runGit(['rev-parse', 'HEAD'])
const date =
  process.env.WIKI_BUILD_DATE ||
  (process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : runGit(['show', '-s', '--format=%cI', revision]))
const metadata = createProductMetadata({ revision, date })

// CI prepares this ignored output before checking its security boundary.
// Never follow output links or write through a server directory outside the repository.
const realRoot = fs.realpathSync(rootPath)
const outputDirectory = fs.realpathSync(path.dirname(outputPath))
const relativeDirectory = path.relative(realRoot, outputDirectory)
if (relativeDirectory === '..' || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
  throw new Error('Build metadata directory must stay inside the repository.')
}
const destination = path.join(outputDirectory, path.basename(outputPath))
const existing = fs.lstatSync(destination, { throwIfNoEntry: false })
if (existing && !existing.isFile()) throw new Error('Build metadata output must be a regular file.')
const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`
try {
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ revision: metadata.revision, date: metadata.date }, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporaryPath, destination)
} catch (error: unknown) {
  fs.rmSync(temporaryPath, { force: true })
  throw error
}
process.stdout.write(`Embedded ${metadata.name} ${metadata.version} build ${metadata.revision}\n`)
