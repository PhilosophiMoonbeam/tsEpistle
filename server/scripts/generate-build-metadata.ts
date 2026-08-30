import { execFileSync } from 'node:child_process'
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

fs.writeFileSync(outputPath, `${JSON.stringify({ revision: metadata.revision, date: metadata.date }, null, 2)}\n`)
process.stdout.write(`Embedded ${metadata.name} ${metadata.version} build ${metadata.revision}\n`)
