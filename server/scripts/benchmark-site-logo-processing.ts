import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import sharp from 'sharp'

import { SiteLogoProcessingError, type SiteLogoProcessingErrorCode, crc32, processSiteLogoSource } from '../helpers/site-logo-processing.ts'

export const SITE_LOGO_PROCESSING_ITERATIONS = 3
export const SITE_LOGO_PROCESSING_CONCURRENCY = 1 as const
export const SITE_LOGO_PROCESSING_DEFAULT_THRESHOLDS = Object.freeze({
  // These intentionally broad release gates catch hangs and runaway native allocations without turning shared-CI variance into noise.
  maxCaseP95Milliseconds: 120_000,
  maxCasePeakRssDeltaBytes: 768 * 1024 * 1024,
  maxCorpusWallMilliseconds: 600_000
})

export const SITE_LOGO_PROCESSING_SAFE_ERROR_CODES = Object.freeze([
  'UNSUPPORTED_IMAGE',
  'IMAGE_TOO_LARGE',
  'INVALID_IMAGE',
  'NO_VISIBLE_PIXELS',
  'UNSUITABLE_LOGO',
  'PROCESSING_FAILED',
  'ARTIFACT_TOO_LARGE'
] satisfies readonly SiteLogoProcessingErrorCode[])

type CorpusCategory = 'accepted' | 'malformed' | 'decompression-bomb'
type ExpectedOutcome = { status: 'accepted' } | { status: 'rejected'; errorCodes: readonly SiteLogoProcessingErrorCode[] }

export interface SiteLogoProcessingEnvironment {
  runtime: { name: 'bun' | 'node'; version: string }
  operatingSystem: { platform: string; release: string; architecture: string }
  cpu: { model: string; logicalCores: number }
  memory: { totalBytes: number }
  libraries: { sharp: string; libvips: string }
}

export interface SiteLogoProcessingSample {
  durationMilliseconds: number
  // Retained for the existing report gate; isolated samples contain an absolute process peak, not a baseline delta.
  peakRssDeltaBytes: number
  outcome: { status: 'accepted' } | { status: 'rejected'; errorCode: SiteLogoProcessingErrorCode }
}

export interface SiteLogoProcessingFixtureIdentity {
  byteLength: number
  sha256: string
}

export interface SiteLogoProcessingCaseInput {
  id: string
  category: CorpusCategory
  expected: ExpectedOutcome
  fixture: SiteLogoProcessingFixtureIdentity
  samples: SiteLogoProcessingSample[]
}

export interface NearestRankSummary {
  samples: number
  minimum: number
  p50: number
  p95: number
  p99: number
  maximum: number
}

export interface SiteLogoProcessingThresholds {
  maxCaseP95Milliseconds: number
  maxCasePeakRssDeltaBytes: number
  maxCorpusWallMilliseconds: number
}

export interface SiteLogoProcessingThresholdViolation {
  scope: string
  invariant: string
  measured: number | string
  threshold: number | string
}

export interface SiteLogoProcessingCaseReport extends SiteLogoProcessingCaseInput {
  status: 'passed' | 'failed'
  durationMilliseconds: NearestRankSummary
  peakRssDeltaBytes: NearestRankSummary
  thresholdViolations: SiteLogoProcessingThresholdViolation[]
}

export interface SiteLogoProcessingBenchmarkInput {
  generatedAt: string
  environment: SiteLogoProcessingEnvironment
  thresholds: SiteLogoProcessingThresholds
  iterationsPerCase: number
  corpusWallMilliseconds: number
  cases: SiteLogoProcessingCaseInput[]
}

export interface SiteLogoProcessingBenchmarkReport {
  reportVersion: 1
  status: 'passed' | 'failed'
  generatedAt: string
  environment: SiteLogoProcessingEnvironment
  measurement: {
    concurrency: 1
    iterationsPerCase: number
    processIsolation: 'fresh Bun child process per fixture iteration'
    wallClock: 'performance.now'
    peakRss: 'absolute child process.resourceUsage().maxRSS converted from KiB to bytes on Linux'
  }
  thresholds: SiteLogoProcessingThresholds
  corpusWallMilliseconds: number
  cases: SiteLogoProcessingCaseReport[]
  thresholdViolations: SiteLogoProcessingThresholdViolation[]
}

export interface AtomicReportFileSystem {
  writeFile(path: string, contents: string, options: { flag: 'wx' }): Promise<unknown>
  rename(source: string, destination: string): Promise<unknown>
  rm(path: string, options: { force: true }): Promise<unknown>
}

