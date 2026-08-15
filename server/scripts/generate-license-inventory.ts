import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

interface PnpmLicensePackage {
  name: string
  versions: string[]
  license: string
  author?: string
  homepage?: string
  description?: string
}

interface InventoryPackage {
  name: string
  versions: string[]
  license: string
  author?: string
  homepage?: string
  licenseMetadataSource?: string
}

const rootPath = process.cwd()
const outputPath = path.resolve(rootPath, process.argv[2] ?? 'third-party-licenses.json')
const pnpmCli = process.env.npm_execpath

if (!pnpmCli) {
  throw new Error('npm_execpath is unavailable; run this script through pnpm')
}

const raw = execFileSync(process.execPath, [pnpmCli, 'licenses', 'list', '--prod', '--json'], {
  cwd: rootPath,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
})
const report = JSON.parse(raw) as Record<string, PnpmLicensePackage[]>

// These published manifests omit a license field. Their repository license
// files were reviewed explicitly; any new metadata gap fails the release gate.
const licenseMetadataOverrides: Record<string, { license: string, source: string }> = {
  'pause@0.0.1': {
    license: 'MIT',
    source: 'https://github.com/stream-utils/pause/blob/master/LICENSE'
  },
  'pkginfo@0.2.3': {
    license: 'MIT',
    source: 'https://github.com/indexzero/node-pkginfo/blob/master/LICENSE'
  },
  'thirty-two@1.0.2': {
    license: 'MIT',
    source: 'https://github.com/chrisumbel/thirty-two/blob/master/LICENSE.txt'
  }
}
const unknown = (report.Unknown ?? []).flatMap(pkg =>
  pkg.versions.map(version => `${pkg.name}@${version}`)
).filter(pkg => !licenseMetadataOverrides[pkg])

if (unknown.length > 0) {
  throw new Error(`Unreviewed dependency license metadata: ${unknown.sort().join(', ')}`)
}

const packages: InventoryPackage[] = Object.entries(report)
  .flatMap(([reportedLicense, entries]) => entries.map(entry => {
    const versions = [...entry.versions].sort()
    const overrides = versions
      .map(version => licenseMetadataOverrides[`${entry.name}@${version}`])
      .filter((override): override is { license: string, source: string } => override !== undefined)
    const overrideLicenses = [...new Set(overrides.map(override => override.license))]
    if (reportedLicense === 'Unknown' && (overrides.length !== versions.length || overrideLicenses.length !== 1)) {
      throw new Error(`Incomplete license metadata override for ${entry.name}@${versions.join(',')}`)
    }
    return {
      name: entry.name,
      versions,
      license: overrideLicenses[0] ?? reportedLicense,
      ...(entry.author ? { author: entry.author } : {}),
      ...(entry.homepage ? { homepage: entry.homepage } : {}),
      ...(overrides.length > 0
        ? { licenseMetadataSource: [...new Set(overrides.map(override => override.source))].join(', ') }
        : {})
    }
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.license.localeCompare(right.license))

const lockfile = fs.readFileSync(path.join(rootPath, 'pnpm-lock.yaml'))
const inventory = {
  schemaVersion: 1,
  source: {
    lockfile: 'pnpm-lock.yaml',
    sha256: createHash('sha256').update(lockfile).digest('hex'),
    scope: 'production'
  },
  licenseMetadataOverrides: Object.fromEntries(Object.entries(licenseMetadataOverrides).sort(([left], [right]) => left.localeCompare(right))),
  packages
}

fs.writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`)
console.log(`Wrote ${packages.length} production dependency license records to ${path.relative(rootPath, outputPath)}`)
