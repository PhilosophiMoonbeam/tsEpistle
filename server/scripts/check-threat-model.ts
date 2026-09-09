import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

const REQUIRED_COMMANDS = [
  'bun run dependencies:check',
  'bun run licenses:check',
  'bun run test:security',
  'bun audit --production',
  'bun run typecheck:server'
] as const

const THREAT_MODEL_SCRIPT = 'bun server/scripts/check-threat-model.ts'
const THREAT_MODEL_CI_COMMAND = 'bun run threat-model:check'
const THREAT_MODEL_AUDIT_COMMAND = 'bun audit --production'

export const CANONICAL_REPOSITORY = 'PhilosophiMoonbeam/tsEpistle'
export const CANONICAL_FINGERPRINT_ALGORITHM = 'tsepistle-isolated-preview-v1'
export const SECURITY_BOUNDARY_DIGEST_PREFIX = 'tsepistle-security-boundary-v1\0'
export const CANONICAL_THREAT_MODEL_PATH = 'docs/security/threat-model.md'

export const CANONICAL_POLICY_V1_PREFIXES = ['server/', 'client/', 'shared/', 'deploy/', 'patches/', '.github/workflows/', '.github/actions/', 'dev/'] as const

export const CANONICAL_POLICY_V1_EXACT_FILES: Record<string, true> = {
  '.dockerignore': true,
  '.gitattributes': true,
  LICENSE: true,
  NOTICE: true,
  'package.json': true,
  'bun.lock': true,
  'bunfig.toml': true,
  'biome.json': true,
  'config.sample.yml': true,
  'license-policy.json': true,
  'playwright.config.ts': true,
  'vite.config.mts': true
}

/**
 * Canonical exact ignored file path permitted as a generated build artifact.
 * Only `server/.build-metadata.json` may be excluded from ignored-boundary drift,
 * because `server/scripts/generate-build-metadata.ts` deterministically overwrites it
 * during supported builds and it remains separately governed by build provenance.
 * If it ever becomes tracked it remains in the covered-tree digest.
 * Every other ignored file under canonical boundary must still fail.
 */
export const CANONICAL_IGNORED_BUILD_METADATA_PATH = 'server/.build-metadata.json'

export type PackageManifest = {
  packageManager?: unknown
  scripts?: unknown
  [key: string]: unknown
}

export type FindingDisposition = 'blocking' | 'accepted' | 'resolved'

export type ReviewFinding = {
  id: string
  severity: string
  disposition: FindingDisposition
  evidencePaths: string[]
}

export type ReviewerInfo = {
  identity: string
  reviewedAt: string
}

export type SourceReviewSource = {
  revision: string
  baseRevision: string
  coveredTreeDigest: string
}

export type WorkingTreeAuditSource = {
  baseRevision: string
  fingerprint: string
  fingerprintAlgorithm: string
}


export type BaseReviewRecord = {
  schemaVersion: 2
  id: string
  kind: 'source-review' | 'working-tree-audit'
  repository: string
  policyVersion: 1
  threatModelDigest: string
  reviewer: ReviewerInfo
  releaseEligible: boolean
  findings: ReviewFinding[]
  evidencePaths: string[]
}

export type SourceReviewRecord = BaseReviewRecord & {
  kind: 'source-review'
  source: SourceReviewSource
}

export type WorkingTreeAuditRecord = BaseReviewRecord & {
  kind: 'working-tree-audit'
  source: WorkingTreeAuditSource
}

export type ReviewRecord = SourceReviewRecord | WorkingTreeAuditRecord

export type ReviewAttestationsManifest = {
  schemaVersion: 2
  policyVersion: 1
  threatModelPath: string
  activeReviewId: string
  records: Array<{
    id: string
    path: string
  }>
}

export type ThreatModelContract = {
  modelVersion: number
  commands: string[]
  citedPaths: string[]
}

export type ThreatModelCheckOptions = {
  release?: boolean
}