const defaultAtomicReportFileSystem: AtomicReportFileSystem = fs

export const nearestRankPercentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) throw new Error('Cannot calculate a percentile without samples')
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) throw new Error('Percentile quantile must be in (0, 1]')
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Percentile samples must be finite non-negative numbers')
  const sorted = [...values].sort((left, right) => left - right)
  const selected = sorted[Math.ceil(sorted.length * quantile) - 1]
  if (selected === undefined) throw new Error('Percentile sample selection failed')
  return selected
}

export const summarizeNearestRank = (values: readonly number[]): NearestRankSummary => ({
  samples: values.length,
  minimum: nearestRankPercentile(values, 1 / values.length),
  p50: nearestRankPercentile(values, 0.5),
  p95: nearestRankPercentile(values, 0.95),
  p99: nearestRankPercentile(values, 0.99),
  maximum: nearestRankPercentile(values, 1)
})

const outcomeMatches = (sample: SiteLogoProcessingSample, expected: ExpectedOutcome): boolean => {
  if (expected.status === 'accepted') return sample.outcome.status === 'accepted'
  return sample.outcome.status === 'rejected' && expected.errorCodes.includes(sample.outcome.errorCode)
}

export const createSiteLogoProcessingBenchmarkReport = (input: SiteLogoProcessingBenchmarkInput): SiteLogoProcessingBenchmarkReport => {
  const thresholdViolations: SiteLogoProcessingThresholdViolation[] = []
  const cases = input.cases.map(caseInput => {
    const violations: SiteLogoProcessingThresholdViolation[] = []
    const durationMilliseconds = summarizeNearestRank(caseInput.samples.map(sample => sample.durationMilliseconds))
    const peakRssDeltaBytes = summarizeNearestRank(caseInput.samples.map(sample => sample.peakRssDeltaBytes))

    if (caseInput.samples.length !== input.iterationsPerCase) {
      violations.push({
        scope: caseInput.id,
        invariant: 'samples.length === measurement.iterationsPerCase',
        measured: caseInput.samples.length,
        threshold: input.iterationsPerCase
      })
    }
    caseInput.samples.forEach((sample, index) => {
      if (!outcomeMatches(sample, caseInput.expected)) {
        const expected = caseInput.expected.status === 'accepted' ? 'accepted' : `rejected:${caseInput.expected.errorCodes.join('|')}`
        const measured = sample.outcome.status === 'accepted' ? 'accepted' : `rejected:${sample.outcome.errorCode}`
        violations.push({
          scope: caseInput.id,
          invariant: `sample[${index}].outcome matches expected safe outcome`,
          measured,
          threshold: expected
        })
      }
      if (sample.outcome.status === 'rejected' && !SITE_LOGO_PROCESSING_SAFE_ERROR_CODES.includes(sample.outcome.errorCode)) {
        violations.push({
          scope: caseInput.id,
          invariant: `sample[${index}].errorCode is safe`,
          measured: sample.outcome.errorCode,
          threshold: SITE_LOGO_PROCESSING_SAFE_ERROR_CODES.join('|')
        })
      }
    })
    if (durationMilliseconds.p95 > input.thresholds.maxCaseP95Milliseconds) {
      violations.push({
        scope: caseInput.id,
        invariant: 'durationMilliseconds.p95 <= thresholds.maxCaseP95Milliseconds',
        measured: durationMilliseconds.p95,
        threshold: input.thresholds.maxCaseP95Milliseconds
      })
    }
    if (peakRssDeltaBytes.maximum > input.thresholds.maxCasePeakRssDeltaBytes) {
      violations.push({
        scope: caseInput.id,
        invariant: 'peakRssDeltaBytes.maximum <= thresholds.maxCasePeakRssDeltaBytes',
        measured: peakRssDeltaBytes.maximum,
        threshold: input.thresholds.maxCasePeakRssDeltaBytes
      })
    }
    thresholdViolations.push(...violations)
    return {
      ...caseInput,
      status: violations.length === 0 ? ('passed' as const) : ('failed' as const),
      durationMilliseconds,
      peakRssDeltaBytes,
      thresholdViolations: violations
    }
  })

  if (input.corpusWallMilliseconds > input.thresholds.maxCorpusWallMilliseconds) {
    thresholdViolations.push({
      scope: 'corpus',
      invariant: 'corpusWallMilliseconds <= thresholds.maxCorpusWallMilliseconds',
      measured: input.corpusWallMilliseconds,
      threshold: input.thresholds.maxCorpusWallMilliseconds
    })
  }

  return {
    reportVersion: 1,
    status: thresholdViolations.length === 0 ? 'passed' : 'failed',
    generatedAt: input.generatedAt,
    environment: input.environment,
    measurement: {
      concurrency: SITE_LOGO_PROCESSING_CONCURRENCY,
      iterationsPerCase: input.iterationsPerCase,
      processIsolation: 'fresh Bun child process per fixture iteration',
      wallClock: 'performance.now',
      peakRss: 'absolute child process.resourceUsage().maxRSS converted from KiB to bytes on Linux'
    },
    thresholds: { ...input.thresholds },
    corpusWallMilliseconds: input.corpusWallMilliseconds,
    cases,
    thresholdViolations
  }
}

