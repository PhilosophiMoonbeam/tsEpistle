import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import {
  SITE_LOGO_PROCESSING_DEFAULT_THRESHOLDS,
  createSiteLogoProcessingBenchmarkReport,
  nearestRankPercentile,
  publishSiteLogoProcessingBenchmarkReport,
  summarizeNearestRank
} from '../../scripts/benchmark-site-logo-processing.ts'
import type {
  SiteLogoProcessingBenchmarkInput,
  SiteLogoProcessingCaseInput,
  SiteLogoProcessingEnvironment,
  SiteLogoProcessingSample
} from '../../scripts/benchmark-site-logo-processing.ts'

const temporaryDirectories: string[] = []

const environment: SiteLogoProcessingEnvironment = {
  runtime: { name: 'bun', version: '1.4.0' },
  operatingSystem: { platform: 'linux', release: 'test', architecture: 'x64' },
  cpu: { model: 'Test CPU', logicalCores: 8 },
  memory: { totalBytes: 16 * 1024 * 1024 * 1024 },
  libraries: { sharp: '0.34.4', libvips: '8.17.2' }
}

const samples = (outcome: SiteLogoProcessingSample['outcome'], durations = [10, 20, 30]): SiteLogoProcessingSample[] =>
  durations.map((durationMilliseconds, index) => ({
    durationMilliseconds,
    peakRssDeltaBytes: (128 + index) * 1024 * 1024,
    outcome
  }))

const cases = (): SiteLogoProcessingCaseInput[] => [
  {
    id: 'accepted-transparent-chromatic-logo',
    category: 'accepted',
    expected: { status: 'accepted' },
    fixture: { byteLength: 12_345, sha256: 'a'.repeat(64) },
    samples: samples({ status: 'accepted' })
  },
  {
    id: 'malformed-truncated-png',
    category: 'malformed',
    expected: { status: 'rejected', errorCodes: ['INVALID_IMAGE'] },
    fixture: { byteLength: 8, sha256: 'b'.repeat(64) },
    samples: samples({ status: 'rejected', errorCode: 'INVALID_IMAGE' })
  },
  {
    id: 'decompression-bomb-4097x4095-grayscale-png',
    category: 'decompression-bomb',
    expected: { status: 'rejected', errorCodes: ['INVALID_IMAGE', 'IMAGE_TOO_LARGE'] },
    fixture: { byteLength: 67_890, sha256: 'c'.repeat(64) },
    samples: samples({ status: 'rejected', errorCode: 'IMAGE_TOO_LARGE' })
  }
]

const input = (overrides: Partial<SiteLogoProcessingBenchmarkInput> = {}): SiteLogoProcessingBenchmarkInput => ({
  generatedAt: '2026-09-04T00:00:00.000Z',
  environment,
  thresholds: { ...SITE_LOGO_PROCESSING_DEFAULT_THRESHOLDS },
  iterationsPerCase: 3,
  corpusWallMilliseconds: 100,
  cases: cases(),
  ...overrides
})

const reportPath = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-site-logo-processing-benchmark-'))
  temporaryDirectories.push(directory)
  return join(directory, 'report.json')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('site logo processing benchmark evidence', () => {
  it('records exact fixture identities and isolated absolute child-process peak RSS with nearest-rank summaries', () => {
    const values = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10]

    expect(nearestRankPercentile(values, 0.5)).toBe(10)
    expect(nearestRankPercentile(values, 0.95)).toBe(19)
    expect(nearestRankPercentile(values, 0.99)).toBe(20)
    expect(summarizeNearestRank(values)).toEqual({ samples: 20, minimum: 1, p50: 10, p95: 19, p99: 20, maximum: 20 })

    const first = createSiteLogoProcessingBenchmarkReport(input())
    const second = createSiteLogoProcessingBenchmarkReport(input())

    expect(second).toEqual(first)
    expect(first.status).toBe('passed')
    expect(first.measurement).toEqual({
      concurrency: 1,
      iterationsPerCase: 3,
      processIsolation: 'fresh Bun child process per fixture iteration',
      wallClock: 'performance.now',
      peakRss: 'absolute child process.resourceUsage().maxRSS converted from KiB to bytes on Linux'
    })
    expect(first.cases.map(result => ({ id: result.id, category: result.category, status: result.status }))).toEqual([
      { id: 'accepted-transparent-chromatic-logo', category: 'accepted', status: 'passed' },
      { id: 'malformed-truncated-png', category: 'malformed', status: 'passed' },
      { id: 'decompression-bomb-4097x4095-grayscale-png', category: 'decompression-bomb', status: 'passed' }
    ])
    expect(first.cases.map(result => result.fixture)).toEqual([
      { byteLength: 12_345, sha256: 'a'.repeat(64) },
      { byteLength: 8, sha256: 'b'.repeat(64) },
      { byteLength: 67_890, sha256: 'c'.repeat(64) }
    ])
    expect(first.cases[0]?.durationMilliseconds).toEqual({ samples: 3, minimum: 10, p50: 20, p95: 30, p99: 30, maximum: 30 })
    expect(first.cases[0]?.peakRssDeltaBytes).toEqual({
      samples: 3,
      minimum: 128 * 1024 * 1024,
      p50: 129 * 1024 * 1024,
      p95: 130 * 1024 * 1024,
      p99: 130 * 1024 * 1024,
      maximum: 130 * 1024 * 1024
    })
    expect(first.cases.every(result => result.samples.length === 3 && result.thresholdViolations.length === 0)).toBe(true)
  })

  it('atomically writes measured threshold failures before returning the failing exit path', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const outputPath = await reportPath()
    const report = createSiteLogoProcessingBenchmarkReport(
      input({
        thresholds: { ...SITE_LOGO_PROCESSING_DEFAULT_THRESHOLDS, maxCaseP95Milliseconds: 25 }
      })
    )

    await expect(publishSiteLogoProcessingBenchmarkReport(report, outputPath)).rejects.toThrow('Site logo processing benchmark failed')

    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(report)
    expect(report.status).toBe('failed')
    expect(report.cases).toHaveLength(3)
    expect(report.thresholdViolations).toEqual(
      cases().map(caseInput => ({
        scope: caseInput.id,
        invariant: 'durationMilliseconds.p95 <= thresholds.maxCaseP95Milliseconds',
        measured: 30,
        threshold: 25
      }))
    )
    expect(await readdir(dirname(outputPath))).toEqual(['report.json'])
  })
})