function runGit(rootPath: string, args: string[]) {
  return spawnSync('git', args, {
    cwd: rootPath,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function unsupportedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed)
  return Object.keys(value).filter(key => !allowedSet.has(key))
}

export function isSecurityBoundaryPath(changedPath: string): boolean {
  const normalized = changedPath.replace(/^[.][/]/, '').replaceAll('\\', '/')
  if (CANONICAL_POLICY_V1_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return true
  }
  if (CANONICAL_POLICY_V1_EXACT_FILES[normalized]) {
    return true
  }
  if (/^tsconfig(?:[^/]*)\.json$/.test(normalized)) {
    return true
  }
  return false
}

export function computeCoveredTreeDigest(rootPath: string, revision = 'HEAD'): string {
  const git = runGit(rootPath, ['ls-tree', '-r', '-z', revision])
  if (git.status !== 0) {
    throw new Error(`Cannot list Git tree for revision ${revision}: ${String(git.stderr).trim()}`)
  }
  const entries: Array<{ path: string; mode: string; type: string; objectId: string }> = []
  const tokens = String(git.stdout).split('\0').filter(Boolean)
  for (const token of tokens) {
    const tabIndex = token.indexOf('\t')
    if (tabIndex === -1) continue
    const meta = token.slice(0, tabIndex)
    const filePath = token.slice(tabIndex + 1)
    const [mode, type, objectId] = meta.split(' ')
    if (type !== 'tree' && isSecurityBoundaryPath(filePath)) {
      entries.push({ path: filePath, mode: mode ?? '', type: type ?? '', objectId: objectId ?? '' })
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash('sha256')
  hash.update(SECURITY_BOUNDARY_DIGEST_PREFIX)
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.mode}\0${entry.type}\0${entry.objectId}\0`)
  }
  return hash.digest('hex')
}

export function computeThreatModelDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}


export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const maxDays = daysInMonth[month - 1]!
  return day >= 1 && day <= maxDays
}

export function isValidIsoTimestamp(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value
}


function isRepoRelativePath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return false
  if (path.isAbsolute(relativePath)) return false
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) return false
  const normalized = path.normalize(relativePath)
  return !normalized.startsWith('..') && !path.isAbsolute(normalized)
}

async function checkRealpathContained(realRoot: string, resolvedPath: string, relativePath: string, label: string): Promise<string | null> {
  try {
    const realTarget = await realpath(resolvedPath)
    const relReal = path.relative(realRoot, realTarget)
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      return `${label} escapes repository via symlink: ${relativePath}`
    }
    return null
  } catch {
    // Target does not exist; check nearest existing ancestor directory
    let current = path.dirname(resolvedPath)
    while (current !== path.dirname(current)) {
      try {
        const realParent = await realpath(current)
        const relParent = path.relative(realRoot, realParent)
        if (relParent.startsWith('..') || path.isAbsolute(relParent)) {
          return `${label} escapes repository via parent symlink: ${relativePath}`
        }
        break
      } catch {
        current = path.dirname(current)
      }
    }
    return null
  }
}

async function checkRegularFile(resolvedPath: string, relativePath: string, label: string): Promise<string | null> {
  try {
    const st = await lstat(resolvedPath)
    if (st.isSymbolicLink()) {
      return `${label} must not be a symbolic link: ${relativePath}`
    }
    if (!st.isFile()) {
      return `${label} must be a regular file: ${relativePath}`
    }
  } catch (error) {
    return `${label} could not be inspected: ${relativePath}${error instanceof Error ? `: ${error.message}` : `: ${String(error)}`}`
  }
  return null
}

type ContainedPathPolicy = 'existing-path' | 'regular-file'

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

type MarkdownSection = {
  heading: string
  lines: string[]
}

function parseSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n')
  let inCode = false
  let fenceChar = ''
  let fenceLen = 0

  const sections: MarkdownSection[] = []
  let currentHeading: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/)
    const fence = fenceMatch?.[1]
    if (!inCode) {
      if (fence) {
        const char = fence.charAt(0)
        if (char === '`' || char === '~') {
          inCode = true
          fenceChar = char
          fenceLen = fence.length
        }
      } else {
        const headingMatch = line.match(/^##\s+([^\n]+)$/)
        const rawHeading = headingMatch?.[1]
        if (rawHeading !== undefined) {
          const heading = rawHeading.trim()
          if (heading.length > 0) {
            if (currentHeading !== null) {
              sections.push({ heading: currentHeading, lines: currentLines })
            }
            currentHeading = heading
            currentLines = []
            continue
          }
        }
      }
    } else {
      const closeMatch = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/)
      const closeFence = closeMatch?.[1]
      if (closeFence && fenceChar !== '' && closeFence.charAt(0) === fenceChar && closeFence.length >= fenceLen) {
        inCode = false
      }
    }
    if (currentHeading !== null) {
      currentLines.push(line)
    }
  }
  if (currentHeading !== null) {
    sections.push({ heading: currentHeading, lines: currentLines })
  }
  return sections
}

function extractGateCommandsFromSection(lines: string[]): string[] {
  const consoleBlocks: string[][] = []
  let activeFence: { char: string; length: number; console: boolean; lines: string[] } | undefined

  for (const line of lines) {
    if (!activeFence) {
      const opening = /^[ \t]*(`{3,}|~{3,})([^`]*)$/.exec(line)
      const marker = opening?.[1]
      if (!marker) continue
      activeFence = {
        char: marker.charAt(0),
        length: marker.length,
        console: (opening?.[2] ?? '').trim() === 'console',
        lines: []
      }
      continue
    }

    const closing = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1]
    if (closing && closing.charAt(0) === activeFence.char && closing.length >= activeFence.length) {
      if (activeFence.console) consoleBlocks.push(activeFence.lines)
      activeFence = undefined
      continue
    }
    if (activeFence.console) activeFence.lines.push(line)
  }

  if (consoleBlocks.length !== 1) throw new Error('Executable security gate must contain exactly one console command block')
  return consoleBlocks[0]!.map(line => line.trim()).filter(Boolean)
}

function extractTableRowsFromSection(lines: string[], heading: string, expectedHeaders: string[]): string[][] {
  let inCode = false
  let fenceChar = ''
  let fenceLen = 0
  const nonCodeLines: string[] = []

  for (const line of lines) {
    const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/)
    const fence = fenceMatch?.[1]
    if (!inCode) {
      if (fence) {
        const char = fence.charAt(0)
        if (char === '`' || char === '~') {
          inCode = true
          fenceChar = char
          fenceLen = fence.length
        }
      } else {
        nonCodeLines.push(line)
      }
    } else {
      const closeMatch = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/)
      const closeFence = closeMatch?.[1]
      if (closeFence && fenceChar !== '' && closeFence.charAt(0) === fenceChar && closeFence.length >= fenceLen) {
        inCode = false
      }
    }
  }

  const text = nonCodeLines.join('\n')
  const tableBlocks = [...text.matchAll(/(?:^|\n)((?:\|[^\n]*\|[ \t]*(?:\n|$))+)/g)]
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

export function parseThreatModel(markdown: string): ThreatModelContract {
  if (/\bpnpm\b|pnpm-lock\.yaml|package-lock\.json|yarn\.lock/.test(markdown)) {
    throw new Error('Threat model dependency evidence must use Bun and bun.lock exclusively')
  }

  const sections = parseSections(markdown)
  const statusSections = sections.filter(s => s.heading === 'Status and review contract')
  if (statusSections.length === 0) {
    throw new Error('Threat model must contain a Status and review contract section')
  }
  if (statusSections.length > 1) {
    throw new Error('Threat model contains duplicate Status and review contract sections')
  }

  const gateSections = sections.filter(s => s.heading === 'Executable security gate')
  if (gateSections.length === 0) {
    throw new Error('Threat model must contain an Executable security gate section')
  }
  if (gateSections.length > 1) {
    throw new Error('Threat model contains duplicate Executable security gate sections')
  }

  const statusRows = extractTableRowsFromSection(statusSections[0]?.lines ?? [], 'Status and review contract', ['Field', 'Value'])
  const status = new Map<string, string>()
  for (const [field = '', value = ''] of statusRows) {
    if (status.has(field)) throw new Error(`Status and review contract contains duplicate field: ${field}`)
    status.set(field, value)
  }

  const modelVersionValue = status.get('Model version')
  if (!modelVersionValue) throw new Error('Threat model must declare a Model version')
  if (!/^[1-9][0-9]*$/.test(modelVersionValue.trim())) {
    throw new Error(`Model version must be a positive integer: ${modelVersionValue}`)
  }
  const modelVersion = Number.parseInt(modelVersionValue.trim(), 10)
  if (modelVersion !== 1) {
    throw new Error(`Unsupported model version: expected 1, received ${modelVersion}`)
  }

  const commands = extractGateCommandsFromSection(gateSections[0]?.lines ?? [])
  for (const requiredCommand of REQUIRED_COMMANDS) {
    if (!commands.includes(requiredCommand)) throw new Error(`Executable security gate is missing command: ${requiredCommand}`)
  }
  const citedPaths = extractRepositoryCitations(markdown)
  if (!citedPaths.includes('bun.lock')) throw new Error('Threat model must cite bun.lock as frozen dependency evidence')

  return { modelVersion, commands, citedPaths }
}

