import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from '../bun-test.mts'

import {
  CANONICAL_FINGERPRINT_ALGORITHM,
  CANONICAL_IGNORED_BUILD_METADATA_PATH,
  CANONICAL_REPOSITORY,
  checkThreatModel,
  computeCoveredTreeDigest,
  computeThreatModelDigest,
  isSecurityBoundaryPath,
  isValidIsoTimestamp,
  parseThreatModel,
  type ReviewRecord,
  type SourceReviewRecord
} from '../../scripts/check-threat-model.ts'

const temporaryDirectories: string[] = []
const requiredCommands = ['bun run dependencies:check', 'bun run licenses:check', 'bun run test:security', 'bun audit --production', 'bun run typecheck:server']

type FixtureManifest = {
  packageManager: string
  scripts: Record<string, string>
}

function normativeThreatModel(commands = requiredCommands, extraEvidence = ''): string {
  return `# tsEpistle security threat model

## Status and review contract

| Field | Value |
| --- | --- |
| Product | tsEpistle |
| Model version | 1 |
| Last reviewed | 2026-09-04 |
| Review owner | tsEpistle maintainers |

## Executable security gate

\`\`\`console
${commands.join('\n')}
\`\`\`

Evidence: \`package.json\`, \`bun.lock\`, \`server/core/auth.ts\`, \`server/scripts/check-threat-model.ts\`${extraEvidence}.
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

type RepositoryFixtureOptions = {
  releaseEligible?: boolean
  reviewerIdentity?: string
  findings?: ReviewRecord['findings']
  extraEvidence?: string
  commands?: string[]
}

function createRepository(options: RepositoryFixtureOptions = {}): {
  rootPath: string
  reviewedRevision: string
  treeDigest: string
  threatModelDigest: string
} {
  const rootPath = mkdtempSync(path.join(tmpdir(), 'wiki-threat-model-'))
  temporaryDirectories.push(rootPath)
  runGit(rootPath, ['init', '--quiet'])
  runGit(rootPath, ['config', 'user.name', 'Threat Model Test'])
  runGit(rootPath, ['config', 'user.email', 'threat-model@example.invalid'])

  const baseManifest: FixtureManifest = {
    packageManager: 'bun@1.4.2',
    scripts: {
      'dependencies:check': 'bun dependency-policy.ts',
      'licenses:check': 'bun licenses.ts',
      'test:security': 'bun security-tests.ts',
      'typecheck:server': 'bun --bun tsc --noEmit',
      'threat-model:check': 'bun server/scripts/check-threat-model.ts',
      'ci:static': 'bun run dependencies:check && bun run licenses:check && bun audit --production && bun run threat-model:check'
    }
  }
  write(rootPath, 'package.json', `${JSON.stringify(baseManifest, null, 2)}\n`)
  write(rootPath, 'bun.lock', '{}\n')
  write(rootPath, 'server/core/auth.ts', 'export const authenticated = true\n')
  write(rootPath, 'server/scripts/check-threat-model.ts', 'export {}\n')
  write(rootPath, 'server/test/scripts/check-threat-model.test.ts', 'export {}\n')
  write(rootPath, '.github/workflows/build.yml', 'name: build\n')
  write(rootPath, 'deploy/docker-compose.yml', 'version: "3"\n')
  write(rootPath, 'dev/build/create-linux-bundle.sh', '#!/bin/sh\n')
  write(rootPath, 'dev/build/Dockerfile', 'FROM alpine\n')

  const tmContent = normativeThreatModel(options.commands ?? requiredCommands, options.extraEvidence ?? '')
  write(rootPath, 'docs/security/threat-model.md', tmContent)

  const reviewedRevision = commit(rootPath, 'reviewed application baseline')
  const treeDigest = computeCoveredTreeDigest(rootPath, reviewedRevision)
  const threatModelDigest = computeThreatModelDigest(tmContent)

  const baselineRecord: SourceReviewRecord = {
    schemaVersion: 2,
    id: 'baseline-review',
    kind: 'source-review',
    repository: CANONICAL_REPOSITORY,
    policyVersion: 1,
    threatModelDigest,
    reviewer: {
      identity: options.reviewerIdentity ?? 'tsEpistle maintainers',
      reviewedAt: '2026-09-04'
    },
    releaseEligible: options.releaseEligible ?? false,
    findings: options.findings ?? [
      {
        id: 'SEC-BASELINE-001',
        severity: 'Low',
        disposition: 'resolved',
        evidencePaths: ['server/core/auth.ts']
      }
    ],
    evidencePaths: ['server/core/auth.ts'],
    source: {
      revision: reviewedRevision,
      baseRevision: reviewedRevision,
      coveredTreeDigest: treeDigest
    }
  }

  write(rootPath, 'docs/security/review-attestations/baseline-review.json', `${JSON.stringify(baselineRecord, null, 2)}\n`)
  write(
    rootPath,
    'docs/security/review-attestations.json',
    `${JSON.stringify(
      {
        schemaVersion: 2,
        policyVersion: 1,
        threatModelPath: 'docs/security/threat-model.md',
        activeReviewId: 'baseline-review',
        records: [
          {
            id: 'baseline-review',
            path: 'docs/security/review-attestations/baseline-review.json'
          }
        ]
      },
      null,
      2
    )}\n`
  )

  commit(rootPath, 'add review attestations')
  return { rootPath, reviewedRevision, treeDigest, threatModelDigest }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('canonical policy-v1 path classification and digest', () => {
  it('covers server, client, shared, deploy, patches, workflows, actions, entire dev prefix, and config files', () => {
    expect(isSecurityBoundaryPath('server/core/auth.ts')).toBe(true)
    expect(isSecurityBoundaryPath('client/components/app.vue')).toBe(true)
    expect(isSecurityBoundaryPath('shared/constants.ts')).toBe(true)
    expect(isSecurityBoundaryPath('deploy/Dockerfile')).toBe(true)
    expect(isSecurityBoundaryPath('patches/package.patch')).toBe(true)
    expect(isSecurityBoundaryPath('.github/workflows/build.yml')).toBe(true)
    expect(isSecurityBoundaryPath('.github/actions/setup/action.yml')).toBe(true)
    expect(isSecurityBoundaryPath('dev/containers/app.dockerfile')).toBe(true)
    expect(isSecurityBoundaryPath('dev/helm/Chart.yaml')).toBe(true)
    expect(isSecurityBoundaryPath('dev/build/create-linux-bundle.sh')).toBe(true)
    expect(isSecurityBoundaryPath('dev/build/Dockerfile')).toBe(true)
    expect(isSecurityBoundaryPath('dev/build-arm/Dockerfile')).toBe(true)
    expect(isSecurityBoundaryPath('package.json')).toBe(true)
    expect(isSecurityBoundaryPath('bun.lock')).toBe(true)
    expect(isSecurityBoundaryPath('bunfig.toml')).toBe(true)
    expect(isSecurityBoundaryPath('biome.json')).toBe(true)
    expect(isSecurityBoundaryPath('config.sample.yml')).toBe(true)
    expect(isSecurityBoundaryPath('license-policy.json')).toBe(true)
    expect(isSecurityBoundaryPath('playwright.config.ts')).toBe(true)
    expect(isSecurityBoundaryPath('vite.config.mts')).toBe(true)
    expect(isSecurityBoundaryPath('tsconfig.json')).toBe(true)
    expect(isSecurityBoundaryPath('tsconfig.node.json')).toBe(true)
    expect(isSecurityBoundaryPath('.dockerignore')).toBe(true)
    expect(isSecurityBoundaryPath('.gitattributes')).toBe(true)
    expect(isSecurityBoundaryPath('LICENSE')).toBe(true)
    expect(isSecurityBoundaryPath('NOTICE')).toBe(true)
  })

  it('strictly covers the checker script and tests without exemption', () => {
    expect(isSecurityBoundaryPath('server/scripts/check-threat-model.ts')).toBe(true)
    expect(isSecurityBoundaryPath('server/test/scripts/check-threat-model.test.ts')).toBe(true)
  })

  it('strictly covers server/.build-metadata.json as a security boundary path without exemption', () => {
    expect(isSecurityBoundaryPath('server/.build-metadata.json')).toBe(true)
    expect(isSecurityBoundaryPath(CANONICAL_IGNORED_BUILD_METADATA_PATH)).toBe(true)
    expect(CANONICAL_IGNORED_BUILD_METADATA_PATH).toBe('server/.build-metadata.json')
  })

  it('includes server/.build-metadata.json in covered-tree digest when tracked', () => {
    const { rootPath, treeDigest } = createRepository()
    write(rootPath, 'server/.build-metadata.json', '{"revision":"tracked-1","date":"2026-09-08T00:00:00.000Z"}\n')
    const revWithMetadata = commit(rootPath, 'track build metadata')
    const digestWithMetadata = computeCoveredTreeDigest(rootPath, revWithMetadata)
    expect(digestWithMetadata).not.toBe(treeDigest)
    expect(digestWithMetadata).toMatch(/^[0-9a-f]{64}$/)
  })

  it('excludes documentation and unmanaged root scratchpaths from security boundary', () => {
    expect(isSecurityBoundaryPath('docs/security/threat-model.md')).toBe(false)
    expect(isSecurityBoundaryPath('docs/architecture.md')).toBe(false)
    expect(isSecurityBoundaryPath('README.md')).toBe(false)
  })

  it('computes deterministic covered-tree digest over boundary blobs and gitlinks', () => {
    const { rootPath, reviewedRevision, treeDigest } = createRepository()
    expect(treeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(computeCoveredTreeDigest(rootPath, reviewedRevision)).toBe(treeDigest)
  })

  it('includes every root Docker and source-archive input in the covered digest', () => {
    const releaseInputs = ['.dockerignore', '.gitattributes', 'LICENSE', 'NOTICE']
    for (const releaseInput of releaseInputs) {
      const { rootPath, treeDigest } = createRepository()
      write(rootPath, releaseInput, `${releaseInput} release input\n`)
      const revision = commit(rootPath, `add ${releaseInput}`)
      expect(computeCoveredTreeDigest(rootPath, revision)).not.toBe(treeDigest)
    }
  })
})

describe('normative threat-model markdown parser', () => {
  it('extracts modelVersion, required gate commands, and repository citations', () => {
    const contract = parseThreatModel(normativeThreatModel())
    expect(contract.modelVersion).toBe(1)
    expect(contract.commands).toEqual(requiredCommands)
    expect(contract.citedPaths).toContain('bun.lock')
    expect(contract.citedPaths).toContain('package.json')
  })

  it('rejects foreign package managers, lockfiles, and missing modelVersion', () => {
    expect(() => parseThreatModel(normativeThreatModel().replace('bun.lock', 'pnpm-lock.yaml'))).toThrow('Bun and bun.lock exclusively')
    expect(() => parseThreatModel(normativeThreatModel().replace('| Model version | 1 |', ''))).toThrow('Threat model must declare a Model version')
    expect(() => parseThreatModel(normativeThreatModel(requiredCommands.slice(1)))).toThrow(
      'Executable security gate is missing command: bun run dependencies:check'
    )
  })

  it('rejects malformed versions and duplicate sections (TMG-007)', () => {
    const tmBase = normativeThreatModel()
    expect(() => parseThreatModel(tmBase.replace('| Model version | 1 |', '| Model version | 1junk |'))).toThrow(
      'Model version must be a positive integer: 1junk'
    )
    expect(() => parseThreatModel(tmBase.replace('| Model version | 1 |', '| Model version | 1.5 |'))).toThrow('Model version must be a positive integer: 1.5')
    expect(() => parseThreatModel(tmBase.replace('| Model version | 1 |', '| Model version | 2 |'))).toThrow(
      'Unsupported model version: expected 1, received 2'
    )
    expect(() => parseThreatModel(tmBase.replace('| Model version | 1 |', '| Model version | 0 |'))).toThrow('Model version must be a positive integer: 0')

    const duplicateStatus = `${tmBase}\n## Status and review contract\n\n| Field | Value |\n| --- | --- |\n| Model version | 1 |\n`
    expect(() => parseThreatModel(duplicateStatus)).toThrow('duplicate Status and review contract sections')

    const duplicateGate = `${tmBase}\n## Executable security gate\n\n\`\`\`console\nbun audit\n\`\`\`\n`
    expect(() => parseThreatModel(duplicateGate)).toThrow('duplicate Executable security gate sections')
  })

  it('ignores headings inside code fences and does not treat them as sections (TMG-007)', () => {
    const tmWithFencedHeading = normativeThreatModel(requiredCommands, '\n```markdown\n## Status and review contract\nFake\n```')
    const contract = parseThreatModel(tmWithFencedHeading)
    expect(contract.modelVersion).toBe(1)
  })

  it('does not accept console blocks nested inside longer or alternate fences', () => {
    const commandBlock = `\`\`\`console\n${requiredCommands.join('\n')}\n\`\`\``
    const nestedBackticks = normativeThreatModel().replace(commandBlock, `\`\`\`\`markdown\n${commandBlock}\n\`\`\`\``)
    expect(() => parseThreatModel(nestedBackticks)).toThrow('Executable security gate must contain exactly one console command block')

    const nestedTildes = normativeThreatModel().replace(commandBlock, `~~~~markdown\n${commandBlock}\n~~~~`)
    expect(() => parseThreatModel(nestedTildes)).toThrow('Executable security gate must contain exactly one console command block')
  })
})

