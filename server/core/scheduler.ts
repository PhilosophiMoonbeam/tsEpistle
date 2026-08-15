import moment from 'moment'
import { fork, type ChildProcess } from 'node:child_process'
import _ from 'lodash'
import configHelper from '../helpers/config.ts'

interface JobOptions { name: string; immediate?: boolean; schedule?: string; repeat?: boolean; worker?: boolean }
interface JobConfig { offlineSkip?: boolean; onInit?: boolean; repeat?: boolean; schedule?: string; worker?: boolean }
interface WikiContext { ROOTPATH: string; config: { offline: boolean }; data: { jobs: Record<string, JobConfig> }; logger: { warn(message: unknown): void } }
const wiki = WIKI as unknown as WikiContext
const validJobName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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
  stopping = false

  constructor({ name, immediate = false, schedule = 'P1D', repeat = false, worker = false }: JobOptions, queue: Scheduler) {
    if (!validJobName.test(name)) throw new TypeError(`Invalid scheduler job name: ${name}`)
    this.queue = queue
    this.name = name
    this.immediate = immediate
    this.schedule = moment.duration(schedule)
    this.repeat = repeat
    this.worker = worker
  }

  start(data?: unknown): void {
    this.stopping = false
    this.queue.jobs.push(this)
    if (this.immediate) void this.invoke(data)
    else this.enqueue(data)
  }

  enqueue(data?: unknown): void {
    if (this.stopping) return
    this.timeout = setTimeout(() => { void this.invoke(data) }, this.schedule.asMilliseconds())
  }

  async invoke(data?: unknown): Promise<void> {
    this.timeout = undefined
    try {
      if (this.worker) {
        const serializedData = data === undefined ? undefined : JSON.stringify(data)
        if (data !== undefined && serializedData === undefined) throw new TypeError(`Job ${this.name} data must be JSON-serializable`)
        const dataArgument = serializedData === undefined ? [] : [`--data=${serializedData}`]
        const proc = fork('server/core/worker.ts', [`--job=${this.name}`, ...dataArgument], {
          cwd: wiki.ROOTPATH,
          stdio: ['ignore', 'inherit', 'pipe', 'ipc']
        })
        this.process = proc
        const stderr: Buffer[] = []
        proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
        const { promise, reject, resolve } = Promise.withResolvers<unknown>()
        this.finished = promise
        {
          let settled = false
          const finish = (error?: Error): void => {
            if (settled) return
            settled = true
            this.process = undefined
            if (error && !this.stopping) reject(error)
            else resolve(Buffer.concat(stderr).toString())
          }
          proc.once('error', finish)
          proc.once('exit', (code, signal) => {
            const output = Buffer.concat(stderr).toString()
            finish(code === 0
              ? undefined
              : Object.assign(new Error(`Error when running job ${this.name}: ${output}`), {
                  exitSignal: signal,
                  exitCode: code,
                  stderr: output
                }))
          })
        }
      } else {
        // Job name is selected from the validated runtime scheduler registry.
        this.finished = import(new URL(`../jobs/${this.name}.ts`, import.meta.url).href)
          .then((module: { default: (value: unknown) => Promise<unknown> }) => module.default(data))
      }
      await this.finished
    } catch (error) {
      wiki.logger.warn(error)
    }

    if (this.repeat && !this.stopping && this.queue.jobs.includes(this)) {
      this.enqueue(data)
    } else {
      this.queue.jobs = this.queue.jobs.filter(job => job !== this)
    }
  }

  async stop(): Promise<unknown> {
    this.stopping = true
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = undefined
    }
    this.queue.jobs = this.queue.jobs.filter(job => job !== this)
    if (this.process && this.process.exitCode === null && !this.process.killed) this.process.kill('SIGTERM')
    try {
      return await this.finished
    } catch (error) {
      if (!this.stopping) throw error
      return undefined
    }
  }
}

interface Scheduler {
  jobs: Job[]
  started: boolean
  init(): Scheduler
  start(): void
  registerJob(opts: JobOptions, data?: unknown): Job
  stop(): Promise<void>
}
const scheduler: Scheduler = {
  jobs: [],
  started: false,
  init() { return this },
  start() {
    if (this.started) return
    this.started = true
    _.forOwn(wiki.data.jobs, (params, queueName) => {
      if (wiki.config.offline && params.offlineSkip) {
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
  async stop() {
    const jobs = [...this.jobs]
    await Promise.all(jobs.map(async job => {
      try {
        await job.stop()
      } catch (error) {
        wiki.logger.warn(error)
      }
    }))
    this.started = false
  }
}

export default scheduler
