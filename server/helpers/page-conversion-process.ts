import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import errors from '../operations/errors.ts'
import { ConversionResultSchema, PAGE_CONVERSION_LIMITS as limits, type ConversionResult, type ConversionWorkerInput } from './page-conversion-protocol.ts'

let active = 0
const refusal = (reason: string, status = 422): Error => new errors.ApplicationError(reason, { code: 'CONVERSION_REFUSED', status })

/**
 * Bun Workers do not implement resourceLimits (installed bun-types leaves it commented out).
 * A separate Bun process is killed and reaped on deadline, cancellation, output or RSS refusal.
 * Linux /proc RSS is sampled every 25ms: this is NOT a hard heap/allocation cap; transient
 * overshoot between samples is possible. Strict 256KiB input and structural bounds also apply.
 * Unsupported monitoring hosts refuse admission rather than silently dropping memory enforcement.
 */
export async function runPageConversion(input: ConversionWorkerInput, signal?: AbortSignal): Promise<ConversionResult> {
  if (signal?.aborted) throw new DOMException('Conversion cancelled.', 'AbortError')
  if (input.source.length > limits.inputBytes || Buffer.byteLength(input.source, 'utf8') > limits.inputBytes) throw refusal('HTML source exceeds the 256 KiB conversion limit.', 413)
  const request = JSON.stringify(input)
  if (Buffer.byteLength(request, 'utf8') > limits.inputBytes + 64 * 1024) throw refusal('Conversion renderer configuration exceeds its budget.', 413)
  if (active >= limits.concurrency) throw refusal('Conversion capacity is busy. Try again after another review completes.', 429)
  active += 1
  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let failure: Error | undefined
  let monitoring = false
  const stop = (error: Error): void => {
    failure ??= error
    if (child?.exitCode === null) child.kill('SIGKILL')
  }
  const abort = (): void => stop(new DOMException('Conversion cancelled.', 'AbortError'))
  try {
    if (process.platform !== 'linux') throw refusal('Conversion requires independently monitored Linux child-process memory accounting.')
    await readFile('/proc/self/statm', 'utf8')
    if (signal?.aborted) throw new DOMException('Conversion cancelled.', 'AbortError')
    child = Bun.spawn([process.execPath, '--no-env-file', fileURLToPath(new URL('./page-conversion-worker.ts', import.meta.url))], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
      timeout: limits.deadlineMs,
      killSignal: 'SIGKILL'
    })
    const running = child
    const deadline = Date.now() + limits.deadlineMs
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const monitor = async (): Promise<void> => {
      if (monitoring || running.exitCode !== null) return
      monitoring = true
      try {
        const status = await readFile(`/proc/${running.pid}/status`, 'utf8')
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
        if (!rss) {
          if (!/^State:\s+Z/m.test(status)) stop(refusal('Conversion memory accounting is unavailable.'))
        } else if (Number(rss[1]) * 1024 > limits.rssBytes) stop(refusal('Conversion exceeded its monitored 256 MiB resident-memory budget.'))
        if (Date.now() >= deadline) stop(refusal('Conversion exceeded its five-second deadline.'))
      } catch {
        // A successfully reaped process no longer has a /proc record.
        if (running.exitCode === null) stop(refusal('Conversion memory accounting failed.'))
      } finally { monitoring = false }
    }
    timer = setInterval(() => { void monitor() }, limits.monitorMs)
    void monitor()
    const collect = async (stream: ReadableStream<Uint8Array>, maximum: number): Promise<string> => {
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of stream) {
        size += chunk.byteLength
        if (size > maximum) { stop(refusal('Conversion exceeded its output budget.')); continue }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    const stdout = collect(running.stdout, limits.wireBytes)
    // Diagnostics are bounded but deliberately never returned or logged: they may contain source.
    const stderr = collect(running.stderr, 8192)
    running.stdin.write(request)
    running.stdin.end()
    const [output, , code] = await Promise.all([stdout, stderr, running.exited])
    if (failure) throw failure
    if (signal?.aborted) throw new DOMException('Conversion cancelled.', 'AbortError')
    if (code !== 0 || running.signalCode !== null) throw refusal('Conversion was refused or exceeded its isolated work budget. Original HTML is unchanged.')
    const result = ConversionResultSchema.parse(JSON.parse(output))
    if ([result.candidate, result.report.previewHtml, result.report.roundtripSource].some(value => Buffer.byteLength(value, 'utf8') > limits.outputBytes)) {
      throw refusal('Conversion exceeded its output budget.')
    }
    return result
  } catch (error) {
    if (child?.exitCode === null) child.kill('SIGKILL')
    if (child) await child.exited.catch(() => undefined)
    if (error instanceof errors.ApplicationError || (error instanceof DOMException && error.name === 'AbortError')) throw error
    throw refusal('Conversion could not complete safely. Original HTML is unchanged.')
  } finally {
    clearInterval(timer)
    signal?.removeEventListener('abort', abort)
    active -= 1
  }
}