export const writeSiteLogoProcessingBenchmarkReportAtomically = async (
  path: string,
  serialized: string,
  fileSystem: AtomicReportFileSystem = defaultAtomicReportFileSystem
): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fileSystem.writeFile(temporaryPath, serialized, { flag: 'wx' })
    await fileSystem.rename(temporaryPath, path)
  } catch (error: unknown) {
    await fileSystem.rm(temporaryPath, { force: true })
    throw error
  }
}

export const publishSiteLogoProcessingBenchmarkReport = async (
  report: SiteLogoProcessingBenchmarkReport,
  path: string,
  fileSystem: AtomicReportFileSystem = defaultAtomicReportFileSystem
): Promise<void> => {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  await writeSiteLogoProcessingBenchmarkReportAtomically(path, serialized, fileSystem)
  process.stdout.write(serialized)
  if (report.status === 'failed') {
    throw new Error(
      `Site logo processing benchmark failed: ${report.thresholdViolations.map(violation => `${violation.scope}: ${violation.invariant}`).join('; ')}`
    )
  }
}

const pngChunk = (type: string, data: Buffer): Buffer => {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return chunk
}

const createAcceptedFixture = async (): Promise<Buffer> => {
  const canvas = sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
  const artwork = Buffer.from(`
    <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <rect x="40" y="120" width="96" height="272" rx="48" fill="#2457c5"/>
      <path
        d="M256 72 352 256 256 440 160 256Z M256 188a68 68 0 1 0 0 136 68 68 0 1 0 0-136Z"
        fill="#e86b35"
        fill-rule="evenodd"
      />
      <circle cx="256" cy="256" r="26" fill="#f2c14e"/>
      <rect x="376" y="120" width="96" height="272" rx="48" fill="#087f76"/>
    </svg>
  `)
  return await canvas
    .composite([{ input: artwork }])
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()
}

