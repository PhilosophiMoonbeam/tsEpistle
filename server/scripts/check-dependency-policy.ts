import fs from 'node:fs'
import path from 'node:path'

interface PackageManifest {
  packageManager?: unknown
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const packageManagerVersion = /^bun@(\d+\.\d+\.\d+)$/
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const rootPath = process.cwd()
const manifest = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8')) as PackageManifest

const managerMatch = typeof manifest.packageManager === 'string'
  ? packageManagerVersion.exec(manifest.packageManager)
  : null
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

const configuredBun = process.env.BUN_VERSION
if (configuredBun && configuredBun !== managerMatch[1]) {
  throw new Error(`BUN_VERSION ${configuredBun} does not match packageManager ${managerMatch[1]}`)
}

process.stdout.write(`Dependency policy valid: exact Bun ${managerMatch[1]} and exact direct dependency versions.\n`)