describe('release gate wiring', () => {
  it('rejects an empty threat model even when its empty-byte digest is bound', async () => {
    const { rootPath } = createRepository({ releaseEligible: true })
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.threatModelDigest = computeThreatModelDigest('')
    write(rootPath, 'docs/security/threat-model.md', '')
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)

    const ordinaryFailures = await checkThreatModel(rootPath)
    expect(ordinaryFailures).toContain('Threat model parsing failed: Threat model must contain a Status and review contract section')

    const releaseFailures = await checkThreatModel(rootPath, { release: true })
    expect(releaseFailures).toContain('Threat model parsing failed: Threat model must contain a Status and review contract section')
  })

  it('requires an exact unsuppressed audit segment in the canonical ci:static chain', async () => {
    const invalidChains = [
      'bun run dependencies:check && bun run licenses:check && bun run threat-model:check',
      'bun run dependencies:check && bun run licenses:check && echo "bun audit --production" && bun run threat-model:check',
      'bun run dependencies:check && bun run licenses:check && bun audit --production && bun run threat-model:check || true',
      'bun run dependencies:check && bun run licenses:check && bun audit --production --audit-level=high && bun run threat-model:check',
      'bun run dependencies:check && bun run licenses:check && bun audit --production & bun run threat-model:check'
    ]

    for (const ciStatic of invalidChains) {
      const { rootPath } = createRepository()
      const packagePath = path.join(rootPath, 'package.json')
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
      manifest.scripts['ci:static'] = ciStatic
      write(rootPath, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)

      const failures = await checkThreatModel(rootPath)
      expect(failures).toContain(
        'ci:static must execute exact unconditional bun audit --production after dependencies:check and licenses:check and before threat-model:check'
      )
    }
  })
})

