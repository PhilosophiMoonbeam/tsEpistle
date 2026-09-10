import moment from 'moment'
import { randomUUID } from 'node:crypto'
import type { ScheduledObservation } from '../../shared/system-workspace.ts'
import { fork, type ChildProcess } from 'node:child_process'
import _ from 'lodash'
import configHelper from '../helpers/config.ts'

interface JobOptions {
  name: string
  immediate?: boolean
  schedule?: string
  repeat?: boolean
  worker?: boolean
}
interface JobConfig {
  offlineSkip?: boolean
  onInit?: boolean
  repeat?: boolean
  schedule?: string
  worker?: boolean
}
interface WikiContext {
  ROOTPATH: string
  config: { offline: boolean }
  data: { jobs: Record<string, JobConfig> }
  logger: { warn(message: unknown): void }
}
const wiki = WIKI as unknown as WikiContext
const validJobName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_RETAINED_STDERR_BYTES = 65_536
const STDERR_TRUNCATION_MARKER = '\n[truncated]'
const SCHEDULER_WORKER_TERMINATION_UNCONFIRMED = 'SCHEDULER_WORKER_TERMINATION_UNCONFIRMED'
const SCHEDULER_WORKER_COMPLETION_UNCONFIRMED = 'SCHEDULER_WORKER_COMPLETION_UNCONFIRMED'

class Job {
  queue: Scheduler
  finished: Promise<unknown> = Promise.resolve()
  name: string
  immediate: boolean
  schedule: moment.Duration
  repeat: boolean
  worker: boolean
  timeout: NodeJS.Timeout | undefined
  process: ChildProcess | undefined
  processExited = false
  stopping = false
  stopPromise: Promise<unknown> | undefined
  escalationTimeout: NodeJS.Timeout | undefined
  cancellationTimeout: NodeJS.Timeout | undefined
  sigtermSent = false
  sigkillSent = false
  observation: ScheduledObservation

  constructor({ name, immediate = false, schedule = 'P1D', repeat = false, worker = false }: JobOptions, queue: Scheduler) {
    if (!validJobName.test(name)) throw new TypeError(`Invalid scheduler job name: ${name}`)
    this.queue = queue
    this.name = name
    this.immediate = immediate
    this.schedule = moment.duration(schedule)
    this.repeat = repeat
    this.worker = worker
    this.observation = {
      id: randomUUID(),
      name,
      state: 'waiting',
      repeat,
      worker,
      intervalMs: Math.max(0, Math.round(this.schedule.asMilliseconds())),
      nextRunAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      lastOutcome: null,
      runs: 0,
      failures: 0
    }
  }

  clearEscalationTimer(): void {
    if (this.escalationTimeout) {
      clearTimeout(this.escalationTimeout)
      this.escalationTimeout = undefined
    }
  }

  clearTerminationTimers(): void {
    this.clearEscalationTimer()
    if (this.cancellationTimeout) {
      clearTimeout(this.cancellationTimeout)
      this.cancellationTimeout = undefined
    }
  }

  start(data?: unknown): void {
    this.stopping = false
    this.processExited = false
    this.sigtermSent = false
    this.sigkillSent = false
    this.queue.jobs.push(this)
    if (this.immediate) void this.invoke(data)
    else this.enqueue(data)
  }

  enqueue(data?: unknown): void {
    if (this.stopping) return
    this.observation.state = 'waiting'
    this.observation.nextRunAt = new Date(Date.now() + this.schedule.asMilliseconds()).toISOString()
    this.timeout = setTimeout(() => {
      void this.invoke(data)
    }, this.schedule.asMilliseconds())
  }