function packageScripts(manifest: PackageManifest): Record<string, unknown> | undefined {
  if (typeof manifest.scripts !== 'object' || manifest.scripts === null || Array.isArray(manifest.scripts)) return undefined
  return manifest.scripts as Record<string, unknown>
}

function packageManagerName(manifest: PackageManifest): string | undefined {
  if (typeof manifest.packageManager !== 'string') return undefined
  return manifest.packageManager.match(/^([^@]+)@/)?.[1]
}

async function validateContainedPaths(
  rootPath: string,
  realRoot: string,
  paths: string[],
  label: string,
  policy: ContainedPathPolicy,
  failures: string[]
) {
  for (const p of paths) {
    if (!isRepoRelativePath(p)) {
      failures.push(`${label} escapes repository: ${p}`)
      continue
    }
    const resolved = path.resolve(rootPath, p)
    const escapeError = await checkRealpathContained(realRoot, resolved, p, label)
    if (escapeError) {
      failures.push(escapeError)
      continue
    }
    if (policy === 'regular-file') {
      const fileError = await checkRegularFile(resolved, p, label)
      if (fileError) {
        failures.push(fileError)
      }
      continue
    }
    try {
      await access(resolved)
    } catch {
      failures.push(`${label} does not exist: ${p}`)
    }
  }
}

