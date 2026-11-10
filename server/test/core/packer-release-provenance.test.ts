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
  bash)
    [[ "$#" == 4 && "$1" == -euo && "$2" == pipefail && "$3" == -c ]] || exit 99
    real_apt_root=/etc/apt/
    fixture_apt_root="$TEST_APT_TREE/"
    policy_script="\${4//$real_apt_root/$fixture_apt_root}"
    /bin/mkdir -p "$TEST_APT_TREE/apt.conf.d"
    /bin/bash "$1" "$2" "$3" "$policy_script"
    ;;
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
          .filter(source => source === 'sources.list' || source.startsWith('sources.list.d/'))
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

  const aptPlanHeader = ['Reading package lists...', 'Building dependency tree...', 'Reading state information...', 'Calculating upgrade...'].join('\n') + '\n'
  const cleanAptPlan = aptPlanHeader + '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n'
  const securityInstall = 'Inst libssl3t64 [3.0.13-0ubuntu3] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])'
  const securityConfigure = 'Conf libssl3t64 (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])'
  const secondSecurityInstall = 'Inst openssh-client [1:9.6p1-3ubuntu13] (1:9.6p1-3ubuntu13.8 Ubuntu:24.04/noble-security [amd64])'
  const secondSecurityConfigure = 'Conf openssh-client (1:9.6p1-3ubuntu13.8 Ubuntu:24.04/noble-security [amd64])'
  const aptNoise = [
    'NOTE: security repository metadata is current.',
    'NOTE: security inspection uses the simulated upgrade below.',
    'Inst security-tools [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])',
    'Conf security-tools (1.1 Ubuntu:24.04/noble-updates [amd64])'
  ].join('\n')
  const checkerScenarios: Array<{
    name: string
    password?: boolean
    keyPath?: string
    failures: number
    yumStatus?: number
    yumPlan?: string
    firewall?: { csfStatus?: number; firewalldStatus: number; activeService?: 'csf' | 'firewalld' }
    inspectionIncomplete?: boolean
    aptUpdateStatus?: number
    aptPlanStatus?: number
    aptPlan?: string
    pendingPackages?: string[]
    logPaths?: string[]
    agentPackages?: Record<string, string>
    agentMetadataFailure?: boolean
    agentArtifact?: 'directory' | 'file' | 'dangling-symlink'
  }> = [
    { name: 'accepts a clean Marketplace account fixture after successful apt inspection', failures: 0 },
    {
      name: 'accepts classifiable not-installed vendor records without purging unrelated packages',
      agentPackages: { 'droplet-agent': 'purge ok not-installed', 'do-agent': 'unknown ok not-installed' },
      failures: 0
    },
    { name: 'rejects installed droplet-agent without a vendor directory', agentPackages: { 'droplet-agent': 'install ok installed' }, failures: 1 },
    { name: 'rejects installed do-agent without a vendor directory', agentPackages: { 'do-agent': 'install ok installed' }, failures: 1 },
    { name: 'rejects config-only vendor agents without a vendor directory', agentPackages: { 'do-agent': 'deinstall ok config-files' }, failures: 1 },
    { name: 'rejects partially installed vendor agents without a vendor directory', agentPackages: { 'droplet-agent': 'install ok unpacked' }, failures: 1 },
    { name: 'rejects unclassifiable native package metadata without a vendor directory', agentMetadataFailure: true, failures: 1 },
    { name: 'rejects a residual vendor directory with absent vendor packages', agentArtifact: 'directory', failures: 1 },
    { name: 'rejects a residual vendor file with absent vendor packages', agentArtifact: 'file', failures: 1 },
    { name: 'rejects a dangling vendor symlink with absent vendor packages', agentArtifact: 'dangling-symlink', failures: 1 },
    { name: 'fails Marketplace validation for a non-root account password', password: true, failures: 1 },
    { name: 'detects root private SSH keys without disclosing their bytes', keyPath: 'root/.ssh/id_rsa', failures: 1 },
    { name: 'detects non-root private SSH keys without disclosing their bytes', keyPath: 'home/alice/.ssh/id_rsa', failures: 1 },
    { name: 'rejects root authorized SSH keys without disclosing their bytes', keyPath: 'root/.ssh/authorized_keys', failures: 1 },
    { name: 'rejects non-root authorized SSH keys without disclosing their bytes', keyPath: 'home/alice/.ssh/authorized_keys', failures: 1 },
    { name: 'fails closed when apt metadata refresh fails', aptUpdateStatus: 100, failures: 1 },
    { name: 'fails closed when the apt upgrade inspection fails', aptPlanStatus: 100, failures: 1 },
    { name: 'rejects an empty successful apt inspection as indeterminate', aptPlan: '', inspectionIncomplete: true, failures: 1 },
    { name: 'rejects a truncated apt inspection as indeterminate', aptPlan: aptPlanHeader, inspectionIncomplete: true, failures: 1 },
    {
      name: 'rejects an apt plan truncated after its upgrade summary',
      aptPlan: `${aptPlanHeader}1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`,
      inspectionIncomplete: true,
      failures: 1
    },
    { name: 'fails closed when yum security inspection fails', yumStatus: 1, failures: 1 },
    { name: 'accepts a successful yum inspection with no pending updates', yumStatus: 0, failures: 0 },
    { name: 'rejects pending yum security updates using its documented status', yumStatus: 100, yumPlan: 'openssl.x86_64 1.2.3 updates\n', failures: 1 },
    { name: 'rejects an indeterminate yum update result', yumStatus: 100, yumPlan: '', inspectionIncomplete: true, failures: 1 },
    {
      name: 'reports an active native CSF service without probing firewalld',
      yumStatus: 0,
      firewall: { csfStatus: 0, firewalldStatus: 3, activeService: 'csf' },
      failures: 0
    },
    {
      name: 'falls back from inactive CSF to active firewalld',
      yumStatus: 0,
      firewall: { csfStatus: 3, firewalldStatus: 0, activeService: 'firewalld' },
      failures: 0
    },
    {
      name: 'falls back from a CSF status error to active firewalld',
      yumStatus: 0,
      firewall: { csfStatus: 1, firewalldStatus: 0, activeService: 'firewalld' },
      failures: 0
    },
    {
      name: 'warns without failing when CSF and firewalld are inactive',
      yumStatus: 0,
      firewall: { csfStatus: 3, firewalldStatus: 3 },
      failures: 0
    },
    {
      name: 'warns without falsely passing when both firewall status commands error',
      yumStatus: 0,
      firewall: { csfStatus: 1, firewalldStatus: 1 },
      failures: 0
    },
    {
      name: 'reports active native firewalld when CSF is not installed',
      yumStatus: 0,
      firewall: { firewalldStatus: 0, activeService: 'firewalld' },
      failures: 0
    },
    {
      name: 'warns without failing for inactive native firewalld when CSF is absent',
      yumStatus: 0,
      firewall: { firewalldStatus: 3 },
      failures: 0
    },
    {
      name: 'warns without falsely passing for a native firewalld status error',
      yumStatus: 0,
      firewall: { firewalldStatus: 1 },
      failures: 0
    },
    {
      name: 'preserves critical failure aggregation alongside a firewall warning',
      yumStatus: 0,
      firewall: { firewalldStatus: 3 },
      password: true,
      failures: 1
    },
    {
      name: 'does not treat arbitrary security text or non-security package records as pending security upgrades',
      aptPlan: `${aptPlanHeader}1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n${aptNoise}\n`,
      failures: 0
    },
    {
      name: 'rejects a single security Inst record without requiring a matching Conf line',
      aptPlan: `${aptPlanHeader}1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n${securityInstall}\n`,
      pendingPackages: ['libssl3t64'],
      failures: 1
    },
    {
      name: 'counts one pending security package rather than its Inst and Conf records',
      aptPlan: `${aptPlanHeader}1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n${securityInstall}\n${securityConfigure}\n`,
      pendingPackages: ['libssl3t64'],
      failures: 1
    },
    {
      name: 'counts repeated security Inst records only once',
      aptPlan: `${aptPlanHeader}1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n${securityInstall}\n${securityInstall}\n`,
      pendingPackages: ['libssl3t64'],
      failures: 1
    },
    {
      name: 'ignores a security Conf record without any pending Inst record',
      aptPlan: `${cleanAptPlan}${securityConfigure}\n`,
      failures: 0
    },
    {
      name: 'counts multiple pending security packages while ignoring matching Conf records and unrelated noise',
      aptPlan: `${aptPlanHeader}3 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n${aptNoise}\n${securityInstall}\n${secondSecurityInstall}\n${securityConfigure}\n${secondSecurityConfigure}\n`,
      pendingPackages: ['libssl3t64', 'openssh-client'],
      failures: 1
    },
    {
      name: 'warns about residual current and rotated logs without disclosing their contents',
      logPaths: ['var/log/application-20261110', 'var/log/application.log.1', 'var/log/application.log', 'var/log/lfd.log'],
      failures: 0
    }
  ]
  for (const scenario of checkerScenarios) {
    it(scenario.name, () => {
      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'packer-marketplace-accounts-'))
      const fixtureRoot = path.join(temporaryDirectory, 'guest')
      const bin = path.join(temporaryDirectory, 'bin')
      const keyMaterial = 'SYNTHETIC_SSH_KEY_BYTES_MUST_NOT_BE_LOGGED_' + 'x'.repeat(80)
      const logMaterial = 'SYNTHETIC_RESIDUAL_LOG_SECRET_MUST_NOT_BE_LOGGED_' + 'z'.repeat(80)
      const packageMaterial = 'SYNTHETIC_PACKAGE_SOURCE_CREDENTIAL_MUST_NOT_BE_LOGGED'
      const aptOperations = path.join(temporaryDirectory, 'apt-operations')
      const aptPlan = path.join(temporaryDirectory, 'apt-plan')
      const firewallOperations = path.join(temporaryDirectory, 'firewall-operations')
      try {
        for (const directory of ['etc', 'root', 'home/alice', 'var/log', 'opt', 'tmp', 'usr/lib/systemd/system']) {
          fs.mkdirSync(path.join(fixtureRoot, directory), { recursive: true })
        }
        fs.mkdirSync(bin)
        const database = path.join(fixtureRoot, 'var/lib/dpkg')
        fs.mkdirSync(database, { recursive: true })
        const packageStates = {
          'tsepistle-agent': 'install ok installed',
          'droplet-agent-tools': 'install ok installed',
          'do-agent-tools': 'install ok installed',
          ...scenario.agentPackages
        }
        const packageMetadata = Object.entries(packageStates).map(([name, state]) =>
          `Package: ${name}\nStatus: ${state}\nArchitecture: all\nVersion: 1.0\nMaintainer: Fixture <fixture@example.invalid>\nDescription: Guest fixture\n\n`
        ).join('')
        const databaseContents = scenario.agentMetadataFailure
          ? `Package: do-agent\nStatus: install ok unclassifiable-${packageMaterial}\n\n`
          : packageMetadata
        fs.writeFileSync(path.join(database, 'status'), databaseContents)
        const unrelatedArtifact = path.join(fixtureRoot, 'opt/tsepistle-agent')
        fs.writeFileSync(unrelatedArtifact, 'UNRELATED_NATIVE_AGENT\n')
        const vendorArtifact = path.join(fixtureRoot, 'opt/digitalocean')
        if (scenario.agentArtifact === 'directory') fs.mkdirSync(vendorArtifact)
        if (scenario.agentArtifact === 'file') fs.writeFileSync(vendorArtifact, 'VENDOR_ARTIFACT\n')
        if (scenario.agentArtifact === 'dangling-symlink') fs.symlinkSync('missing-vendor-artifact', vendorArtifact)
        fs.writeFileSync(
          path.join(fixtureRoot, 'etc/os-release'),
          scenario.yumStatus === undefined ? 'NAME="Ubuntu"\nVERSION_ID="24.04"\n' : 'NAME="Rocky Linux"\nVERSION_ID="9.4"\n'
        )
        fs.writeFileSync(path.join(fixtureRoot, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/home/alice:/bin/bash\n')
        fs.writeFileSync(
          path.join(fixtureRoot, 'etc/shadow'),
          `root:!:20000:0:99999:7:::\nalice:${scenario.password ? 'synthetic-password-hash' : '!'}:20000:0:99999:7:::\n`
        )
        if (scenario.firewall?.csfStatus !== undefined) {
          fs.writeFileSync(path.join(fixtureRoot, 'usr/lib/systemd/system/csf.service'), '[Service]\nExecStart=/usr/sbin/csf\n')
        }
        if (scenario.keyPath) {
          const keyPath = path.join(fixtureRoot, scenario.keyPath)
          fs.mkdirSync(path.dirname(keyPath), { recursive: true })
          fs.writeFileSync(keyPath, keyMaterial + '\n')
        }
        for (const logPath of scenario.logPaths ?? []) {
          fs.writeFileSync(path.join(fixtureRoot, logPath), logMaterial + '\n')
        }
        fs.writeFileSync(aptPlan, scenario.yumStatus === undefined ? (scenario.aptPlan ?? cleanAptPlan) : (scenario.yumPlan ?? ''))
        const checker = fs.readFileSync(path.join(repositoryRoot, 'dev/packer/scripts/999-img-check.sh'), 'utf8')
        // EUID is readonly. Root admission is covered by the full-script container
        // smoke; ordinary tests execute every other statement against guest fixtures.
        const admissionStart = checker.indexOf('if [ "$EUID" -ne 0 ]')
        const admissionEnd = checker.indexOf('\nfi\n', admissionStart)
        if (admissionStart < 0 || admissionEnd < 0) throw new Error('Cannot isolate the Marketplace checker root-admission block')
        const isolatedChecker = (checker.slice(0, admissionStart) + checker.slice(admissionEnd + '\nfi\n'.length)).replace(
          /\/(?:etc|root|home|var\/log|opt|tmp|usr\/lib\/systemd\/system)(?=\/|["'\s;])/g,
          prefix => fixtureRoot + prefix
        )
        const script = path.join(temporaryDirectory, 'checker.sh')
        fs.writeFileSync(script, isolatedChecker)
        const commands = {
          clear: '#!/bin/bash\nexit 0\n',
          'cloud-init': '#!/bin/bash\nexit 0\n',
          'dpkg-query': '#!/bin/bash\nexec /usr/bin/dpkg-query --admindir="$TEST_DPKG_DATABASE" "$@"\n',
          ufw: '#!/bin/bash\n[[ "$*" == status ]] || exit 99\nprintf "Status: active\\n"\n',
          'firewall-cmd': '#!/bin/bash\nexit 0\n',
          systemctl: `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_FIREWALL_OPERATIONS"
case "$*" in
  "status csf") status="$TEST_CSF_STATUS" ;;
  "is-active firewalld") status="$TEST_FIREWALLD_STATUS" ;;
  *) exit 99 ;;
esac
case "$status" in
  0) printf 'active\\n' ;;
  3) printf 'inactive\\n' ;;
  *) printf 'Failed to query service status\\n' >&2 ;;
esac
exit "$status"
`,
          yum: `#!/bin/bash
[[ "$*" == "check-update --security --quiet" && "$LC_ALL" == C ]] || exit 99
printf 'yum\\n' >> "$TEST_APT_OPERATIONS"
cat "$TEST_APT_PLAN"
printf '%s\\n' "$TEST_PACKAGE_SECRET" >&2
exit "$TEST_YUM_STATUS"
`,
          'apt-get': `#!/bin/bash
[[ "$LC_ALL" == C && "$DEBIAN_FRONTEND" == noninteractive ]] || exit 99
printf '%s\\n' "$TEST_PACKAGE_SECRET" >&2
operation=
simulation=false
strictRefresh=false
for argument in "$@"; do
  case "$argument" in
    update|upgrade) operation="$argument" ;;
    --just-print|--simulate|-s) simulation=true ;;
    --error-on=any) strictRefresh=true ;;
  esac
done
case "$operation" in
  update)
    [[ "$strictRefresh" == true ]] || exit 99
    printf 'update\\n' >> "$TEST_APT_OPERATIONS"
    printf 'Reading package lists...\\n'
    printf '%s\\n' "$TEST_PACKAGE_SECRET"
    if [[ "$TEST_APT_UPDATE_STATUS" != 0 ]]; then
      printf 'E: Failed to fetch fixture package metadata\\n' >&2
    fi
    exit "$TEST_APT_UPDATE_STATUS"
    ;;
  upgrade)
    [[ "$simulation" == true ]] || exit 99
    printf 'plan\\n' >> "$TEST_APT_OPERATIONS"
    cat "$TEST_APT_PLAN"
    printf '%s\\n' "$TEST_PACKAGE_SECRET"
    if [[ "$TEST_APT_PLAN_STATUS" != 0 ]]; then
      printf 'E: Unable to calculate fixture upgrade plan\\n' >&2
    fi
    exit "$TEST_APT_PLAN_STATUS"
    ;;
  *) exit 99 ;;
esac
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
            TEST_GUEST_TMP: path.join(fixtureRoot, 'tmp'),
            TEST_DPKG_DATABASE: database,
            TEST_APT_OPERATIONS: aptOperations,
            TEST_APT_PLAN: aptPlan,
            TEST_APT_UPDATE_STATUS: String(scenario.aptUpdateStatus ?? 0),
            TEST_APT_PLAN_STATUS: String(scenario.aptPlanStatus ?? 0),
            TEST_YUM_STATUS: String(scenario.yumStatus ?? 0),
            TEST_FIREWALL_OPERATIONS: firewallOperations,
            TEST_CSF_STATUS: String(scenario.firewall?.csfStatus ?? 3),
            TEST_FIREWALLD_STATUS: String(scenario.firewall?.firewalldStatus ?? 0),
            TEST_PACKAGE_SECRET: packageMaterial
          }
        })
        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status).toBe(scenario.failures === 0 ? 0 : 1)
        const output = result.stdout + result.stderr
        expect(output).toContain(`${scenario.failures} Tests FAILED`)
        expect(output).not.toContain(keyMaterial)
        expect(output).not.toContain(logMaterial)
        expect(output).not.toContain(packageMaterial)
        expect(output).not.toContain(securityInstall)
        expect(output).toContain('Checking the root account')
        const agentFailure = scenario.agentMetadataFailure || scenario.agentArtifact ||
          Object.values(scenario.agentPackages ?? {}).some(state => !state.endsWith('not-installed'))
        if (agentFailure) {
          expect(output).not.toContain('DigitalOcean Monitoring agent was not found')
          expect(output).toContain('DigitalOcean')
          if (scenario.agentArtifact) expect(output).toContain(vendorArtifact)
          if (scenario.agentMetadataFailure) expect(output).toContain('Unable to inspect DigitalOcean agent package metadata')
          for (const [name, state] of Object.entries(scenario.agentPackages ?? {})) {
            if (!state.endsWith('not-installed')) expect(output).toContain(name)
          }
        } else {
          expect(output).toContain('DigitalOcean Monitoring agent was not found')
        }
        expect(fs.readFileSync(unrelatedArtifact, 'utf8')).toBe('UNRELATED_NATIVE_AGENT\n')
        expect(fs.readFileSync(path.join(database, 'status'), 'utf8')).toBe(databaseContents)
        const operations = fs.readFileSync(aptOperations, 'utf8').trim().split('\n')
        expect(operations).toEqual(scenario.yumStatus !== undefined ? ['yum'] : scenario.aptUpdateStatus ? ['update'] : ['update', 'plan'])
        if (scenario.aptUpdateStatus || scenario.aptPlanStatus || scenario.inspectionIncomplete || scenario.yumStatus === 1) {
          expect(output).toContain('[FAIL]')
          expect(output).not.toContain('There are no pending security updates')
        }
        if (scenario.pendingPackages) {
          expect(output).toContain(`There are ${scenario.pendingPackages.length} security updates available`)
          for (const packageName of scenario.pendingPackages) expect(output).toContain(packageName)
        }
        for (const logPath of scenario.logPaths ?? []) {
          expect(output).toContain(path.join(fixtureRoot, logPath))
        }
        if (scenario.logPaths) {
          expect(output).toContain(`${scenario.logPaths.length} WARNINGS`)
          expect(output).toContain('[WARN]')
        }
        if (scenario.firewall) {
          const { csfStatus, activeService } = scenario.firewall
          const firewallCalls = fs.readFileSync(firewallOperations, 'utf8').trim().split('\n')
          expect(firewallCalls).toEqual(
            csfStatus === undefined ? ['is-active firewalld'] : csfStatus === 0 ? ['status csf'] : ['status csf', 'is-active firewalld']
          )
          if (activeService) {
            expect(output).toContain(`Firewall service (${activeService}) is active`)
            expect(output).not.toContain('No firewall is configured')
            expect(output).toContain('0 WARNINGS')
          } else {
            expect(output).toContain('No firewall is configured. Ensure firewalld is installed and configured')
            expect(output).not.toMatch(/Firewall service \([^)]+\) is active/)
            expect(output).toContain('1 WARNINGS')
          }
          expect(output).toContain(scenario.failures === 0 ? 'All Tests Passed!' : 'Some critical tests failed.')
        }
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