  async invoke(data?: unknown): Promise<void> {
    this.timeout = undefined
    const started = Date.now()
    this.observation.state = 'running'
    this.observation.nextRunAt = null
    this.observation.lastStartedAt = new Date(started).toISOString()
    this.observation.runs++
    let failed = false
    try {
      if (this.worker) {
        const { promise, reject, resolve } = Promise.withResolvers<unknown>()
        this.finished = promise
        let proc: ChildProcess | undefined
        let stderrClosed = false
        let childError: Error | undefined
        let exitCode: number | null | undefined
        let exitSignal: NodeJS.Signals | null | undefined
        const retainedStderr: Buffer[] = []
        let retainedStderrBytes = 0
        let stderrTruncated = false
        let materializedOutput: string | undefined
        const materializeOutput = (): string => {
          if (materializedOutput === undefined) {
            materializedOutput = Buffer.concat(retainedStderr, retainedStderrBytes).toString()
            if (stderrTruncated) materializedOutput += STDERR_TRUNCATION_MARKER
          }
          return materializedOutput
        }
        const finish = (): void => {
          if ((!this.processExited && !childError) || !stderrClosed || !proc || this.process !== proc) return
          const output = materializeOutput()
          let error: Error | undefined
          if (childError || exitCode !== 0) {
            error = childError ?? new Error(`Error when running job ${this.name}: ${output}`)
            Object.assign(error, { exitSignal, exitCode, stderr: output })
          }
          this.clearTerminationTimers()
          this.process = undefined
          if (error && !this.stopping) reject(error)
          else resolve(output)
        }
        try {
          const serializedData = data === undefined ? undefined : JSON.stringify(data)
          if (data !== undefined && serializedData === undefined) throw new TypeError(`Job ${this.name} data must be JSON-serializable`)
          const dataArgument = serializedData === undefined ? [] : [`--data=${serializedData}`]
          proc = fork('server/core/worker.ts', [`--job=${this.name}`, ...dataArgument], {
            cwd: wiki.ROOTPATH,
            execArgv: process.execArgv.filter(argument => argument !== '--watch' && argument !== '--hot'),
            stdio: ['ignore', 'inherit', 'pipe', 'ipc']
          })
          this.process = proc
          this.processExited = false
          const retainStderr = (chunk: Buffer): void => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            const remaining = MAX_RETAINED_STDERR_BYTES - retainedStderrBytes
            if (remaining > 0) {
              const retained = bytes.subarray(0, remaining)
              if (retained.length > 0) {
                retainedStderr.push(Buffer.from(retained))
                retainedStderrBytes += retained.length
              }
            }
            if (bytes.length > remaining) stderrTruncated = true
          }
          proc.stderr?.on('data', retainStderr)
          proc.once('error', error => {
            childError = error instanceof Error ? error : new Error(String(error))
            finish()
          })
          proc.once('exit', (code, signal) => {
            this.processExited = true
            exitCode = code
            exitSignal = signal
            this.clearEscalationTimer()
            finish()
          })
          proc.once('close', () => {
            stderrClosed = true
            finish()
          })
        } catch (error) {
          reject(error)
        }
      } else {
        // Job name is selected from the validated runtime scheduler registry.
        this.finished = import(new URL(`../jobs/${this.name}.ts`, import.meta.url).href).then((module: { default: (value: unknown) => Promise<unknown> }) =>
          module.default(data)
        )
      }
      await this.finished
    } catch (error) {
      failed = true
      wiki.logger.warn(error)
    }
    this.observation.lastFinishedAt = new Date().toISOString()
    this.observation.lastDurationMs = Math.max(0, Date.now() - started)
    this.observation.lastOutcome = this.stopping ? 'stopped' : failed ? 'failed' : 'succeeded'
    if (failed && !this.stopping) this.observation.failures++
    this.observation.state = this.stopping ? 'stopped' : 'finished'

