import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from '../bun-test.mts'

const repositoryRoot = process.cwd()
const readRepositoryFile = (filePath: string): string => fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8')
const bracedExpansion = (value: string): string => '$' + '{' + value + '}'

describe('Packer release provenance contracts', () => {
  it('verifies the attested release manifest and checksum before passing an immutable image to Packer', () => {
    const workflow = readRepositoryFile('.github/workflows/packer.yml')
    const download = workflow.indexOf('gh release download "v$APPLICATION_VERSION"')
    const attestation = workflow.indexOf('gh attestation verify "$release_dir/release-manifest.json"')
    const checksum = workflow.indexOf('sha256sum --check --strict --ignore-missing SHA256SUMS')
    const manifestValidation = workflow.indexOf('(.containerImage.reference == ("ghcr.io/philosophimoonbeam/wiki@" + .containerImage.digest))')
    const build = workflow.indexOf('packer build .')

    expect(download).toBeGreaterThan(-1)
    expect(attestation).toBeGreaterThan(download)
    expect(checksum).toBeGreaterThan(attestation)
    expect(manifestValidation).toBeGreaterThan(checksum)
    expect(build).toBeGreaterThan(manifestValidation)
    expect(workflow).toContain('attestations: read')
    expect(workflow).toContain('and (.product.version == $version)')
    expect(workflow).toContain('and (.release.tag == ("v" + $version))')
    expect(workflow).toContain('and (.release.revision | type == "string" and test("^[0-9a-f]{40}$"))')
    expect(workflow).toContain('and (.containerImage.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))')
    expect(workflow).toContain('PKR_VAR_application_image: ' + bracedExpansion('{ steps.release.outputs.application_image }'))
    expect(workflow).not.toContain('PKR_VAR_application_version')
    expect(workflow).not.toContain('docker manifest inspect')
  })

  it('resolves every runtime-changing input before invoking Packer and passes only immutable identities', () => {
    const workflow = readRepositoryFile('.github/workflows/packer.yml')
    const resolver = workflow.indexOf('run: dev/packer/scripts/resolve-runtime-inputs.sh')
    const build = workflow.indexOf('packer build .')

    expect(workflow).toContain("description: 'Immutable Ubuntu archive timestamp (YYYYMMDDTHHMMSSZ)'")
    expect(resolver).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(resolver)
    for (const variable of [
      'PKR_VAR_apt_snapshot: ' + bracedExpansion('{ steps.runtime.outputs.apt_snapshot }'),
      'PKR_VAR_base_image_id: ' + bracedExpansion('{ steps.runtime.outputs.base_image_id }'),
      'PKR_VAR_docker_package_manifest_sha256: ' + bracedExpansion('{ steps.runtime.outputs.docker_package_manifest_sha256 }'),
      'PKR_VAR_postgres_image: ' + bracedExpansion('{ steps.runtime.outputs.postgres_image }')
    ]) {
      expect(workflow).toContain(variable)
    }

    const resolverScript = readRepositoryFile('dev/packer/scripts/resolve-runtime-inputs.sh')
    expect(resolverScript).toContain('https://api.digitalocean.com/v2/images?type=distribution&per_page=200')
    expect(resolverScript).toContain('select(.slug == $slug)')
    expect(resolverScript).toContain('https://snapshot.ubuntu.com/ubuntu/$APT_SNAPSHOT/dists/$suite/InRelease')
    expect(resolverScript).toContain('postgres_image="docker.io/library/postgres@$postgres_digest"')
    expect(resolverScript).toContain('cmp --silent "$postgres_tag_manifest" "$postgres_digest_manifest"')
    expect(resolverScript).toContain('docker_package_manifest_sha256=')
    expect(resolverScript).toContain('sha256sum --check --strict')
    for (const packageIdentity of ['package: .[0]', 'version: .[1]', 'architecture: .[2]', 'file: .[3]', 'sha256: .[4]']) {
      expect(resolverScript).toContain(packageIdentity)
    }
  })

  it('persists evidence binding the snapshot to the resolved release provenance', () => {
    const workflow = readRepositoryFile('.github/workflows/packer.yml')

    for (const field of [
      'snapshotId: .artifact_id',
      'applicationDigest: $application_digest',
      'applicationImage: $application_image',
      'sourceRevision: $source_revision',
      'releaseVersion: $release_version',
      'runtimeInputs: $runtime_inputs[0]'
    ]) {
      expect(workflow).toContain(field)
    }
    expect(workflow).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7')
    expect(workflow).toContain('path: dev/packer/snapshot-provenance.json')
    expect(workflow).toContain('if-no-files-found: error')
    for (const identity of [
      '$runtime.digitalOceanBaseImage.id == $base_image_id',
      '$runtime.ubuntuAptSnapshot.id == $apt_snapshot',
      '$runtime.postgresqlImage.reference == $postgres_image',
      '$runtime.postgresqlImage.digest == $postgres_digest',
      '$runtime.dockerPackages.manifestSha256 == $docker_package_manifest_sha256'
    ]) {
      expect(workflow).toContain(identity)
    }
  })

  it('accepts only a digest-pinned application image and records it in the Packer manifest', () => {
    const template = readRepositoryFile('dev/packer/digitalocean.pkr.hcl')

    expect(template).toContain('variable "application_image"')
    expect(template).toContain('^ghcr\\\\.io/philosophimoonbeam/wiki@sha256:[0-9a-f]{64}$')
    expect(template).toContain('"application_image=' + bracedExpansion('var.application_image') + '"')
    expect(template).toContain('application_digest = split("@", var.application_image)[1]')
    expect(template).toContain('application_image  = var.application_image')
    expect(template).toContain('release_version    = var.release_version')
    expect(template).toContain('source_revision    = var.source_revision')
    expect(template).toContain('variable "base_image_id"')
    expect(template).toContain('image         = var.base_image_id')
    expect(template).toContain('variable "apt_snapshot"')
    expect(template).toContain('variable "postgres_image"')
    expect(template).toContain('^docker\\\\.io/library/postgres@sha256:[0-9a-f]{64}$')
    expect(template).toContain('variable "docker_package_manifest_sha256"')
    expect(template).toContain('apt_snapshot                   = var.apt_snapshot')
    expect(template).toContain('base_image_id                  = var.base_image_id')
    expect(template).toContain('docker_package_manifest_sha256 = var.docker_package_manifest_sha256')
    expect(template).toContain('postgres_digest    = split("@", var.postgres_image)[1]')
    expect(template).toContain('postgres_image     = var.postgres_image')
    expect(template).not.toContain('image         = "ubuntu-24-04-x64"')
    expect(template).toContain('output     = "packer-manifest.json"')
    expect(template).not.toContain('variable "application_version"')
  })

  it('provisions the application container from only the validated digest reference', () => {
    const script = readRepositoryFile('dev/packer/scripts/010-docker.sh')

    expect(script).toContain(': "' + bracedExpansion('application_image:?application_image is required') + '"')
    expect(script).toContain('^ghcr\\.io/philosophimoonbeam/wiki@sha256:[0-9a-f]{64}$')
    expect(script).toContain('"$application_image"')
    expect(script).not.toContain('ghcr.io/philosophimoonbeam/wiki:' + bracedExpansion('application_version'))
    expect(script).not.toContain('application_version is required')
  })

  it('installs only verified Docker package bytes and a digest-pinned PostgreSQL image', () => {
    const script = readRepositoryFile('dev/packer/scripts/010-docker.sh')

    expect(script).toContain(': "' + bracedExpansion('postgres_image:?postgres_image is required') + '"')
    expect(script).toContain('^docker\\.io/library/postgres@sha256:[0-9a-f]{64}$')
    expect(script).toContain('printf \'%s  %s\\n\' "$docker_package_manifest_sha256" "$manifest" | sha256sum --check --strict')
    expect(script).toContain('done < <(jq -r \'.[] | [.sha256, .file] | @tsv\' "$manifest") | sha256sum --check --strict')
    expect(script).toContain('sudo apt-get -qqy install "' + bracedExpansion('docker_packages[@]') + '"')
    expect(script).toContain('"$postgres_image"')
    expect(script).not.toContain('download.docker.com')
    expect(script).not.toContain('postgres:17')
  })

  it('uses only the requested Ubuntu archive snapshot for guest apt operations', () => {
    const script = readRepositoryFile('dev/packer/scripts/005-apt-snapshot.sh')

    expect(script).toContain('https://snapshot.ubuntu.com/ubuntu/' + bracedExpansion('apt_snapshot') + '/')
    expect(script).toContain('Suites: noble noble-updates noble-backports noble-security')
    expect(script).toContain('Check-Valid-Until: no')
    expect(script).not.toContain('archive.ubuntu.com')
    expect(script).not.toContain('security.ubuntu.com')
  })
})
