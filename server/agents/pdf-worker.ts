import { lstat, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse, stringify, isLosslessNumber } from 'lossless-json'

const PART_BYTES = 48_000_000
const OUTPUT_BYTES = 300 * 1024 * 1024
const INPUT_BYTES = 250 * 1024 * 1024
const MAX_PAGES = 1000
const MAX_PARTS = 8
const MAX_METADATA_BYTES = 8 * 1024 * 1024
const CPU_MICROSECONDS = 30_000_000
const TIMEOUT_MS = 45_000
const SAVE_OPTIONS = ['--compress-streams=y', '--decode-level=generalized', '--recompress-flate', '--object-streams=generate'] as const

// Bash applies limits before exec; qpdf is the only process that reads untrusted PDF bytes.
// All document paths and qpdf options are positional arguments, never shell source.
const LAUNCH = 'umask 077; ulimit -HSv 1048576 && ulimit -HSf 307200 && ulimit -HSn 64 && ulimit -HSc 0 && ulimit -HSt "$1" || exit 126; shift; exec "$@"'

export type PdfWorkerManifest = {
  pageCount: number
  parts: { filename: string; startPage: number; endPage: number; byteLength: number }[]
}
export type PdfWorkerErrorCode =
  | 'PDF_INVALID' | 'PDF_EMPTY' | 'PDF_ENCRYPTED' | 'PDF_TOO_MANY_PAGES'
  | 'PDF_TOO_LARGE' | 'PDF_PAGE_TOO_LARGE' | 'PDF_TOO_MANY_PARTS'
  | 'PDF_OUTPUT_TOO_LARGE' | 'PDF_PREPARATION_FAILED'

export class PdfWorkerError extends Error {
  readonly code: PdfWorkerErrorCode
  constructor(code: PdfWorkerErrorCode) {
    super(code)
    this.code = code
  }
}

const failure = (code: PdfWorkerErrorCode): never => { throw new PdfWorkerError(code) }
const abortError = (): DOMException => new DOMException('PDF preparation was cancelled.', 'AbortError')
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const numeric = (value: unknown, expected: number): boolean =>
  isLosslessNumber(value) ? value.toString() === String(expected) : value === expected

const collect = async (stream: ReadableStream<Uint8Array>, maximum: number, overflow: () => void): Promise<string> => {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of stream) {
    if (length + chunk.byteLength > maximum) { overflow(); continue }
    chunks.push(Buffer.from(chunk))
    length += chunk.byteLength
  }
  return Buffer.concat(chunks, length).toString('utf8')
}

/** A single preparation budget spans all qpdf processes and their cleanup. */
class QpdfSession {
  private readonly deadline = Date.now() + TIMEOUT_MS
  private cpuUsed = 0
  private metadataBytes = 0
  private readonly signal: AbortSignal
  constructor(signal: AbortSignal) { this.signal = signal }
  async run(args: readonly string[], limit = 512, metadata = false): Promise<{ code: number; stdout: string; resourceFailure: boolean }> {
    if (this.signal.aborted) throw abortError()
    const remaining = Math.floor((CPU_MICROSECONDS - this.cpuUsed) / 1_000_000)
    const timeLeft = this.deadline - Date.now()
    if (remaining < 1 || timeLeft <= 0) failure('PDF_PREPARATION_FAILED')
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      child = Bun.spawn(['bash', '--noprofile', '--norc', '-c', LAUNCH, '--', String(remaining), ...args], {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
      })
    } catch { return failure('PDF_PREPARATION_FAILED') }
    let overflowed = false
    let expired = false
    const overflow = () => { overflowed = true; child.kill('SIGKILL') }
    const onAbort = () => child.kill('SIGKILL')
    this.signal.addEventListener('abort', onAbort, { once: true })
    if (this.signal.aborted) onAbort()
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, timeLeft)
    timer.unref()
    try {
      const [stdout, stderr, code] = await Promise.all([
        collect(child.stdout, limit, overflow),
        collect(child.stderr, 8 * 1024, overflow),
        child.exited
      ])
      if (this.signal.aborted) throw abortError()
      if (expired || overflowed || child.signalCode !== null || code === 126 || Date.now() > this.deadline) failure('PDF_PREPARATION_FAILED')
      const cpu = child.resourceUsage()?.cpuTime.total as number | bigint | undefined
      if (cpu === undefined || !Number.isSafeInteger(Number(cpu)) || Number(cpu) < 0) failure('PDF_PREPARATION_FAILED')
      this.cpuUsed += Number(cpu)
      if (this.cpuUsed > CPU_MICROSECONDS) failure('PDF_PREPARATION_FAILED')
      if (metadata) {
        this.metadataBytes += Buffer.byteLength(stdout)
        if (this.metadataBytes > MAX_METADATA_BYTES) failure('PDF_PREPARATION_FAILED')
      }
      return { code, stdout, resourceFailure: stderr.includes('std::bad_alloc') }
    } catch (error) {
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited.catch(() => undefined)
      throw error
    } finally {
      clearTimeout(timer)
      this.signal.removeEventListener('abort', onAbort)
    }
  }
}

