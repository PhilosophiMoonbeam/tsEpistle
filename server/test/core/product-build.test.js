import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { productDefinition } from '../../core/product.ts'

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
    expect(packer).toContain('@sha256:[0-9a-f]{64}$')
    expect(packer).toContain('"application_image=${var.application_image}"')
    expect(packer).toContain('"$application_image"')
    expect(packer).not.toContain(`${productDefinition.containerRepository}:\${application_version}`)
    expect(deploymentSurface).not.toMatch(/ghcr\.io\/requarks|charts\.js\.wiki|wiki-update-companion/)
  })

  test('runs the canonical static contract before PR and protected-branch tests and validates changed chart sources', () => {
    const workflow = read('.github/workflows/build.yml')
    const staticCommands = JSON.parse(read('package.json')).scripts['ci:static']
    const actionlint = read('.github/actionlint.yaml')
    const helmContract = read('server/test/scripts/check-helm-lifecycle-contract.sh')
    for (const command of ['dependencies:check', 'licenses:check', 'openapi:check', 'placeholders:check', 'agents:release-check']) {
      expect(staticCommands).toContain(`bun run ${command}`)
    }
    expect(actionlint).toContain('config-variables: []')
    const prQuality = workflow.slice(workflow.indexOf('  pr-quality:'), workflow.indexOf('\n  quality:'))
    const protectedQuality = workflow.slice(workflow.indexOf('  quality:'), workflow.indexOf('\n  agent-postgres:'))

    for (const qualityJob of [prQuality, protectedQuality]) {
      const staticContract = qualityJob.indexOf('run: bun run ci:static')
      expect(staticContract).toBeGreaterThan(-1)
      expect(staticContract).toBeLessThan(qualityJob.indexOf('run: bun run test'))
      expect(staticContract).toBeLessThan(qualityJob.indexOf('run: bun run build'))
    }

    expect(prQuality).toContain('git diff --quiet "$BASE_SHA" "$GITHUB_SHA" -- dev/helm/')
    expect(prQuality.match(/if: steps\.chart-changes\.outputs\.changed == 'true'/g)).toHaveLength(2)
    expect(prQuality).toContain('run: server/test/scripts/check-helm-lifecycle-contract.sh')
    expect(workflow.match(/server\/test\/scripts\/check-helm-lifecycle-contract\.sh/g)).toHaveLength(2)
    expect(workflow).not.toContain('helm lint dev/helm')
    const releaseHelm = workflow.slice(workflow.indexOf('    - name: Package Helm Chart'), workflow.indexOf('\n    - name: Stage Release Artifacts'))
    expect(releaseHelm.indexOf('server/test/scripts/check-helm-lifecycle-contract.sh')).toBeLessThan(releaseHelm.indexOf('helm package --destination dist dev/helm'))
    expect(helmContract).toContain('helm lint dev/helm')
    expect(helmContract).toContain('helm template wiki dev/helm')
    expect(helmContract).toContain('helm install wiki dev/helm')
    expect(helmContract).toContain('--dry-run=client')
    expect(`${prQuality}\n${helmContract}`).not.toContain('kind create cluster')
    expect(`${prQuality}\n${helmContract}`).not.toContain('helm package')
  })

  test('commits the complete canary set once from a revision-bound immutable promotion record', () => {
    const workflow = read('.github/workflows/build.yml')
    const resolver = read('dev/resolve-canary-promotion.sh')
    const amd64 = workflow.slice(workflow.indexOf('  publish-amd64:'), workflow.indexOf('\n  arm:'))
    const arm64 = workflow.slice(workflow.indexOf('  arm:'), workflow.indexOf('\n  publish-canary:'))
    const canary = workflow.slice(workflow.indexOf('  publish-canary:'), workflow.indexOf('\n  beta:'))
    const release = workflow.slice(workflow.indexOf('  release:'))

    expect(workflow).toContain('group: build-${{ github.ref }}')
    expect(workflow).toContain('cancel-in-progress: true')
    expect(amd64).not.toContain(':canary')
    expect(arm64).not.toContain(':canary')
    expect(amd64).toContain('candidate-amd64-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(arm64).toContain('candidate-arm64-${{ github.run_id }}-${{ github.run_attempt }}')

    expect(canary).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'")
    expect(canary).toContain('needs: [publish-amd64, arm]')
    for (const descriptor of [
      'image-amd64-descriptor.txt',
      'image-arm64-descriptor.txt',
      'agent-browser-amd64-descriptor.txt',
      'agent-browser-arm64-descriptor.txt'
    ]) {
      expect(canary).toContain(descriptor)
    }
    expect(canary).toContain('dev/build/Dockerfile.canary-promotion')
    expect(canary).toContain('mainSha: $main_sha')
    expect(canary).toContain('application: {amd64: $image_amd64, arm64: $image_arm64}')
    expect(canary).toContain('agentBrowser: {amd64: $agent_browser_amd64, arm64: $agent_browser_arm64}')
    expect(canary).toContain('immutable_record="$promotion_repository:$GITHUB_SHA"')
    expect(canary).toContain('if docker buildx imagetools inspect "$immutable_record" --raw')
    expect(canary).toContain('record_descriptor="$immutable_record"')
    expect(canary).toContain('--tag "$immutable_record"')

    const firstFreshnessFence = canary.indexOf('\n        freshness_fence\n')
    const immutableRecord = canary.indexOf('--tag "$immutable_record"')
    const convenienceTags = canary.indexOf('- name: Update Non-authoritative Convenience Canary Tags')
    const finalFreshnessFence = canary.lastIndexOf('if [ "$remote_main" != "$GITHUB_SHA" ]')
    const authoritativeCommit = canary.indexOf('--tag "$promotion_repository:canary-set"')
    expect(firstFreshnessFence).toBeGreaterThan(-1)
    expect(immutableRecord).toBeGreaterThan(firstFreshnessFence)
    expect(convenienceTags).toBeGreaterThan(immutableRecord)
    expect(finalFreshnessFence).toBeGreaterThan(convenienceTags)
    expect(authoritativeCommit).toBeGreaterThan(finalFreshnessFence)
    expect(canary.match(/\$promotion_repository:canary-set/g)).toHaveLength(1)
    expect(resolver).toContain('pointer_reference="${promotion_repository}:canary-set"')
    expect(resolver).toContain('immutable_manifest="$(docker buildx imagetools inspect "$promotion_repository:$revision" --raw)"')
    expect(resolver).not.toContain('${application_repository}:canary')

    for (const tag of [
      '$IMAGE_REPOSITORY:canary',
      '$IMAGE_REPOSITORY:canary-$REL_VERSION_STRICT',
      '$IMAGE_REPOSITORY:canary-arm64-$REL_VERSION_STRICT',
      '$agent_browser_repository:canary',
      '$agent_browser_repository:canary-$REL_VERSION_STRICT',
      '$agent_browser_repository:canary-arm64-$REL_VERSION_STRICT'
    ]) {
      expect(canary).toContain(`--tag "${tag}"`)
      expect(canary.indexOf(`--tag "${tag}"`)).toBeLessThan(authoritativeCommit)
    }

    expect(release).toContain('image_amd64="$(read_descriptor image-descriptors/image-amd64-descriptor.txt "$IMAGE_REPOSITORY")"')
    expect(release).toContain('image_arm64="$(read_descriptor image-descriptors/image-arm64-descriptor.txt "$IMAGE_REPOSITORY")"')
    expect(release).toContain('docker buildx imagetools inspect "$IMAGE_REPOSITORY@$image_digest"')
  })

  test('resolves deployment images only when the canary pointer matches its immutable revision record', () => {
    const temporaryDirectory = fs.mkdtempSync('/tmp/wiki-canary-promotion-')
    const fakeBin = path.join(temporaryDirectory, 'bin')
    const pointerManifest = path.join(temporaryDirectory, 'pointer.json')
    const immutableManifest = path.join(temporaryDirectory, 'immutable.json')
    const revision = 'a'.repeat(40)
    const applicationAmd64 = `registry.test/wiki@sha256:${'b'.repeat(64)}`
    const applicationArm64 = `registry.test/wiki@sha256:${'c'.repeat(64)}`
    const agentBrowserAmd64 = `registry.test/wiki-agent-browser@sha256:${'d'.repeat(64)}`
    const agentBrowserArm64 = `registry.test/wiki-agent-browser@sha256:${'e'.repeat(64)}`
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      annotations: {
        'io.tsfranki.canary-promotion.schema-version': '1',
        'io.tsfranki.canary-promotion.main-sha': revision,
        'org.opencontainers.image.revision': revision,
        'io.tsfranki.canary-promotion.application-amd64': applicationAmd64,
        'io.tsfranki.canary-promotion.application-arm64': applicationArm64,
        'io.tsfranki.canary-promotion.agent-browser-amd64': agentBrowserAmd64,
        'io.tsfranki.canary-promotion.agent-browser-arm64': agentBrowserArm64
      }
    })

    try {
      fs.mkdirSync(fakeBin)
      fs.writeFileSync(pointerManifest, manifest)
      fs.writeFileSync(immutableManifest, manifest)
      const fakeDocker = path.join(fakeBin, 'docker')
      fs.writeFileSync(fakeDocker, `#!/bin/sh
if [ "$4" = "$WIKI_CANARY_PROMOTION_REPOSITORY:${revision}" ]; then
  cat "$CANARY_IMMUTABLE_MANIFEST"
else
  cat "$CANARY_POINTER_MANIFEST"
fi
`)
      fs.chmodSync(fakeDocker, 0o755)
      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        WIKI_CANARY_PROMOTION_REPOSITORY: 'registry.test/wiki-canary-promotion',
        WIKI_IMAGE_REPOSITORY: 'registry.test/wiki',
        CANARY_POINTER_MANIFEST: pointerManifest,
        CANARY_IMMUTABLE_MANIFEST: immutableManifest
      }

      const resolved = JSON.parse(execFileSync('bash', ['dev/resolve-canary-promotion.sh', '--format=json'], {
        cwd: rootPath,
        encoding: 'utf8',
        env
      }))
      expect(resolved).toEqual({
        schemaVersion: 1,
        mainSha: revision,
        images: {
          application: { amd64: applicationAmd64, arm64: applicationArm64 },
          agentBrowser: { amd64: agentBrowserAmd64, arm64: agentBrowserArm64 }
        }
      })

      const deploymentEnvironment = execFileSync('bash', ['dev/resolve-canary-promotion.sh', '--format=env'], {
        cwd: rootPath,
        encoding: 'utf8',
        env: { ...env, WIKI_CANARY_ARCHITECTURE: 'arm64' }
      })
      expect(deploymentEnvironment).toContain(`export WIKI_CANARY_MAIN_SHA='${revision}'`)
      expect(deploymentEnvironment).toContain(`export WIKI_IMAGE='${applicationArm64}'`)
      expect(deploymentEnvironment).toContain(`export WIKI_AGENT_BROWSER_IMAGE='${agentBrowserArm64}'`)

      fs.writeFileSync(immutableManifest, '{}')
      expect(() => execFileSync('bash', ['dev/resolve-canary-promotion.sh', '--format=json'], {
        cwd: rootPath,
        env,
        stdio: 'ignore'
      })).toThrow()
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  test('release artifacts include complete revision-specific Corresponding Source', () => {
    const workflow = read('.github/workflows/build.yml')
    expect(workflow).toContain('git archive --format=tar.gz')
    expect(workflow).toContain('tsfranki-source.tar.gz')
    expect(workflow).toContain('$WIKI_SOURCE_REPOSITORY/tree/$WIKI_BUILD_REVISION')
    for (const path of ['package.json', 'bun.lock', 'patches', 'dev/build/Dockerfile', 'dev/build-arm/Dockerfile', 'server/scripts/generate-build-metadata.ts']) {
      expect(() => execFileSync('git', ['ls-files', '--error-unmatch', path], { cwd: rootPath })).not.toThrow()
    }
  })
})