describe('manifest and review record structure and integrity', () => {
  it('rejects malformed manifest JSON', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'docs/security/review-attestations.json', '{ invalid json')
    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Malformed review attestations manifest JSON'))).toBe(true)
  })

  it('rejects null and wrong-shaped JSON without throwing (TMG-005)', async () => {
    const { rootPath } = createRepository()
    const manifestPath = 'docs/security/review-attestations.json'

    write(rootPath, manifestPath, 'null\n')
    expect(await checkThreatModel(rootPath)).toContain('Manifest must be a JSON object')

    write(rootPath, manifestPath, '"primitive string"\n')
    expect(await checkThreatModel(rootPath)).toContain('Manifest must be a JSON object')

    write(rootPath, manifestPath, '[]\n')
    expect(await checkThreatModel(rootPath)).toContain('Manifest must be a JSON object')

    write(
      rootPath,
      manifestPath,
      JSON.stringify({
        schemaVersion: 2,
        policyVersion: 1,
        threatModelPath: 'docs/security/threat-model.md',
        activeReviewId: 'baseline-review',
        records: [null, 123, { id: '', path: '' }]
      })
    )
    const recFailures = await checkThreatModel(rootPath)
    expect(recFailures.some(f => f.includes('Manifest record reference at index 0 must be an object'))).toBe(true)
    expect(recFailures.some(f => f.includes('Manifest record reference at index 1 must be an object'))).toBe(true)
    expect(recFailures.some(f => f.includes('id at index 2 must be a non-empty string'))).toBe(true)
  })

  it('rejects wrong-shaped review record without throwing (TMG-005)', async () => {
    const { rootPath } = createRepository()
    const recordPath = 'docs/security/review-attestations/baseline-review.json'

    write(rootPath, recordPath, 'null\n')
    expect(await checkThreatModel(rootPath)).toContain('Record baseline-review must be a JSON object')

    write(rootPath, recordPath, JSON.stringify({ schemaVersion: 2, id: 'baseline-review' }))
    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('repository must be "PhilosophiMoonbeam/tsEpistle"'))).toBe(true)
    expect(failures.some(f => f.includes('must declare reviewer object'))).toBe(true)
    expect(failures.some(f => f.includes('findings must be an array'))).toBe(true)
    expect(failures.some(f => f.includes('evidencePaths must be an array'))).toBe(true)
  })

  it('rejects unsupported schemaVersion or policyVersion in manifest', async () => {
    const { rootPath } = createRepository()
    const manifestPath = 'docs/security/review-attestations.json'
    const valid = JSON.parse(readFileSync(path.join(rootPath, manifestPath), 'utf8'))

    write(rootPath, manifestPath, JSON.stringify({ ...valid, schemaVersion: 1 }))
    expect(await checkThreatModel(rootPath)).toContain('Unsupported manifest schemaVersion: expected 2, received 1')

    write(rootPath, manifestPath, JSON.stringify({ ...valid, schemaVersion: 3 }))
    expect(await checkThreatModel(rootPath)).toContain('Unsupported manifest schemaVersion: expected 2, received 3')
    write(rootPath, manifestPath, JSON.stringify({ ...valid, policyVersion: 2 }))
    expect(await checkThreatModel(rootPath)).toContain('Unsupported manifest policyVersion: expected 1, received 2')
  })

  it('rejects duplicate record IDs and paths escaping the repository', async () => {
    const { rootPath } = createRepository()
    const manifestPath = 'docs/security/review-attestations.json'
    const valid = JSON.parse(readFileSync(path.join(rootPath, manifestPath), 'utf8'))

    write(
      rootPath,
      manifestPath,
      JSON.stringify({
        ...valid,
        records: [...valid.records, { id: 'baseline-review', path: 'docs/security/review-attestations/another.json' }]
      })
    )
    expect(await checkThreatModel(rootPath)).toContain('Duplicate record ID in manifest: baseline-review')

    write(
      rootPath,
      manifestPath,
      JSON.stringify({
        ...valid,
        records: [{ id: 'escaped', path: '../escaped-record.json' }]
      })
    )
    expect(await checkThreatModel(rootPath)).toContain('Manifest record path escapes repository: ../escaped-record.json')
  })

  it('normalizes manifest identifiers and paths before duplicate checks', async () => {
    const { rootPath } = createRepository()
    const manifestPath = 'docs/security/review-attestations.json'
    const valid = JSON.parse(readFileSync(path.join(rootPath, manifestPath), 'utf8'))
    write(
      rootPath,
      manifestPath,
      JSON.stringify({
        ...valid,
        activeReviewId: ' baseline-review ',
        records: [...valid.records, { id: ' baseline-review ', path: ` ${valid.records[0].path} ` }]
      })
    )

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Manifest activeReviewId must not contain leading or trailing whitespace')
    expect(failures).toContain('Manifest record reference id at index 1 must not contain leading or trailing whitespace')
    expect(failures).toContain('Duplicate record ID in manifest: baseline-review')
    expect(failures).toContain('Manifest record reference path must not contain leading or trailing whitespace for id: baseline-review')
    expect(failures).toContain(`Duplicate record path in manifest: ${valid.records[0].path}`)
  })

  it('rejects non-canonical manifest threatModelPath', async () => {
    const { rootPath } = createRepository()
    const manifestPath = 'docs/security/review-attestations.json'
    const valid = JSON.parse(readFileSync(path.join(rootPath, manifestPath), 'utf8'))
    write(rootPath, manifestPath, JSON.stringify({ ...valid, threatModelPath: 'docs/security/other-model.md' }))
    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Manifest threatModelPath must be canonical literal "docs/security/threat-model.md", received: docs/security/other-model.md')
  })

  it('rejects symlink escapes and symlinked record/model files (TMG-004)', async () => {
    const { rootPath } = createRepository()
    const outside = mkdtempSync(path.join(tmpdir(), 'threat-outside-'))
    temporaryDirectories.push(outside)

    write(outside, 'fake-record.json', '{"schemaVersion": 1}\n')

    // leaf symlink pointing outside
    symlinkSync(path.join(outside, 'fake-record.json'), path.join(rootPath, 'docs/security/review-attestations/escaped-symlink.json'))

    const manifestPath = 'docs/security/review-attestations.json'
    const valid = JSON.parse(readFileSync(path.join(rootPath, manifestPath), 'utf8'))
    write(
      rootPath,
      manifestPath,
      JSON.stringify({
        ...valid,
        records: [...valid.records, { id: 'escaped-symlink', path: 'docs/security/review-attestations/escaped-symlink.json' }]
      })
    )

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Record file must not be a symbolic link: docs/security/review-attestations/escaped-symlink.json'))).toBe(true)
  })

  it('rejects activeReviewId that does not exist in manifest records', async () => {
    const { rootPath } = createRepository()
    const manifestPath = 'docs/security/review-attestations.json'
    const valid = JSON.parse(readFileSync(path.join(rootPath, manifestPath), 'utf8'))
    write(rootPath, manifestPath, JSON.stringify({ ...valid, activeReviewId: 'nonexistent-id' }))

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Active review ID "nonexistent-id" is not present in manifest records')
  })

  it('enforces working-tree-audit ineligibility and canonical algorithm (TMG-006)', async () => {
    const { rootPath, reviewedRevision, threatModelDigest } = createRepository()
    const stagedRecord = {
      schemaVersion: 2,
      id: 'staged-audit',
      kind: 'working-tree-audit',
      repository: CANONICAL_REPOSITORY,
      policyVersion: 1,
      threatModelDigest,
      reviewer: {
        identity: 'Maintainer Staged Audit',
        reviewedAt: '2026-09-08'
      },
      releaseEligible: true,
      findings: [],
      evidencePaths: ['server/core/auth.ts'],
      source: {
        baseRevision: reviewedRevision,
        fingerprint: '3adffcba7255a3f88ec490ceffefe6f826e9508a',
        fingerprintAlgorithm: 'sha256'
      }
    }
    write(rootPath, 'docs/security/review-attestations/staged-audit.json', `${JSON.stringify(stagedRecord, null, 2)}\n`)
    write(
      rootPath,
      'docs/security/review-attestations.json',
      JSON.stringify({
        schemaVersion: 2,
        policyVersion: 1,
        threatModelPath: 'docs/security/threat-model.md',
        activeReviewId: 'baseline-review',
        records: [
          { id: 'baseline-review', path: 'docs/security/review-attestations/baseline-review.json' },
          { id: 'staged-audit', path: 'docs/security/review-attestations/staged-audit.json' }
        ]
      })
    )

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Working-tree-audit record staged-audit must declare releaseEligible as false')
    expect(failures).toContain(
      `Working-tree-audit record staged-audit source.fingerprintAlgorithm must be "${CANONICAL_FINGERPRINT_ALGORITHM}", received: sha256`
    )
  })

  it('rejects wrong coveredTreeDigest or tampering in review record', async () => {
    const { rootPath } = createRepository()
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.source.coveredTreeDigest = '0000000000000000000000000000000000000000000000000000000000000000'
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('coveredTreeDigest does not match reviewed revision tree'))).toBe(true)
  })

  it('rejects invalid or duplicate finding IDs in review record', async () => {
    const { rootPath } = createRepository()
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.findings = [{ id: 'SEC-1', severity: 'Low', disposition: 'invalid-disposition', evidencePaths: [] }]
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)
    expect(await checkThreatModel(rootPath)).toContain(
      'Record baseline-review finding SEC-1 disposition must be blocking, accepted, or resolved; received: invalid-disposition'
    )

    record.findings = [
      { id: 'SEC-1', severity: 'Low', disposition: 'resolved', evidencePaths: [] },
      { id: 'SEC-1', severity: 'Medium', disposition: 'resolved', evidencePaths: [] }
    ]
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)
    expect(await checkThreatModel(rootPath)).toContain('Record baseline-review contains duplicate finding ID: SEC-1')
  })

  it('enforces exact valid and invalid reviewedAt date behavior', async () => {
    const { rootPath } = createRepository()
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const original = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))

    // Non-canonical / invalid format
    write(rootPath, recordPath, JSON.stringify({ ...original, reviewer: { ...original.reviewer, reviewedAt: '2026/09/08' } }))
    let failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Record baseline-review reviewer.reviewedAt must be an exact YYYY-MM-DD date, received: "2026/09/08"')

    // Impossible date: Feb 30
    write(rootPath, recordPath, JSON.stringify({ ...original, reviewer: { ...original.reviewer, reviewedAt: '2026-02-30' } }))
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Record baseline-review reviewer.reviewedAt is not a valid calendar date: "2026-02-30"')

    // Non-leap year Feb 29: 2025-02-29
    write(rootPath, recordPath, JSON.stringify({ ...original, reviewer: { ...original.reviewer, reviewedAt: '2025-02-29' } }))
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Record baseline-review reviewer.reviewedAt is not a valid calendar date: "2025-02-29"')

    // Invalid month: 2026-13-01
    write(rootPath, recordPath, JSON.stringify({ ...original, reviewer: { ...original.reviewer, reviewedAt: '2026-13-01' } }))
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Record baseline-review reviewer.reviewedAt is not a valid calendar date: "2026-13-01"')

    // Invalid day: April 31
    write(rootPath, recordPath, JSON.stringify({ ...original, reviewer: { ...original.reviewer, reviewedAt: '2026-04-31' } }))
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Record baseline-review reviewer.reviewedAt is not a valid calendar date: "2026-04-31"')

    // Valid leap year: 2024-02-29
    write(rootPath, recordPath, JSON.stringify({ ...original, reviewer: { ...original.reviewer, reviewedAt: '2024-02-29' } }))
    failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('reviewedAt'))).toBe(false)
  })
})