const successful = (result: { code: number; resourceFailure: boolean }): boolean => result.code === 0 || result.code === 3
const requireSuccess = (result: { code: number; resourceFailure: boolean }): void => {
  if (!successful(result)) failure('PDF_PREPARATION_FAILED')
}

const pageReferences = (raw: string, count: number): string[] => {
  const references: string[] = []
  for (const match of raw.matchAll(/^page (\d+): (\d+) (\d+) R$/gm)) {
    if (Number(match[1]) !== references.length + 1) failure('PDF_PREPARATION_FAILED')
    references.push(`${match[2]} ${match[3]} R`)
  }
  if (references.length !== count) failure('PDF_PREPARATION_FAILED')
  return references
}

/** Only page dictionaries are read into JS; stream data never enters the application. */
const thumbnailPatch = (raw: string, references: string[]): string | undefined => {
  const data: unknown = parse(raw)
  if (!record(data)) throw new PdfWorkerError('PDF_PREPARATION_FAILED')
  const qpdf = data.qpdf
  if (!Array.isArray(qpdf) || qpdf.length !== 2 || !record(qpdf[1])) throw new PdfWorkerError('PDF_PREPARATION_FAILED')
  if (!numeric(data.version, 2) || !record(qpdf[0]) || !numeric(qpdf[0].jsonversion, 2))
    failure('PDF_PREPARATION_FAILED')
  const entries = qpdf[1]
  const changed: Record<string, unknown> = {}
  for (const reference of new Set(references)) {
    const key = `obj:${reference}`
    const object = entries[key]
    if (!record(object)) throw new PdfWorkerError('PDF_PREPARATION_FAILED')
    const value = object.value
    if (!record(value) || value['/Type'] !== '/Page') throw new PdfWorkerError('PDF_PREPARATION_FAILED')
    if (Object.hasOwn(value, '/Thumb')) {
      delete value['/Thumb']
      changed[key] = object
    }
  }
  if (Object.keys(changed).length === 0) return undefined
  const patch = stringify({ version: data.version, parameters: data.parameters, qpdf: [qpdf[0], changed] })
  if (!patch || Buffer.byteLength(patch) > MAX_METADATA_BYTES) failure('PDF_PREPARATION_FAILED')
  return patch
}