const createMalformedFixture = (): Buffer => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const createDecompressionBombFixture = (): Buffer => {
  const width = 4097
  const height = 4095
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 0
  const inflated = Buffer.alloc((width + 1) * height)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(inflated, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const corpus = [
  {
    id: 'accepted-transparent-chromatic-logo',
    category: 'accepted',
    expected: { status: 'accepted' },
    createFixture: createAcceptedFixture
  },
  {
    id: 'malformed-truncated-png',
    category: 'malformed',
    expected: { status: 'rejected', errorCodes: ['INVALID_IMAGE'] },
    createFixture: createMalformedFixture
  },
  {
    id: 'decompression-bomb-4097x4095-grayscale-png',
    category: 'decompression-bomb',
    expected: { status: 'rejected', errorCodes: ['INVALID_IMAGE', 'IMAGE_TOO_LARGE'] },
    createFixture: createDecompressionBombFixture
  }
] satisfies ReadonlyArray<{
  id: string
  category: CorpusCategory
  expected: ExpectedOutcome
  createFixture: () => Buffer | Promise<Buffer>
}>

const CHILD_MODE_ARGUMENT = '--site-logo-processing-benchmark-child'
const CHILD_OUTPUT_LIMIT_BYTES = 16 * 1024
const CHILD_TIMEOUT_MILLISECONDS = SITE_LOGO_PROCESSING_DEFAULT_THRESHOLDS.maxCaseP95Milliseconds
const SCRIPT_PATH = fileURLToPath(import.meta.url)

interface ChildFixtureMeasurement extends SiteLogoProcessingSample {
  fixture: SiteLogoProcessingFixtureIdentity
}

interface ChildResourceUsage {
  // Bun.Subprocess.resourceUsage() normalizes maxRSS to bytes.
  maxRSS: number
}

interface BenchmarkChildProcess {
  stdout: ReadableStream<Uint8Array> | number | null | undefined
  stderr: ReadableStream<Uint8Array> | number | null | undefined
  exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
  resourceUsage(): ChildResourceUsage | undefined
}

const fixtureIdentity = (bytes: Buffer): SiteLogoProcessingFixtureIdentity => ({
  byteLength: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex')
})

const maxRssKilobytesToBytes = (maxRssKilobytes: number): number => (Number.isFinite(maxRssKilobytes) && maxRssKilobytes >= 0 ? maxRssKilobytes * 1024 : 0)

const safeErrorCode = (error: unknown): SiteLogoProcessingErrorCode => {
  if (error instanceof SiteLogoProcessingError && SITE_LOGO_PROCESSING_SAFE_ERROR_CODES.includes(error.code)) return error.code
  return 'PROCESSING_FAILED'
}

const runFixtureChild = async (fixturePath: string): Promise<void> => {
  let measurement: ChildFixtureMeasurement
  try {
    const bytes = await fs.readFile(fixturePath)
    const fixture = fixtureIdentity(bytes)
    const startedAt = performance.now()
    let outcome: SiteLogoProcessingSample['outcome']
    try {
      await processSiteLogoSource(bytes, fixture.sha256)
      outcome = { status: 'accepted' }
    } catch (error: unknown) {
      outcome = { status: 'rejected', errorCode: safeErrorCode(error) }
    }
    measurement = {
      fixture,
      durationMilliseconds: performance.now() - startedAt,
      peakRssDeltaBytes: maxRssKilobytesToBytes(process.resourceUsage().maxRSS),
      outcome
    }
  } catch {
    measurement = {
      fixture: { byteLength: 0, sha256: '' },
      durationMilliseconds: 0,
      peakRssDeltaBytes: maxRssKilobytesToBytes(process.resourceUsage().maxRSS),
      outcome: { status: 'rejected', errorCode: 'PROCESSING_FAILED' }
    }
  }
  process.stdout.write(`${JSON.stringify(measurement)}\n`)
}

const readBoundedChildOutput = async (stream: ReadableStream<Uint8Array>, limitBytes: number): Promise<string> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      byteLength += result.value.byteLength
      if (byteLength > limitBytes) throw new Error('Site logo processing benchmark child output exceeded its limit')
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, byteLength).toString('utf8')
}

const parseChildMeasurement = (serialized: string, expectedFixture: SiteLogoProcessingFixtureIdentity): SiteLogoProcessingSample | undefined => {
  let candidate: unknown
  try {
    candidate = JSON.parse(serialized)
  } catch {
    return undefined
  }
  if (candidate === null || typeof candidate !== 'object') return undefined
  const value = candidate as Partial<ChildFixtureMeasurement>
  if (
    value.fixture?.byteLength !== expectedFixture.byteLength ||
    value.fixture.sha256 !== expectedFixture.sha256 ||
    typeof value.durationMilliseconds !== 'number' ||
    !Number.isFinite(value.durationMilliseconds) ||
    value.durationMilliseconds < 0 ||
    typeof value.peakRssDeltaBytes !== 'number' ||
    !Number.isSafeInteger(value.peakRssDeltaBytes) ||
    value.peakRssDeltaBytes < 0
  ) {
    return undefined
  }
  if (value.outcome?.status === 'accepted') {
    return {
      durationMilliseconds: value.durationMilliseconds,
      peakRssDeltaBytes: value.peakRssDeltaBytes,
      outcome: { status: 'accepted' }
    }
  }
  if (value.outcome?.status === 'rejected' && SITE_LOGO_PROCESSING_SAFE_ERROR_CODES.includes(value.outcome.errorCode as SiteLogoProcessingErrorCode)) {
    return {
      durationMilliseconds: value.durationMilliseconds,
      peakRssDeltaBytes: value.peakRssDeltaBytes,
      outcome: { status: 'rejected', errorCode: value.outcome.errorCode as SiteLogoProcessingErrorCode }
    }
  }
  return undefined
}

const failedChildSample = (startedAt: number, resourceUsage?: ChildResourceUsage): SiteLogoProcessingSample => {
  const peakRssBytes = resourceUsage !== undefined && Number.isSafeInteger(resourceUsage.maxRSS) && resourceUsage.maxRSS >= 0 ? resourceUsage.maxRSS : 0
  return {
    durationMilliseconds: performance.now() - startedAt,
    peakRssDeltaBytes: peakRssBytes,
    outcome: { status: 'rejected', errorCode: 'PROCESSING_FAILED' }
  }
}

