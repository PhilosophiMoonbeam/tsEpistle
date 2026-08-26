import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('release manifest generation', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
  })

  it('binds sorted release artifacts and the image digest to deterministic checksums', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-release-manifest-'))
    temporaryDirectories.push(directory)
    const alphaPath = path.join(directory, 'alpha.tar.gz')
    const zetaPath = path.join(directory, 'zeta.json')
    const manifestPath = path.join(directory, 'release-manifest.json')
    const checksumsPath = path.join(directory, 'SHA256SUMS')
    fs.writeFileSync(zetaPath, 'zeta\n')
    fs.writeFileSync(alphaPath, 'alpha\n')

    const env = {
      ...process.env,
      GITHUB_REF_NAME: 'v0.1.0-alpha.1',
      IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
      IMAGE_REPOSITORY: 'ghcr.io/philosophimoonbeam/wiki',
      WIKI_BUILD_DATE: '2026-08-15T00:00:00.000Z',
      WIKI_BUILD_REVISION: 'b'.repeat(40),
      WIKI_PRODUCT_NAME: 'tsFranki',
      WIKI_PRODUCT_VERSION: '0.1.0-alpha.1',
      WIKI_SOURCE_REPOSITORY: 'https://github.com/PhilosophiMoonbeam/wiki',
      WIKI_UPSTREAM_BASE: 'Wiki.js 2.5.314'
    }
    const args = [
      'server/scripts/generate-release-manifest.ts',
      manifestPath,
      checksumsPath,
      zetaPath,
      alphaPath
    ]

    execFileSync(process.execPath, args, { cwd: process.cwd(), env })
    const firstManifest = fs.readFileSync(manifestPath, 'utf8')
    const firstChecksums = fs.readFileSync(checksumsPath, 'utf8')
    const manifest = JSON.parse(firstManifest)

    expect(manifest.containerImage).toEqual({
      reference: `ghcr.io/philosophimoonbeam/wiki@sha256:${'a'.repeat(64)}`,
      digest: `sha256:${'a'.repeat(64)}`
    })
    expect(manifest.release).toMatchObject({
      revision: 'b'.repeat(40),
      tag: 'v0.1.0-alpha.1'
    })
    expect(manifest.artifacts).toEqual([
      { name: 'alpha.tar.gz', sha256: sha256('alpha\n'), bytes: 6 },
      { name: 'zeta.json', sha256: sha256('zeta\n'), bytes: 5 }
    ])
    expect(firstChecksums.trim().split('\n')).toEqual([
      `${sha256('alpha\n')}  alpha.tar.gz`,
      `${sha256(firstManifest)}  release-manifest.json`,
      `${sha256('zeta\n')}  zeta.json`
    ])

    execFileSync(process.execPath, args, { cwd: process.cwd(), env })
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(firstManifest)
    expect(fs.readFileSync(checksumsPath, 'utf8')).toBe(firstChecksums)
  })
})
