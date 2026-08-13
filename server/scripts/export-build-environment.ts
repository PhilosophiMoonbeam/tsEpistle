import { execFileSync } from 'node:child_process'

import { productDefinition } from '../../shared/product.ts'

const rootPath = process.cwd()
const runGit = (args: string[]): string => execFileSync('git', args, {
  cwd: rootPath,
  encoding: 'utf8'
}).trim()
const candidateRevision = process.env.GITHUB_SHA || runGit(['rev-parse', 'HEAD'])
const revision = candidateRevision.toLowerCase()
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('GITHUB_SHA must be a full Git commit SHA')
const date = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date(runGit(['show', '-s', '--format=%cI', revision])).toISOString()

const values = {
  IMAGE_REPOSITORY: productDefinition.containerRepository,
  REL_VERSION_STRICT: productDefinition.version,
  SOURCE_DATE_EPOCH: String(Math.floor(Date.parse(date) / 1000)),
  WIKI_BUILD_DATE: date,
  WIKI_BUILD_REVISION: revision,
  WIKI_PRODUCT_DESCRIPTION: productDefinition.description,
  WIKI_PRODUCT_NAME: productDefinition.name,
  WIKI_PRODUCT_VERSION: productDefinition.version,
  WIKI_SOURCE_REPOSITORY: productDefinition.sourceRepository,
  WIKI_UPSTREAM_BASE: `${productDefinition.upstreamName} ${productDefinition.upstreamVersion}`
}
for (const [key, value] of Object.entries(values)) process.stdout.write(`${key}=${value}\n`)
