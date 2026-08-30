import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from '../bun-test.mts'

import { checkThreatModel, parseThreatModel } from '../../scripts/check-threat-model.ts'

const temporaryDirectories: string[] = []
const fullRevision = '614e8b5a1dd3bc2088fc3c9547f85e6620b7c21d'
const requiredCommands = ['bun run dependencies:check', 'bun run licenses:check', 'bun run test:security', 'bun audit --production', 'bun run typecheck:server']

type FixtureManifest = {
  packageManager: string
  scripts: Record<string, string>
}
type ThreatModelReview = {
  externalReviewer?: string
  openFindings?: string[]
  resolvedFindings?: string[]
}

function threatModel(revision: string, commands = requiredCommands, extraEvidence = '', review: ThreatModelReview = {}): string {
  const externalReviewer = review.externalReviewer ?? 'Unassigned — blocks the first external release'
  const openFindings = review.openFindings ?? [
    '| SEC-EXT-001 — independent security review not yet performed | Release blocker | Maintainers | Freeze revision, record reviewer/scope, resolve findings, retain retest evidence. |',
    '| SEC-ADAPTER-001 — deployment integrations require operator review | Medium | Operator | Complete enabled integration canaries. |'
  ]
  const resolvedFindings = review.resolvedFindings ?? ['| SEC-AUTH-001 — browser security journeys | Resolved 2026-08-15. Focused browser journeys pass. |']
  return `# Test threat model

## Status and review contract

| Field | Value |
| --- | --- |
| External reviewer | ${externalReviewer} |
| Covered source | \`${revision}\` |

| Evidence | Paths |
| --- | --- |
| Supply chain | \`package.json\`; \`bun.lock\`; \`server/core/auth.ts\`; \`server/scripts/check-threat-model.ts\`${extraEvidence} |

## Executable security gate

\`\`\`console
${commands.join('\n')}
\`\`\`

## Open findings and accepted limitations

| Finding | Severity | Owner | Required disposition |
| --- | --- | --- | --- |
${openFindings.join('\n')}

## Resolved findings

| Finding | Resolution evidence |
| --- | --- |
${resolvedFindings.join('\n')}
`
}

function runGit(rootPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: rootPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(rootPath: string, relativePath: string, contents: string) {
  const destination = path.join(rootPath, relativePath)
  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, contents)
}

function commit(rootPath: string, message: string): string {
  runGit(rootPath, ['add', '.'])
  runGit(rootPath, ['commit', '-m', message])
  return runGit(rootPath, ['rev-parse', 'HEAD'])
}

