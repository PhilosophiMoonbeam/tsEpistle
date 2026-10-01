import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { load } from 'js-yaml'

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
    expect(resolverScript).toMatch(/https:\/\/api\.digitalocean\.com\/v2\/images\?[^"\n]*\btype=distribution\b/)
    expect(resolverScript).toContain('https://snapshot.ubuntu.com/ubuntu/$APT_SNAPSHOT/dists/$suite/InRelease')
    expect(resolverScript).toContain('postgres_image="docker.io/library/postgres@$postgres_digest"')
    expect(resolverScript).toContain('cmp --silent "$postgres_tag_manifest" "$postgres_digest_manifest"')
    expect(resolverScript).toContain('docker_package_manifest_sha256=')
    expect(resolverScript).toContain('sha256sum --check --strict')
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-runtime-inputs-'))
    const bin = path.join(temporaryDirectory, 'bin')
    const scripts = path.join(temporaryDirectory, 'scripts')
    const packages = path.join(temporaryDirectory, 'downloaded-packages')
    const postgresManifest = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}\n'
    const postgresDigest = `sha256:${createHash('sha256').update(postgresManifest).digest('hex')}`
    const packageIdentities = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'].map(packageName => {
      const bytes = Buffer.from(`downloaded archive bytes for ${packageName}`)
      return { package: packageName, version: '1.2.3-1~ubuntu.24.04~noble', architecture: 'amd64', file: `${packageName}_amd64.deb`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes }
    })
    try {
      for (const directory of [bin, scripts, packages]) fs.mkdirSync(directory)
      fs.writeFileSync(path.join(scripts, 'resolve-runtime-inputs.sh'), resolverScript)
      fs.writeFileSync(path.join(temporaryDirectory, 'base-images.json'), JSON.stringify({
        images: [{ slug: 'unrelated-image', id: 99 }, { slug: 'ubuntu-24-04-x64', id: 123456 }]
      }))
      fs.writeFileSync(path.join(temporaryDirectory, 'postgres-manifest.json'), postgresManifest)
      for (const identity of packageIdentities) fs.writeFileSync(path.join(packages, identity.file), identity.bytes)
      fs.writeFileSync(path.join(packages, 'package-manifest.tsv'), packageIdentities.map(identity =>
        [identity.package, identity.version, identity.architecture, identity.file, identity.sha256].join('\t')
      ).join('\n') + '\n')
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
set -euo pipefail
url="\${!#}"
printf '%s\\n' "$url" >> "$TEST_REQUESTS"
case "$url" in
  https://api.digitalocean.com/v2/images\\?*) cat "$TEST_BASE_IMAGES" ;;
  https://snapshot.ubuntu.com/ubuntu/*/dists/*/InRelease) ;;
  *) exit 99 ;;