describe('threat-model content digest binding', () => {
  it('rejects modified threat-model content when digest is not updated in active record', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'docs/security/threat-model.md', `${normativeThreatModel()}\n<!-- unauthorized modification -->\n`)
    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Threat-model content digest does not match active review record'))).toBe(true)
  })
})

describe('committed coverage, drift enforcement, and dev build inputs', () => {
  it('accepts documentation-only successor commits when covered digests match', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'docs/operator/deploy.md', '# Deploy notes\n')
    write(rootPath, 'docs/security/threat-model-notes.md', '# Notes\n')
    commit(rootPath, 'docs: add deploy and security notes')

    expect(await checkThreatModel(rootPath)).toEqual([])
  })

  it('rejects committed dev/build drift (governance finding)', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'dev/build/create-linux-bundle.sh', '#!/bin/sh\necho "modified bundle"\n')
    commit(rootPath, 'modify dev build bundle script')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Covered-tree digest of HEAD does not match active review record'))).toBe(true)
    expect(failures.some(f => f.includes('dev/build/create-linux-bundle.sh'))).toBe(true)
  })

  it('rejects committed checker drift', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'server/scripts/check-threat-model.ts', 'export const changed = true\n')
    commit(rootPath, 'modify checker script')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Covered-tree digest of HEAD does not match active review record'))).toBe(true)
    expect(failures.some(f => f.includes('server/scripts/check-threat-model.ts'))).toBe(true)
  })

  it('rejects committed test drift', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'server/test/scripts/check-threat-model.test.ts', 'export const testChanged = true\n')
    commit(rootPath, 'modify checker test')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Covered-tree digest of HEAD does not match active review record'))).toBe(true)
    expect(failures.some(f => f.includes('server/test/scripts/check-threat-model.test.ts'))).toBe(true)
  })

  it('rejects committed workflow drift', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.github/workflows/build.yml', 'name: modified build\n')
    commit(rootPath, 'modify workflow')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Covered-tree digest of HEAD does not match active review record'))).toBe(true)
    expect(failures.some(f => f.includes('.github/workflows/build.yml'))).toBe(true)
  })

  it('rejects committed deploy drift', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'deploy/docker-compose.yml', 'version: "3.9"\n')
    commit(rootPath, 'modify deploy config')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Covered-tree digest of HEAD does not match active review record'))).toBe(true)
    expect(failures.some(f => f.includes('deploy/docker-compose.yml'))).toBe(true)
  })
})

