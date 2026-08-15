import { execFileSync, spawnSync } from 'node:child_process'

import { productDefinition } from '../../shared/product.ts'

const rootPath = process.cwd()
const runGit = (args: string[]): string => execFileSync('git', args, {
  cwd: rootPath,
  encoding: 'utf8'
}).trim()

if (runGit(['status', '--porcelain']).length > 0) {
  throw new Error('Refusing to build a release image from a dirty working tree. Commit the build inputs first.')
}

const revision = runGit(['rev-parse', 'HEAD'])
const date = new Date(runGit(['show', '-s', '--format=%cI', revision])).toISOString()
const image = process.argv[2] || `${productDefinition.containerRepository}:${productDefinition.version}`
const buildArgs = {
  WIKI_BUILD_DATE: date,
  WIKI_BUILD_REVISION: revision,
  WIKI_PRODUCT_DESCRIPTION: productDefinition.description,
  WIKI_PRODUCT_NAME: productDefinition.name,
  WIKI_PRODUCT_VERSION: productDefinition.version,
  WIKI_SOURCE_REPOSITORY: productDefinition.sourceRepository,
  WIKI_UPSTREAM_BASE: `${productDefinition.upstreamName} ${productDefinition.upstreamVersion}`
}
const args = ['build', '--provenance=false', '--file', 'dev/build/Dockerfile', '--tag', image]
for (const [key, value] of Object.entries(buildArgs)) args.push('--build-arg', `${key}=${value}`)
args.push('.')

const result = spawnSync('docker', args, { cwd: rootPath, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