function createRepository(): { rootPath: string; reviewedRevision: string } {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'wiki-threat-model-'))
  temporaryDirectories.push(rootPath)
  runGit(rootPath, ['init', '--quiet'])
  runGit(rootPath, ['config', 'user.name', 'Threat Model Test'])
  runGit(rootPath, ['config', 'user.email', 'threat-model@example.invalid'])

  const baseManifest: FixtureManifest = {
    packageManager: 'bun@1.4.0',
    scripts: {
      'dependencies:check': 'bun dependency-policy.ts',
      'licenses:check': 'bun licenses.ts',
      'test:security': 'bun security-tests.ts',
      'typecheck:server': 'bun --bun tsc --noEmit',
      'ci:static': 'bun run dependencies:check'
    }
  }
  write(rootPath, 'package.json', `${JSON.stringify(baseManifest, null, 2)}\n`)
  write(rootPath, 'bun.lock', '{}\n')
  write(rootPath, 'server/core/auth.ts', 'export const authenticated = true\n')
  const reviewedRevision = commit(rootPath, 'reviewed application')

  const currentManifest = structuredClone(baseManifest)
  currentManifest.scripts['threat-model:check'] = 'bun server/scripts/check-threat-model.ts'
  currentManifest.scripts['ci:static'] += ' && bun run threat-model:check'
  write(rootPath, 'package.json', `${JSON.stringify(currentManifest, null, 2)}\n`)
  write(rootPath, 'server/scripts/check-threat-model.ts', 'export {}\n')
  write(rootPath, 'docs/security/threat-model.md', threatModel(reviewedRevision))
  commit(rootPath, 'add executable threat-model review')
  return { rootPath, reviewedRevision }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('threat-model contract parser', () => {
  it('accepts one exact revision and the complete Bun evidence contract', () => {
    const contract = parseThreatModel(threatModel(fullRevision))

    expect(contract.reviewedRevision).toBe(fullRevision)
    expect(contract.commands).toEqual(requiredCommands)
    expect(contract.citedPaths).toEqual(['package.json', 'bun.lock', 'server/core/auth.ts', 'server/scripts/check-threat-model.ts'])
    expect(contract.externalReviewer).toBe('Unassigned — blocks the first external release')
    expect(contract.openFindings).toEqual([
      { id: 'SEC-EXT-001', severity: 'Release blocker' },
      { id: 'SEC-ADAPTER-001', severity: 'Medium' }
    ])
    expect(contract.resolvedFindingIds).toEqual(['SEC-AUTH-001'])
  })

  it.each(['main', `${fullRevision}..HEAD`, fullRevision.slice(0, 12)])('rejects branch, range, or abbreviated coverage %s', coveredSource => {
    expect(() => parseThreatModel(threatModel(coveredSource))).toThrow('exactly one full 40-character lowercase Git revision')
  })

  it('rejects stale lock evidence and omitted canonical commands', () => {
    expect(() => parseThreatModel(threatModel(fullRevision).replace('bun.lock', 'pnpm-lock.yaml'))).toThrow('Bun and bun.lock exclusively')
    expect(() => parseThreatModel(threatModel(fullRevision, requiredCommands.slice(1)))).toThrow('bun run dependencies:check')
  })

  it('rejects missing review declarations and contradictory finding dispositions', () => {
    expect(() => parseThreatModel(threatModel(fullRevision).replace('| External reviewer | Unassigned — blocks the first external release |\n', ''))).toThrow(
      'External reviewer'
    )
    expect(() =>
      parseThreatModel(
        threatModel(fullRevision, requiredCommands, '', {
          resolvedFindings: ['| SEC-EXT-001 — independent security review not yet performed | Resolved after independent retest. |']
        })
      )
    ).toThrow('exactly one open or resolved disposition: SEC-EXT-001')
  })
})

