import { spawn } from 'node:child_process'
import { chmod, copyFile, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const AGENT_PDF_PART_MAX_BYTES = 48_000_000
export const AGENT_PDF_MAX_BYTES = 250 * 1024 * 1024
export const AGENT_PDF_MAX_PAGES = 1000
const MAX_OUTPUT_BYTES = 300 * 1024 * 1024
const WORKER_TIMEOUT_MS = 45_000
const workerPath = fileURLToPath(new URL('./pdf-worker.py', import.meta.url))
let workerBusy = false

export const AGENT_PDF_ERRORS = {
  PDF_INVALID: { status: 400, message: 'This PDF could not be read. Export a new PDF and attach it again.' },
  PDF_EMPTY: { status: 400, message: 'This PDF has no pages. Attach a document with at least one page.' },
  PDF_ENCRYPTED: { status: 400, message: 'This PDF is encrypted. Attach an unencrypted copy.' },
  PDF_TOO_MANY_PAGES: { status: 400, message: 'Attach a PDF with no more than 1,000 pages.' },
  PDF_TOO_LARGE: { status: 413, message: 'Attach a PDF no larger than 250 MB.' },
  PDF_PAGE_TOO_LARGE: { status: 413, message: 'One PDF page is too large for the provider. Reduce that page’s image resolution and attach the PDF again.' },
  PDF_TOO_MANY_PARTS: { status: 413, message: 'This PDF needs too many parts. Attach a smaller page range.' },
  PDF_OUTPUT_TOO_LARGE: { status: 413, message: 'Preparing this PDF exceeds the document size limit. Attach a smaller page range.' },
  PDF_PREPARATION_BUSY: { status: 503, message: 'Another PDF is being prepared. Try this attachment again shortly.' },
  PDF_PREPARATION_FAILED: { status: 503, message: 'This PDF could not be prepared within the processing limits. Attach a smaller or newly exported PDF.' }
} as const satisfies Record<string, { status: number; message: string }>
export type AgentPdfErrorCode = keyof typeof AGENT_PDF_ERRORS
export class AgentPdfPreparationError extends Error {
  readonly status: number
  readonly code: AgentPdfErrorCode
  constructor(code: AgentPdfErrorCode) {
    const detail = AGENT_PDF_ERRORS[code]
    super(detail.message)
    this.name = 'AgentPdfPreparationError'
    this.code = code
    this.status = detail.status
  }
}
const manifestSchema = z.strictObject({
  pageCount: z.number().int().min(1).max(AGENT_PDF_MAX_PAGES),
  parts: z.array(z.strictObject({
    filename: z.string().regex(/^(?:input|optimized|part-0[1-8])\.pdf$/),
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
    byteLength: z.number().int().positive().max(AGENT_PDF_PART_MAX_BYTES)
  })).min(1).max(8)
})
export interface PreparedAgentPdf {
  pageCount: number
  parts: { path: string; startPage: number; endPage: number; byteLength: number }[]
  cleanup: () => Promise<void>
}
const abortError = (): DOMException => new DOMException('PDF preparation was cancelled.', 'AbortError')

const runWorker = (inputPath: string, signal: AbortSignal): Promise<unknown> => new Promise((complete, fail) => {
  if (signal.aborted) { fail(abortError()); return }
  const child = spawn('python3', ['-I', '-B', workerPath, inputPath], {
    shell: false,
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderrBytes = 0
  let stopped = false
  let aborted = false
  const stop = () => { stopped = true; child.kill('SIGKILL') }
  const onAbort = () => { aborted = true; stop() }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const timeout = setTimeout(stop, WORKER_TIMEOUT_MS)
  timeout.unref()
  const release = () => { clearTimeout(timeout); signal.removeEventListener('abort', onAbort) }
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopped) return
    if (Buffer.byteLength(stdout) + chunk.byteLength > 32 * 1024) { stop(); return }
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > 8 * 1024) stop() })
  child.once('error', () => { release(); fail(new AgentPdfPreparationError('PDF_PREPARATION_FAILED')) })
  // 'close' waits for exit and closed stdio: callers never remove a live worker's files.
  child.once('close', code => {
    release()
    if (aborted) { fail(abortError()); return }
    if (stopped) { fail(new AgentPdfPreparationError('PDF_PREPARATION_FAILED')); return }
    try {
      const value: unknown = JSON.parse(stdout)
      if (code !== 0) {
        const error = z.strictObject({ error: z.string() }).safeParse(value)
        throw new AgentPdfPreparationError(error.success && Object.hasOwn(AGENT_PDF_ERRORS, error.data.error) ? error.data.error as AgentPdfErrorCode : 'PDF_PREPARATION_FAILED')
      }
      complete(value)
    } catch (error) { fail(error instanceof AgentPdfPreparationError ? error : new AgentPdfPreparationError('PDF_PREPARATION_FAILED')) }
  })
})

