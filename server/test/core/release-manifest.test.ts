import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from '../bun-test.mts'

const temporaryDirectories: string[] = []
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const releaseEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  AGENT_BROWSER_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
  AGENT_BROWSER_IMAGE_REPOSITORY: 'ghcr.io/philosophimoonbeam/wiki-agent-browser',
  GITHUB_REF_NAME: 'v0.1.0-alpha.1',
  IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
  IMAGE_REPOSITORY: 'ghcr.io/philosophimoonbeam/wiki',
  WIKI_BUILD_DATE: '2026-08-15T00:00:00.000Z',
  WIKI_BUILD_REVISION: 'b'.repeat(40),
  WIKI_PRODUCT_NAME: 'tsEpistle',
  WIKI_PRODUCT_VERSION: '0.1.0-alpha.1',
  WIKI_SOURCE_REPOSITORY: 'https://github.com/PhilosophiMoonbeam/wiki',
  WIKI_UPSTREAM_BASE: 'Wiki.js 2.5.314'
})

describe('release manifest generation', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
  })

  it('keeps package-backed product identity out of the browser system API graph', async () => {
    const rootPath = process.cwd()
    const packagePath = path.join(rootPath, 'package.json')
    const packageManifest = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      description: string
      product: Record<string, unknown>
    }
    const build = await Bun.build({
      entrypoints: [path.join(rootPath, 'client', 'helpers', 'system-api.ts')],
      target: 'browser',
      write: false,
      metafile: true
    })

    expect(build.success).toBe(true)
    const inputs = Object.keys(build.metafile?.inputs ?? {})
    expect(inputs.some(input => input === 'package.json' || input.endsWith('/package.json'))).toBe(false)

    const bundleSource = (await Promise.all(build.outputs.map(output => output.text()))).join('\n')
    for (const key of ['releaseDate', 'packageManager']) {
      expect(bundleSource).not.toContain(key)
    }
    const uniqueManifestValues = [
      packageManifest.description,
      ...['sourceRepository', 'containerRepository', 'modifiedAt'].map(key => packageManifest.product[key])
    ]
    for (const value of uniqueManifestValues) {
      if (typeof value !== 'string') throw new Error('Product manifest values must be strings')
      expect(bundleSource).not.toContain(value)
    }
  })

  it('binds sorted release artifacts and both image digests to deterministic checksums', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-release-manifest-'))
    temporaryDirectories.push(directory)
    const alphaPath = path.join(directory, 'alpha.tar.gz')
    const zetaPath = path.join(directory, 'zeta.json')
    const manifestPath = path.join(directory, 'release-manifest.json')
    const checksumsPath = path.join(directory, 'SHA256SUMS')
    fs.writeFileSync(zetaPath, 'zeta\n')
    fs.writeFileSync(alphaPath, 'alpha\n')

    const env = releaseEnvironment()
    const args = ['server/scripts/generate-release-manifest.ts', manifestPath, checksumsPath, zetaPath, alphaPath]

    execFileSync(process.execPath, args, { cwd: process.cwd(), env })
    const firstManifest = fs.readFileSync(manifestPath, 'utf8')
    const firstChecksums = fs.readFileSync(checksumsPath, 'utf8')
    const manifest = JSON.parse(firstManifest)

    expect(manifest.containerImage).toEqual({
      reference: `ghcr.io/philosophimoonbeam/wiki@sha256:${'a'.repeat(64)}`,
      digest: `sha256:${'a'.repeat(64)}`
    })
    expect(manifest.agentBrowserImage).toEqual({
      reference: `ghcr.io/philosophimoonbeam/wiki-agent-browser@sha256:${'c'.repeat(64)}`,
      digest: `sha256:${'c'.repeat(64)}`
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
    env.IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`
    execFileSync(process.execPath, args, { cwd: process.cwd(), env })
    const primaryDigestManifest = fs.readFileSync(manifestPath, 'utf8')
    const primaryDigestChecksums = fs.readFileSync(checksumsPath, 'utf8')
    expect(primaryDigestManifest).not.toBe(firstManifest)
    expect(primaryDigestChecksums).not.toBe(firstChecksums)
    expect(primaryDigestChecksums).toContain(`${sha256(primaryDigestManifest)}  release-manifest.json`)

    env.IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`
    env.AGENT_BROWSER_IMAGE_DIGEST = `sha256:${'e'.repeat(64)}`
    execFileSync(process.execPath, args, { cwd: process.cwd(), env })
    const browserDigestManifest = fs.readFileSync(manifestPath, 'utf8')
    const browserDigestChecksums = fs.readFileSync(checksumsPath, 'utf8')
    expect(browserDigestManifest).not.toBe(firstManifest)
    expect(browserDigestChecksums).not.toBe(firstChecksums)
    expect(browserDigestChecksums).toContain(`${sha256(browserDigestManifest)}  release-manifest.json`)
  })

  it('rejects missing, malformed, or mutable image provenance', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-release-manifest-invalid-'))
    temporaryDirectories.push(directory)
    const artifactPath = path.join(directory, 'artifact.tar.gz')
    fs.writeFileSync(artifactPath, 'artifact\n')
    const args = [
      'server/scripts/generate-release-manifest.ts',
      path.join(directory, 'release-manifest.json'),
      path.join(directory, 'SHA256SUMS'),
      artifactPath
    ]

    const missingPrimaryDigestEnv = releaseEnvironment()
    delete missingPrimaryDigestEnv.IMAGE_DIGEST
    expect(() =>
      execFileSync(process.execPath, args, {
        cwd: process.cwd(),
        env: missingPrimaryDigestEnv,
        stdio: 'pipe'
      })
    ).toThrow()

    for (const imageRepository of ['ghcr.io/philosophimoonbeam/wiki:latest', `ghcr.io/philosophimoonbeam/wiki@sha256:${'a'.repeat(64)}`]) {
      expect(() =>
        execFileSync(process.execPath, args, {
          cwd: process.cwd(),
          env: {
            ...releaseEnvironment(),
            IMAGE_REPOSITORY: imageRepository
          },
          stdio: 'pipe'
        })
      ).toThrow()
    }

    const missingRepositoryEnv = releaseEnvironment()
    delete missingRepositoryEnv.AGENT_BROWSER_IMAGE_REPOSITORY
    expect(() =>
      execFileSync(process.execPath, args, {
        cwd: process.cwd(),
        env: missingRepositoryEnv,
        stdio: 'pipe'
      })
    ).toThrow()

    const missingDigestEnv = releaseEnvironment()
    delete missingDigestEnv.AGENT_BROWSER_IMAGE_DIGEST
    expect(() =>
      execFileSync(process.execPath, args, {
        cwd: process.cwd(),
        env: missingDigestEnv,
        stdio: 'pipe'
      })
    ).toThrow()

    expect(() =>
      execFileSync(process.execPath, args, {
        cwd: process.cwd(),
        env: {
          ...releaseEnvironment(),
          AGENT_BROWSER_IMAGE_DIGEST: `sha256:${'z'.repeat(64)}`
        },
        stdio: 'pipe'
      })
    ).toThrow()
  })
})
