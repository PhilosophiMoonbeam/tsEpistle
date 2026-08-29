import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { createProductMetadata, type BuildIdentity, type ProductMetadata } from '../../shared/product.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  const runGit = (args: string[]): string => execFileSync('git', args, {
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