const preparePdfInput = async (writeInput: (path: string) => Promise<void>, signal: AbortSignal): Promise<PreparedAgentPdf> => {
  if (signal.aborted) throw abortError()
  if (workerBusy) throw new AgentPdfPreparationError('PDF_PREPARATION_BUSY')
  workerBusy = true
  let directory: string | undefined
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => cleanupPromise ??= directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()
  try {
    directory = await mkdtemp(join(tmpdir(), 'wiki-agent-pdf-'))
    await chmod(directory, 0o700)
    const inputPath = join(directory, 'input.pdf')
    await writeInput(inputPath)
    await chmod(inputPath, 0o600)
    const raw = await runWorker(inputPath, signal)
    if (signal.aborted) throw abortError()
    const parsed = manifestSchema.safeParse(raw)
    if (!parsed.success) throw new AgentPdfPreparationError('PDF_PREPARATION_FAILED')
    const manifest = parsed.data
    const canonicalDirectory = await realpath(directory)
    const parts: PreparedAgentPdf['parts'] = []
    const filenames = new Set<string>()
    let nextPage = 1
    let totalBytes = 0
    for (const part of manifest.parts) {
      if (filenames.has(part.filename) || part.startPage !== nextPage || part.endPage < part.startPage || part.endPage > manifest.pageCount) throw new AgentPdfPreparationError('PDF_PREPARATION_FAILED')
      filenames.add(part.filename)
      const path = resolve(directory, part.filename)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== part.byteLength || (info.mode & 0o777) !== 0o600 || await realpath(path) !== join(canonicalDirectory, part.filename)) throw new AgentPdfPreparationError('PDF_PREPARATION_FAILED')
      const handle = await open(path, 'r')
      try {
        const header = Buffer.alloc(5)
        const { bytesRead } = await handle.read(header, 0, 5, 0)
        if (bytesRead !== 5 || header.toString('ascii') !== '%PDF-') throw new AgentPdfPreparationError('PDF_PREPARATION_FAILED')
      } finally { await handle.close() }
      totalBytes += part.byteLength
      if (totalBytes > MAX_OUTPUT_BYTES) throw new AgentPdfPreparationError('PDF_OUTPUT_TOO_LARGE')
      nextPage = part.endPage + 1
      parts.push({ path, startPage: part.startPage, endPage: part.endPage, byteLength: part.byteLength })
    }
    if (nextPage !== manifest.pageCount + 1) throw new AgentPdfPreparationError('PDF_PREPARATION_FAILED')
    if (signal.aborted) throw abortError()
    return { pageCount: manifest.pageCount, parts, cleanup }
  } catch (error) {
    await cleanup()
    throw error instanceof AgentPdfPreparationError || signal.aborted ? (signal.aborted ? abortError() : error) : new AgentPdfPreparationError('PDF_PREPARATION_FAILED')
  } finally {
    workerBusy = false
  }
}

export const prepareAgentPdf = async (payload: Buffer, signal: AbortSignal): Promise<PreparedAgentPdf> => {
  if (signal.aborted) throw abortError()
  if (!payload.byteLength) throw new AgentPdfPreparationError('PDF_INVALID')
  if (payload.byteLength > AGENT_PDF_MAX_BYTES) throw new AgentPdfPreparationError('PDF_TOO_LARGE')
  return preparePdfInput(path => writeFile(path, payload, { mode: 0o600, flag: 'wx' }), signal)
}

/** Accepts an integrity-checked private original; prepared copies are always ephemeral. */
export const prepareAgentPdfFromPath = async (sourcePath: string, signal: AbortSignal): Promise<PreparedAgentPdf> => {
  if (signal.aborted) throw abortError()
  const info = await lstat(sourcePath)
  if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new AgentPdfPreparationError('PDF_INVALID')
  if (info.size > AGENT_PDF_MAX_BYTES) throw new AgentPdfPreparationError('PDF_TOO_LARGE')
  return preparePdfInput(path => copyFile(sourcePath, path), signal)
}
