import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { productDefinition } from '../../../shared/product.ts'

const rootPath = process.cwd()
const read = relativePath => fs.readFileSync(path.join(rootPath, relativePath), 'utf8')

describe('product build and publication metadata', () => {
  test('exports deterministic CI build arguments from the product contract', () => {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootPath, encoding: 'utf8' }).trim()
    const output = execFileSync(process.execPath, ['server/scripts/export-build-environment.ts'], {
      cwd: rootPath,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: revision }
    })
    const values = Object.fromEntries(output.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))

    expect(values).toMatchObject({
      IMAGE_REPOSITORY: productDefinition.containerRepository,
      REL_VERSION_STRICT: productDefinition.version,
      WIKI_BUILD_REVISION: revision,
      WIKI_PRODUCT_DESCRIPTION: productDefinition.description,
      WIKI_PRODUCT_NAME: productDefinition.name,
      WIKI_PRODUCT_VERSION: productDefinition.version,
      WIKI_SOURCE_REPOSITORY: productDefinition.sourceRepository,
      WIKI_UPSTREAM_BASE: `${productDefinition.upstreamName} ${productDefinition.upstreamVersion}`
    })
    expect(new Date(values.WIKI_BUILD_DATE).toISOString()).toBe(values.WIKI_BUILD_DATE)
    expect(Number(values.SOURCE_DATE_EPOCH)).toBe(Math.floor(Date.parse(values.WIKI_BUILD_DATE) / 1000))
  })

  test('publishes only fork-owned images and includes required OCI labels', () => {
    const workflow = read('.github/workflows/build.yml')
    const dockerfiles = `${read('dev/build/Dockerfile')}\n${read('dev/build-arm/Dockerfile')}`

    expect(workflow).toContain('server/scripts/export-build-environment.ts')
    expect(workflow).toContain('IMAGE_REPOSITORY')
    expect(workflow.match(/ghcr\.io\/requarks\/wiki:[^\s]+/g)).toEqual([
      expect.stringMatching(new RegExp(`^ghcr\\.io/requarks/wiki:${productDefinition.upstreamVersion}@sha256:[a-f0-9]{64}$`))
    ])
    expect(workflow).not.toMatch(/(?:--tag|tags:)[^\n]*requarks\/wiki/)
    for (const label of ['created', 'description', 'licenses', 'revision', 'source', 'title', 'version']) {
      expect(dockerfiles).toContain(`org.opencontainers.image.${label}`)
    }
    expect(dockerfiles).toContain('io.tsfranki.upstream-base')
  })

  test('keeps deployment defaults on fork-owned artifacts without an upstream updater', () => {
    const helmChart = read('dev/helm/Chart.yaml')
    const helmValues = read('dev/helm/values.yaml')
    const helmWorkflow = read('.github/workflows/helm.yml')
    const packer = `${read('dev/packer/digitalocean.pkr.hcl')}\n${read('dev/packer/scripts/010-docker.sh')}\n${read('dev/packer/scripts/001-onboot.sh')}`
    const deploymentSurface = `${helmChart}\n${helmValues}\n${helmWorkflow}\n${packer}`

    expect(helmChart).toContain(`version: '${productDefinition.version}'`)
    expect(helmChart).toContain(`appVersion: '${productDefinition.version}'`)
    expect(helmValues).toContain(`repository: ${productDefinition.containerRepository}`)
    expect(helmWorkflow).toContain('helm package')
    expect(packer).toContain(`${productDefinition.containerRepository}:\${application_version}`)
    expect(deploymentSurface).not.toMatch(/ghcr\.io\/requarks|charts\.js\.wiki|wiki-update-companion/)
  })

  test('release artifacts include complete revision-specific Corresponding Source', () => {
    const workflow = read('.github/workflows/build.yml')
    expect(workflow).toContain('git archive --format=tar.gz')
    expect(workflow).toContain('tsfranki-source.tar.gz')
    expect(workflow).toContain('$WIKI_SOURCE_REPOSITORY/tree/$WIKI_BUILD_REVISION')
    for (const path of ['package.json', 'pnpm-lock.yaml', 'patches', 'dev/build/Dockerfile', 'dev/build-arm/Dockerfile', 'server/scripts/generate-build-metadata.ts']) {
      expect(() => execFileSync('git', ['ls-files', '--error-unmatch', path], { cwd: rootPath })).not.toThrow()
    }
  })
})
