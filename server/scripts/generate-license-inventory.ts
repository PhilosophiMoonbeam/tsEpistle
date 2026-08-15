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

interface LicensePolicy {
  schemaVersion: number
  allowedExpressions: string[]
  deniedExpressions: string[]
  reviewRequiredExpressions: string[]
  unknownExpressionPolicy: 'review-required'
}

const rootPath = process.cwd()
const checkOnly = process.argv.includes('--check')
const outputArgument = process.argv.slice(2).find(argument => argument !== '--check')
const outputPath = path.resolve(rootPath, outputArgument ?? 'third-party-licenses.json')
const policyPath = path.join(rootPath, 'license-policy.json')
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as LicensePolicy
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

if (
  policy.schemaVersion !== 1
  || !Array.isArray(policy.allowedExpressions)
  || !Array.isArray(policy.deniedExpressions)
  || !Array.isArray(policy.reviewRequiredExpressions)
  || policy.unknownExpressionPolicy !== 'review-required'
) {
  throw new Error('license-policy.json does not match schema version 1')
}
const expressionCategories = [
  ...policy.allowedExpressions.map(expression => [expression, 'allowed'] as const),
  ...policy.deniedExpressions.map(expression => [expression, 'denied'] as const),
  ...policy.reviewRequiredExpressions.map(expression => [expression, 'review-required'] as const)
]
const duplicateExpressions = expressionCategories
  .filter(([expression], index) => expressionCategories.findIndex(([candidate]) => candidate === expression) !== index)
  .map(([expression]) => expression)
if (duplicateExpressions.length > 0) {
  throw new Error(`License expressions appear in multiple policy categories: ${[...new Set(duplicateExpressions)].sort().join(', ')}`)
}
const allowedExpressions = new Set(policy.allowedExpressions)
const deniedExpressions = new Set(policy.deniedExpressions)
const reviewRequiredExpressions = new Set(policy.reviewRequiredExpressions)
const violations = packages
  .filter(pkg => !allowedExpressions.has(pkg.license))
  .map(pkg => {
    const disposition = deniedExpressions.has(pkg.license)
      ? 'denied'
      : reviewRequiredExpressions.has(pkg.license) ? 'review-required' : policy.unknownExpressionPolicy
    return `${pkg.name}@${pkg.versions.join(',')}: ${pkg.license} (${disposition})`
  })
if (violations.length > 0) {
  throw new Error(`Production dependency licenses violate policy:\n${violations.join('\n')}`)
}

const lockfile = fs.readFileSync(path.join(rootPath, 'pnpm-lock.yaml'))
const inventory = {
  schemaVersion: 1,
  source: {
    lockfile: 'pnpm-lock.yaml',
    sha256: createHash('sha256').update(lockfile).digest('hex'),
    scope: 'production',
    policy: {
      file: path.relative(rootPath, policyPath),
      sha256: createHash('sha256').update(fs.readFileSync(policyPath)).digest('hex')
    },
  },
  licenseMetadataOverrides: Object.fromEntries(Object.entries(licenseMetadataOverrides).sort(([left], [right]) => left.localeCompare(right))),
  packages
}

const serializedInventory = `${JSON.stringify(inventory, null, 2)}\n`
if (checkOnly) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== serializedInventory) {
    throw new Error(`${path.relative(rootPath, outputPath)} is stale; run pnpm run licenses:inventory and commit the result`)
  }
  console.log(`Verified ${packages.length} tracked production dependency license records`)
} else {
  fs.writeFileSync(outputPath, serializedInventory)
  console.log(`Wrote ${packages.length} production dependency license records to ${path.relative(rootPath, outputPath)}`)
}