describe('gitlink and submodule security boundary handling (TMG-002)', () => {
  it('includes gitlinks in tree digest and detects gitlink add, change, and remove', () => {
    const { rootPath } = createRepository()

    // Create a submodule repo
    const subRepoPath = mkdtempSync(path.join(tmpdir(), 'sub-repo-'))
    temporaryDirectories.push(subRepoPath)
    runGit(subRepoPath, ['init', '--quiet'])
    runGit(subRepoPath, ['config', 'user.name', 'Sub Test'])
    runGit(subRepoPath, ['config', 'user.email', 'sub@example.invalid'])
    write(subRepoPath, 'sub.txt', 'sub content v1\n')
    runGit(subRepoPath, ['add', '.'])
    runGit(subRepoPath, ['commit', '-m', 'sub v1'])

    const digestBefore = computeCoveredTreeDigest(rootPath, 'HEAD')

    // Add submodule under dev/submod (boundary path!)
    runGit(rootPath, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepoPath, 'dev/submod'])
    commit(rootPath, 'add submodule')

    const digestAfterAdd = computeCoveredTreeDigest(rootPath, 'HEAD')
    expect(digestAfterAdd).not.toBe(digestBefore)

    // Change submodule commit
    write(subRepoPath, 'sub.txt', 'sub content v2\n')
    runGit(subRepoPath, ['add', '.'])
    runGit(subRepoPath, ['commit', '-m', 'sub v2'])
    runGit(rootPath, ['-C', 'dev/submod', 'pull'])
    runGit(rootPath, ['add', 'dev/submod'])
    commit(rootPath, 'update submodule')

    const digestAfterChange = computeCoveredTreeDigest(rootPath, 'HEAD')
    expect(digestAfterChange).not.toBe(digestAfterAdd)

    // Remove submodule
    runGit(rootPath, ['rm', 'dev/submod'])
    commit(rootPath, 'remove submodule')

    const digestAfterRemove = computeCoveredTreeDigest(rootPath, 'HEAD')
    expect(digestAfterRemove).not.toBe(digestAfterChange)
  })

  it('detects dirty submodule working tree via --ignore-submodules=none (TMG-003)', async () => {
    const { rootPath } = createRepository()
    const subRepoPath = mkdtempSync(path.join(tmpdir(), 'sub-repo-dirty-'))
    temporaryDirectories.push(subRepoPath)
    runGit(subRepoPath, ['init', '--quiet'])
    runGit(subRepoPath, ['config', 'user.name', 'Sub Test'])
    runGit(subRepoPath, ['config', 'user.email', 'sub@example.invalid'])
    write(subRepoPath, 'sub.txt', 'sub content\n')
    runGit(subRepoPath, ['add', '.'])
    runGit(subRepoPath, ['commit', '-m', 'sub v1'])

    runGit(rootPath, ['-c', 'protocol.file.allow=always', 'submodule', 'add', subRepoPath, 'dev/submod'])
    commit(rootPath, 'add sub')

    // Modify a file inside dev/submod without committing
    write(rootPath, 'dev/submod/sub.txt', 'sub content modified dirty\n')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('dev/submod'))).toBe(true)
  })
})