export async function checkThreatModel(rootPath = process.cwd(), options: ThreatModelCheckOptions = {}): Promise<string[]> {
  const failures: string[] = []

  let realRoot: string
  try {
    realRoot = await realpath(rootPath)
  } catch (error) {
    return [`Cannot resolve repository root realpath: ${error instanceof Error ? error.message : String(error)}`]
  }

  const manifestRel = 'docs/security/review-attestations.json'
  const manifestPath = path.resolve(rootPath, manifestRel)

  const manifestFileErr = await checkRegularFile(manifestPath, manifestRel, 'Manifest file')
  if (manifestFileErr) {
    failures.push(manifestFileErr)
    return failures
  }

  const manifestEscapeErr = await checkRealpathContained(realRoot, manifestPath, manifestRel, 'Manifest file')
  if (manifestEscapeErr) {
    failures.push(manifestEscapeErr)
    return failures
  }

  let manifestRaw: string
  try {
    manifestRaw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    return [`Cannot read review attestations manifest: ${error instanceof Error ? error.message : String(error)}`]
  }

  let manifestParsed: unknown
  try {
    manifestParsed = JSON.parse(manifestRaw)
  } catch (error) {
    return [`Malformed review attestations manifest JSON: ${error instanceof Error ? error.message : String(error)}`]
  }

  if (!isPlainObject(manifestParsed)) {
    return ['Manifest must be a JSON object']
  }

  if (manifestParsed.schemaVersion !== 2) {
    failures.push(`Unsupported manifest schemaVersion: expected 2, received ${String(manifestParsed.schemaVersion)}`)
  }
  if (manifestParsed.policyVersion !== 1) {
    failures.push(`Unsupported manifest policyVersion: expected 1, received ${String(manifestParsed.policyVersion)}`)
  }
  const manifestExtraKeys = unsupportedKeys(manifestParsed, ['schemaVersion', 'policyVersion', 'threatModelPath', 'activeReviewId', 'records'])
  if (manifestExtraKeys.length > 0) {
    failures.push(`Manifest contains unsupported fields: ${manifestExtraKeys.join(', ')}`)
  }

  if (typeof manifestParsed.threatModelPath !== 'string' || !manifestParsed.threatModelPath.trim()) {
    failures.push('Manifest threatModelPath must be a non-empty string')
  } else {
    if (!isRepoRelativePath(manifestParsed.threatModelPath)) {
      failures.push(`Manifest threatModelPath escapes repository: ${manifestParsed.threatModelPath}`)
    }
    if (manifestParsed.threatModelPath !== CANONICAL_THREAT_MODEL_PATH) {
      failures.push(`Manifest threatModelPath must be canonical literal "${CANONICAL_THREAT_MODEL_PATH}", received: ${manifestParsed.threatModelPath}`)
    }
  }

  if (typeof manifestParsed.activeReviewId !== 'string' || !manifestParsed.activeReviewId.trim()) {
    failures.push('Manifest activeReviewId must be a non-empty string')
  } else if (manifestParsed.activeReviewId !== manifestParsed.activeReviewId.trim()) {
    failures.push('Manifest activeReviewId must not contain leading or trailing whitespace')
  }
  if (!Array.isArray(manifestParsed.records) || manifestParsed.records.length === 0) {
    failures.push('Manifest records must be a non-empty array')
    return failures
  }

  const manifestThreatModelPath = typeof manifestParsed.threatModelPath === 'string' ? manifestParsed.threatModelPath.trim() : ''
  const manifestActiveReviewId = typeof manifestParsed.activeReviewId === 'string' ? manifestParsed.activeReviewId.trim() : ''

  const recordIds = new Set<string>()
  const recordPaths = new Set<string>()
  const validRecordRefs: Array<{ id: string; path: string }> = []

  for (let idx = 0; idx < manifestParsed.records.length; idx++) {
    const recordRef = manifestParsed.records[idx]
    if (!isPlainObject(recordRef)) {
      failures.push(`Manifest record reference at index ${idx} must be an object`)
      continue
    }
    const recordRefExtraKeys = unsupportedKeys(recordRef, ['id', 'path'])
    if (recordRefExtraKeys.length > 0) {
      failures.push(`Manifest record reference contains unsupported fields: ${recordRefExtraKeys.join(', ')}`)
    }
    if (typeof recordRef.id !== 'string' || !recordRef.id.trim()) {
      failures.push(`Manifest record reference id at index ${idx} must be a non-empty string`)
      continue
    }
    const normalizedId = recordRef.id.trim()
    if (recordRef.id !== normalizedId) {
      failures.push(`Manifest record reference id at index ${idx} must not contain leading or trailing whitespace`)
    }
    if (recordIds.has(normalizedId)) {
      failures.push(`Duplicate record ID in manifest: ${normalizedId}`)
    }
    recordIds.add(normalizedId)

    if (typeof recordRef.path !== 'string' || !recordRef.path.trim()) {
      failures.push(`Manifest record reference path must be a non-empty string for id: ${normalizedId}`)
      continue
    }
    const normalizedPath = recordRef.path.trim()
    if (recordRef.path !== normalizedPath) {
      failures.push(`Manifest record reference path must not contain leading or trailing whitespace for id: ${normalizedId}`)
    }
    if (!isRepoRelativePath(normalizedPath)) {
      failures.push(`Manifest record path escapes repository: ${normalizedPath}`)
      continue
    }
    if (recordPaths.has(normalizedPath)) {
      failures.push(`Duplicate record path in manifest: ${normalizedPath}`)
    }
    recordPaths.add(normalizedPath)
    validRecordRefs.push({ id: normalizedId, path: normalizedPath })
  }

  if (manifestActiveReviewId && !recordIds.has(manifestActiveReviewId)) {
    failures.push(`Active review ID "${manifestActiveReviewId}" is not present in manifest records`)
  }

  let threatModelRaw: string | undefined
  if (manifestThreatModelPath === CANONICAL_THREAT_MODEL_PATH && isRepoRelativePath(manifestThreatModelPath)) {
    const resolvedThreatModel = path.resolve(rootPath, manifestThreatModelPath)
    const tmFileErr = await checkRegularFile(resolvedThreatModel, manifestThreatModelPath, 'Threat model file')
    if (tmFileErr) {
      failures.push(tmFileErr)
    } else {
      const tmEscapeErr = await checkRealpathContained(realRoot, resolvedThreatModel, manifestThreatModelPath, 'Threat model file')
      if (tmEscapeErr) {
        failures.push(tmEscapeErr)
      } else {
        try {
          threatModelRaw = await readFile(resolvedThreatModel, 'utf8')
        } catch (error) {
          failures.push(`Cannot read threat model at ${manifestThreatModelPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  let threatModelContract: ThreatModelContract | undefined
  if (threatModelRaw !== undefined) {
    try {
      threatModelContract = parseThreatModel(threatModelRaw)
    } catch (error) {
      failures.push(`Threat model parsing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const recordsById = new Map<string, ReviewRecord>()

  for (const recordRef of validRecordRefs) {
    const resolvedRecordPath = path.resolve(rootPath, recordRef.path)
    const recFileErr = await checkRegularFile(resolvedRecordPath, recordRef.path, 'Record file')
    if (recFileErr) {
      failures.push(recFileErr)
      continue
    }
    const recEscapeErr = await checkRealpathContained(realRoot, resolvedRecordPath, recordRef.path, 'Record file')
    if (recEscapeErr) {
      failures.push(recEscapeErr)
      continue
    }

    let recordContent = ''
    try {
      recordContent = await readFile(resolvedRecordPath, 'utf8')
    } catch (error) {
      failures.push(`Cannot read review record at ${recordRef.path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    let recordRaw: unknown
    try {
      recordRaw = JSON.parse(recordContent)
    } catch (error) {
      failures.push(`Malformed review record JSON at ${recordRef.path}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    if (!isPlainObject(recordRaw)) {
      failures.push(`Record ${recordRef.id} must be a JSON object`)
      continue
    }

    let hasRecordStructuralError = false

    if (recordRaw.schemaVersion !== 2) {
      failures.push(`Record ${recordRef.id} has unsupported schemaVersion: ${String(recordRaw.schemaVersion)}`)
      hasRecordStructuralError = true
    }
    const recordExtraKeys = unsupportedKeys(recordRaw, [
      'schemaVersion',
      'id',
      'kind',
      'repository',
      'policyVersion',
      'threatModelDigest',
      'reviewer',
      'releaseEligible',
      'findings',
      'evidencePaths',
      'source'
    ])
    if (recordExtraKeys.length > 0) {
      failures.push(`Record ${recordRef.id} contains unsupported fields: ${recordExtraKeys.join(', ')}`)
      hasRecordStructuralError = true
    }
    if (recordRaw.id !== recordRef.id) {
      failures.push(`Record file ${recordRef.path} ID "${String(recordRaw.id)}" does not match manifest ID "${recordRef.id}"`)
      hasRecordStructuralError = true
    }
    if (recordRaw.repository !== CANONICAL_REPOSITORY) {
      failures.push(`Record ${recordRef.id} repository must be "${CANONICAL_REPOSITORY}", received: ${String(recordRaw.repository)}`)
      hasRecordStructuralError = true
    }
    if (recordRaw.policyVersion !== 1) {
      failures.push(`Record ${recordRef.id} has unsupported policyVersion: ${String(recordRaw.policyVersion)}`)
      hasRecordStructuralError = true
    }
    if (typeof recordRaw.threatModelDigest !== 'string' || !DIGEST_PATTERN.test(recordRaw.threatModelDigest)) {
      failures.push(`Record ${recordRef.id} threatModelDigest must be a 64-character lowercase SHA-256 hex string`)
      hasRecordStructuralError = true
    }

    const recordKind = recordRaw.kind
    if (recordKind !== 'source-review' && recordKind !== 'working-tree-audit') {
      failures.push(`Record ${recordRef.id} has invalid kind: ${String(recordKind)}`)
      hasRecordStructuralError = true
    }

    if (!isPlainObject(recordRaw.reviewer)) {
      failures.push(`Record ${recordRef.id} must declare reviewer object`)
      hasRecordStructuralError = true
    } else {
      const reviewerExtraKeys = unsupportedKeys(recordRaw.reviewer, ['identity', 'reviewedAt'])
      if (reviewerExtraKeys.length > 0) {
        failures.push(`Record ${recordRef.id} reviewer contains unsupported fields: ${reviewerExtraKeys.join(', ')}`)
        hasRecordStructuralError = true
      }
      if (typeof recordRaw.reviewer.identity !== 'string' || !recordRaw.reviewer.identity.trim()) {
        failures.push(`Record ${recordRef.id} reviewer must have non-empty identity`)
        hasRecordStructuralError = true
      }
      if (typeof recordRaw.reviewer.reviewedAt !== 'string' || !recordRaw.reviewer.reviewedAt.trim()) {
        failures.push(`Record ${recordRef.id} reviewer must have non-empty reviewedAt`)
        hasRecordStructuralError = true
      } else {
        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(recordRaw.reviewer.reviewedAt)
        if (!dateMatch) {
          failures.push(`Record ${recordRef.id} reviewer.reviewedAt must be an exact YYYY-MM-DD date, received: "${recordRaw.reviewer.reviewedAt}"`)
          hasRecordStructuralError = true
        } else {
          const year = parseInt(dateMatch[1]!, 10)
          const month = parseInt(dateMatch[2]!, 10)
          const day = parseInt(dateMatch[3]!, 10)
          if (!isValidCalendarDate(year, month, day)) {
            failures.push(`Record ${recordRef.id} reviewer.reviewedAt is not a valid calendar date: "${recordRaw.reviewer.reviewedAt}"`)
            hasRecordStructuralError = true
          }
        }
      }
    }

    if (typeof recordRaw.releaseEligible !== 'boolean') {
      failures.push(`Record ${recordRef.id} releaseEligible must be a boolean`)
      hasRecordStructuralError = true
    }

    const parsedFindings: ReviewFinding[] = []
    if (!Array.isArray(recordRaw.findings)) {
      failures.push(`Record ${recordRef.id} findings must be an array`)
      hasRecordStructuralError = true
    } else {
      const findingIds = new Set<string>()
      for (let fIdx = 0; fIdx < recordRaw.findings.length; fIdx++) {
        const finding = recordRaw.findings[fIdx]
        if (!isPlainObject(finding)) {
          failures.push(`Record ${recordRef.id} finding at index ${fIdx} must be an object`)
          hasRecordStructuralError = true
          continue
        }
        const findingExtraKeys = unsupportedKeys(finding, ['id', 'severity', 'disposition', 'evidencePaths'])
        if (findingExtraKeys.length > 0) {
          failures.push(`Record ${recordRef.id} finding at index ${fIdx} contains unsupported fields: ${findingExtraKeys.join(', ')}`)
          hasRecordStructuralError = true
        }
        if (typeof finding.id !== 'string' || !finding.id.trim()) {
          failures.push(`Record ${recordRef.id} finding at index ${fIdx} id must be a non-empty string`)
          hasRecordStructuralError = true
        } else {
          if (findingIds.has(finding.id)) {
            failures.push(`Record ${recordRef.id} contains duplicate finding ID: ${finding.id}`)
            hasRecordStructuralError = true
          }
          findingIds.add(finding.id)
        }
        if (typeof finding.severity !== 'string' || !finding.severity.trim()) {
          failures.push(`Record ${recordRef.id} finding ${String(finding.id)} must declare severity`)
          hasRecordStructuralError = true
        }
        if (finding.disposition !== 'blocking' && finding.disposition !== 'accepted' && finding.disposition !== 'resolved') {
          failures.push(
            `Record ${recordRef.id} finding ${String(finding.id)} disposition must be blocking, accepted, or resolved; received: ${String(finding.disposition)}`
          )
          hasRecordStructuralError = true
        }
        if (!Array.isArray(finding.evidencePaths)) {
          failures.push(`Record ${recordRef.id} finding ${String(finding.id)} evidencePaths must be an array`)
          hasRecordStructuralError = true
        } else {
          for (let epIdx = 0; epIdx < finding.evidencePaths.length; epIdx++) {
            const ep = finding.evidencePaths[epIdx]
            if (typeof ep !== 'string' || !ep.trim()) {
              failures.push(`Record ${recordRef.id} finding ${String(finding.id)} evidencePaths[${epIdx}] must be a non-empty string`)
              hasRecordStructuralError = true
            }
          }
        }
        parsedFindings.push({
          id: String(finding.id ?? ''),
          severity: String(finding.severity ?? ''),
          disposition: (finding.disposition ?? 'blocking') as FindingDisposition,
          evidencePaths: Array.isArray(finding.evidencePaths) ? (finding.evidencePaths as string[]) : []
        })
      }
    }

    if (!Array.isArray(recordRaw.evidencePaths)) {
      failures.push(`Record ${recordRef.id} evidencePaths must be an array`)
      hasRecordStructuralError = true
    } else {
      for (let epIdx = 0; epIdx < recordRaw.evidencePaths.length; epIdx++) {
        const ep = recordRaw.evidencePaths[epIdx]
        if (typeof ep !== 'string' || !ep.trim()) {
          failures.push(`Record ${recordRef.id} evidencePaths[${epIdx}] must be a non-empty string`)
          hasRecordStructuralError = true
        }
      }
    }

    if (recordKind === 'source-review') {
      const src = recordRaw.source
      if (!isPlainObject(src)) {
        failures.push(`Record ${recordRef.id} source-review must have source object`)
        hasRecordStructuralError = true
      } else {
        const sourceExtraKeys = unsupportedKeys(src, ['revision', 'baseRevision', 'coveredTreeDigest'])
        if (sourceExtraKeys.length > 0) {
          failures.push(`Record ${recordRef.id} source contains unsupported fields: ${sourceExtraKeys.join(', ')}`)
          hasRecordStructuralError = true
        }
        if (typeof src.revision !== 'string' || !FULL_SHA_PATTERN.test(src.revision)) {
          failures.push(`Record ${recordRef.id} source.revision must be a 40-character lowercase hex Git commit`)
          hasRecordStructuralError = true
        }
        if (typeof src.baseRevision !== 'string' || !FULL_SHA_PATTERN.test(src.baseRevision)) {
          failures.push(`Record ${recordRef.id} source.baseRevision must be a 40-character lowercase hex Git commit`)
          hasRecordStructuralError = true
        }
        if (typeof src.coveredTreeDigest !== 'string' || !DIGEST_PATTERN.test(src.coveredTreeDigest)) {
          failures.push(`Record ${recordRef.id} source.coveredTreeDigest must be a 64-character lowercase hex SHA-256`)
          hasRecordStructuralError = true
        }
      }
    } else if (recordKind === 'working-tree-audit') {
      if (recordRaw.releaseEligible !== false) {
        failures.push(`Working-tree-audit record ${recordRef.id} must declare releaseEligible as false`)
        hasRecordStructuralError = true
      }
      const src = recordRaw.source
      if (!isPlainObject(src)) {
        failures.push(`Record ${recordRef.id} working-tree-audit must have source object`)
        hasRecordStructuralError = true
      } else {
        const sourceExtraKeys = unsupportedKeys(src, ['baseRevision', 'fingerprint', 'fingerprintAlgorithm'])
        if (sourceExtraKeys.length > 0) {
          failures.push(`Record ${recordRef.id} source contains unsupported fields: ${sourceExtraKeys.join(', ')}`)
          hasRecordStructuralError = true
        }
        if (typeof src.baseRevision !== 'string' || !FULL_SHA_PATTERN.test(src.baseRevision)) {
          failures.push(`Record ${recordRef.id} source.baseRevision must be a 40-character lowercase hex Git commit`)
          hasRecordStructuralError = true
        }
        if (typeof src.fingerprint !== 'string' || !src.fingerprint.trim()) {
          failures.push(`Record ${recordRef.id} source.fingerprint must be a non-empty string`)
          hasRecordStructuralError = true
        }
        if (src.fingerprintAlgorithm !== CANONICAL_FINGERPRINT_ALGORITHM) {
          failures.push(
            `Working-tree-audit record ${recordRef.id} source.fingerprintAlgorithm must be "${CANONICAL_FINGERPRINT_ALGORITHM}", received: ${String(src.fingerprintAlgorithm)}`
          )
          hasRecordStructuralError = true
        }
      }
    }
    if (!hasRecordStructuralError) {
      recordsById.set(recordRef.id, recordRaw as unknown as ReviewRecord)
    }
  }

  const activeRecord = recordsById.get(manifestActiveReviewId)
  if (!activeRecord) {
    failures.push(`Active review record "${manifestActiveReviewId}" could not be loaded`)
    return failures
  }

  if (activeRecord.kind !== 'source-review') {
    failures.push(`Active review record must have kind "source-review", found: "${activeRecord.kind}"`)
    return failures
  }
  if (activeRecord.evidencePaths.length === 0) {
    failures.push('Active review record must declare at least one evidence path')
  }
  for (const finding of activeRecord.findings) {
    if (finding.evidencePaths.length === 0) {
      failures.push(`Active finding ${finding.id} must declare at least one evidence path`)
    }
  }

  if (threatModelRaw !== undefined) {
    const computedDigest = computeThreatModelDigest(threatModelRaw)
    if (activeRecord.threatModelDigest !== computedDigest) {
      failures.push(`Threat-model content digest does not match active review record: expected ${activeRecord.threatModelDigest}, computed ${computedDigest}`)
    }
  }

  if (threatModelContract) {
    await validateContainedPaths(rootPath, realRoot, threatModelContract.citedPaths, 'Cited path', 'existing-path', failures)
  }

  await validateContainedPaths(rootPath, realRoot, activeRecord.evidencePaths, 'Active record evidence path', 'regular-file', failures)
  for (const finding of activeRecord.findings) {
    await validateContainedPaths(rootPath, realRoot, finding.evidencePaths, `Finding ${finding.id} evidence path`, 'regular-file', failures)
  }

  let packageManifest: PackageManifest | undefined
  try {
    packageManifest = JSON.parse(await readFile(path.join(rootPath, 'package.json'), 'utf8')) as PackageManifest
  } catch (error) {
    failures.push(`Cannot read package.json: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (packageManifest && threatModelContract) {
    const manager = packageManagerName(packageManifest)
    if (manager !== 'bun') {
      failures.push('packageManager must select a versioned Bun release')
    }
    for (const command of threatModelContract.commands) {
      const prefix = command.split(/\s+/, 1)[0]
      if (prefix !== manager) {
        failures.push(`Security command prefix does not match packageManager: ${command}`)
      }
    }
    const scripts = packageScripts(packageManifest)
    if (!scripts) {
      failures.push('package.json scripts must be an object')
    } else {
      for (const command of threatModelContract.commands) {
        const scriptMatch = command.match(/^bun run ([A-Za-z0-9:_-]+)$/)
        if (scriptMatch && typeof scripts[scriptMatch[1] ?? ''] !== 'string') {
          failures.push(`Referenced package script does not exist: ${scriptMatch[1]}`)
        }
      }
      if (scripts['threat-model:check'] !== THREAT_MODEL_SCRIPT) {
        failures.push(`package.json must define threat-model:check as ${THREAT_MODEL_SCRIPT}`)
      }
      const ciStatic = scripts['ci:static']
      if (typeof ciStatic !== 'string') {
        failures.push('ci:static must be a canonical && command chain')
      } else {
        const chain = ciStatic.split(' && ')
        const dependencyCheckIndex = chain.indexOf('bun run dependencies:check')
        const licenseCheckIndex = chain.indexOf('bun run licenses:check')
        const auditIndex = chain.indexOf(THREAT_MODEL_AUDIT_COMMAND)
        const threatModelIndex = chain.indexOf(THREAT_MODEL_CI_COMMAND)
        const hasSuppressedFailure = /\|\|/.test(ciStatic) || /(^|[^&])&([^&]|$)/.test(ciStatic)

        if (threatModelIndex === -1) {
          failures.push('ci:static must execute bun run threat-model:check as an exact && segment')
        }
        if (
          auditIndex === -1 ||
          hasSuppressedFailure ||
          dependencyCheckIndex === -1 ||
          licenseCheckIndex === -1 ||
          auditIndex <= dependencyCheckIndex ||
          auditIndex <= licenseCheckIndex ||
          (threatModelIndex !== -1 && auditIndex >= threatModelIndex)
        ) {
          failures.push(
            'ci:static must execute exact unconditional bun audit --production after dependencies:check and licenses:check and before threat-model:check'
          )
        }
      }
    }
  }

  const { revision, baseRevision, coveredTreeDigest } = activeRecord.source

  const exists = runGit(rootPath, ['cat-file', '-e', `${revision}^{commit}`])
  if (exists.status !== 0) {
    failures.push(`Reviewed revision does not exist in this repository: ${revision}`)
    return failures
  }

  const baseExists = runGit(rootPath, ['cat-file', '-e', `${baseRevision}^{commit}`])
  if (baseExists.status !== 0) {
    failures.push(`Base revision does not exist in this repository: ${baseRevision}`)
    return failures
  }

  const baseAncestor = runGit(rootPath, ['merge-base', '--is-ancestor', baseRevision, revision])
  if (baseAncestor.status !== 0) {
    failures.push(`Base revision is not an ancestor of reviewed revision: ${baseRevision}`)
    return failures
  }

  const ancestor = runGit(rootPath, ['merge-base', '--is-ancestor', revision, 'HEAD'])
  if (ancestor.status !== 0) {
    failures.push(`Reviewed revision is not an ancestor of HEAD: ${revision}`)
    return failures
  }

  let revisionComputedDigest = ''
  try {
    revisionComputedDigest = computeCoveredTreeDigest(rootPath, revision)
  } catch (error) {
    failures.push(`Failed to compute covered-tree digest for reviewed revision ${revision}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (revisionComputedDigest && revisionComputedDigest !== coveredTreeDigest) {
    failures.push(
      `Active review record coveredTreeDigest does not match reviewed revision tree: declared ${coveredTreeDigest}, computed ${revisionComputedDigest}`
    )
  }

  const revisionDiff = runGit(rootPath, ['diff', '--name-only', '--no-renames', '-z', '--ignore-submodules=none', revision, 'HEAD'])
  if (revisionDiff.status !== 0) {
    failures.push(`Git diff between reviewed revision ${revision} and HEAD failed: ${String(revisionDiff.stderr).trim()}`)
  } else {
    const boundaryChanges = String(revisionDiff.stdout).split('\0').filter(Boolean).filter(isSecurityBoundaryPath)
    if (boundaryChanges.length > 0) {
      failures.push(`Security-boundary source changed after the reviewed revision:\n- ${boundaryChanges.join('\n- ')}`)
    }
  }

  let headDigest = ''
  try {
    headDigest = computeCoveredTreeDigest(rootPath, 'HEAD')
  } catch (error) {
    failures.push(`Failed to compute covered-tree digest for HEAD: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (headDigest && headDigest !== coveredTreeDigest) {
    failures.push(`Covered-tree digest of HEAD does not match active review record: expected ${coveredTreeDigest}, computed ${headDigest}`)
  }

  const stagedRaw = runGit(rootPath, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--ignore-submodules=none'])
  if (stagedRaw.status !== 0) {
    failures.push(`Git staged diff failed: ${String(stagedRaw.stderr).trim()}`)
  }
  const unstagedRaw = runGit(rootPath, ['diff', '--name-only', '--no-renames', '-z', '--ignore-submodules=none'])
  if (unstagedRaw.status !== 0) {
    failures.push(`Git unstaged diff failed: ${String(unstagedRaw.stderr).trim()}`)
  }
  const untrackedRaw = runGit(rootPath, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (untrackedRaw.status !== 0) {
    failures.push(`Git untracked files enumeration failed: ${String(untrackedRaw.stderr).trim()}`)
  }
  const ignoredRaw = runGit(rootPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
  if (ignoredRaw.status !== 0) {
    failures.push(`Git ignored files enumeration failed: ${String(ignoredRaw.stderr).trim()}`)
  }
  const indexFlagsRaw = runGit(rootPath, ['ls-files', '-v', '-z'])
  if (indexFlagsRaw.status !== 0) {
    failures.push(`Git index flags enumeration failed: ${String(indexFlagsRaw.stderr).trim()}`)
  }

  if (indexFlagsRaw.status === 0) {
    const indexTokens = String(indexFlagsRaw.stdout).split('\0').filter(Boolean)
    const flaggedFiles: string[] = []
    for (const token of indexTokens) {
      const tag = token.slice(0, 1)
      const filePath = token.slice(2)
      if (tag === 'h' || tag === 'S' || tag === 's') {
        flaggedFiles.push(`${filePath} (${tag === 'h' ? 'assume-unchanged' : 'skip-worktree'})`)
      }
    }
    if (flaggedFiles.length > 0) {
      failures.push(`Git index contains assume-unchanged or skip-worktree entries:\n- ${flaggedFiles.join('\n- ')}`)
    }
  }

  const stagedPaths = stagedRaw.status === 0 ? String(stagedRaw.stdout).split('\0').filter(Boolean) : []
  const unstagedPaths = unstagedRaw.status === 0 ? String(unstagedRaw.stdout).split('\0').filter(Boolean) : []
  const untrackedPaths = untrackedRaw.status === 0 ? String(untrackedRaw.stdout).split('\0').filter(Boolean) : []
  const ignoredPaths = ignoredRaw.status === 0 ? String(ignoredRaw.stdout).split('\0').filter(Boolean) : []

  const stagedBoundary = stagedPaths.filter(isSecurityBoundaryPath)
  const unstagedBoundary = unstagedPaths.filter(isSecurityBoundaryPath)
  const untrackedBoundary = untrackedPaths.filter(isSecurityBoundaryPath)
  const allIgnoredBoundary = ignoredPaths.filter(isSecurityBoundaryPath)

  let buildMetadataExceptionValid = false
  if (allIgnoredBoundary.includes(CANONICAL_IGNORED_BUILD_METADATA_PATH)) {
    const metadataRel = CANONICAL_IGNORED_BUILD_METADATA_PATH
    const resolvedMetadata = path.resolve(rootPath, metadataRel)
    let isSymlink = false
    let isRegularFile = false

    try {
      const st = await lstat(resolvedMetadata)
      if (st.isSymbolicLink()) {
        isSymlink = true
        failures.push(`Build metadata file must not be a symbolic link: ${metadataRel}`)
      } else if (!st.isFile()) {
        failures.push(`Build metadata file must be a regular file: ${metadataRel}`)
      } else {
        isRegularFile = true
      }
    } catch (error) {
      failures.push(`Cannot stat build metadata file at ${metadataRel}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const metadataEscapeErr = await checkRealpathContained(realRoot, resolvedMetadata, metadataRel, 'Build metadata file')
    if (metadataEscapeErr) {
      failures.push(metadataEscapeErr)
    }

    let metadataParsed: unknown
    if (isRegularFile && !isSymlink && !metadataEscapeErr) {
      try {
        const raw = await readFile(resolvedMetadata, 'utf8')
        try {
          metadataParsed = JSON.parse(raw)
        } catch (error) {
          failures.push(`Malformed build metadata JSON at ${metadataRel}: ${error instanceof Error ? error.message : String(error)}`)
        }
      } catch (error) {
        failures.push(`Cannot read build metadata file at ${metadataRel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (metadataParsed !== undefined) {
      if (!isPlainObject(metadataParsed)) {
        failures.push(`Build metadata at ${metadataRel} must be a JSON object`)
      } else {
        const keys = Object.keys(metadataParsed)
        const extraKeys = keys.filter(k => k !== 'revision' && k !== 'date')
        if (extraKeys.length > 0) {
          failures.push(`Build metadata at ${metadataRel} contains unexpected keys: ${extraKeys.join(', ')}`)
        }
        if (!('revision' in metadataParsed)) {
          failures.push(`Build metadata at ${metadataRel} is missing "revision" key`)
        }
        if (!('date' in metadataParsed)) {
          failures.push(`Build metadata at ${metadataRel} is missing "date" key`)
        }

        let revisionOk = false
        if (typeof metadataParsed.revision !== 'string' || !metadataParsed.revision.trim()) {
          failures.push(`Build metadata revision at ${metadataRel} must be a non-empty string`)
        } else {
          const headRevRes = runGit(rootPath, ['rev-parse', 'HEAD'])
          if (headRevRes.status !== 0) {
            failures.push(`Failed to determine current HEAD commit: ${String(headRevRes.stderr).trim()}`)
          } else {
            const currentHead = String(headRevRes.stdout).trim()
            if (metadataParsed.revision !== currentHead) {
              failures.push(`Build metadata revision does not match current HEAD: expected ${currentHead}, received ${metadataParsed.revision}`)
            } else {
              revisionOk = true
            }
          }
        }

        let dateOk = false
        if (typeof metadataParsed.date !== 'string' || !metadataParsed.date.trim()) {
          failures.push(`Build metadata date at ${metadataRel} must be a non-empty string`)
        } else if (!isValidIsoTimestamp(metadataParsed.date)) {
          failures.push(`Build metadata date is not a valid canonical ISO timestamp: ${metadataParsed.date}`)
        } else {
          dateOk = true
        }

        if (isRegularFile && !isSymlink && !metadataEscapeErr && extraKeys.length === 0 && keys.length === 2 && revisionOk && dateOk) {
          buildMetadataExceptionValid = true
        }
      }
    }
  }

  const ignoredBoundary = allIgnoredBoundary.filter(p => !(p === CANONICAL_IGNORED_BUILD_METADATA_PATH && buildMetadataExceptionValid))

  const boundaryDriftSections: string[] = []
  if (stagedBoundary.length > 0) {
    boundaryDriftSections.push(`Staged boundary changes:\n- ${stagedBoundary.join('\n- ')}`)
  }
  if (unstagedBoundary.length > 0) {
    boundaryDriftSections.push(`Unstaged boundary changes:\n- ${unstagedBoundary.join('\n- ')}`)
  }
  if (untrackedBoundary.length > 0) {
    boundaryDriftSections.push(`Untracked boundary files:\n- ${untrackedBoundary.join('\n- ')}`)
  }
  if (ignoredBoundary.length > 0) {
    boundaryDriftSections.push(`Ignored boundary files:\n- ${ignoredBoundary.join('\n- ')}`)
  }

  if (boundaryDriftSections.length > 0) {
    failures.push(`Working tree has dirty security-boundary drift:\n${boundaryDriftSections.join('\n')}`)
  }


  if (options.release) {
    const allDirtySections: string[] = []
    if (stagedPaths.length > 0) {
      allDirtySections.push(`Staged changes:\n- ${stagedPaths.join('\n- ')}`)
    }
    if (unstagedPaths.length > 0) {
      allDirtySections.push(`Unstaged changes:\n- ${unstagedPaths.join('\n- ')}`)
    }
    if (untrackedPaths.length > 0) {
      allDirtySections.push(`Untracked files:\n- ${untrackedPaths.join('\n- ')}`)
    }
    if (ignoredBoundary.length > 0) {
      allDirtySections.push(`Ignored boundary files:\n- ${ignoredBoundary.join('\n- ')}`)
    }
    if (allDirtySections.length > 0) {
      failures.push(`Release check requires a clean repository, but dirty paths were found:\n${allDirtySections.join('\n')}`)
    }
    if (!activeRecord.releaseEligible) {
      failures.push('Active review record is not marked releaseEligible')
    }

    const blockingFindings = activeRecord.findings.filter(finding => finding.disposition === 'blocking')
    if (blockingFindings.length > 0) {
      failures.push(`Release blocked by unresolved findings: ${blockingFindings.map(f => f.id).join(', ')}`)
    }
  }

  return failures
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--digest')) {
    const rootPath = process.cwd()
    const digestIdx = args.indexOf('--digest')
    const revArg = args[digestIdx + 1]
    const revision = revArg && !revArg.startsWith('--') ? revArg : 'HEAD'
    const treeDigest = computeCoveredTreeDigest(rootPath, revision)
    console.log(`Covered-tree digest (${revision}): ${treeDigest}`)
    try {
      const tmContent = await readFile(path.join(rootPath, CANONICAL_THREAT_MODEL_PATH), 'utf8')
      const tmDigest = computeThreatModelDigest(tmContent)
      console.log(`Threat-model digest: ${tmDigest}`)
    } catch {
      // ignore if threat model missing
    }
    return
  }

  if (args.some(argument => argument !== '--release') || args.length > 1) {
    throw new Error('Usage: bun server/scripts/check-threat-model.ts [--release] [--digest [revision]]')
  }
  const release = args[0] === '--release'
  const failures = await checkThreatModel(process.cwd(), { release })
  if (failures.length > 0) throw new Error(`Threat-model contract failed:\n- ${failures.join('\n- ')}`)
  console.log(release ? 'Threat-model release state is valid' : 'Threat-model revision, evidence, and successor paths are valid')
}

if (import.meta.main) await main()