    if (this.repeat && !this.stopping && this.queue.jobs.includes(this)) {
      this.enqueue(data)
    } else {
      this.queue.jobs = this.queue.jobs.filter(job => job !== this)
      this.queue.remember(this)
    }
  }

  stop(): Promise<unknown> {
    if (this.stopPromise) return this.stopPromise
    const proc = this.process
    this.stopping = true
    this.observation.nextRunAt = null
    if (!proc) {
      this.observation.state = 'stopped'
      this.queue.remember(this)
    }
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = undefined
    }

    const { promise, reject, resolve } = Promise.withResolvers<unknown>()
    this.stopPromise = promise
    const finishStopping = (value?: unknown): void => {
      this.clearTerminationTimers()
      this.queue.jobs = this.queue.jobs.filter(job => job !== this)
      resolve(value)
    }
    this.finished.then(finishStopping, () => finishStopping())

    if (proc) {
      this.cancellationTimeout = setTimeout(() => {
        this.cancellationTimeout = undefined
        const code = this.processExited ? SCHEDULER_WORKER_COMPLETION_UNCONFIRMED : SCHEDULER_WORKER_TERMINATION_UNCONFIRMED
        const message = this.processExited ? 'completion unconfirmed' : 'termination unconfirmed'
        reject(Object.assign(new Error(`${message} for job ${this.name}`), { code }))
      }, 5_000)
      if (!this.processExited) {
        this.escalationTimeout = setTimeout(() => {
          this.escalationTimeout = undefined
          if (this.process !== proc || this.processExited || this.sigkillSent) return
          this.sigkillSent = true
          try {
            proc.kill('SIGKILL')
          } catch {
            // The confirmation timeout remains responsible for reporting an unconfirmed termination.
          }
        }, 1_000)
        if (!this.sigtermSent) {
          this.sigtermSent = true
          try {
            proc.kill('SIGTERM')
          } catch {
            // Escalation and the confirmation bound still apply when signal delivery throws.
          }
        }
      }
    }
    return promise
  }
}

interface Scheduler {
  jobs: Job[]
  started: boolean
  recent: ScheduledObservation[]
  skipped: ScheduledObservation[]
  stopPromise: Promise<void> | undefined
  remember(job: Job): void
  snapshot(): { started: boolean; jobs: ScheduledObservation[] }
  init(): Scheduler
  start(): void
  registerJob(opts: JobOptions, data?: unknown): Job
  stop(): Promise<void>
}
const scheduler: Scheduler = {
  jobs: [],
  started: false,
  recent: [],
  skipped: [],
  stopPromise: undefined,
  remember(job) {
    this.recent = [{ ...job.observation }, ...this.recent.filter(row => row.id !== job.observation.id)].slice(0, 50)
  },
  snapshot() {
    const active = this.jobs.map(job => ({ ...job.observation }))
    return {
      started: this.started,
      jobs: active.concat(
        this.recent.filter(row => !active.some(job => job.id === row.id)).map(row => ({ ...row })),
        this.skipped.map(row => ({ ...row }))
      )
    }
  },
  init() {
    return this
  },
  start() {
    if (this.started) return
    this.started = true
    this.stopPromise = undefined
    this.skipped = []
    _.forOwn(wiki.data.jobs, (params, queueName) => {
      if (wiki.config.offline && params.offlineSkip) {
        this.skipped.push({
          id: randomUUID(),
          name: _.kebabCase(queueName),
          state: 'skipped',
          repeat: params.repeat ?? false,
          worker: params.worker ?? false,
          intervalMs: 0,
          nextRunAt: null,
          lastStartedAt: null,
          lastFinishedAt: null,
          lastDurationMs: null,
          lastOutcome: null,
          runs: 0,
          failures: 0
        })
        wiki.logger.warn(`Skipping job ${queueName} because offline mode is enabled. [SKIPPED]`)
        return
      }
      const schedule = typeof params.schedule === 'string' && configHelper.isValidDurationString(params.schedule) ? params.schedule : 'P1D'
      this.registerJob({
        name: _.kebabCase(queueName),
        immediate: params.onInit ?? false,
        schedule,
        repeat: params.repeat ?? false,
        worker: params.worker ?? false
      })
    })
  },
  registerJob(opts, data) {
    const job = new Job(opts, this)
    job.start(data)
    return job
  },
  stop() {
    if (this.stopPromise) return this.stopPromise
    const jobs = [...this.jobs]
    let stopping: Promise<void>
    stopping = Promise.all(
      jobs.map(job =>
        job.stop().catch(error => {
          wiki.logger.warn(error)
          throw error
        })
      )
    )
      .then(() => {
        this.started = false
      })
      .finally(() => {
        if (this.stopPromise === stopping) this.stopPromise = undefined
      })
    this.stopPromise = stopping
    return stopping
  }
}

export default scheduler
