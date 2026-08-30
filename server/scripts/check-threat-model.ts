import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/
const REQUIRED_COMMANDS = [
  'bun run dependencies:check',
  'bun run licenses:check',
  'bun run test:security',
  'bun audit --production',
  'bun run typecheck:server'
] as const
const THREAT_MODEL_SCRIPT = 'bun server/scripts/check-threat-model.ts'
const THREAT_MODEL_CI_COMMAND = 'bun run threat-model:check'

type PackageManifest = {
  packageManager?: unknown
  scripts?: unknown
  [key: string]: unknown
}

export type ThreatModelFinding = {
  id: string
  severity: string
}

export type ThreatModelContract = {
  reviewedRevision: string
  externalReviewer: string
  openFindings: ThreatModelFinding[]
  resolvedFindingIds: string[]
  citedPaths: string[]
  commands: string[]
}

export type ThreatModelCheckOptions = {
  release?: boolean
}

function extractRepositoryCitations(markdown: string): string[] {
  const citations = new Set<string>()
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1]
    if (!value || value.startsWith('/') || value.includes(' ') || value.includes(';')) continue
    if (value === 'package.json' || value === 'bun.lock' || /^(?:server|shared|client|dev|docs|patches|\.github)\/[A-Za-z0-9_./-]+$/.test(value)) {
      citations.add(value)
    }
  }
  return [...citations]
}

