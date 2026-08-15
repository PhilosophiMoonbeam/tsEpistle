import fs from 'node:fs'
import path from 'node:path'

interface PackageManifest {
  packageManager?: unknown
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const packageManagerVersion = /^pnpm@(\d+\.\d+\.\d+)$/
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const rootPath = process.cwd()
const manifest = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8')) as PackageManifest
const npmrc = fs.readFileSync(path.join(rootPath, '.npmrc'), 'utf8')

const managerMatch = typeof manifest.packageManager === 'string'
  ? packageManagerVersion.exec(manifest.packageManager)
  : null
if (!managerMatch) throw new Error('packageManager must pin one exact pnpm version')

const npmrcSettings = new Map(npmrc
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line.length > 0 && !line.startsWith('#'))
  .map(line => line.split('=').map(part => part.trim()) as [string, string]))
if (npmrcSettings.get('save-exact') !== 'true' || npmrcSettings.get('save-prefix') !== '""') {
  throw new Error('.npmrc must enforce save-exact=true and an empty save-prefix')
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

const configuredPnpm = process.env.PNPM_VERSION
if (configuredPnpm && configuredPnpm !== managerMatch[1]) {
  throw new Error(`PNPM_VERSION ${configuredPnpm} does not match packageManager ${managerMatch[1]}`)
}

process.stdout.write(`Dependency policy valid: exact pnpm ${managerMatch[1]} and exact direct dependency versions.\n`)
