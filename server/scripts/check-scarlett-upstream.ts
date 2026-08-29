import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type CandidateDisposition = 'adapt' | 'adopt' | 'compare' | 'conditional' | 'reject' | 'replace' | 'split' | 'supersede' | 'synthesize'
type CandidateState = 'active' | 'closed' | 'completed'

type ScarlettCandidate = {
  id: string
  commits: string[]
  category: string
  disposition: CandidateDisposition
  state: CandidateState
  workstream: string
  contract: string
  lastReviewed: string
}

type ScarlettLedger = {
  schemaVersion: 1
  upstream: {
    repository: string
    branch: string
    recordedTip: string
    recordedAt: string
    lastFetchedAt: string
  }
  forkCheckpoint: string
  candidates: ScarlettCandidate[]
}

type ChangedPath = {
  status: string
  path: string
}

type CommitSummary = {
  sha: string
  committedAt: string
  subject: string
}
type LedgerInput = {
  schemaVersion?: unknown
  upstream?: unknown
  forkCheckpoint?: unknown
  candidates?: unknown
}

type UpstreamInput = {
  repository?: unknown
  branch?: unknown
  recordedTip?: unknown
  recordedAt?: unknown
  lastFetchedAt?: unknown
}

type CandidateInput = {
  id?: unknown
  commits?: unknown
  category?: unknown
  disposition?: unknown
  state?: unknown
  workstream?: unknown
  contract?: unknown
  lastReviewed?: unknown
}


