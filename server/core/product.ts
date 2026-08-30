import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import packageJson from '../../package.json' with { type: 'json' }
import type { BuildIdentity, ProductDefinition, ProductMetadata } from '../../shared/product.ts'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`package.json product.${key} must be a non-empty string`)
  }
  return value
}

const readProductDefinition = (): ProductDefinition => {
  const rawPackage = packageJson as unknown as Record<string, unknown>
  const rawProduct = rawPackage.product
  if (!isRecord(rawProduct)) throw new Error('package.json product metadata is missing')
  if (rawProduct.independentFork !== true) throw new Error('package.json product.independentFork must be true')

  const definition: ProductDefinition = {
    name: requireString(rawProduct, 'name'),
    version: requireString(rawPackage, 'version'),
    description: requireString(rawPackage, 'description'),
    sourceRepository: requireString(rawProduct, 'sourceRepository'),
    containerRepository: requireString(rawProduct, 'containerRepository'),
    upstreamName: requireString(rawProduct, 'upstreamName'),
    upstreamVersion: requireString(rawProduct, 'upstreamVersion'),
    independentFork: true,
    modifiedAt: requireString(rawProduct, 'modifiedAt')
  }

  if (requireString(rawProduct, 'version') !== definition.version) {
    throw new Error('package.json version and product.version must match')
  }
  return Object.freeze(definition)
}

export const productDefinition = readProductDefinition()

export const createProductMetadata = (build: BuildIdentity): ProductMetadata => {
  if (!/^[0-9a-f]{40}$/.test(build.revision)) {
    throw new Error('Build revision must be a full lowercase Git commit SHA')
  }
  if (!Number.isFinite(Date.parse(build.date))) {
    throw new Error('Build date must be an ISO-8601 timestamp')
  }

  return Object.freeze({
    ...productDefinition,
    revision: build.revision,
    date: new Date(build.date).toISOString(),
    upstreamBase: `${productDefinition.upstreamName} ${productDefinition.upstreamVersion}`,
    sourceUrl: `${productDefinition.sourceRepository}/tree/${build.revision}`
  })
}

const readGeneratedIdentity = (rootPath: string): BuildIdentity | null => {
  const metadataPath = path.join(rootPath, 'server', '.build-metadata.json')
  if (!fs.existsSync(metadataPath)) return null
  const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  if (!isRecord(parsed) || typeof parsed.revision !== 'string' || typeof parsed.date !== 'string') {
    throw new Error(`Invalid generated build metadata at ${metadataPath}`)
  }
  return { revision: parsed.revision, date: parsed.date }
}

const readGitIdentity = (rootPath: string): BuildIdentity => {
  const runGit = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: rootPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  const revision = runGit(['rev-parse', 'HEAD'])
  return {
    revision,
    date: runGit(['show', '-s', '--format=%cI', revision])
  }
}

export const loadProductMetadata = (rootPath: string): ProductMetadata => {
  const generated = readGeneratedIdentity(rootPath)
  if (generated) return createProductMetadata(generated)

  if (process.env.WIKI_BUILD_REVISION && process.env.WIKI_BUILD_DATE) {
    return createProductMetadata({
      revision: process.env.WIKI_BUILD_REVISION,
      date: process.env.WIKI_BUILD_DATE
    })
  }

  try {
    return createProductMetadata(readGitIdentity(rootPath))
  } catch {
    throw new Error('Build metadata is unavailable. Run bun run build or provide WIKI_BUILD_REVISION and WIKI_BUILD_DATE.')
  }
}
