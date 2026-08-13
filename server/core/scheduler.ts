import moment from 'moment'
import { fork } from 'node:child_process'
import _ from 'lodash'
import configHelper from '../helpers/config.ts'

interface JobOptions { name: string; immediate?: boolean; schedule?: string; repeat?: boolean; worker?: boolean }
interface JobConfig { offlineSkip?: boolean; onInit?: boolean; repeat?: boolean; schedule?: string; worker?: boolean }
interface WikiContext { ROOTPATH: string; config: { offline: boolean }; data: { jobs: Record<string, JobConfig> }; logger: { warn(message: unknown): void } }
const wiki = WIKI as unknown as WikiContext

class Job {
  queue: Scheduler
  finished: Promise<unknown> = Promise.resolve()
  name: string
  immediate: boolean
  schedule: moment.Duration
  repeat: boolean
  worker: boolean
  timeout?: NodeJS.Timeout
  constructor({ name, immediate = false, schedule = 'P1D', repeat = false, worker = false }: JobOptions, queue: Scheduler) { this.queue = queue; this.name = name; this.immediate = immediate; this.schedule = moment.duration(schedule); this.repeat = repeat; this.worker = worker }
  start(data?: unknown) { this.queue.jobs.push(this); if (this.immediate) void this.invoke(data); else this.enqueue(data) }
  enqueue(data?: unknown) { this.timeout = setTimeout(() => { void this.invoke(data) }, this.schedule.asMilliseconds()) }
  async invoke(data?: unknown) {
    try {
      if (this.worker) {
        const proc = fork('server/core/worker.ts', [`--job=${this.name}`, `--data=${String(data)}`], { cwd: wiki.ROOTPATH, stdio: ['inherit', 'inherit', 'pipe', 'ipc'] })
        const stderr: Buffer[] = []
        proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
        this.finished = new Promise((resolve, reject) => { proc.on('exit', (code, signal) => { const output = Buffer.concat(stderr).toString(); if (code === 0) resolve(output); else reject(Object.assign(new Error(`Error when running job ${this.name}: ${output}`), { exitSignal: signal, exitCode: code, stderr: output })); proc.kill() }) })
      } else {
        // Job name is selected from the runtime scheduler registry.
        this.finished = import(new URL(`../jobs/${this.name}.ts`, import.meta.url).href).then((module: { default: (value: unknown) => Promise<unknown> }) => module.default(data))
      }
      await this.finished
    } catch (error) { wiki.logger.warn(error) }
    if (this.repeat && this.queue.jobs.includes(this)) this.enqueue(data); else void this.stop().catch(() => undefined)
  }
  async stop() { if (this.timeout) clearTimeout(this.timeout); this.queue.jobs = this.queue.jobs.filter(job => job !== this); return this.finished }
}

interface Scheduler { jobs: Job[]; init(): Scheduler; start(): void; registerJob(opts: JobOptions, data?: unknown): Job; stop(): Promise<unknown[]> }
const scheduler: Scheduler = {
  jobs: [],
  init() { return this },
  start() {
    _.forOwn(wiki.data.jobs, (params, queueName) => {
      if (wiki.config.offline && params.offlineSkip) { wiki.logger.warn(`Skipping job ${queueName} because offline mode is enabled. [SKIPPED]`); return }
      const schedule = typeof params.schedule === 'string' && configHelper.isValidDurationString(params.schedule) ? params.schedule : 'P1D'
      this.registerJob({ name: _.kebabCase(queueName), immediate: params.onInit ?? false, schedule, repeat: params.repeat ?? false, worker: params.worker ?? false })
    })
  },
  registerJob(opts, data) { const job = new Job(opts, this); job.start(data); return job },
  async stop() { return Promise.all(this.jobs.map(job => job.stop())) }
}

export default scheduler