const SHA_PATTERN = /^[0-9a-f]{40}$/
const SHORT_SHA_PATTERN = /^[0-9a-f]{8,40}$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const validDispositions: Record<CandidateDisposition, true> = {
  adapt: true,
  adopt: true,
  compare: true,
  conditional: true,
  reject: true,
  replace: true,
  split: true,
  supersede: true,
  synthesize: true
}
const validStates: Record<CandidateState, true> = {
  active: true,
  closed: true,
  completed: true
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${location} must be a non-empty string`)
  return value
}

export function parseScarlettLedger(input: unknown): ScarlettLedger {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Scarlett ledger must be an object')
  const ledgerInput = input as LedgerInput
  if (ledgerInput.schemaVersion !== 1) throw new Error('Scarlett ledger schemaVersion must be 1')
  if (typeof ledgerInput.upstream !== 'object' || ledgerInput.upstream === null || Array.isArray(ledgerInput.upstream)) {
    throw new Error('Scarlett ledger upstream must be an object')
  }
  const upstreamInput = ledgerInput.upstream as UpstreamInput
  const upstream = {
    repository: requireString(upstreamInput.repository, 'upstream.repository'),
    branch: requireString(upstreamInput.branch, 'upstream.branch'),
    recordedTip: requireString(upstreamInput.recordedTip, 'upstream.recordedTip'),
    recordedAt: requireString(upstreamInput.recordedAt, 'upstream.recordedAt'),
    lastFetchedAt: requireString(upstreamInput.lastFetchedAt, 'upstream.lastFetchedAt')
  }
  if (!SHA_PATTERN.test(upstream.recordedTip)) throw new Error('upstream.recordedTip must be a full lowercase Git SHA')
  if (Number.isNaN(Date.parse(upstream.recordedAt))) throw new Error('upstream.recordedAt must be an ISO timestamp')
  if (Number.isNaN(Date.parse(upstream.lastFetchedAt))) throw new Error('upstream.lastFetchedAt must be an ISO timestamp')
  const forkCheckpoint = requireString(ledgerInput.forkCheckpoint, 'ledger.forkCheckpoint')
  if (!SHA_PATTERN.test(forkCheckpoint)) throw new Error('forkCheckpoint must be a full lowercase Git SHA')
  if (!Array.isArray(ledgerInput.candidates) || ledgerInput.candidates.length === 0) {
    throw new Error('Scarlett ledger candidates must be a non-empty array')
  }

  const ids = new Set<string>()
  const candidates = ledgerInput.candidates.map((candidateValue, index): ScarlettCandidate => {
    const location = `candidates[${index}]`
    if (typeof candidateValue !== 'object' || candidateValue === null || Array.isArray(candidateValue)) {
      throw new Error(`${location} must be an object`)
    }
    const candidateInput = candidateValue as CandidateInput
    const id = requireString(candidateInput.id, `${location}.id`)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`${location}.id must be kebab-case`)
    if (ids.has(id)) throw new Error(`Duplicate Scarlett candidate id: ${id}`)
    ids.add(id)
    if (!Array.isArray(candidateInput.commits) || candidateInput.commits.some(commit => typeof commit !== 'string' || !SHORT_SHA_PATTERN.test(commit))) {
      throw new Error(`${location}.commits must contain lowercase Git SHAs`)
    }
    const disposition = requireString(candidateInput.disposition, `${location}.disposition`) as CandidateDisposition
    const state = requireString(candidateInput.state, `${location}.state`) as CandidateState
    if (!(disposition in validDispositions)) throw new Error(`${location}.disposition is unsupported`)
    if (!(state in validStates)) throw new Error(`${location}.state is unsupported`)
    const lastReviewed = requireString(candidateInput.lastReviewed, `${location}.lastReviewed`)
    if (!DATE_PATTERN.test(lastReviewed)) throw new Error(`${location}.lastReviewed must use YYYY-MM-DD`)
    return {
      id,
      commits: candidateInput.commits as string[],
      category: requireString(candidateInput.category, `${location}.category`),
      disposition,
      state,
      workstream: requireString(candidateInput.workstream, `${location}.workstream`),
      contract: requireString(candidateInput.contract, `${location}.contract`),
      lastReviewed
    }
  })

  return { schemaVersion: 1, upstream, forkCheckpoint, candidates }
}

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' })
  if (result.status === 0) return true
  if (result.status === 1) return false
  throw new Error(`git merge-base failed with status ${String(result.status)}`)
}

export function parseChangedPaths(output: string): ChangedPath[] {
  if (output.trim() === '') return []
  return output.split('\n').map(line => {
    const fields = line.split('\t')
    const status = fields[0]
    const changedPath = fields.at(-1)
    if (!status || !changedPath) throw new Error(`Malformed git name-status row: ${line}`)
    return { status, path: changedPath }
  })
}

export function summarizeTopLevelAreas(paths: ChangedPath[]): Array<{ area: string, files: number }> {
  const counts = new Map<string, number>()
  for (const changed of paths) {
    const area = changed.path.includes('/') ? changed.path.slice(0, changed.path.indexOf('/')) : changed.path
    counts.set(area, (counts.get(area) ?? 0) + 1)
  }
  return [...counts].map(([area, files]) => ({ area, files })).sort((left, right) => right.files - left.files || left.area.localeCompare(right.area))
}

function parseCommits(output: string): CommitSummary[] {
  if (output.trim() === '') return []
  return output.split('\n').map(line => {
    const [sha, committedAt, subject] = line.split('\u001f')
    if (!sha || !committedAt || subject === undefined) throw new Error(`Malformed git log row: ${line}`)
    return { sha, committedAt, subject }
  })
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function addedWipMarkers(diff: string): string[] {
  const markers = new Set<string>()
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const matches = line.match(/\b(?:FIXME|TODO|WIP|placeholder|not implemented)\b/gi)
    for (const match of matches ?? []) markers.add(match.toUpperCase())
  }
  return [...markers].sort()
}

export function buildScarlettReport(ledger: ScarlettLedger, upstreamRef: string) {
  const currentTip = runGit(['rev-parse', upstreamRef])
  if (!SHA_PATTERN.test(currentTip)) throw new Error(`Resolved upstream tip is invalid: ${currentTip}`)
  const recordedExists = spawnSync('git', ['cat-file', '-e', `${ledger.upstream.recordedTip}^{commit}`], { stdio: 'ignore' }).status === 0
  if (!recordedExists) throw new Error(`Recorded Scarlett tip is not present locally: ${ledger.upstream.recordedTip}`)
  const relation = currentTip === ledger.upstream.recordedTip
    ? 'unchanged'
    : isAncestor(ledger.upstream.recordedTip, currentTip) ? 'advanced' : 'rewritten'
  const range = `${ledger.upstream.recordedTip}..${currentTip}`
  const commits = relation === 'unchanged'
    ? []
    : parseCommits(runGit(['log', '--reverse', '--format=%H%x1f%cI%x1f%s', range]))
  const changedPaths = relation === 'unchanged'
    ? []
    : parseChangedPaths(runGit(['diff', '--name-status', ledger.upstream.recordedTip, currentTip]))
  const diff = relation === 'unchanged'
    ? ''
    : runGit(['diff', '--unified=0', '--no-ext-diff', ledger.upstream.recordedTip, currentTip])
  const testPaths = changedPaths.filter(changed => /(?:^|\/)(?:test|tests|spec|__tests__)(?:\/|\.)|\.(?:test|spec)\.[^.]+$/i.test(changed.path))
  const migrationPaths = changedPaths.filter(changed => /(?:^|\/)migrations?(?:\/|$)/i.test(changed.path))
  const dependencyPaths = changedPaths.filter(changed => /(?:^|\/)(?:package\.json|bun\.lock|pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/i.test(changed.path))

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    upstream: {
      repository: ledger.upstream.repository,
      branch: ledger.upstream.branch,
      recordedTip: ledger.upstream.recordedTip,
      currentTip,
      relation,
      newCommitCount: commits.length
    },
    commits,
    changes: {
      files: changedPaths.length,
      topLevelAreas: summarizeTopLevelAreas(changedPaths),
      dependencies: dependencyPaths,
      migrations: migrationPaths,
      tests: {
        added: testPaths.filter(changed => changed.status.startsWith('A')).map(changed => changed.path),
        removed: testPaths.filter(changed => changed.status.startsWith('D')).map(changed => changed.path),
        modified: testPaths.filter(changed => !changed.status.startsWith('A') && !changed.status.startsWith('D')).map(changed => changed.path)
      },
      addedWipMarkers: addedWipMarkers(diff)
    },
    ledger: {
      candidates: ledger.candidates.length,
      states: countBy(ledger.candidates.map(candidate => candidate.state)),
      dispositions: countBy(ledger.candidates.map(candidate => candidate.disposition)),
      activeWorkstreams: [...new Set(ledger.candidates.filter(candidate => candidate.state === 'active').map(candidate => candidate.workstream))].sort()
    }
  }
}

function argumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

async function main() {
  const args = process.argv.slice(2)
  const ledgerPath = path.resolve(argumentValue(args, '--ledger') ?? 'docs/.planning/scarlett-upstream-ledger.json')
  const ledger = parseScarlettLedger(JSON.parse(await readFile(ledgerPath, 'utf8')))
  const upstreamRef = `refs/remotes/upstream/${ledger.upstream.branch}`
  if (args.includes('--fetch')) {
    runGit(['fetch', '--no-tags', ledger.upstream.repository, `+refs/heads/${ledger.upstream.branch}:${upstreamRef}`])
  }
  const report = buildScarlettReport(ledger, upstreamRef)
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  const output = argumentValue(args, '--output')
  if (output) {
    const outputPath = path.resolve(output)
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, serialized)
    console.log(`Wrote Scarlett intake report to ${path.relative(process.cwd(), outputPath)}`)
  } else {
    process.stdout.write(serialized)
  }
  if (args.includes('--check') && report.upstream.relation !== 'unchanged') {
    throw new Error(`Scarlett upstream ${report.upstream.relation}: ${report.upstream.recordedTip} -> ${report.upstream.currentTip}`)
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()