describe('working-tree dirty boundary drift, ignored files, and index flags (TMG-003)', () => {
  it('rejects unstaged modification in security boundary during ordinary check', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'server/core/auth.ts', 'export const authenticated = false\n')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Unstaged boundary changes:\n- server/core/auth.ts'))).toBe(true)
  })

  it('rejects staged modification in security boundary during ordinary check', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'server/core/auth.ts', 'export const authenticated = false\n')
    runGit(rootPath, ['add', 'server/core/auth.ts'])

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Staged boundary changes:\n- server/core/auth.ts'))).toBe(true)
  })

  it('rejects untracked file in security boundary during ordinary check', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'server/core/new-secret.ts', 'export const secret = 42\n')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Untracked boundary files:\n- server/core/new-secret.ts'))).toBe(true)
  })

  it('detects and rejects ignored boundary file during ordinary check (TMG-003)', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '*.secret\n')
    commit(rootPath, 'add gitignore')

    write(rootPath, 'server/core/auth.secret', 'secret-key\n')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/core/auth.secret'))).toBe(true)
  })

  it('permits ignored server/.build-metadata.json as a canonical generated artifact exception', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '/server/.build-metadata.json\n')
    const headRev = commit(rootPath, 'add gitignore with metadata exception')

    write(rootPath, 'server/.build-metadata.json', `${JSON.stringify({ revision: headRev, date: '2026-09-08T00:00:00.000Z' }, null, 2)}\n`)

    const failures = await checkThreatModel(rootPath)
    expect(failures).toEqual([])
  })

  it('rejects other ignored boundary files even when server/.build-metadata.json is ignored', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '/server/.build-metadata.json\n*.secret\n')
    const headRev = commit(rootPath, 'add gitignore')

    write(rootPath, 'server/.build-metadata.json', `${JSON.stringify({ revision: headRev, date: '2026-09-08T00:00:00.000Z' }, null, 2)}\n`)
    write(rootPath, 'server/core/auth.secret', 'secret-key\n')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/core/auth.secret'))).toBe(true)
    expect(failures.some(f => f.includes('server/.build-metadata.json'))).toBe(false)
  })

  it('rejects ignored server/.build-metadata.json when it is a symlink', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '/server/.build-metadata.json\n')
    commit(rootPath, 'add gitignore')

    symlinkSync('/dev/null', path.join(rootPath, 'server/.build-metadata.json'))

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Build metadata file must not be a symbolic link: server/.build-metadata.json')
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/.build-metadata.json'))).toBe(true)
  })

  it('rejects ignored server/.build-metadata.json when malformed or not an object', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '/server/.build-metadata.json\n')
    commit(rootPath, 'add gitignore')

    write(rootPath, 'server/.build-metadata.json', '{ malformed json\n')
    let failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Malformed build metadata JSON at server/.build-metadata.json'))).toBe(true)
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/.build-metadata.json'))).toBe(true)

    write(rootPath, 'server/.build-metadata.json', 'null\n')
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Build metadata at server/.build-metadata.json must be a JSON object')
  })

  it('rejects ignored server/.build-metadata.json when extra keys or missing keys are present', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '/server/.build-metadata.json\n')
    const headRev = commit(rootPath, 'add gitignore')

    write(
      rootPath,
      'server/.build-metadata.json',
      `${JSON.stringify({ revision: headRev, date: '2026-09-08T00:00:00.000Z', extraKey: 'unexpected' }, null, 2)}\n`
    )
    let failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Build metadata at server/.build-metadata.json contains unexpected keys: extraKey')
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/.build-metadata.json'))).toBe(true)

    write(rootPath, 'server/.build-metadata.json', `${JSON.stringify({ revision: headRev }, null, 2)}\n`)
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Build metadata at server/.build-metadata.json is missing "date" key')
  })

  it('rejects ignored server/.build-metadata.json when revision does not match HEAD', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '/server/.build-metadata.json\n')
    commit(rootPath, 'add gitignore')

    write(
      rootPath,
      'server/.build-metadata.json',
      `${JSON.stringify({ revision: '0000000000000000000000000000000000000000', date: '2026-09-08T00:00:00.000Z' }, null, 2)}\n`
    )
    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Build metadata revision does not match current HEAD'))).toBe(true)
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/.build-metadata.json'))).toBe(true)
  })

  it('rejects ignored server/.build-metadata.json when date is not a valid canonical ISO timestamp', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', '/server/.build-metadata.json\n')
    const headRev = commit(rootPath, 'add gitignore')

    // Arbitrary non-date string
    write(rootPath, 'server/.build-metadata.json', `${JSON.stringify({ revision: headRev, date: 'invalid-date' }, null, 2)}\n`)
    let failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Build metadata date is not a valid canonical ISO timestamp: invalid-date')
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/.build-metadata.json'))).toBe(true)

    // Impossible calendar date in ISO timestamp: Feb 30
    write(rootPath, 'server/.build-metadata.json', `${JSON.stringify({ revision: headRev, date: '2026-02-30T00:00:00.000Z' }, null, 2)}\n`)
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Build metadata date is not a valid canonical ISO timestamp: 2026-02-30T00:00:00.000Z')

    // Date without time
    write(rootPath, 'server/.build-metadata.json', `${JSON.stringify({ revision: headRev, date: '2026-09-08' }, null, 2)}\n`)
    failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Build metadata date is not a valid canonical ISO timestamp: 2026-09-08')
  })

  it('rejects arbitrary ignored boundary file under server prefix when no exception applies', async () => {
    const { rootPath } = createRepository()
    write(rootPath, '.gitignore', 'server/unexplained-ignored.ts\n')
    commit(rootPath, 'add gitignore with unexpected ignored file')

    write(rootPath, 'server/unexplained-ignored.ts', 'export const evil = true\n')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Ignored boundary files:\n- server/unexplained-ignored.ts'))).toBe(true)
  })

  it('rejects untracked server/.build-metadata.json when not ignored', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'server/.build-metadata.json', '{"revision":"test-rev","date":"2026-09-08T00:00:00.000Z"}\n')

    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Working tree has dirty security-boundary drift'))).toBe(true)
    expect(failures.some(f => f.includes('Untracked boundary files:\n- server/.build-metadata.json'))).toBe(true)
  })

  it('accepts only the exact canonical timestamp representation emitted by Date.toISOString()', () => {
    expect(isValidIsoTimestamp('2026-09-08T00:00:00.000Z')).toBe(true)
    expect(isValidIsoTimestamp('2026-09-08T01:00:00+01:00')).toBe(false)
    expect(isValidIsoTimestamp('2026-09-08T00:00:00.1Z')).toBe(false)
    expect(isValidIsoTimestamp('2026-09-08T00:00:00Z')).toBe(false)
  })

  it('detects and rejects assume-unchanged and skip-worktree index flags (TMG-003)', async () => {
    const { rootPath } = createRepository()

    runGit(rootPath, ['update-index', '--assume-unchanged', 'server/core/auth.ts'])
    let failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Git index contains assume-unchanged or skip-worktree entries:\n- server/core/auth.ts (assume-unchanged)'))).toBe(true)

    runGit(rootPath, ['update-index', '--no-assume-unchanged', 'server/core/auth.ts'])
    runGit(rootPath, ['update-index', '--skip-worktree', 'server/core/auth.ts'])
    failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('Git index contains assume-unchanged or skip-worktree entries:\n- server/core/auth.ts (skip-worktree)'))).toBe(true)
  })

  it('permits untracked non-boundary documentation during ordinary check', async () => {
    const { rootPath } = createRepository()
    write(rootPath, 'docs/scratchpad.md', '# Scratchpad notes\n')

    expect(await checkThreatModel(rootPath)).toEqual([])
  })
})
describe('maintainer release integrity enforcement (TMG-001)', () => {
  it('passes release check for a schema-2 maintainer record without external authority', async () => {
    const { rootPath } = createRepository({ releaseEligible: true })
    expect(await checkThreatModel(rootPath, { release: true })).toEqual([])
  })

  it('rejects schema-1 records without conversion', async () => {
    const { rootPath } = createRepository()
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.schemaVersion = 1
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)
    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Record baseline-review has unsupported schemaVersion: 1')
  })

  it('rejects tampered covered digest and escaping evidence', async () => {
    const { rootPath } = createRepository({ releaseEligible: true })
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.source.coveredTreeDigest = '0'.repeat(64)
    record.evidencePaths = ['../outside-evidence.txt']
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)
    const failures = await checkThreatModel(rootPath)
    expect(failures.some(f => f.includes('coveredTreeDigest does not match reviewed revision tree'))).toBe(true)
    expect(failures).toContain('Active record evidence path escapes repository: ../outside-evidence.txt')
  })

  it('requires active record evidence and rejects an active working-tree audit', async () => {
    const { rootPath, reviewedRevision, threatModelDigest } = createRepository({ releaseEligible: true })
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const auditRecord = {
      schemaVersion: 2,
      id: 'baseline-review',
      kind: 'working-tree-audit',
      repository: CANONICAL_REPOSITORY,
      policyVersion: 1,
      threatModelDigest,
      reviewer: {
        identity: 'Maintainer audit',
        reviewedAt: '2026-09-08'
      },
      releaseEligible: false,
      findings: [],
      evidencePaths: ['server/core/auth.ts'],
      source: {
        baseRevision: reviewedRevision,
        fingerprint: '3adffcba7255a3f88ec490ceffefe6f826e9508a',
        fingerprintAlgorithm: CANONICAL_FINGERPRINT_ALGORITHM
      }
    }
    write(rootPath, recordPath, `${JSON.stringify(auditRecord, null, 2)}\n`)
    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Active review record must have kind "source-review", found: "working-tree-audit"')

    const sourceRecord = {
      ...auditRecord,
      kind: 'source-review',
      releaseEligible: true,
      source: {
        revision: reviewedRevision,
        baseRevision: reviewedRevision,
        coveredTreeDigest: computeCoveredTreeDigest(rootPath, reviewedRevision)
      },
      evidencePaths: []
    }
    write(rootPath, recordPath, `${JSON.stringify(sourceRecord, null, 2)}\n`)
    const evidenceFailures = await checkThreatModel(rootPath)
    expect(evidenceFailures).toContain('Active review record must declare at least one evidence path')
  })
  it('rejects a directory as active-record evidence', async () => {
    const { rootPath } = createRepository({ releaseEligible: true })
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.evidencePaths = ['docs/security']
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Active record evidence path must be a regular file: docs/security')
  })

  it('rejects a directory as finding evidence', async () => {
    const { rootPath } = createRepository({
      releaseEligible: true,
      findings: [
        {
          id: 'SEC-DIRECTORY-001',
          severity: 'Low',
          disposition: 'resolved',
          evidencePaths: ['docs/security']
        }
      ]
    })

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain('Finding SEC-DIRECTORY-001 evidence path must be a regular file: docs/security')
  })

  it('rejects an in-repository symlink as active-record evidence', async () => {
    const { rootPath } = createRepository({ releaseEligible: true })
    const evidencePath = 'docs/security/active-evidence-link'
    symlinkSync(path.join(rootPath, 'server/core/auth.ts'), path.join(rootPath, evidencePath))
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.evidencePaths = [evidencePath]
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain(`Active record evidence path must not be a symbolic link: ${evidencePath}`)
  })

  it('rejects an in-repository symlink as finding evidence', async () => {
    const { rootPath } = createRepository({
      releaseEligible: true,
      findings: [
        {
          id: 'SEC-SYMLINK-001',
          severity: 'Low',
          disposition: 'resolved',
          evidencePaths: ['server/core/auth.ts']
        }
      ]
    })
    const evidencePath = 'docs/security/finding-evidence-link'
    symlinkSync(path.join(rootPath, 'server/core/auth.ts'), path.join(rootPath, evidencePath))
    const recordPath = 'docs/security/review-attestations/baseline-review.json'
    const record = JSON.parse(readFileSync(path.join(rootPath, recordPath), 'utf8'))
    record.findings[0].evidencePaths = [evidencePath]
    write(rootPath, recordPath, `${JSON.stringify(record, null, 2)}\n`)

    const failures = await checkThreatModel(rootPath)
    expect(failures).toContain(`Finding SEC-SYMLINK-001 evidence path must not be a symbolic link: ${evidencePath}`)
  })

  it('accepts regular files as active-record and finding evidence', async () => {
    const { rootPath } = createRepository({
      releaseEligible: true,
      findings: [
        {
          id: 'SEC-REGULAR-001',
          severity: 'Low',
          disposition: 'resolved',
          evidencePaths: ['server/core/auth.ts']
        }
      ]
    })

    expect(await checkThreatModel(rootPath)).toEqual([])
  })

  it('accepts an existing directory as a threat-model citation', async () => {
    const { rootPath } = createRepository({ extraEvidence: ', `docs/security`' })

    expect(await checkThreatModel(rootPath)).toEqual([])
  })
})

