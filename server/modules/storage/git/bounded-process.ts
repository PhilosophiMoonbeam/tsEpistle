import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { lstat, opendir } from 'node:fs/promises'
import type { Dir } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'

export const GIT_NATIVE_DEADLINE_MS = 120_000
export const GIT_NATIVE_STDOUT_LIMIT_BYTES = 96 * 1024 * 1024
export const GIT_NATIVE_STDERR_LIMIT_BYTES = 64 * 1024
export const GIT_NATIVE_RECORD_LIMIT_BYTES = 8 * 1024
export const GIT_NATIVE_METADATA_LIMIT_BYTES = 512 * 1024 * 1024
export const GIT_NATIVE_METADATA_ENTRY_LIMIT = 50_000
export const GIT_NATIVE_WORKTREE_LIMIT_BYTES = 256 * 1024 * 1024
export const GIT_NATIVE_WORKTREE_ENTRY_LIMIT = 10_000
export const GIT_NATIVE_MONITOR_INTERVAL_MS = 100
export const GIT_NATIVE_KILL_GRACE_MS = 250

export type BoundedProcessFailureKind = 'deadline' | 'output' | 'monitor' | 'parser' | 'aborted' | 'spawn' | 'exit'

export interface BoundedProcessOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly deadlineMs?: number
  readonly maxStdoutBytes?: number
  readonly maxStderrBytes?: number
  readonly captureStdout?: boolean
  readonly onStdoutChunk?: (chunk: Buffer) => void | Promise<void>
  readonly onStderrChunk?: (chunk: Buffer) => void | Promise<void>
  readonly monitor?: () => void | Promise<void>
  readonly monitorIntervalMs?: number
  readonly killGraceMs?: number
  readonly signal?: AbortSignal
}

export interface BoundedProcessResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: Buffer
  readonly stderr: string
}

export class BoundedProcessError extends Error {
  readonly kind: BoundedProcessFailureKind
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly quarantine: boolean