esac
`)
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
set -euo pipefail
if [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
  cat "$TEST_POSTGRES_MANIFEST"
elif [[ "$1" == run ]]; then
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == --volume ]]; then
      destination="\${2%:/out}"
      cp "$TEST_PACKAGES/"* "$destination/"
      exit 0
    fi
    shift
  done
  exit 99
else
  exit 99
fi
`)
      for (const command of ['curl', 'docker']) fs.chmodSync(path.join(bin, command), 0o755)
      const result = spawnSync('bash', [path.join(scripts, 'resolve-runtime-inputs.sh')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          BASH_ENV: '',
          PATH: `${bin}:${process.env.PATH}`,
          DO_TOKEN: 'isolated-test-token',
          APT_SNAPSHOT: '20260813T123456Z',
          GITHUB_OUTPUT: path.join(temporaryDirectory, 'outputs'),
          TEST_REQUESTS: path.join(temporaryDirectory, 'requests'),
          TEST_BASE_IMAGES: path.join(temporaryDirectory, 'base-images.json'),
          TEST_POSTGRES_MANIFEST: path.join(temporaryDirectory, 'postgres-manifest.json'),
          TEST_PACKAGES: packages
        }
      })
      expect(result.status).toBe(0)
      const inputs = JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'runtime-inputs/runtime-inputs.json'), 'utf8'))
      expect(inputs.digitalOceanBaseImage).toEqual({ slug: 'ubuntu-24-04-x64', id: '123456' })
      expect(inputs.ubuntuAptSnapshot).toEqual({ id: '20260813T123456Z', url: 'https://snapshot.ubuntu.com/ubuntu/20260813T123456Z/' })
      expect(inputs.postgresqlImage).toMatchObject({ reference: `docker.io/library/postgres@${postgresDigest}`, digest: postgresDigest })
      expect(inputs.dockerPackages.packages).toEqual(packageIdentities.map(({ bytes, ...identity }) => identity).sort((left, right) => left.package.localeCompare(right.package)))
      const manifestBytes = fs.readFileSync(path.join(temporaryDirectory, 'runtime-inputs/docker-packages/docker-packages.json'))
      expect(inputs.dockerPackages.manifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'))
      const requests = fs.readFileSync(path.join(temporaryDirectory, 'requests'), 'utf8').trim().split('\n')
      const imageRequest = new URL(requests[0]!)
      expect(imageRequest.origin + imageRequest.pathname).toBe('https://api.digitalocean.com/v2/images')
      expect(imageRequest.searchParams.get('type')).toBe('distribution')
      for (const suite of ['noble', 'noble-updates', 'noble-backports', 'noble-security']) {
        expect(requests).toContain(`https://snapshot.ubuntu.com/ubuntu/20260813T123456Z/dists/${suite}/InRelease`)
      }
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
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
    const parsed = load(workflow) as { jobs: Record<string, { steps: Array<{ uses?: string, with?: Record<string, unknown> }> }> }
    const upload = parsed.jobs['build-do-image']!.steps.find(step =>
      step.uses?.startsWith('actions/upload-artifact@') && step.with?.path === 'dev/packer/snapshot-provenance.json'
    )
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    expect(upload?.with).toMatchObject({ path: 'dev/packer/snapshot-provenance.json', 'if-no-files-found': 'error' })
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

    expect(script).toMatch(/^docker create\b[^\n]*--name=wiki\b[^\n]*"\$application_image"\s*$/m)
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-application-admission-'))
    const operations = path.join(temporaryDirectory, 'operations')
    const admissionBoundary = path.join(temporaryDirectory, 'bash-env')
    try {
      fs.writeFileSync(admissionBoundary, 'test() { printf "%s\\n" "provisioning reached" >> "$TEST_OPERATIONS"; exit 91; }\n')
      const env = {
        ...process.env,
        BASH_ENV: admissionBoundary,
        TEST_OPERATIONS: operations,
        postgres_image: `docker.io/library/postgres@sha256:${'b'.repeat(64)}`,
        docker_package_manifest_sha256: 'c'.repeat(64)
      }
      for (const applicationImage of ['', 'ghcr.io/philosophimoonbeam/wiki:latest', `ghcr.io/another/wiki@sha256:${'a'.repeat(64)}`]) {
        fs.writeFileSync(operations, '')
        const result = spawnSync('bash', ['dev/packer/scripts/010-docker.sh'], {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: { ...env, application_image: applicationImage }
        })
        expect(result.status).toBe(1)
        expect(fs.readFileSync(operations, 'utf8')).toBe('')
      }
      const admitted = spawnSync('bash', ['dev/packer/scripts/010-docker.sh'], {
        cwd: repositoryRoot,
        env: { ...env, application_image: `ghcr.io/philosophimoonbeam/wiki@sha256:${'a'.repeat(64)}` }
      })
      expect(admitted.status).toBe(91)
      expect(fs.readFileSync(operations, 'utf8')).toBe('provisioning reached\n')
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
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
    // Keep the original source guard until Main exercises the isolated replacement and its controls.
    expect(script).toContain('https://snapshot.ubuntu.com/ubuntu/' + bracedExpansion('apt_snapshot') + '/')
    expect(script).toContain('Suites: noble noble-updates noble-backports noble-security')
    expect(script).toContain('Check-Valid-Until: no')
    expect(script).not.toContain('archive.ubuntu.com')
    expect(script).not.toContain('security.ubuntu.com')
  })

  it('keeps all surviving apt sources snapshot-only at every apt operation', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-apt-snapshot-'))
    const aptTree = path.join(temporaryDirectory, 'apt-tree')
    const boundaries = path.join(temporaryDirectory, 'apt-boundaries')
    const operations = path.join(temporaryDirectory, 'operations')
    try {
      fs.mkdirSync(path.join(aptTree, 'sources.list.d'), { recursive: true })
      fs.mkdirSync(boundaries)
      fs.writeFileSync(path.join(aptTree, 'sources.list'), 'deb http://archive.ubuntu.com/ubuntu noble main\n')
      fs.writeFileSync(path.join(aptTree, 'sources.list.d', 'security.list'), 'deb http://security.ubuntu.com/ubuntu noble-security main\n')
      fs.writeFileSync(path.join(aptTree, 'sources.list.d', 'ubuntu.sources'), 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble\nComponents: main\n')
      fs.writeFileSync(path.join(temporaryDirectory, 'sudo'), `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_OPERATIONS"
command="$1"
shift
map_source_path() {
  [[ "$1" =~ ^/etc/apt/(sources\\.list|sources\\.list\\.d(/[a-zA-Z0-9_.-]+)?)$ ]] || exit 99
  [[ "$1" != */. && "$1" != */.. ]] || exit 99
  printf '%s/%s' "$TEST_APT_TREE" "\${1#/etc/apt/}"
}
case "$command" in
  tee)
    append=false
    if [[ "\${1:-}" == -a ]]; then append=true; shift; fi
    [[ "$#" == 1 ]] || exit 99
    destination="$(map_source_path "$1")"
    if "$append"; then /bin/cat >> "$destination"; else /bin/cat > "$destination"; fi
    ;;
  rm)
    [[ "$#" == 2 && ( "$1" == -f || "$1" == -rf ) ]] || exit 99
    destination="$(map_source_path "$2")"
    /bin/rm "$1" -- "$destination"
    ;;
  install)
    [[ "$#" == 4 && "$1" == -m && "$2" == 0755 && "$3" == -d ]] || exit 99
    destination="$(map_source_path "$4")"
    /bin/mkdir -p -- "$destination"
    ;;
  apt-get)
    boundary="$(/bin/mktemp -d "$TEST_APT_BOUNDARIES/operation.XXXXXX")"
    /bin/cp -a "$TEST_APT_TREE/." "$boundary/"
    ;;
  *) exit 99 ;;
esac
`)
      fs.chmodSync(path.join(temporaryDirectory, 'sudo'), 0o755)
      // Bare commands must not fall through to real host apt or filesystem operations.
      for (const command of ['apt-get', 'apt', 'rm', 'install', 'tee']) {
        fs.writeFileSync(path.join(temporaryDirectory, command), '#!/bin/bash\nexit 99\n')
        fs.chmodSync(path.join(temporaryDirectory, command), 0o755)
      }
      const env = {
        ...process.env,
        BASH_ENV: '',
        PATH: `${temporaryDirectory}:${process.env.PATH}`,
        TEST_APT_TREE: aptTree,
        TEST_APT_BOUNDARIES: boundaries,
        TEST_OPERATIONS: operations
      }
      const result = spawnSync('bash', ['dev/packer/scripts/005-apt-snapshot.sh'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...env, apt_snapshot: '20260813T123456Z' }
      })
      expect(result.status).toBe(0)
      const aptBoundaries = fs.readdirSync(boundaries)
      for (const boundary of aptBoundaries) {
        const boundaryTree = path.join(boundaries, boundary)
        const survivingSources = fs.readdirSync(boundaryTree, { recursive: true, withFileTypes: true })
          .filter(entry => entry.isFile())
          .map(entry => path.relative(boundaryTree, path.join(entry.parentPath, entry.name)))
          .sort()
        expect(survivingSources).toEqual(['sources.list.d/ubuntu.sources'])
        for (const source of survivingSources) {
          const rendered = fs.readFileSync(path.join(boundaryTree, source), 'utf8')
          const fields = Object.fromEntries(rendered.trim().split('\n').map(line => line.split(/:\s+(.*)/s).slice(0, 2)))
          expect(fields.URIs).toBe('https://snapshot.ubuntu.com/ubuntu/20260813T123456Z/')
          expect(fields.Suites?.split(/\s+/).sort()).toEqual(['noble', 'noble-backports', 'noble-security', 'noble-updates'])
          expect(fields['Check-Valid-Until']).toBe('no')
          expect(fields['Signed-By']).toBe('/usr/share/keyrings/ubuntu-archive-keyring.gpg')
          expect(rendered).not.toMatch(/(?:archive|security)\.ubuntu\.com/)
        }
      }
      const aptOperations = fs.readFileSync(operations, 'utf8').trim().split('\n').filter(operation => operation.startsWith('apt-get '))
      expect(aptOperations.some(operation => /\bupdate\b/.test(operation))).toBe(true)
      expect(aptOperations.some(operation => /\bfull-upgrade\b/.test(operation))).toBe(true)
      expect(aptOperations.some(operation => /\binstall\b/.test(operation))).toBe(true)
      expect(aptBoundaries.length).toBe(aptOperations.length)
      fs.writeFileSync(operations, '')
      const invalid = spawnSync('bash', ['dev/packer/scripts/005-apt-snapshot.sh'], {
        cwd: repositoryRoot,
        env: { ...env, apt_snapshot: 'latest' }
      })
      expect(invalid.status).toBe(1)
      expect(fs.readFileSync(operations, 'utf8')).toBe('')
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
