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

  it('persists evidence binding the snapshot to the resolved release provenance', () => {
    const workflow = readRepositoryFile('.github/workflows/packer.yml')

    for (const field of [
      'snapshotId: .artifact_id',
      'applicationDigest: $application_digest',
      'applicationImage: $application_image',
      'sourceRevision: $source_revision',
      'releaseVersion: $release_version'
    ]) {
      expect(workflow).toContain(field)
    }
    expect(workflow).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7')
    expect(workflow).toContain('path: dev/packer/snapshot-provenance.json')
    expect(workflow).toContain('if-no-files-found: error')
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
})
