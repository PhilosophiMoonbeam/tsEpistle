import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  parseChangedPaths,
  parseScarlettLedger,
  summarizeTopLevelAreas
} from '../scripts/check-scarlett-upstream.ts'

describe('Scarlett upstream intake', () => {
  it('validates the tracked candidate ledger', async () => {
    const input: unknown = JSON.parse(await readFile('docs/.planning/scarlett-upstream-ledger.json', 'utf8'))
    const ledger = parseScarlettLedger(input)

    expect(ledger.upstream.recordedTip).toHaveLength(40)
    expect(ledger.candidates.length).toBeGreaterThan(20)
    expect(ledger.candidates.some(candidate => candidate.id === 'postgresql-only-platform')).toBe(true)
    expect(ledger.candidates.every(candidate => candidate.contract.length > 40)).toBe(true)
  })

  it('rejects duplicate candidate identities', async () => {
    const input = JSON.parse(await readFile('docs/.planning/scarlett-upstream-ledger.json', 'utf8')) as {
      candidates: unknown[]
    }
    input.candidates.push(input.candidates[0])

    expect(() => parseScarlettLedger(input)).toThrow(/Duplicate Scarlett candidate id/)
  })

  it('summarizes changed and renamed paths by destination area', () => {
    const paths = parseChangedPaths([
      'M\tbackend/core/db.ts',
      'A\tfrontend/src/new.test.ts',
      'R100\tfrontend/src/old.ts\tshared/new.ts'
    ].join('\n'))

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
