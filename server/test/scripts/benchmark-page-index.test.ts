import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import { createBenchmarkReport, publishBenchmarkReport, type PrincipalMetrics } from '../../scripts/benchmark-page-index.ts'

const temporaryDirectories: string[] = []

const metric = (overrides: Partial<PrincipalMetrics> = {}): PrincipalMetrics => ({
  principal: 'anonymous',
  items: 200,
  p50Milliseconds: 8,
  p95Milliseconds: 12.5,
  p99Milliseconds: 14,
  maxHeapGrowthBytes: 4096,
  queriesPerIteration: 2,
  peakConnectionsUsed: 1,
  candidatePlanRows: 4800,
  rowsRemovedByFilter: 0,
  sharedBlocksRead: 3,
  sharedBlocksHit: 27,
  ...overrides
})

const reportFor = (principals: PrincipalMetrics[], maxP95Milliseconds: number) =>
  createBenchmarkReport({
    postgresVersion: '15.14',
    dataset: { pages: 7200, benchmarkLocalePages: 4800, overflowCandidates: 5000 },
    iterations: 30,
    warmups: 5,
    maxP95Milliseconds,
    principals,
    projectionRequired: false
  })

const reportPath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-page-index-benchmark-'))
  temporaryDirectories.push(directory)
  return join(directory, 'report.json')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('page-index benchmark evidence', () => {
  it('atomically retains measured p95 and its impossible threshold before failing', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const outputPath = await reportPath()
    await writeFile(outputPath, '{"stale":true}\n')
    const report = reportFor([metric()], 0)

    await expect(publishBenchmarkReport(report, outputPath)).rejects.toThrow('Page index benchmark failed')

    const written = JSON.parse(await readFile(outputPath, 'utf8'))
    expect(written.status).toBe('failed')
    expect(written.principals[0].p95Milliseconds).toBe(12.5)
    expect(written.thresholds.maxP95Milliseconds).toBe(0)
    expect(written.violatedInvariants).toEqual([
      {
        invariant: 'p95Milliseconds <= thresholds.maxP95Milliseconds',
        principal: 'anonymous',
        measured: 12.5,
        threshold: 0
      }
    ])
    expect(await readdir(dirname(outputPath))).toEqual(['report.json'])
  })

  it('writes an explicit successful report with all measurements and thresholds', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const outputPath = await reportPath()
    const principals = [metric()]
    const report = reportFor(principals, 250)

    await publishBenchmarkReport(report, outputPath)

    const written = JSON.parse(await readFile(outputPath, 'utf8'))
    expect(written).toEqual(report)
    expect(written.status).toBe('passed')
    expect(written.thresholds).toEqual({
      maxP95Milliseconds: 250,
      queriesPerIteration: 2,
      maxPeakConnectionsUsed: 1
    })
    expect(written.principals).toEqual(principals)
    expect(written.violatedInvariants).toEqual([])
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(report, null, 2)}\n`)
  })
})