describe('threat-model repository gate', () => {
  it('permits documentation and delivery descendants of reviewed application code', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'docs/operator/release.md', 'Release procedure\n')
    write(rootPath, '.github/workflows/release.yml', 'name: release\n')
    commit(rootPath, 'document delivery')

    expect(await checkThreatModel(rootPath)).toEqual([])
  })

  it('rejects a later application security-boundary change', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'server/core/auth.ts', 'export const authenticated = false\n')
    commit(rootPath, 'change authentication boundary')

    expect(await checkThreatModel(rootPath)).toContain('Security-boundary source changed after the reviewed revision:\n- server/core/auth.ts')
  })

  it('rejects nonexistent and non-ancestor reviewed revisions', async () => {
    const nonexistent = createRepository()
    write(nonexistent.rootPath, 'docs/security/threat-model.md', threatModel('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
    expect(await checkThreatModel(nonexistent.rootPath)).toContain(
      'Reviewed revision does not exist in this repository: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )

    const divergent = createRepository()
    const originalBranch = runGit(divergent.rootPath, ['branch', '--show-current'])
    runGit(divergent.rootPath, ['checkout', '-b', 'reviewed-side'])
    write(divergent.rootPath, 'docs/side.md', 'Side revision\n')
    const sideRevision = commit(divergent.rootPath, 'side revision')
    runGit(divergent.rootPath, ['checkout', originalBranch])
    write(divergent.rootPath, 'docs/security/threat-model.md', threatModel(sideRevision))

    expect(await checkThreatModel(divergent.rootPath)).toContain(`Reviewed revision is not an ancestor of HEAD: ${sideRevision}`)
  })

  it('rejects missing cited paths, package scripts, and manager-prefix drift', async () => {
    const missingPath = createRepository()
    write(missingPath.rootPath, 'docs/security/threat-model.md', threatModel(missingPath.reviewedRevision, requiredCommands, '; `server/core/missing.ts`'))
    expect(await checkThreatModel(missingPath.rootPath)).toContain('Cited path does not exist: server/core/missing.ts')

    const missingScript = createRepository()
    const manifest = JSON.parse(readFileSync(path.join(missingScript.rootPath, 'package.json'), 'utf8')) as FixtureManifest
    delete manifest.scripts['licenses:check']
    write(missingScript.rootPath, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    expect(await checkThreatModel(missingScript.rootPath)).toContain('Referenced package script does not exist: licenses:check')

    const wrongManager = createRepository()
    const wrongManifest = JSON.parse(readFileSync(path.join(wrongManager.rootPath, 'package.json'), 'utf8')) as FixtureManifest
    wrongManifest.packageManager = 'pnpm@10.0.0'
    write(wrongManager.rootPath, 'package.json', `${JSON.stringify(wrongManifest, null, 2)}\n`)
    const failures = await checkThreatModel(wrongManager.rootPath)
    expect(failures).toContain('packageManager must select a versioned Bun release')
    expect(failures).toContain('Security command prefix does not match packageManager: bun run test:security')
  })

  it('keeps ordinary checks usable while strict release state enforces independent review and blocker resolution', async () => {
    const unassigned = createRepository()
    write(
      unassigned.rootPath,
      'docs/security/threat-model.md',
      threatModel(unassigned.reviewedRevision, requiredCommands, '', {
        openFindings: ['| SEC-ADAPTER-001 — deployment integrations require operator review | Medium | Operator | Complete enabled integration canaries. |'],
        resolvedFindings: ['| SEC-EXT-001 — independent security review not yet performed | Resolved after independent retest. |']
      })
    )
    commit(unassigned.rootPath, 'record completed findings without assigning reviewer')
    expect(await checkThreatModel(unassigned.rootPath)).toEqual([])
    expect(await checkThreatModel(unassigned.rootPath, { release: true })).toContain('External reviewer is unassigned; release publication is blocked')

    const blocked = createRepository()
    write(
      blocked.rootPath,
      'docs/security/threat-model.md',
      threatModel(blocked.reviewedRevision, requiredCommands, '', { externalReviewer: 'Independent Security LLC, 2026-08-20 through 2026-08-29' })
    )
    commit(blocked.rootPath, 'assign external reviewer with blocker open')
    expect(await checkThreatModel(blocked.rootPath)).toEqual([])
    expect(await checkThreatModel(blocked.rootPath, { release: true })).toContain('Unresolved release blockers: SEC-EXT-001')

    const releasable = createRepository()
    write(
      releasable.rootPath,
      'docs/security/threat-model.md',
      threatModel(releasable.reviewedRevision, requiredCommands, '', {
        externalReviewer: 'Independent Security LLC, 2026-08-20 through 2026-08-29',
        openFindings: ['| SEC-ADAPTER-001 — deployment integrations require operator review | Medium | Operator | Complete enabled integration canaries. |'],
        resolvedFindings: [
          '| SEC-EXT-001 — independent security review not yet performed | Resolved 2026-08-29 after fix verification and independent retest. |'
        ]
      })
    )
    commit(releasable.rootPath, 'record independent review and resolve release blocker')
    expect(await checkThreatModel(releasable.rootPath, { release: true })).toEqual([])
  })
})

describe('release workflow threat-model boundary', () => {
  it('runs strict release-state checks immediately before preview and release publication', () => {
    const workflow = readFileSync(path.join(process.cwd(), '.github/workflows/build.yml'), 'utf8')
    expect(workflow.match(/run: bun server\/scripts\/check-threat-model\.ts --release/g)).toHaveLength(2)
    for (const publication of ['Preview', 'Release']) {
      expect(workflow).toMatch(
        new RegExp(
          `- name: Enforce Threat Model Release State\\n\\s+run: bun server/scripts/check-threat-model\\.ts --release\\n\\n\\s+- name: Verify Descriptors and Push ${publication} Manifests`
        )
      )
    }
  })
})
