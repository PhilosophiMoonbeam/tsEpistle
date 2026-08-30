import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const manifestPath = process.argv[2]
const checksumsPath = process.argv[3]
const artifactPaths = process.argv.slice(4)

if (!manifestPath || !checksumsPath || artifactPaths.length === 0) {
  throw new Error('Usage: generate-release-manifest.ts MANIFEST CHECKSUMS ARTIFACT...')
}

const revision = requireEnv('WIKI_BUILD_REVISION')
const buildDate = requireEnv('WIKI_BUILD_DATE')
const version = requireEnv('WIKI_PRODUCT_VERSION')
const releaseTag = requireEnv('GITHUB_REF_NAME')
const imageRepository = requireEnv('IMAGE_REPOSITORY')
const imageDigest = requireEnv('IMAGE_DIGEST')
const agentBrowserImageRepository = requireEnv('AGENT_BROWSER_IMAGE_REPOSITORY')
const agentBrowserImageDigest = requireEnv('AGENT_BROWSER_IMAGE_DIGEST')

const imageRepositoryPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/
const requireCleanImageRepository = (name: string, value: string): void => {
  if (!imageRepositoryPattern.test(value)) {
    throw new Error(`${name} must be an OCI repository without a tag or digest`)
  }
}

requireCleanImageRepository('IMAGE_REPOSITORY', imageRepository)
requireCleanImageRepository('AGENT_BROWSER_IMAGE_REPOSITORY', agentBrowserImageRepository)

if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('WIKI_BUILD_REVISION must be a full lowercase Git SHA')
if (new Date(buildDate).toISOString() !== buildDate) throw new Error('WIKI_BUILD_DATE must be an ISO 8601 UTC timestamp')
if (releaseTag !== `v${version}`) throw new Error(`Release tag ${releaseTag} does not match product version ${version}`)
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new Error('IMAGE_DIGEST must be a sha256 OCI digest')
if (!/^sha256:[0-9a-f]{64}$/.test(agentBrowserImageDigest)) {
  throw new Error('AGENT_BROWSER_IMAGE_DIGEST must be a sha256 OCI digest')
}

const sha256 = (filePath: string): string => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const describeArtifact = (filePath: string) => {
  const stats = fs.statSync(filePath)
  if (!stats.isFile()) throw new Error(`Release artifact is not a regular file: ${filePath}`)
  return {
    name: path.basename(filePath),
    sha256: sha256(filePath),
    bytes: stats.size
  }
}

const artifacts = artifactPaths.map(describeArtifact).sort((left, right) => left.name.localeCompare(right.name))
const names = artifacts.map(artifact => artifact.name)
if (new Set(names).size !== names.length) throw new Error('Release artifact basenames must be unique')

const reservedNames = new Set([path.basename(manifestPath), path.basename(checksumsPath)])
if (names.some(name => reservedNames.has(name))) throw new Error('Release artifacts must not overwrite manifest outputs')

const manifest = {
  schemaVersion: 1,
  product: {
    name: requireEnv('WIKI_PRODUCT_NAME'),
    version
  },
  release: {
    tag: releaseTag,
    revision,
    buildDate,
    sourceRepository: requireEnv('WIKI_SOURCE_REPOSITORY'),
    upstreamBase: requireEnv('WIKI_UPSTREAM_BASE')
  },
  containerImage: {
    reference: `${imageRepository}@${imageDigest}`,
    digest: imageDigest
  },
  agentBrowserImage: {
    reference: `${agentBrowserImageRepository}@${agentBrowserImageDigest}`,
    digest: agentBrowserImageDigest
  },
  artifacts
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const checksumEntries = [...artifacts, describeArtifact(manifestPath)].sort((left, right) => left.name.localeCompare(right.name))
fs.writeFileSync(checksumsPath, `${checksumEntries.map(artifact => `${artifact.sha256}  ${artifact.name}`).join('\n')}\n`)
