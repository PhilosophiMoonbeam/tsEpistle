import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import semver from 'semver'

interface BunLockPackageMetadata {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalPeers?: string[]
}

interface BunLockfile {
  workspaces: Record<string, {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }>
  overrides?: Record<string, string>
  packages: Record<string, [string, string, BunLockPackageMetadata?]>
}

interface InstalledPackageManifest {
  name?: unknown
  version?: unknown
  licence?: unknown
  license?: unknown
  licenses?: unknown
  author?: unknown
  homepage?: unknown
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

interface ResolvedPackage {
  name: string
  version: string
  metadata: BunLockPackageMetadata
}

interface PackageMetadata {
  license: string
  author?: string
  homepage?: string
}

const rootPath = process.cwd()
const checkOnly = process.argv.includes('--check')
const outputArgument = process.argv.slice(2).find(argument => argument !== '--check')
const outputPath = path.resolve(rootPath, outputArgument ?? 'third-party-licenses.json')
const policyPath = path.join(rootPath, 'license-policy.json')
const lockfilePath = path.join(rootPath, 'bun.lock')
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as LicensePolicy
const lockfileBytes = fs.readFileSync(lockfilePath)
const lockfile = Bun.JSONC.parse(lockfileBytes.toString('utf8')) as BunLockfile

const parsePackageDescriptor = (descriptor: string): { name: string, version: string } => {
  const separator = descriptor.lastIndexOf('@')
  if (separator <= 0 || separator === descriptor.length - 1) {
    throw new Error(`Invalid Bun lockfile package descriptor: ${descriptor}`)
  }
  return { name: descriptor.slice(0, separator), version: descriptor.slice(separator + 1) }
}

const packagesByName = new Map<string, ResolvedPackage[]>()
for (const [, [descriptor, , metadata = {}]] of Object.entries(lockfile.packages)) {
  const { name, version } = parsePackageDescriptor(descriptor)
  const packages = packagesByName.get(name) ?? []
  packages.push({ name, version, metadata })
  packagesByName.set(name, packages)
}

const matchesRange = (version: string, range: string): boolean => {
  if (range.startsWith('npm:')) {
    const aliasSeparator = range.lastIndexOf('@')
    range = aliasSeparator > 3 ? range.slice(aliasSeparator + 1) : '*'
  }
  return semver.valid(version) !== null && (semver.validRange(range) === null || semver.satisfies(version, range, { includePrerelease: true }))
}

const rootWorkspace = lockfile.workspaces['']
if (!rootWorkspace) throw new Error('bun.lock does not define the root workspace')

const productionPackages = new Map<string, ResolvedPackage>()
const pending = Object.entries({
  ...rootWorkspace.dependencies,
  ...rootWorkspace.optionalDependencies
})

while (pending.length > 0) {
  const [dependencyName, range] = pending.pop() as [string, string]
  const candidates = (packagesByName.get(dependencyName) ?? [])
    .filter(candidate => matchesRange(candidate.version, range) || lockfile.overrides?.[dependencyName] === candidate.version)
  if (candidates.length === 0) {
    throw new Error(`bun.lock cannot resolve production dependency ${dependencyName}@${range}`)
  }
  for (const candidate of candidates) {
    const identity = `${candidate.name}@${candidate.version}`
    if (productionPackages.has(identity)) continue
    productionPackages.set(identity, candidate)
    const requiredPeers = Object.entries(candidate.metadata.peerDependencies ?? {})
      .filter(([name]) => !candidate.metadata.optionalPeers?.includes(name))
    pending.push(
      ...Object.entries(candidate.metadata.dependencies ?? {}),
      ...Object.entries(candidate.metadata.optionalDependencies ?? {}),
      ...requiredPeers
    )
  }
}
const packageMetadata = new Map<string, PackageMetadata>()
const normalizeLicense = (manifest: InstalledPackageManifest): string => {
  const declaredLicense = manifest.license ?? manifest.licence
  if (typeof declaredLicense === 'string' && declaredLicense.length > 0) return declaredLicense
  if (Array.isArray(declaredLicense)) {
    const expressions = declaredLicense.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    if (expressions.length > 0) return `(${[...new Set(expressions)].join(' OR ')})`
  }
  if (declaredLicense && typeof declaredLicense === 'object' && 'type' in declaredLicense) {
    const type = (declaredLicense as { type?: unknown }).type
    if (typeof type === 'string' && type.length > 0) return type
  }
  if (Array.isArray(manifest.licenses)) {
    const expressions = manifest.licenses
      .map(entry => typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'type' in entry ? (entry as { type?: unknown }).type : undefined)
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    if (expressions.length > 0) return [...new Set(expressions)].sort().join(' OR ')
  }
  return 'Unknown'
}

const normalizeAuthor = (author: unknown): string | undefined => {
  if (typeof author === 'string' && author.length > 0) return author
  if (author && typeof author === 'object' && 'name' in author) {
    const name = (author as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) return name
  }
  return undefined
}

const collectInstalledPackages = (nodeModulesPath: string): void => {
  if (!fs.existsSync(nodeModulesPath)) return
  for (const entry of fs.readdirSync(nodeModulesPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const entryPath = path.join(nodeModulesPath, entry.name)
    if (entry.name.startsWith('@')) {
      collectInstalledPackages(entryPath)
      continue
    }
    const manifestPath = path.join(entryPath, 'package.json')
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as InstalledPackageManifest
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
    const author = normalizeAuthor(manifest.author)
    const homepage = typeof manifest.homepage === 'string' && manifest.homepage.length > 0 ? manifest.homepage : undefined
    packageMetadata.set(`${manifest.name}@${manifest.version}`, {
      license: normalizeLicense(manifest),
      ...(author ? { author } : {}),
      ...(homepage ? { homepage } : {})
    })
    collectInstalledPackages(path.join(entryPath, 'node_modules'))
  }
}
collectInstalledPackages(path.join(rootPath, 'node_modules'))

// These published manifests omit a license field. Their repository license
// files were reviewed explicitly; any new metadata gap fails the release gate.
const licenseMetadataOverrides: Record<string, { license: string, source: string }> = {
  'notp@2.0.3': {
    license: 'MIT',
    source: 'https://github.com/guyht/notp/blob/master/LICENSE'
  },
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
  },
  'uid2@0.0.3': {
    license: 'MIT',
    source: 'https://github.com/coreh/uid2/blob/master/LICENSE'
  }
}

const groupedPackages = new Map<string, InventoryPackage>()
const missingMetadata: string[] = []
const unknownMetadata: string[] = []
for (const identity of [...productionPackages.keys()].sort()) {
  const metadata = packageMetadata.get(identity)
  if (!metadata) {
    missingMetadata.push(identity)
    continue
  }
  const override = licenseMetadataOverrides[identity]
  const license = override?.license ?? metadata.license
  if (license === 'Unknown') unknownMetadata.push(identity)
  const separator = identity.lastIndexOf('@')
  const name = identity.slice(0, separator)
  const version = identity.slice(separator + 1)
  const groupIdentity = `${name}\0${license}`
  const existing = groupedPackages.get(groupIdentity)
  if (existing) {
    existing.versions.push(version)
    if (override?.source) {
      existing.licenseMetadataSource = [...new Set([...(existing.licenseMetadataSource?.split(', ') ?? []), override.source])].sort().join(', ')
    }
  } else {
    groupedPackages.set(groupIdentity, {
      name,
      versions: [version],
      license,
      ...(metadata.author ? { author: metadata.author } : {}),
      ...(metadata.homepage ? { homepage: metadata.homepage } : {}),
      ...(override?.source ? { licenseMetadataSource: override.source } : {})
    })
  }
}
if (missingMetadata.length > 0) {
  throw new Error(`Production dependencies are missing from node_modules; run bun install --frozen-lockfile:\n${missingMetadata.join('\n')}`)
}
if (unknownMetadata.length > 0) {
  throw new Error(`Unreviewed dependency license metadata: ${unknownMetadata.join(', ')}`)
}

const packages = [...groupedPackages.values()]
  .map(pkg => ({ ...pkg, versions: [...new Set(pkg.versions)].sort() }))
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

const inventory = {
  schemaVersion: 1,
  source: {
    lockfile: 'bun.lock',
    sha256: createHash('sha256').update(lockfileBytes).digest('hex'),
    scope: 'production',
    policy: {
      file: path.relative(rootPath, policyPath),
      sha256: createHash('sha256').update(fs.readFileSync(policyPath)).digest('hex')
    }
  },
  licenseMetadataOverrides: Object.fromEntries(Object.entries(licenseMetadataOverrides).sort(([left], [right]) => left.localeCompare(right))),
  packages
}

const serializedInventory = `${JSON.stringify(inventory, null, 2)}\n`
if (checkOnly) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== serializedInventory) {
    throw new Error(`${path.relative(rootPath, outputPath)} is stale; run bun run licenses:inventory and commit the result`)
  }
  console.log(`Verified ${packages.length} tracked production dependency license records`)
} else {
  fs.writeFileSync(outputPath, serializedInventory)
  console.log(`Wrote ${packages.length} production dependency license records to ${path.relative(rootPath, outputPath)}`)
}