  constructor (
    kind: BoundedProcessFailureKind,
    message: string,
    options: {
      readonly code?: number | null
      readonly signal?: NodeJS.Signals | null
      readonly stderr?: string
      readonly cause?: unknown
      readonly quarantine?: boolean
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BoundedProcessError'
    this.kind = kind
    this.code = options.code ?? null
    this.signal = options.signal ?? null
    this.stderr = options.stderr ?? ''
    this.quarantine = options.quarantine ?? (kind !== 'exit' || options.signal !== undefined && options.signal !== null)
  }
}

const assertLimit = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`)
}

const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))

const delay = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}

function signalProcessGroup (child: ChildProcessByStdio<null, Readable, Readable>, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.pid === null) {
    try { child.kill(signal) } catch { /* The child may have exited before it received the signal. */ }
    return
  }
  try {
    // A detached child is the leader of its own process group. Negative pid targets
    // the group, ensuring helper processes spawned by Git are reaped as well.
    process.kill(-child.pid, signal)
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code !== 'ESRCH') {
      try { child.kill(signal) } catch { /* Preserve the original failure. */ }
    }
  }
}

async function readBoundedStream (
  stream: NodeJS.ReadableStream,
  options: {
    readonly limit: number
    readonly capture: boolean
    readonly onChunk?: (chunk: Buffer) => void | Promise<void>
    readonly label: string
    readonly fail: (error: unknown, kind: BoundedProcessFailureKind) => void
  }
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const value of stream as AsyncIterable<Buffer | Uint8Array | string>) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      total += chunk.byteLength
      if (total > options.limit) {
        const error = new RangeError(`Git ${options.label} output exceeded ${options.limit} bytes`)
        options.fail(error, 'output')
        break
      }
      if (options.capture) chunks.push(chunk)
      if (options.onChunk) await options.onChunk(chunk)
    }
  } catch (error: unknown) {
    options.fail(error, 'parser')
  }
  return options.capture ? Buffer.concat(chunks, total) : Buffer.alloc(0)
}

export async function runBoundedProcess (options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const deadlineMs = options.deadlineMs ?? GIT_NATIVE_DEADLINE_MS
  const maxStdoutBytes = options.maxStdoutBytes ?? GIT_NATIVE_STDOUT_LIMIT_BYTES
  const maxStderrBytes = options.maxStderrBytes ?? GIT_NATIVE_STDERR_LIMIT_BYTES
  const monitorIntervalMs = options.monitorIntervalMs ?? GIT_NATIVE_MONITOR_INTERVAL_MS
  const killGraceMs = options.killGraceMs ?? GIT_NATIVE_KILL_GRACE_MS
  assertLimit(deadlineMs, 'Git process deadline')
  assertLimit(maxStdoutBytes, 'Git stdout limit')
  assertLimit(maxStderrBytes, 'Git stderr limit')
  assertLimit(monitorIntervalMs, 'Git monitor interval')
  assertLimit(killGraceMs, 'Git kill grace period')

  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error: unknown) {
    throw new BoundedProcessError('spawn', `Unable to start Git process: ${asError(error).message}`, { cause: error })
  }

  let failure: BoundedProcessError | undefined
  let termination: Promise<void> | undefined
  let monitorActive = true
  let monitorInFlight: Promise<void> | undefined
  let monitorTimer: ReturnType<typeof setInterval> | undefined

  const closed = (() => {
    const { promise, resolve } = Promise.withResolvers<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>()
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }))
    return promise
  })()

  const terminate = async (): Promise<void> => {
    if (termination !== undefined) return termination
    termination = (async () => {
      signalProcessGroup(child, 'SIGTERM')
      const graceful = await Promise.race([
        closed.then(() => true),
        delay(killGraceMs).then(() => false)
      ])
      if (!graceful) {
        signalProcessGroup(child, 'SIGKILL')
        await closed
      }
    })()
    return termination
  }

  const fail = (error: unknown, kind: BoundedProcessFailureKind): void => {
    if (failure !== undefined) return
    const normalized = asError(error)
    failure = error instanceof BoundedProcessError
      ? error
      : new BoundedProcessError(kind, normalized.message, { cause: error })
    void terminate()
  }

  child.once('error', error => fail(error, 'spawn'))

  const monitorOnce = async (): Promise<void> => {
    if (!options.monitor || !monitorActive || failure !== undefined) return
    if (monitorInFlight !== undefined) return monitorInFlight
    const running = (async () => {
      try {
        await options.monitor?.()
      } catch (error: unknown) {
        fail(error, 'monitor')
      } finally {
        monitorInFlight = undefined
      }
    })()
    monitorInFlight = running
    await running
  }

  if (options.signal) {
    if (options.signal.aborted) fail(options.signal.reason ?? new Error('Git process was aborted'), 'aborted')
    else options.signal.addEventListener('abort', () => fail(options.signal?.reason ?? new Error('Git process was aborted'), 'aborted'), { once: true })
  }
  const deadlineTimer = setTimeout(() => fail(new Error(`Git process exceeded its ${deadlineMs}ms deadline`), 'deadline'), deadlineMs)
  if (options.monitor) {
    void monitorOnce()
    monitorTimer = setInterval(() => { void monitorOnce() }, monitorIntervalMs)
  }

  const stderrChunks: Buffer[] = []
  let stderrBytes = 0
  const stderrHandler = async (chunk: Buffer): Promise<void> => {
    stderrBytes += chunk.byteLength
    if (stderrBytes > maxStderrBytes) {
      fail(new RangeError(`Git stderr exceeded ${maxStderrBytes} bytes`), 'output')
      return
    }
    stderrChunks.push(chunk)
    if (options.onStderrChunk) await options.onStderrChunk(chunk)
  }

  const stdoutPromise = readBoundedStream(child.stdout, {
    limit: maxStdoutBytes,
    capture: options.captureStdout === true,
    ...(options.onStdoutChunk === undefined ? {} : { onChunk: options.onStdoutChunk }),
    label: 'stdout',
    fail
  })
  const stderrPromise = readBoundedStream(child.stderr, {
    limit: maxStderrBytes,
    capture: false,
    onChunk: stderrHandler,
    label: 'stderr',
    fail
  })
  const result = await closed
  monitorActive = false
  clearTimeout(deadlineTimer)
  clearInterval(monitorTimer)
  await Promise.allSettled([stdoutPromise, stderrPromise])
  if (monitorInFlight !== undefined) await monitorInFlight
  if (failure !== undefined) {
    await (termination ?? Promise.resolve())
    throw failure
  }
  if (result.code !== 0) {
    const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8').slice(-maxStderrBytes)
    throw new BoundedProcessError(
      'exit',
      `Git process exited with ${result.code === null ? `signal ${result.signal ?? 'unknown'}` : `status ${result.code}`}${stderr ? `: ${stderr}` : ''}`,
      { code: result.code, signal: result.signal, stderr }
    )
  }
  return {
    code: result.code,
    signal: result.signal,
    stdout: await stdoutPromise,
    stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8').slice(-maxStderrBytes)
  }
}

export interface BoundedDirectoryObservation {
  readonly entries: number
  readonly bytes: number
}

export interface BoundedDirectoryObservationOptions {
  readonly maxEntries: number
  readonly maxBytes: number
  readonly deadlineAt?: number
  readonly shouldSkip?: (relativePath: string) => boolean
}

function checkObservationDeadline (deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() > deadlineAt) throw new BoundedProcessError('deadline', 'Git filesystem observation exceeded its deadline')
}

/** Stream a no-follow directory observation without retaining its inventory. */
export async function observeDirectoryTree (
  rootPath: string,
  options: BoundedDirectoryObservationOptions
): Promise<BoundedDirectoryObservation> {
  assertLimit(options.maxEntries, 'Git observation entry limit')
  assertLimit(options.maxBytes, 'Git observation byte limit')
  let entries = 0
  let bytes = 0

  const observe = async (directoryPath: string, prefix: string): Promise<void> => {
    checkObservationDeadline(options.deadlineAt)
    const listed = await lstat(directoryPath)
    if (!listed.isDirectory()) throw new BoundedProcessError('monitor', `Git observation encountered a non-directory: ${prefix || '.'}`)
    let directory: Dir | undefined
    try {
      directory = await opendir(directoryPath, { bufferSize: 32 })
      for await (const entry of directory) {
        checkObservationDeadline(options.deadlineAt)
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (options.shouldSkip?.(relativePath)) continue
        entries += 1
        if (entries > options.maxEntries) throw new BoundedProcessError('monitor', `Git observation exceeded its ${options.maxEntries}-entry limit`)
        const childPath = path.join(directoryPath, entry.name)
        const child = await lstat(childPath)
        if (child.isSymbolicLink()) throw new BoundedProcessError('monitor', `Git observation encountered a symbolic link: ${relativePath}`)
        if (child.isDirectory()) {
          await observe(childPath, relativePath)
          continue
        }
        if (!child.isFile() || !Number.isSafeInteger(child.size) || child.size < 0) {
          throw new BoundedProcessError('monitor', `Git observation encountered an uninspectable entry: ${relativePath}`)
        }
        bytes += child.size
        if (bytes > options.maxBytes) throw new BoundedProcessError('monitor', `Git observation exceeded its ${options.maxBytes}-byte limit`)
      }
    } finally {
      if (directory !== undefined) await directory.close()
    }
  }

  await observe(rootPath, '')
  return { entries, bytes }
}
