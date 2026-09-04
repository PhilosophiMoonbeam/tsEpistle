import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies'

interface PackageManifest {
  packageManager?: unknown
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
}

interface LockPackageMetadata {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  os?: string
  cpu?: string
}

interface BunLockfile {
  workspaces: Record<
    string,
    {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
  >
  packages: Record<string, [string, string, LockPackageMetadata?]>
}

interface LicenseInventory {
  source?: {
    lockfile?: unknown
    sha256?: unknown
  }
  packages?: Array<{
    name?: unknown
    versions?: unknown
    license?: unknown
  }>
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const packageManagerVersion = /^bun@(\d+\.\d+\.\d+)$/
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const rootPath = process.cwd()
const manifest = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8')) as PackageManifest

const managerMatch = typeof manifest.packageManager === 'string' ? packageManagerVersion.exec(manifest.packageManager) : null
if (!managerMatch) throw new Error('packageManager must pin one exact Bun version')

const runtimeVersion = process.versions.bun
if (!runtimeVersion) throw new Error('Dependency policy must run with Bun')
if (runtimeVersion !== managerMatch[1]) {
  throw new Error(`Bun runtime ${runtimeVersion} does not match packageManager ${managerMatch[1]}`)
}

const invalid: string[] = []
for (const section of dependencySections) {
  for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (typeof version !== 'string' || !exactVersion.test(version)) invalid.push(`${section}.${name}=${String(version)}`)
  }
}
if (invalid.length > 0) {
  throw new Error(`Direct runtime and development dependencies must use exact versions:\n${invalid.sort().join('\n')}`)
}

const requiredDirectDependencies: ReadonlyArray<readonly [DependencySection, string, string]> = [
  ['dependencies', 'sharp', '0.35.4'],
  ['devDependencies', '@tresjs/core', '5.8.3'],
  ['devDependencies', '@types/three', '0.184.1'],
  ['devDependencies', 'three', '0.184.0']
]
for (const [section, name, version] of requiredDirectDependencies) {
  if (manifest[section]?.[name] !== version) {
    throw new Error(`${section}.${name} must be pinned to ${version}`)
  }
  for (const otherSection of dependencySections) {
    if (otherSection !== section && manifest[otherSection]?.[name] !== undefined) {
      throw new Error(`${name} must appear only in ${section}`)
    }
  }
}

const lockfilePath = path.join(rootPath, 'bun.lock')
const lockfileBytes = fs.readFileSync(lockfilePath)
const lockfile = Bun.JSONC.parse(lockfileBytes.toString('utf8')) as BunLockfile
const rootWorkspace = lockfile.workspaces['']
if (!rootWorkspace) throw new Error('bun.lock does not define the root workspace')

for (const [section, name, version] of requiredDirectDependencies) {
  if (rootWorkspace[section]?.[name] !== version) {
    throw new Error(`bun.lock root ${section}.${name} must resolve ${version}`)
  }
}

const lockedPackage = (name: string, version: string): LockPackageMetadata => {
  const matches = Object.values(lockfile.packages).filter(([descriptor]) => descriptor === `${name}@${version}`)
  if (matches.length !== 1) {
    throw new Error(`bun.lock must contain exactly one ${name}@${version} package record`)
  }
  return matches[0]?.[2] ?? {}
}

lockedPackage('@tresjs/core', '5.8.3')
lockedPackage('@types/three', '0.184.1')
lockedPackage('three', '0.184.0')
const sharpMetadata = lockedPackage('sharp', '0.35.4')

const requiredSharpOptionals = [
  ['@img/sharp-linuxmusl-x64', '0.35.4', 'linux', 'x64'],
  ['@img/sharp-libvips-linuxmusl-x64', '1.3.3', 'linux', 'x64'],
  ['@img/sharp-linuxmusl-arm64', '0.35.4', 'linux', 'arm64'],
  ['@img/sharp-libvips-linuxmusl-arm64', '1.3.3', 'linux', 'arm64']
] as const
for (const [name, version, os, cpu] of requiredSharpOptionals) {
  if (sharpMetadata.optionalDependencies?.[name] !== version) {
    throw new Error(`sharp@0.35.4 must retain optional dependency ${name}@${version}`)
  }
  const metadata = lockedPackage(name, version)
  if (metadata.os !== os || metadata.cpu !== cpu) {
    throw new Error(`${name}@${version} must target ${os}/${cpu}`)
  }
}
for (const cpu of ['x64', 'arm64'] as const) {
  const binary = lockedPackage(`@img/sharp-linuxmusl-${cpu}`, '0.35.4')
  const libvipsName = `@img/sharp-libvips-linuxmusl-${cpu}`
  if (binary.optionalDependencies?.[libvipsName] !== '1.3.3') {
    throw new Error(`@img/sharp-linuxmusl-${cpu}@0.35.4 must retain ${libvipsName}@1.3.3`)
  }
}

const inventory = JSON.parse(fs.readFileSync(path.join(rootPath, 'third-party-licenses.json'), 'utf8')) as LicenseInventory
const lockfileHash = createHash('sha256').update(lockfileBytes).digest('hex')
if (inventory.source?.lockfile !== 'bun.lock' || inventory.source.sha256 !== lockfileHash) {
  throw new Error('third-party-licenses.json must identify the current bun.lock')
}
const requiredLicenseRecords = [
  ['sharp', '0.35.4', 'Apache-2.0'],
  ['@img/sharp-linuxmusl-x64', '0.35.4', 'Apache-2.0'],
  ['@img/sharp-linuxmusl-arm64', '0.35.4', 'Apache-2.0'],
  ['@img/sharp-libvips-linuxmusl-x64', '1.3.3', 'LGPL-3.0-or-later'],
  ['@img/sharp-libvips-linuxmusl-arm64', '1.3.3', 'LGPL-3.0-or-later'],
  ['@tresjs/core', '5.8.3', 'MIT'],
  ['three', '0.184.0', 'MIT'],
  ['@types/three', '0.184.1', 'MIT']
] as const
for (const [name, version, license] of requiredLicenseRecords) {
  const matches = (inventory.packages ?? []).filter(pkg => pkg.name === name && Array.isArray(pkg.versions) && pkg.versions.includes(version))
  if (matches.length !== 1 || matches[0]?.license !== license) {
    throw new Error(`third-party-licenses.json must record ${name}@${version} as ${license}`)
  }
}

const configuredBun = process.env.BUN_VERSION
if (configuredBun && configuredBun !== managerMatch[1]) {
  throw new Error(`BUN_VERSION ${configuredBun} does not match packageManager ${managerMatch[1]}`)
}

process.stdout.write(
  `Dependency policy valid: exact Bun ${managerMatch[1]}, exact direct versions, reviewed renderer licenses, and reviewed Sharp musl binaries.\n`
)
