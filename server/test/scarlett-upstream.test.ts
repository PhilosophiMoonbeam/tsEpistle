import { readFile } from 'node:fs/promises'

import { describe, expect, it } from './bun-test.mts'

import {
  compareCommitCoverage,
  parseChangedPaths,
  parseScarlettLedger,
  summarizeTopLevelAreas,
  verifyLedgerCoverage
} from '../scripts/check-scarlett-upstream.ts'

describe('Scarlett upstream intake', () => {
  it('proves exact Git identity and coverage for the tracked audit range', async () => {
    const input: unknown = JSON.parse(await readFile('docs/.planning/scarlett-upstream-ledger.json', 'utf8'))
    const ledger = parseScarlettLedger(input)

    expect(verifyLedgerCoverage(ledger)).toEqual({
      auditedCommits: 401,
      historicalCommits: 270,
      candidateCommits: 120
    })
  })

  it('rejects duplicate candidate identities', async () => {
    const input = JSON.parse(await readFile('docs/.planning/scarlett-upstream-ledger.json', 'utf8')) as {
      candidates: unknown[]
    }
    input.candidates.push(input.candidates[0])

    expect(() => parseScarlettLedger(input)).toThrow(/Duplicate Scarlett candidate id/)
  })

  it('rejects duplicate and omitted commit coverage', async () => {
    const source = JSON.parse(await readFile('docs/.planning/scarlett-upstream-ledger.json', 'utf8')) as {
      coverage: Array<{ commit: string }>
    }
    const duplicate = structuredClone(source)
    duplicate.coverage.push(duplicate.coverage[0])
    expect(() => parseScarlettLedger(duplicate)).toThrow(/Duplicate Scarlett coverage commit/)

    const omitted = structuredClone(source)
    omitted.coverage.shift()
    expect(() => verifyLedgerCoverage(parseScarlettLedger(omitted))).toThrow(/audit coverage mismatch; missing:/)
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
