import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CancellationToken,
  CancellationTokenSource,
  createMessageConnection,
  NullLogger,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node'
import { cleanEnvironment } from './local-ci-resources.ts'

export type Backend = 'typescript' | 'vue'
export type Fields = Record<string, unknown>

export function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function fields(value: unknown): Fields {
  return isFields(value) ? value : {}
}

const root = path.resolve(import.meta.dir, '../..')
const require = createRequire(import.meta.url)

export const localTypescript = path.dirname(require.resolve('typescript/lib/tsserver.js'))
export const localVuePlugin = path.dirname(require.resolve('@vue/typescript-plugin/package.json'))

function nodeExecutable(): string {
  const executable = Bun.which('node')
  if (!executable || realpathSync(executable) === realpathSync(process.execPath)) {
    throw new Error('The Vue language bridge requires an actual Node executable.')
  }
  return executable
}

export async function deadline<T>(operation: Promise<T>, milliseconds: number, expire: () => void): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    expire()
    reject(new Error('The language server did not stop within its shutdown deadline.'))
  }, milliseconds)
  try {
    return await Promise.race([operation, promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Each Node LSP owns one process group, including the tsserver it forks. */
export class Upstream {
  readonly backend: Backend
  readonly connection: MessageConnection
  readonly child: ChildProcessWithoutNullStreams
  readonly closed: Promise<void>
  capabilities: Fields = {}
  initialized = false
  stopping = false
  private stopPromise: Promise<void> | undefined
  private initialization: Promise<unknown> | undefined

  constructor(backend: Backend, failure: () => void) {
    this.backend = backend
    const cli = backend === 'typescript'
      ? require.resolve('typescript-language-server/lib/cli.mjs')
      : require.resolve('@vue/language-server/bin/vue-language-server.js')
    const args = backend === 'vue' ? [cli, '--stdio', `--tsdk=${localTypescript}`] : [cli, '--stdio']
    this.child = spawn(nodeExecutable(), args, {
      cwd: root,
      env: cleanEnvironment(),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const closed = Promise.withResolvers<void>()
    this.closed = closed.promise
    this.child.once('close', () => closed.resolve())
    // Upstream stderr can contain source text and paths. Drain it without logging it.
    this.child.stderr.resume()
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
      NullLogger
    )
    const failed = () => { if (!this.stopping) failure() }
    this.child.on('error', failed)
    this.child.on('close', failed)
    this.child.stdin.on('error', failed)
    this.child.stdout.on('error', failed)
    this.connection.onError(failed)
    this.connection.onClose(failed)
  }

  request(method: string, params: unknown, token: CancellationToken): Promise<unknown> {
    if (method === 'initialize' && this.stopping) {
      return Promise.reject(new Error('An upstream cannot initialize after shutdown has started.'))
    }
    let operation: Promise<unknown>
    if (Array.isArray(params)) operation = this.connection.sendRequest<unknown>(method, ...params, token)
    else if (params === undefined) operation = this.connection.sendRequest<unknown>(method, token)
    else operation = this.connection.sendRequest<unknown>(method, params, token)
    if (method === 'initialize') this.initialization = operation
    return operation
  }

  notify(method: string, params: unknown): Promise<void> {
    if (Array.isArray(params)) return this.connection.sendNotification(method, ...params)
    if (params === undefined) return this.connection.sendNotification(method)
    return this.connection.sendNotification(method, params)
  }

  killGroup(signal: NodeJS.Signals): void {
    if (!this.child.pid) return
    try {
      process.kill(-this.child.pid, signal)
    } catch (error) {
      if (!isFields(error) || error.code !== 'ESRCH') throw error
    }
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOwnedGroup()
    return this.stopPromise
  }

  private async terminateOwnedChildren(): Promise<void> {
    if (!this.child.pid || process.platform !== 'linux') return
    const parent = this.child.pid
    const children = await readFile(`/proc/${parent}/task/${parent}/children`, 'utf8')
    for (const value of children.trim().split(/\s+/).filter(Boolean)) {
      const pid = Number(value)
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned service process identity.')
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        const identity = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (Number(identity[1]) !== parent || Number(identity[2]) !== parent) {
          throw new Error('A service process left its owned process group.')
        }
        // TSLS 5.3.0 acknowledges LSP shutdown without calling its server.shutdown.
        // Its own shutdown method uses ChildProcess.kill() (SIGTERM) for tsserver.
        // Do that while TSLS is still alive to reap the child, before LSP exit.
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        if (isFields(error) && (error.code === 'ENOENT' || error.code === 'ESRCH')) continue
        throw error
      }
    }
  }

  private async waitForReapedChildren(): Promise<void> {
    if (!this.child.pid || process.platform !== 'linux') return
    const children = `/proc/${this.child.pid}/task/${this.child.pid}/children`
    const until = Date.now() + 1_000
    while (Date.now() < until) {
      try {
        if (!(await readFile(children, 'utf8')).trim()) return
      } catch (error) {
        if (isFields(error) && error.code === 'ENOENT') return
        throw error
      }
      // Keep the Node LSP alive long enough to reap the tsserver it just killed,
      // instead of exiting immediately and stranding a grandchild zombie.
      await delay(20)
    }
    throw new Error('An upstream did not reap its language-service children.')
  }

  private async stopOwnedGroup(): Promise<void> {
    this.stopping = true
    const cancellation = new CancellationTokenSource()
    let shutdownError: unknown
    try {
      // An initialize already written to Node can spawn tsserver before its
      // acknowledgement arrives. Bound that transition before inspecting/reaping
      // descendants, rather than exiting their parent while it is still starting.
      if (this.initialization && !this.initialized) {
        try {
          await deadline(this.initialization, 3_000, () => cancellation.cancel())
          this.initialized = true
        } catch (error) {
          shutdownError = error
        }
      }
      if (this.initialized && this.child.exitCode === null && this.child.signalCode === null) {
        try {
          await deadline(this.request('shutdown', undefined, cancellation.token), 3_000, () => cancellation.cancel())
        } catch (error) {
          shutdownError ??= error
        }
      }
      // Retirement is unconditional: a rejected/timed-out LSP shutdown must not
      // bypass owned-child signalling and parent reaping before LSP exit.
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          if (this.backend === 'typescript') await this.terminateOwnedChildren()
          await this.waitForReapedChildren()
        } catch (error) {
          shutdownError ??= error
        }
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await this.notify('exit', undefined).catch(() => undefined)
        await deadline(this.closed, 1_000, () => this.killGroup('SIGTERM')).catch(() => undefined)
      }
      // The group may outlive its original leader; always retire any remaining members.
      this.killGroup('SIGTERM')
      await deadline(this.closed, 1_000, () => this.killGroup('SIGKILL')).catch(() => undefined)
    } finally {
      cancellation.dispose()
      this.killGroup('SIGKILL')
      await deadline(this.closed, 1_000, () => undefined).catch(error => { shutdownError ??= error })
      this.connection.dispose()
      this.child.stdin.destroy()
      this.child.stdout.destroy()
      this.child.stderr.destroy()
    }
    if (shutdownError !== undefined) throw shutdownError
  }
}