/** Strictly validates and losslessly prepares one private PDF with qpdf as the limited native parser. */
export const preparePdfWorker = async (
  inputPath: string,
  signal: AbortSignal,
  options: { partLimitBytes?: number; outputLimitBytes?: number; ownedInput?: boolean } = {}
): Promise<PdfWorkerManifest> => {
  const partLimit = options.partLimitBytes ?? PART_BYTES
  const outputLimit = options.outputLimitBytes ?? OUTPUT_BYTES
  if (!Number.isSafeInteger(partLimit) || partLimit < 1 || partLimit > PART_BYTES ||
      !Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > OUTPUT_BYTES)
    failure('PDF_PREPARATION_FAILED')
  if (signal.aborted) throw abortError()
  const directory = dirname(inputPath)
  const input = await lstat(inputPath)
  if (!input.isFile() || input.isSymbolicLink()) failure('PDF_INVALID')
  if (input.size > INPUT_BYTES) failure('PDF_TOO_LARGE')
  if (input.size === 0) failure('PDF_INVALID')
  const session = new QpdfSession(signal)
  const encryption = await session.run(['qpdf', '--suppress-recovery', '--is-encrypted', inputPath])
  if (encryption.code === 0) failure('PDF_ENCRYPTED')
  if (encryption.code !== 2 && encryption.code !== 3) failure('PDF_PREPARATION_FAILED')
  const pages = await session.run(['qpdf', '--suppress-recovery', '--show-npages', inputPath], 64)
  if (!successful(pages)) failure(pages.resourceFailure || encryption.resourceFailure ? 'PDF_PREPARATION_FAILED' : 'PDF_INVALID')
  const pageCount = Number(pages.stdout.trim())
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) failure('PDF_INVALID')
  if (pageCount === 0) failure('PDF_EMPTY')
  if (pageCount > MAX_PAGES) failure('PDF_TOO_MANY_PAGES')
  if (input.size <= partLimit)
    return { pageCount, parts: [{ filename: 'input.pdf', startPage: 1, endPage: pageCount, byteLength: input.size }] }

  const refs = await session.run(['qpdf', '--suppress-recovery', '--show-pages', inputPath], 256 * 1024, true)
  requireSuccess(refs)
  const references = pageReferences(refs.stdout, pageCount)
  const selected = [...new Set(references)].map(ref => `--json-object=${ref.replace(' R', '').replace(' ', ',')}`)
  const json = await session.run(['qpdf', '--suppress-recovery', '--json=2', '--json-key=qpdf', '--json-stream-data=none', ...selected, inputPath], MAX_METADATA_BYTES, true)
  requireSuccess(json)
  let patch: string | undefined
  try { patch = thumbnailPatch(json.stdout, references) } catch { failure('PDF_PREPARATION_FAILED') }
  const updatePath = join(directory, 'page-update.json')
  if (patch !== undefined) await writeFile(updatePath, patch, { mode: 0o600, flag: 'wx' })
  const optimizedPath = join(directory, 'optimized.pdf')
  try {
    const optimized = await session.run(['qpdf', '--suppress-recovery', ...SAVE_OPTIONS,
      ...(patch === undefined ? [] : [`--update-from-json=${updatePath}`]), inputPath, optimizedPath])
    requireSuccess(optimized)
  } finally {
    if (patch !== undefined) await rm(updatePath, { force: true })
  }
  const optimizedSize = (await lstat(optimizedPath)).size
  if (optimizedSize <= partLimit)
    return { pageCount, parts: [{ filename: 'optimized.pdf', startPage: 1, endPage: pageCount, byteLength: optimizedSize }] }
  if (options.ownedInput) await rm(inputPath)

  const manifest: PdfWorkerManifest = { pageCount, parts: [] }
  let total = 0
  const split = async (first: number, last: number): Promise<void> => {
    if (manifest.parts.length >= MAX_PARTS) failure('PDF_TOO_MANY_PARTS')
    const candidatePath = join(directory, 'candidate.pdf')
    const result = await session.run(['qpdf', '--suppress-recovery', '--empty', '--pages', optimizedPath, `${first}-${last}`, '--', candidatePath, ...SAVE_OPTIONS])
    requireSuccess(result)
    const size = (await lstat(candidatePath)).size
    if (size > partLimit) {
      await rm(candidatePath)
      if (first === last) failure('PDF_PAGE_TOO_LARGE')
      const middle = first + Math.floor((last - first) / 2)
      await split(first, middle)
      await split(middle + 1, last)
      return
    }
    total += size
    if (total > outputLimit) failure('PDF_OUTPUT_TOO_LARGE')
    const filename = `part-${String(manifest.parts.length + 1).padStart(2, '0')}.pdf`
    await rename(candidatePath, join(directory, filename))
    manifest.parts.push({ filename, startPage: first, endPage: last, byteLength: size })
  }
  try {
    await split(1, pageCount)
  } finally {
    await rm(optimizedPath, { force: true })
    await rm(join(directory, 'candidate.pdf'), { force: true })
  }
  return manifest
}