function extractGateCommands(markdown: string): string[] {
  const section = markdown.match(/(?:^|\n)## Executable security gate\s*\n([\s\S]*?)(?=\n##\s|$)/)?.[1]
  if (!section) throw new Error('Threat model must contain an Executable security gate section')
  const blocks = [...section.matchAll(/```console\s*\n([\s\S]*?)```/g)]
  if (blocks.length !== 1) throw new Error('Executable security gate must contain exactly one console command block')
  return (blocks[0]?.[1] ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

function extractTableRows(markdown: string, heading: string, expectedHeaders: string[]): string[][] {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sectionMatches = [...markdown.matchAll(new RegExp(`(?:^|\\n)## ${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'g'))]
  if (sectionMatches.length !== 1) throw new Error(`Threat model must contain exactly one ${heading} section`)

  const section = sectionMatches[0]?.[1] ?? ''
  const tableBlocks = [...section.matchAll(/(?:^|\n)((?:\|[^\n]*\|[ \t]*(?:\n|$))+)/g)]
  const matchingTables = tableBlocks
    .map(match =>
      (match[1] ?? '')
        .trim()
        .split('\n')
        .map(line =>
          line
            .trim()
            .slice(1, -1)
            .split('|')
            .map(cell => cell.trim())
        )
    )
    .filter(rows => isDeepStrictEqual(rows[0], expectedHeaders))
  if (matchingTables.length !== 1) {
    throw new Error(`${heading} must contain exactly one ${expectedHeaders.join(' / ')} table`)
  }

  const [header, separator, ...rows] = matchingTables[0] ?? []
  if (!header || !separator || separator.length !== header.length || separator.some(cell => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error(`${heading} table must contain a Markdown header separator`)
  }
  if (rows.some(row => row.length !== header.length || row.some(cell => cell.length === 0))) {
    throw new Error(`${heading} table rows must contain every declared field`)
  }
  return rows
}

function findingId(label: string): string {
  const match = label.match(/^([A-Z][A-Z0-9-]*-\d+)\s+—\s+\S/)
  if (!match) throw new Error(`Finding must begin with a stable ID and description: ${label}`)
  return match[1] ?? ''
}

export function parseThreatModel(markdown: string): ThreatModelContract {
  const statusRows = extractTableRows(markdown, 'Status and review contract', ['Field', 'Value'])
  const status = new Map<string, string>()
  for (const [field = '', value = ''] of statusRows) {
    if (status.has(field)) throw new Error(`Status and review contract contains duplicate field: ${field}`)
    status.set(field, value)
  }

  const coveredValue = status.get('Covered source')
  if (!coveredValue) throw new Error('Threat model must contain exactly one Covered source row')
  const revisionMatch = coveredValue.match(/^`([^`]+)`$/)
  if (!revisionMatch) throw new Error('Covered source must be one backticked full Git revision')
  const reviewedRevision = revisionMatch[1] ?? ''
  if (!FULL_SHA_PATTERN.test(reviewedRevision)) {
    throw new Error('Covered source must be exactly one full 40-character lowercase Git revision, not a branch or range')
  }
  const externalReviewer = status.get('External reviewer')
  if (!externalReviewer) throw new Error('Threat model must declare an External reviewer')
  if (/\bpnpm\b|pnpm-lock\.yaml|package-lock\.json|yarn\.lock/.test(markdown)) {
    throw new Error('Threat model dependency evidence must use Bun and bun.lock exclusively')
  }

  const openFindings = extractTableRows(markdown, 'Open findings and accepted limitations', ['Finding', 'Severity', 'Owner', 'Required disposition']).map(
    ([label = '', severity = '']) => ({ id: findingId(label), severity })
  )
  const resolvedFindingIds = extractTableRows(markdown, 'Resolved findings', ['Finding', 'Resolution evidence']).map(([label = '']) => findingId(label))
  const findingIds = [...openFindings.map(finding => finding.id), ...resolvedFindingIds]
  const duplicateFinding = findingIds.find((id, index) => findingIds.indexOf(id) !== index)
  if (duplicateFinding) throw new Error(`Finding must have exactly one open or resolved disposition: ${duplicateFinding}`)

  const commands = extractGateCommands(markdown)
  for (const requiredCommand of REQUIRED_COMMANDS) {
    if (!commands.includes(requiredCommand)) throw new Error(`Executable security gate is missing command: ${requiredCommand}`)
  }
  const citedPaths = extractRepositoryCitations(markdown)
  if (!citedPaths.includes('bun.lock')) throw new Error('Threat model must cite bun.lock as frozen dependency evidence')

  return { reviewedRevision, externalReviewer, openFindings, resolvedFindingIds, citedPaths, commands }
}

function packageScripts(manifest: PackageManifest): Record<string, unknown> | undefined {
  if (typeof manifest.scripts !== 'object' || manifest.scripts === null || Array.isArray(manifest.scripts)) return undefined
  return manifest.scripts as Record<string, unknown>
}

function packageManagerName(manifest: PackageManifest): string | undefined {
  if (typeof manifest.packageManager !== 'string') return undefined
  return manifest.packageManager.match(/^([^@]+)@/)?.[1]
}

function runGit(rootPath: string, args: string[]) {
  return spawnSync('git', args, {
    cwd: rootPath,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export function isSecurityBoundaryPath(changedPath: string): boolean {
  if (changedPath === 'server/scripts/check-threat-model.ts' || changedPath.startsWith('server/test/')) return false
  if (/^(?:server|shared|client)\//.test(changedPath)) return true
  if (changedPath === 'package.json' || changedPath === 'bun.lock' || /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(changedPath)) return true
  return changedPath.startsWith('patches/')
}

function packageOnlyAddsThreatModelGate(baseText: string, currentManifest: PackageManifest): boolean {
  let baseManifest: PackageManifest
  try {
    baseManifest = JSON.parse(baseText) as PackageManifest
  } catch {
    return false
  }
  const currentScripts = packageScripts(currentManifest)
  if (!currentScripts || currentScripts['threat-model:check'] !== THREAT_MODEL_SCRIPT) return false
  const currentStatic = currentScripts['ci:static']
  if (typeof currentStatic !== 'string') return false
  const marker = ` && ${THREAT_MODEL_CI_COMMAND}`
  if (!currentStatic.endsWith(marker) || currentStatic.slice(0, -marker.length).includes(THREAT_MODEL_CI_COMMAND)) return false

  const normalized = structuredClone(currentManifest)
  const normalizedScripts = packageScripts(normalized)
  if (!normalizedScripts) return false
  delete normalizedScripts['threat-model:check']
  normalizedScripts['ci:static'] = currentStatic.slice(0, -marker.length)
  return isDeepStrictEqual(baseManifest, normalized)
}

async function validateCitations(rootPath: string, citedPaths: string[], failures: string[]) {
  for (const citedPath of citedPaths) {
    const resolved = path.resolve(rootPath, citedPath)
    const relative = path.relative(rootPath, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      failures.push(`Cited path escapes the repository: ${citedPath}`)
      continue
    }
    try {
      await access(resolved)
    } catch {
      failures.push(`Cited path does not exist: ${citedPath}`)
    }
  }
}

export async function checkThreatModel(rootPath = process.cwd(), options: ThreatModelCheckOptions = {}): Promise<string[]> {
  const failures: string[] = []
  let manifest: PackageManifest
  let contract: ThreatModelContract
  try {
    contract = parseThreatModel(await readFile(path.join(rootPath, 'docs/security/threat-model.md'), 'utf8'))
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  try {
    manifest = JSON.parse(await readFile(path.join(rootPath, 'package.json'), 'utf8')) as PackageManifest
  } catch (error) {
    return [`Cannot read package.json: ${error instanceof Error ? error.message : String(error)}`]
  }
  if (options.release) {
    if (/^unassigned\b/i.test(contract.externalReviewer)) failures.push('External reviewer is unassigned; release publication is blocked')
    const releaseBlockers = contract.openFindings.filter(finding => finding.severity.toLowerCase() === 'release blocker')
    if (releaseBlockers.length > 0) failures.push(`Unresolved release blockers: ${releaseBlockers.map(finding => finding.id).join(', ')}`)
  }
  const manager = packageManagerName(manifest)
  if (manager !== 'bun') failures.push('packageManager must select a versioned Bun release')
  for (const command of contract.commands) {
    const prefix = command.split(/\s+/, 1)[0]
    if (prefix !== manager) failures.push(`Security command prefix does not match packageManager: ${command}`)
  }
  const scripts = packageScripts(manifest)
  if (!scripts) {
    failures.push('package.json scripts must be an object')
  } else {
    for (const command of contract.commands) {
      const scriptMatch = command.match(/^bun run ([A-Za-z0-9:_-]+)$/)
      if (scriptMatch && typeof scripts[scriptMatch[1] ?? ''] !== 'string') failures.push(`Referenced package script does not exist: ${scriptMatch[1]}`)
    }
    if (scripts['threat-model:check'] !== THREAT_MODEL_SCRIPT) failures.push(`package.json must define threat-model:check as ${THREAT_MODEL_SCRIPT}`)
    const ciStatic = scripts['ci:static']
    if (typeof ciStatic !== 'string' || !ciStatic.split(' && ').includes(THREAT_MODEL_CI_COMMAND)) {
      failures.push('ci:static must execute bun run threat-model:check')
    }
  }
  await validateCitations(rootPath, contract.citedPaths, failures)

  const exists = runGit(rootPath, ['cat-file', '-e', `${contract.reviewedRevision}^{commit}`])
  if (exists.status !== 0) {
    failures.push(`Reviewed revision does not exist in this repository: ${contract.reviewedRevision}`)
    return failures
  }
  const ancestor = runGit(rootPath, ['merge-base', '--is-ancestor', contract.reviewedRevision, 'HEAD'])
  if (ancestor.status !== 0) {
    failures.push(`Reviewed revision is not an ancestor of HEAD: ${contract.reviewedRevision}`)
    return failures
  }

  const changed = runGit(rootPath, ['diff', '--name-only', '--no-renames', '-z', contract.reviewedRevision, 'HEAD'])
  if (changed.status !== 0) {
    failures.push(`Cannot compare reviewed revision with HEAD: ${String(changed.stderr).trim()}`)
    return failures
  }
  const changedPaths = String(changed.stdout).split('\0').filter(Boolean)
  const boundaryChanges = changedPaths.filter(isSecurityBoundaryPath)
  const packageIndex = boundaryChanges.indexOf('package.json')
  if (packageIndex !== -1) {
    const basePackage = runGit(rootPath, ['show', `${contract.reviewedRevision}:package.json`])
    if (basePackage.status === 0 && packageOnlyAddsThreatModelGate(String(basePackage.stdout), manifest)) boundaryChanges.splice(packageIndex, 1)
  }
  if (boundaryChanges.length > 0) {
    failures.push(`Security-boundary source changed after the reviewed revision:\n- ${boundaryChanges.join('\n- ')}`)
  }
  return failures
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(argument => argument !== '--release') || args.length > 1) throw new Error('Usage: bun server/scripts/check-threat-model.ts [--release]')
  const release = args[0] === '--release'
  const failures = await checkThreatModel(process.cwd(), { release })
  if (failures.length > 0) throw new Error(`Threat-model contract failed:\n- ${failures.join('\n- ')}`)
  console.log(release ? 'Threat-model release state is valid' : 'Threat-model revision, evidence, and successor paths are valid')
}

if (import.meta.main) await main()
