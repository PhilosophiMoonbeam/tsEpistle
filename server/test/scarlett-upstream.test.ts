import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from './bun-test.mts'

import {
  compareCommitCoverage,
  parseChangedPaths,
  parseScarlettLedger,
  summarizeTopLevelAreas
} from '../scripts/check-scarlett-upstream.ts'

describe('Scarlett upstream intake', () => {

  it('rejects duplicate candidate identities', async () => {
    const input = parseScarlettLedger(JSON.parse(await readFile('docs/.planning/scarlett-upstream-ledger.json', 'utf8')))
    input.candidates.push(input.candidates[0])

    expect(() => parseScarlettLedger(input)).toThrow()
  })

  it('rejects duplicate commit coverage', async () => {
    const duplicate = parseScarlettLedger(JSON.parse(await readFile('docs/.planning/scarlett-upstream-ledger.json', 'utf8')))
    duplicate.coverage.push(duplicate.coverage[0])
    expect(() => parseScarlettLedger(duplicate)).toThrow()
  })

  it('checks complete and omitted coverage against an isolated native Git history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wiki-scarlett-coverage-'))
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Coverage fixture',
      GIT_AUTHOR_EMAIL: 'coverage@example.test',
      GIT_COMMITTER_NAME: 'Coverage fixture',
      GIT_COMMITTER_EMAIL: 'coverage@example.test',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
    }
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory, env, encoding: 'utf8'
    }).trim()
    try {
      git('init', '--quiet', '--initial-branch=main', '--object-format=sha1')
      const commits = ['audit baseline', 'historical review', 'candidate'].map(message => {
        git('commit', '--quiet', '--allow-empty', '--no-gpg-sign', '--message', message)
        return git('rev-parse', 'HEAD')
      })
      const [baseline, historical, candidate] = commits
      const ledger = {
        schemaVersion: 2,
        upstream: {
          repository: 'https://example.test/upstream.git', branch: 'main',
          auditBaseline: baseline, candidateBaseline: historical, recordedTip: candidate,
          recordedAt: '2026-01-01T00:00:00Z', lastFetchedAt: '2026-01-01T00:00:00Z',
          historicalReview: {
            recordedTip: historical, commitCount: 1, lastReviewed: '2026-01-01',
            contract: 'Review the historical commit.'
          }
        },
        forkCheckpoint: baseline,
        candidates: [{
          id: 'native-fixture', commits: [candidate], category: 'fixture', disposition: 'adapt',
          state: 'active', workstream: 'fixture', contract: 'Review the candidate commit.',
          lastReviewed: '2026-01-01'
        }],
        coverage: [
          { commit: historical, candidateIds: [], classification: 'reviewed', reason: 'Historical review.' },
          { commit: candidate, candidateIds: ['native-fixture'] }
        ]
      }
      // Only the child changes Git's working directory; other tests keep theirs.
      const script = `
        import { parseScarlettLedger, verifyLedgerCoverage } from ${JSON.stringify(new URL('../scripts/check-scarlett-upstream.ts', import.meta.url).href)};
        const ledger = parseScarlettLedger(${JSON.stringify(ledger)});
        const complete = verifyLedgerCoverage(ledger);
        ledger.coverage.shift();
        let omitted = null;
        try { verifyLedgerCoverage(ledger); } catch (error) { omitted = error.message; }
        console.log(JSON.stringify({ complete, omitted }));
      `
      const result = JSON.parse(execFileSync(process.execPath, ['--eval', script], { cwd: directory, env, encoding: 'utf8' }))
      expect(result.complete).toEqual({ auditedCommits: 2, historicalCommits: 1, candidateCommits: 1 })
      expect(result.omitted).toContain(historical)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports missing and unrelated commits in candidate coverage', () => {
    expect(compareCommitCoverage(['a', 'b', 'c'], ['a', 'c', 'd', 'a'])).toEqual({
      missing: ['b'],
      unexpected: ['d']
    })
  })

  it('summarizes changed and renamed paths by destination area', () => {
    const paths = parseChangedPaths(['M\tbackend/core/db.ts', 'A\tfrontend/src/new.test.ts', 'R100\tfrontend/src/old.ts\tshared/new.ts'].join('\n'))

    expect(paths).toEqual([
      { status: 'M', path: 'backend/core/db.ts' },
      { status: 'A', path: 'frontend/src/new.test.ts' },
      { status: 'R100', path: 'shared/new.ts' }
    ])
    expect(summarizeTopLevelAreas(paths)).toEqual([
      { area: 'backend', files: 1 },
      { area: 'frontend', files: 1 },
      { area: 'shared', files: 1 }
    ])
  })
})
