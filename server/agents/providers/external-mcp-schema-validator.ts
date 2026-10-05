import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AgentRepositoryError } from '../repository.ts'

export type ExternalMcpSchemaCommand =
  | { readonly operation: 'catalog'; readonly schemas: readonly { readonly name: string; readonly schema: Record<string, unknown> }[] }
  | { readonly operation: 'validate'; readonly name: string; readonly input: unknown }
export type ExternalMcpSchemaRequest = ExternalMcpSchemaCommand & { readonly id: number }
export type ExternalMcpSchemaResponse = { readonly id: number; readonly result: boolean | null }

const DEADLINE_MS = 2_000
const failure = (): AgentRepositoryError => new AgentRepositoryError('EXTERNAL_MCP_CALL_FAILED', 'External MCP tool input validation is unavailable', 502)

interface PendingValidation {
  readonly command: ExternalMcpSchemaRequest
  readonly timer: NodeJS.Timeout
  readonly resolve: (result: boolean) => void
  readonly reject: (error: AgentRepositoryError) => void
}

/** One private process per owner lease; untrusted compilation and regexes never run on the server event loop. */
export class ExternalMcpSchemaValidator {
  readonly #signal: AbortSignal
  readonly #pending = new Map<number, PendingValidation>()
  readonly #onAbort = (): void => {
    void this.close()
  }
  #worker: ChildProcess | undefined
  #exit: Promise<void> | undefined
  #closing: Promise<void> | undefined
  #ready = false
  #closed = false
  #nextId = 0

  constructor(signal: AbortSignal) {
    this.#signal = signal
    signal.addEventListener('abort', this.#onAbort, { once: true })
  }

  async prepare(schemas: Extract<ExternalMcpSchemaCommand, { operation: 'catalog' }>['schemas']): Promise<void> {
    if (!(await this.request({ operation: 'catalog', schemas }))) throw failure()
  }

  async validate(name: string, input: unknown): Promise<boolean> {
    return this.request({ operation: 'validate', name, input })
  }

  private start(): void {
    if (this.#worker) return
    // Production preserves the server TypeScript tree and executes it with Bun,
    // as does the existing scheduler's forked worker entrypoint.
    const worker = fork(fileURLToPath(new URL('./external-mcp-schema-worker.ts', import.meta.url)), [], {
      execArgv: [],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'production' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json'
    })
    this.#worker = worker
    const exited = Promise.withResolvers<void>()
    this.#exit = exited.promise
    worker.once('close', () => {
      exited.resolve()
      if (!this.#closed) void this.stop(failure())
    })
    worker.once('error', () => {
      void this.stop(failure())
    })
    worker.on('message', (message: unknown) => {
      if (this.#closed) return
      if (message === 'ready') {
        if (this.#ready) return
        this.#ready = true
        for (const pending of this.#pending.values()) this.send(pending.command)
        return
      }
      if (typeof message !== 'object' || message === null) return void this.stop(failure())
      const id: unknown = Reflect.get(message, 'id')
      const result: unknown = Reflect.get(message, 'result')
      if (typeof id !== 'number' || (result !== null && typeof result !== 'boolean')) return void this.stop(failure())
      const pending = this.#pending.get(id)
      if (!pending) return void this.stop(failure())
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      if (result === null) pending.reject(failure())
      else pending.resolve(result)
    })
  }

  private send(command: ExternalMcpSchemaRequest): void {
    try {
      this.#worker!.send(command, error => {
        if (error) void this.stop(failure())
      })
    } catch {
      void this.stop(failure())
    }
  }

  private request(command: ExternalMcpSchemaCommand): Promise<boolean> {
    this.#signal.throwIfAborted()
    if (this.#closed) return Promise.reject(failure())
    const result = Promise.withResolvers<boolean>()
    const id = ++this.#nextId
    const request = { ...command, id }
    const timer = setTimeout(() => {
      void this.stop(new AgentRepositoryError('EXTERNAL_MCP_SCHEMA_VALIDATION_TIMEOUT', 'External MCP tool input validation exceeded its execution limit', 502))
    }, DEADLINE_MS)
    this.#pending.set(id, { command: request, timer, resolve: result.resolve, reject: result.reject })
    try {
      this.start()
      if (this.#ready) this.send(request)
    } catch {
      void this.stop(failure())
    }
    return result.promise
  }

  private stop(error: AgentRepositoryError): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    this.#signal.removeEventListener('abort', this.#onAbort)
    for (const pending of this.#pending.values()) clearTimeout(pending.timer)
    this.#closing = (async () => {
      if (this.#worker && this.#worker.exitCode === null && this.#worker.signalCode === null) this.#worker.kill('SIGKILL')
      await this.#exit
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
    })()
    return this.#closing
  }

  close(): Promise<void> {
    return this.stop(failure())
  }
}