describe('release mode enforcement', () => {
  it('rejects untracked non-boundary file during release check', async () => {
    const { rootPath } = createRepository({ releaseEligible: true })

    write(rootPath, 'docs/scratchpad.md', '# Scratchpad notes\n')

    const failures = await checkThreatModel(rootPath, { release: true })
    expect(failures.some(f => f.includes('Release check requires a clean repository, but dirty paths were found'))).toBe(true)
    expect(failures.some(f => f.includes('Untracked files:\n- docs/scratchpad.md'))).toBe(true)
  })

  it('enforces the releaseEligible flag during release check', async () => {
    const { rootPath } = createRepository({ releaseEligible: false })
    const failures = await checkThreatModel(rootPath, { release: true })
    expect(failures).toContain('Active review record is not marked releaseEligible')
  })

  it('rejects unresolved blocking findings during release check while ordinary check succeeds', async () => {
    const { rootPath } = createRepository({
      releaseEligible: true,
      findings: [
        {
          id: 'SEC-RELEASE-001',
          severity: 'Release blocker',
          disposition: 'blocking',
          evidencePaths: ['server/core/auth.ts']
        },
        {
          id: 'SEC-ADAPTER-001',
          severity: 'Medium',
          disposition: 'accepted',
          evidencePaths: ['server/core/auth.ts']
        }
      ]
    })

    expect(await checkThreatModel(rootPath)).toEqual([])
    const releaseFailures = await checkThreatModel(rootPath, { release: true })
    expect(releaseFailures).toContain('Release blocked by unresolved findings: SEC-RELEASE-001')
  })
})