const measureFixture = async (fixturePath: string, expectedFixture: SiteLogoProcessingFixtureIdentity): Promise<SiteLogoProcessingSample> => {
  const startedAt = performance.now()
  let child: BenchmarkChildProcess | undefined
  try {
    child = Bun.spawn([process.execPath, SCRIPT_PATH, CHILD_MODE_ARGUMENT, fixturePath], {
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CHILD_TIMEOUT_MILLISECONDS,
      killSignal: 'SIGKILL',
      maxBuffer: CHILD_OUTPUT_LIMIT_BYTES
    }) as BenchmarkChildProcess
    const stdout = child.stdout as ReadableStream<Uint8Array>
    const stderr = child.stderr as ReadableStream<Uint8Array>
    const [serialized, , exitCode] = await Promise.all([
      readBoundedChildOutput(stdout, CHILD_OUTPUT_LIMIT_BYTES),
      readBoundedChildOutput(stderr, CHILD_OUTPUT_LIMIT_BYTES),
      child.exited
    ])
    if (exitCode !== 0) return failedChildSample(startedAt, child.resourceUsage())
    return parseChildMeasurement(serialized, expectedFixture) ?? failedChildSample(startedAt, child.resourceUsage())
  } catch {
    if (child !== undefined) {
      try {
        child.kill('SIGKILL')
      } catch {
        // The child can exit between a stream failure and this best-effort kill.
      }
      await child.exited
    }
    return failedChildSample(startedAt, child?.resourceUsage())
  }
}

const environmentMetadata = (): SiteLogoProcessingEnvironment => {
  const processors = cpus()
  return {
    runtime: process.versions.bun ? { name: 'bun', version: process.versions.bun } : { name: 'node', version: process.version },
    operatingSystem: { platform: platform(), release: release(), architecture: arch() },
    cpu: { model: processors[0]?.model ?? 'unknown', logicalCores: processors.length },
    memory: { totalBytes: totalmem() },
    libraries: { sharp: sharp.versions.sharp, libvips: sharp.versions.vips }
  }
}

export const runSiteLogoProcessingBenchmark = async (): Promise<void> => {
  const outputPath = process.env.SITE_LOGO_PROCESSING_BENCHMARK_FILE ?? 'site-logo-processing-benchmark.json'
  const fixtureDirectory = await fs.mkdtemp(join(tmpdir(), 'wiki-site-logo-processing-benchmark-fixtures-'))
  try {
    const materializedCorpus: Array<{
      specification: (typeof corpus)[number]
      fixture: SiteLogoProcessingFixtureIdentity
      fixturePath: string
    }> = []
    for (const [index, specification] of corpus.entries()) {
      const bytes = await specification.createFixture()
      const fixture = fixtureIdentity(bytes)
      const fixturePath = join(fixtureDirectory, `${index}.fixture`)
      await fs.writeFile(fixturePath, bytes, { flag: 'wx' })
      materializedCorpus.push({ specification, fixture, fixturePath })
    }

    const cases: SiteLogoProcessingCaseInput[] = []
    const corpusStartedAt = performance.now()
    for (const { specification, fixture, fixturePath } of materializedCorpus) {
      const samples: SiteLogoProcessingSample[] = []
      for (let iteration = 0; iteration < SITE_LOGO_PROCESSING_ITERATIONS; iteration += 1) {
        samples.push(await measureFixture(fixturePath, fixture))
      }
      cases.push({
        id: specification.id,
        category: specification.category,
        expected: specification.expected,
        fixture,
        samples
      })
    }
    const report = createSiteLogoProcessingBenchmarkReport({
      generatedAt: new Date().toISOString(),
      environment: environmentMetadata(),
      thresholds: { ...SITE_LOGO_PROCESSING_DEFAULT_THRESHOLDS },
      iterationsPerCase: SITE_LOGO_PROCESSING_ITERATIONS,
      corpusWallMilliseconds: performance.now() - corpusStartedAt,
      cases
    })
    await publishSiteLogoProcessingBenchmarkReport(report, outputPath)
  } finally {
    await fs.rm(fixtureDirectory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (process.argv[2] === CHILD_MODE_ARGUMENT) await runFixtureChild(process.argv[3] ?? '')
  else await runSiteLogoProcessingBenchmark()
}
