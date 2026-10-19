import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { describe, expect, it } from '../bun-test.mts'

const repositoryRoot = process.cwd()

describe('Packer release provenance contracts', () => {
  it.each([false, true])('verifies package bytes before accepting immutable runtime identities (tampered=%s)', tampered => {
    const resolverScript = fs.readFileSync(path.join(repositoryRoot, 'dev/packer/scripts/resolve-runtime-inputs.sh'), 'utf8')
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-runtime-inputs-'))
    const bin = path.join(temporaryDirectory, 'bin')
    const scripts = path.join(temporaryDirectory, 'scripts')
    const packages = path.join(temporaryDirectory, 'downloaded-packages')
    const postgresManifest = '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}\n'
    const postgresDigest = `sha256:${createHash('sha256').update(postgresManifest).digest('hex')}`
    const packageIdentities = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'].map(packageName => {
      const bytes = Buffer.from(`downloaded archive bytes for ${packageName}`)
      return {
        package: packageName,
        version: '1.2.3-1~ubuntu.24.04~noble',
        architecture: 'amd64',
        file: `${packageName}_amd64.deb`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes
      }
    })
    try {
      for (const directory of [bin, scripts, packages]) fs.mkdirSync(directory)
      fs.writeFileSync(path.join(scripts, 'resolve-runtime-inputs.sh'), resolverScript)
      fs.writeFileSync(
        path.join(temporaryDirectory, 'base-images.json'),
        JSON.stringify({
          images: [
            { slug: 'unrelated-image', id: 99 },
            { slug: 'ubuntu-24-04-x64', id: 123456 }
          ]
        })
      )
      fs.writeFileSync(path.join(temporaryDirectory, 'postgres-manifest.json'), postgresManifest)
      for (const identity of packageIdentities) fs.writeFileSync(path.join(packages, identity.file), identity.bytes)
      if (tampered) fs.appendFileSync(path.join(packages, packageIdentities[0]!.file), 'tampered archive')
      fs.writeFileSync(
        path.join(packages, 'package-manifest.tsv'),
        packageIdentities.map(identity => [identity.package, identity.version, identity.architecture, identity.file, identity.sha256].join('\t')).join('\n') +
          '\n'
      )
      fs.writeFileSync(
        path.join(bin, 'curl'),
        `#!/bin/bash
set -euo pipefail
url="\${!#}"
printf '%s\\n' "$url" >> "$TEST_REQUESTS"
case "$url" in
  https://api.digitalocean.com/v2/images\\?*) cat "$TEST_BASE_IMAGES" ;;
  https://snapshot.ubuntu.com/ubuntu/*/dists/*/InRelease) ;;
  *) exit 99 ;;
esac
`
      )
      fs.writeFileSync(
        path.join(bin, 'docker'),
        `#!/bin/bash
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
`
      )
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
      if (tampered) {
        expect(result.status).toBe(1)
        expect(fs.existsSync(path.join(temporaryDirectory, 'outputs'))).toBe(false)
        expect(fs.existsSync(path.join(temporaryDirectory, 'runtime-inputs/runtime-inputs.json'))).toBe(false)
        return
      }
      expect(result.status).toBe(0)
      const inputs = JSON.parse(fs.readFileSync(path.join(temporaryDirectory, 'runtime-inputs/runtime-inputs.json'), 'utf8'))
      expect(inputs.digitalOceanBaseImage).toEqual({ slug: 'ubuntu-24-04-x64', id: '123456' })
      expect(inputs.ubuntuAptSnapshot).toEqual({ id: '20260813T123456Z', url: 'https://snapshot.ubuntu.com/ubuntu/20260813T123456Z/' })
      expect(inputs.postgresqlImage).toMatchObject({ reference: `docker.io/library/postgres@${postgresDigest}`, digest: postgresDigest })
      expect(inputs.dockerPackages.packages).toEqual(
        packageIdentities.map(({ bytes, ...identity }) => identity).sort((left, right) => left.package.localeCompare(right.package))
      )
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

  it('rejects mutable or foreign application images before host provisioning', () => {
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
      fs.writeFileSync(
        path.join(aptTree, 'sources.list.d', 'ubuntu.sources'),
        'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble\nComponents: main\n'
      )
      fs.writeFileSync(
        path.join(temporaryDirectory, 'sudo'),
        `#!/bin/bash
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
`
      )
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
        const survivingSources = fs
          .readdirSync(boundaryTree, { recursive: true, withFileTypes: true })
          .filter(entry => entry.isFile())
          .map(entry => path.relative(boundaryTree, path.join(entry.parentPath, entry.name)))
          .sort()
        expect(survivingSources).toEqual(['sources.list.d/ubuntu.sources'])
        for (const source of survivingSources) {
          const rendered = fs.readFileSync(path.join(boundaryTree, source), 'utf8')
          const fields = Object.fromEntries(
            rendered
              .trim()
              .split('\n')
              .map(line => line.split(/:\s+(.*)/s).slice(0, 2))
          )
          expect(fields.URIs).toBe('https://snapshot.ubuntu.com/ubuntu/20260813T123456Z/')
          expect(fields.Suites?.split(/\s+/).sort()).toEqual(['noble', 'noble-backports', 'noble-security', 'noble-updates'])
          expect(fields['Check-Valid-Until']).toBe('no')
          expect(fields['Signed-By']).toBe('/usr/share/keyrings/ubuntu-archive-keyring.gpg')
          expect(rendered).not.toMatch(/(?:archive|security)\.ubuntu\.com/)
        }
      }
      const aptOperations = fs
        .readFileSync(operations, 'utf8')
        .trim()
        .split('\n')
        .filter(operation => operation.startsWith('apt-get '))
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

  for (const scenario of [
    { name: 'accepts a clean Marketplace account fixture', password: false, keyPath: null, failures: 0 },
    { name: 'fails Marketplace validation for a non-root account password', password: true, keyPath: null, failures: 1 },
    { name: 'detects root private SSH keys without disclosing their bytes', password: false, keyPath: 'root/.ssh/id_rsa', failures: 1 },
    { name: 'detects non-root private SSH keys without disclosing their bytes', password: false, keyPath: 'home/alice/.ssh/id_rsa', failures: 1 },
    { name: 'rejects root authorized SSH keys without disclosing their bytes', password: false, keyPath: 'root/.ssh/authorized_keys', failures: 1 },
    { name: 'rejects non-root authorized SSH keys without disclosing their bytes', password: false, keyPath: 'home/alice/.ssh/authorized_keys', failures: 1 }
  ]) {
    it(scenario.name, () => {
      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-marketplace-accounts-'))
      const fixtureRoot = path.join(temporaryDirectory, 'guest')
      const bin = path.join(temporaryDirectory, 'bin')
      const keyMaterial = 'SYNTHETIC_SSH_KEY_BYTES_MUST_NOT_BE_LOGGED_' + 'x'.repeat(80)
      try {
        for (const directory of ['etc', 'root', 'home/alice', 'var/log', 'opt', 'tmp']) {
          fs.mkdirSync(path.join(fixtureRoot, directory), { recursive: true })
        }
        fs.mkdirSync(bin)
        fs.writeFileSync(path.join(fixtureRoot, 'etc/os-release'), 'NAME="Ubuntu"\nVERSION_ID="24.04"\n')
        fs.writeFileSync(path.join(fixtureRoot, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/home/alice:/bin/bash\n')
        fs.writeFileSync(
          path.join(fixtureRoot, 'etc/shadow'),
          `root:!:20000:0:99999:7:::\nalice:${scenario.password ? 'synthetic-password-hash' : '!'}:20000:0:99999:7:::\n`
        )
        if (scenario.keyPath) {
          const keyPath = path.join(fixtureRoot, scenario.keyPath)
          fs.mkdirSync(path.dirname(keyPath), { recursive: true })
          fs.writeFileSync(keyPath, keyMaterial + '\n')
        }
        const checker = fs.readFileSync(path.join(repositoryRoot, 'dev/packer/scripts/999-img-check.sh'), 'utf8')
        // EUID is readonly. Root admission is covered by the full-script container
        // smoke; ordinary tests execute every other statement against guest fixtures.
        const admissionStart = checker.indexOf('if [ "$EUID" -ne 0 ]')
        const admissionEnd = checker.indexOf('\nfi\n', admissionStart)
        if (admissionStart < 0 || admissionEnd < 0) throw new Error('Cannot isolate the Marketplace checker root-admission block')
        const isolatedChecker = (checker.slice(0, admissionStart) + checker.slice(admissionEnd + '\nfi\n'.length)).replace(
          /\/(?:etc|root|home|var\/log|opt|tmp)(?=\/|["'\s;])/g,
          prefix => fixtureRoot + prefix
        )
        const script = path.join(temporaryDirectory, 'checker.sh')
        fs.writeFileSync(script, isolatedChecker)
        const commands = {
          clear: '#!/bin/bash\nexit 0\n',
          'cloud-init': '#!/bin/bash\nexit 0\n',
          ufw: '#!/bin/bash\n[[ "$*" == status ]] || exit 99\nprintf "Status: active\\n"\n',
          'apt-get': `#!/bin/bash
case "$*" in '-y update'|'--just-print upgrade') exit 0 ;; *) exit 99 ;; esac
`,
          chmod: `#!/bin/bash
[[ "$#" == 2 && "$1" == 1777 && "$2" == "$TEST_GUEST_TMP" ]] || exit 99
`,
          mkdir: '#!/bin/bash\nexit 99\n'
        }
        for (const [command, content] of Object.entries(commands)) {
          const commandPath = path.join(bin, command)
          fs.writeFileSync(commandPath, content)
          fs.chmodSync(commandPath, 0o755)
        }
        const result = spawnSync('bash', [script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            BASH_ENV: '',
            PATH: `${bin}:/usr/bin:/bin`,
            TEST_GUEST_TMP: path.join(fixtureRoot, 'tmp')
          }
        })
        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status).toBe(scenario.failures === 0 ? 0 : 1)
        const output = result.stdout + result.stderr
        expect(output).toContain(`${scenario.failures} Tests FAILED`)
        expect(output).not.toContain(keyMaterial)
        if (scenario.keyPath) expect(output).toContain(path.join(fixtureRoot, scenario.keyPath))
        if (scenario.failures === 0) {
          expect(output).not.toContain('[FAIL]')
        }
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
      }
    })
  }
})
