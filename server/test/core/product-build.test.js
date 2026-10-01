import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

import { productDefinition } from '../../core/product.ts'

const rootPath = process.cwd()
const read = relativePath => fs.readFileSync(path.join(rootPath, relativePath), 'utf8')

describe('product build and publication metadata', () => {
  test('exports deterministic CI build arguments from the product contract', () => {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootPath, encoding: 'utf8' }).trim()
    const output = execFileSync(process.execPath, ['server/scripts/export-build-environment.ts'], {
      cwd: rootPath,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: revision, SOURCE_DATE_EPOCH: '1786624496' }
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
    expect(values.WIKI_BUILD_DATE).toBe('2026-08-13T12:34:56.000Z')
    expect(values.SOURCE_DATE_EPOCH).toBe('1786624496')
  })

  test('publishes only fork-owned images and includes required OCI labels', () => {
    const workflow = read('.github/workflows/build.yml')

    expect(workflow).toContain('server/scripts/export-build-environment.ts')
    expect(workflow).toContain('IMAGE_REPOSITORY')
    expect(workflow.match(/ghcr\.io\/requarks\/wiki:[^\s]+/g)).toEqual([
      expect.stringMatching(new RegExp(`^ghcr\\.io/requarks/wiki:${productDefinition.upstreamVersion}@sha256:[a-f0-9]{64}$`))
    ])
    expect(workflow).not.toMatch(/(?:--tag|tags:)[^\n]*requarks\/wiki/)
    for (const recipe of ['dev/build/Dockerfile', 'dev/build-arm/Dockerfile']) {
      const dockerfile = read(recipe)
      for (const label of ['created', 'description', 'licenses', 'revision', 'source', 'title', 'version']) {
        expect(dockerfile).toContain(`org.opencontainers.image.${label}`)
      }
      expect(dockerfile).toContain('io.tsepistle.upstream-base')
    }
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
    const workflow = load(read('.github/workflows/build.yml'))
    const staticCommands = JSON.parse(read('package.json')).scripts['ci:static']
    const helmContract = read('server/test/scripts/check-helm-lifecycle-contract.sh')
    for (const command of ['dependencies:check', 'licenses:check', 'openapi:check', 'placeholders:check', 'agents:release-check']) {
      expect(staticCommands).toContain(`bun run ${command}`)
    }
    const prQuality = workflow.jobs['pr-quality'].steps
    const protectedQuality = workflow.jobs.quality.steps
    const runs = step => typeof step?.run === 'string' ? step.run : ''
    for (const qualityJob of [prQuality, protectedQuality]) {
      const staticContract = qualityJob.findIndex(step => runs(step).trim() === 'bun run ci:static')
      const tests = qualityJob.findIndex(step => runs(step).trim() === 'bun run test')
      const build = qualityJob.findIndex(step => runs(step).trim() === 'bun run build')
      expect(staticContract).toBeGreaterThan(-1)
      expect(tests).toBeGreaterThan(staticContract)
      expect(build).toBeGreaterThan(staticContract)
    }

    const chartChanges = prQuality.find(step => step.id === 'chart-changes')
    expect(runs(chartChanges)).toContain('git diff --quiet "$BASE_SHA" "$GITHUB_SHA" -- dev/helm/')
    const installHelm = prQuality.findIndex(step => runs(step).includes('https://get.helm.sh/'))
    const validateHelm = prQuality.findIndex(step => runs(step).trim() === 'server/test/scripts/check-helm-lifecycle-contract.sh')
    expect(installHelm).toBeGreaterThan(-1)
    expect(validateHelm).toBeGreaterThan(installHelm)
    for (const index of [installHelm, validateHelm]) {
      expect(prQuality[index].if).toBe("steps.chart-changes.outputs.changed == 'true'")
    }
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) expect(runs(step)).not.toContain('helm lint dev/helm')
    }
    const releaseHelm = workflow.jobs.release.steps.find(step => runs(step).includes('helm package --destination dist dev/helm'))
    const releaseRun = runs(releaseHelm)
    const validation = releaseRun.indexOf('server/test/scripts/check-helm-lifecycle-contract.sh')
    const packaging = releaseRun.indexOf('helm package --destination dist dev/helm')
    expect(validation).toBeGreaterThan(-1)
    expect(packaging).toBeGreaterThan(validation)
    expect(helmContract).toContain('helm lint dev/helm')
    expect(helmContract).toContain('helm template wiki dev/helm')
    expect(helmContract).toContain('helm install wiki dev/helm')
    expect(helmContract).toContain('--dry-run=client')
    const sourceValidation = `${prQuality.map(runs).join('\n')}\n${helmContract}`
    expect(sourceValidation).not.toContain('kind create cluster')
    expect(sourceValidation).not.toContain('helm package')
  })

  test('commits the complete canary set once from a revision-bound immutable promotion record after exact-image gates', () => {
    const workflow = read('.github/workflows/build.yml')
    const resolver = read('dev/resolve-canary-promotion.sh')
    const amd64 = workflow.slice(workflow.indexOf('  publish-amd64:'), workflow.indexOf('\n  arm:'))
    const arm64 = workflow.slice(workflow.indexOf('  arm:'), workflow.indexOf('\n  site-logo-processing-amd64:'))
    const amd64Gate = workflow.slice(workflow.indexOf('  site-logo-processing-amd64:'), workflow.indexOf('\n  site-logo-processing-arm64:'))
    const arm64Gate = workflow.slice(workflow.indexOf('  site-logo-processing-arm64:'), workflow.indexOf('\n  publish-canary:'))
    const canary = workflow.slice(workflow.indexOf('  publish-canary:'), workflow.indexOf('\n  beta:'))
    const beta = workflow.slice(workflow.indexOf('  beta:'), workflow.indexOf('\n  release:'))
    const release = workflow.slice(workflow.indexOf('  release:'))
    const downloadedDescriptorArtifacts = job => Array.from(
      job.matchAll(/uses: actions\/download-artifact@[^\n]+\n {6}with:\n {8}name: ([^\n]*image-descriptors)\n/g),
      match => match[1]
    )
    const uploadedDescriptorArtifacts = job => Array.from(
      job.matchAll(/uses: actions\/upload-artifact@[^\n]+\n {6}with:\n {8}name: ([^\n]*image-descriptors)\n/g),
      match => match[1]
    )

    expect(workflow).toContain('group: build-${{ github.ref }}')
    expect(workflow).toContain('cancel-in-progress: true')
    expect(amd64).not.toContain(':canary')
    expect(arm64).not.toContain(':canary')
    expect(amd64).toContain('candidate-amd64-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(arm64).toContain('candidate-arm64-${{ github.run_id }}-${{ github.run_attempt }}')

    expect(amd64Gate).toContain('needs: [publish-amd64]')
    expect(downloadedDescriptorArtifacts(amd64Gate)).toEqual(['amd64-image-descriptors'])
    expect(uploadedDescriptorArtifacts(amd64Gate)).toEqual(['gated-amd64-image-descriptors'])
    expect(arm64Gate).toContain('needs: [arm]')
    expect(downloadedDescriptorArtifacts(arm64Gate)).toEqual(['arm64-image-descriptors'])
    expect(uploadedDescriptorArtifacts(arm64Gate)).toEqual(['gated-arm64-image-descriptors'])

    expect(canary).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'")
    expect(canary).toContain('needs: [site-logo-processing-amd64, site-logo-processing-arm64]')
    expect(beta).toContain('needs: [site-logo-processing-amd64, site-logo-processing-arm64]')
    expect(release).toContain('needs: [beta, reproducibility, site-logo-processing-amd64, site-logo-processing-arm64]')
    expect(downloadedDescriptorArtifacts(canary)).toEqual([
      'gated-amd64-image-descriptors',
      'gated-arm64-image-descriptors'
    ])
    expect(downloadedDescriptorArtifacts(beta)).toEqual([
      'gated-amd64-image-descriptors',
      'gated-arm64-image-descriptors'
    ])
    expect(uploadedDescriptorArtifacts(beta)).toEqual(['release-image-descriptors'])
    expect(downloadedDescriptorArtifacts(release)).toEqual(['release-image-descriptors'])
    for (const descriptor of [
      'image-amd64-descriptor.txt',
      'image-arm64-descriptor.txt',
      'agent-browser-amd64-descriptor.txt',
      'agent-browser-arm64-descriptor.txt'
    ]) {
      for (const promotion of [canary, beta, release]) {
        expect(promotion).toContain(descriptor)
      }
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
        'io.tsepistle.canary-promotion.schema-version': '1',
        'io.tsepistle.canary-promotion.main-sha': revision,
        'org.opencontainers.image.revision': revision,
        'io.tsepistle.canary-promotion.application-amd64': applicationAmd64,
        'io.tsepistle.canary-promotion.application-arm64': applicationArm64,
        'io.tsepistle.canary-promotion.agent-browser-amd64': agentBrowserAmd64,
        'io.tsepistle.canary-promotion.agent-browser-arm64': agentBrowserArm64
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
        WIKI_AGENT_BROWSER_IMAGE_REPOSITORY: 'registry.test/wiki-agent-browser',
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

      const mismatchedManifest = JSON.parse(manifest)
      mismatchedManifest.annotations['io.tsepistle.canary-promotion.application-amd64'] = `registry.test/wiki@sha256:${'f'.repeat(64)}`
      fs.writeFileSync(immutableManifest, JSON.stringify(mismatchedManifest))
      const mismatch = spawnSync('bash', ['dev/resolve-canary-promotion.sh', '--format=json'], {
        cwd: rootPath,
        env,
        encoding: 'utf8'
      })
      expect(mismatch.status).toBe(1)
      expect(mismatch.stdout).toBe('')
      expect(mismatch.stderr).toContain(`${env.WIKI_CANARY_PROMOTION_REPOSITORY}:${revision}`)
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  test('release artifacts include complete revision-specific Corresponding Source', () => {
    const workflowText = read('.github/workflows/build.yml')
    const releaseSteps = load(workflowText).jobs.release.steps
    const archiveStep = releaseSteps.find(step => step.run?.startsWith('git archive '))
    expect(archiveStep?.run).toMatch(/--format=tar\.gz\b/)
    expect(archiveStep?.run).toMatch(/--prefix="tsepistle-\$REL_VERSION_STRICT\/"/)
    expect(archiveStep?.run).toMatch(/--output=tsepistle-source\.tar\.gz\b/)
    expect(archiveStep?.run).toMatch(/"\$WIKI_BUILD_REVISION"\s*$/)
    expect(workflowText).toContain('$WIKI_SOURCE_REPOSITORY/tree/$WIKI_BUILD_REVISION')
    const checksums = releaseSteps.find(step => step.run?.includes('server/scripts/generate-release-manifest.ts'))
    expect(checksums?.run).toMatch(/^\s*tsepistle-source\.tar\.gz\s*\\$/m)
    const upload = releaseSteps.find(step => step.uses?.startsWith('ncipollo/release-action@'))
    expect(upload?.with.artifacts.split(',')).toContain('tsepistle-source.tar.gz')

    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootPath, encoding: 'utf8' }).trim()
    const temporaryDirectory = fs.mkdtempSync(path.join(rootPath, 'source-archive-contract-'))
    const archive = path.join(temporaryDirectory, 'source.tar.gz')
    const prefix = `tsepistle-${productDefinition.version}/`
    const untracked = path.join(temporaryDirectory, 'untracked-build-input')
    try {
      fs.writeFileSync(untracked, 'not Corresponding Source')
      const archiveCommand = archiveStep.run.replace('--output=tsepistle-source.tar.gz', '--output="$TEST_SOURCE_ARCHIVE"')
      execFileSync('bash', ['-euo', 'pipefail', '-c', archiveCommand], {
        cwd: rootPath,
        env: {
          ...process.env,
          BASH_ENV: '',
          REL_VERSION_STRICT: productDefinition.version,
          WIKI_BUILD_REVISION: revision,
          TEST_SOURCE_ARCHIVE: archive
        }
      })
      const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
      expect(members).not.toContain(`${prefix}${path.relative(rootPath, untracked)}`)
      for (const input of ['package.json', 'bun.lock', 'patches', 'dev/build/Dockerfile', 'dev/build-arm/Dockerfile', 'server/scripts/generate-build-metadata.ts']) {
        const trackedInputs = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', input], { cwd: rootPath, encoding: 'utf8' }).trim().split('\n')
        expect(trackedInputs).not.toContain('')
        for (const tracked of trackedInputs) {
          expect(members).toContain(`${prefix}${tracked}`)
          const archivedBytes = execFileSync('tar', ['-xOzf', archive, `${prefix}${tracked}`])
          const revisionBytes = execFileSync('git', ['show', `${revision}:${tracked}`], { cwd: rootPath })
          expect(archivedBytes).toEqual(revisionBytes)
        }
      }
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
