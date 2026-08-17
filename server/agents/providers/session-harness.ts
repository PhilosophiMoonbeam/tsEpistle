import { AxJSRuntime, type AxCodeSession } from '@ax-llm/ax'
import { z } from 'zod'
import type { AgentActionName } from '../../../shared/agents/contracts.ts'
import type { OfferedAction } from '../actions/kernel.ts'
import { AgentRepositoryError } from '../repository.ts'

const MAX_SNAPSHOT_BYTES = 256 * 1_024
const MAX_ACTION_RESULT_BYTES = 128 * 1_024
const RESERVED_NAMES = ['__wikiActions'] as const

export interface AxHarnessFunction {
  readonly name: AgentActionName
  readonly title: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly risk: string
}

export interface AxActionSession {
  readonly functions: readonly AxHarnessFunction[]
  invoke(name: string, input: unknown, signal: AbortSignal, actionCallId: string): Promise<unknown>
  snapshot(signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  close(): void
}

export interface AxSessionHarnessOptions {
  readonly timeoutMilliseconds?: number
  readonly execute: (action: OfferedAction, input: unknown, signal: AbortSignal, actionCallId: string) => Promise<unknown>
}

const boundedJson = (value: unknown, maxBytes: number, code: string): string => {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new AgentRepositoryError(code, 'Runtime value is not JSON serializable', 500)
  }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new AgentRepositoryError(code, 'Runtime value exceeds its size limit', 500)
  return encoded
}

export class AxSessionHarness {
  readonly #runtime: AxJSRuntime
  readonly #execute: AxSessionHarnessOptions['execute']

  constructor (options: AxSessionHarnessOptions) {
    this.#execute = options.execute
    this.#runtime = new AxJSRuntime({
      timeout: options.timeoutMilliseconds ?? 30_000,
      permissions: [],
      outputMode: 'return',
      captureConsole: false,
      allowUnsafeNodeHostAccess: false,
      nodeWorkerPoolSize: 1,
      blockDynamicImport: true,
      allowedModules: [],
      freezeIntrinsics: true,
      blockShadowRealm: true,
      lockWorkerIPC: true,
      useNodePermissionModel: 'auto',
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16, stackSizeMb: 2 },
      allowDenoRemoteImport: false
    })
  }

  async open(actions: readonly OfferedAction[], initialSnapshot?: Readonly<Record<string, unknown>>): Promise<AxActionSession> {
    const offered = new Map(actions.map(action => [action.definition.descriptor.name, action]))
    let invocationSignal: AbortSignal | undefined
    let invocationActionCallId: string | undefined
    const callbacks = Object.fromEntries(actions.map(action => [action.definition.descriptor.name, async (input: unknown) => {
      if (!invocationSignal || !invocationActionCallId) throw new AgentRepositoryError('ACTION_SESSION_INVALID', 'Action callback was invoked outside an active request', 500)
      const output = await this.#execute(action, input, invocationSignal, invocationActionCallId)
      boundedJson(output, MAX_ACTION_RESULT_BYTES, 'ACTION_RESULT_TOO_LARGE')
      return output
    }]))
    const session: AxCodeSession = this.#runtime.createSession({ __wikiActions: Object.freeze(callbacks) })
    if (initialSnapshot) {
      const encoded = boundedJson(initialSnapshot, MAX_SNAPSHOT_BYTES, 'INVALID_RUNTIME_SNAPSHOT')
      const bindings = JSON.parse(encoded) as Record<string, unknown>
      delete bindings.__wikiActions
      await session.patchGlobals(bindings)
    }
    let closed = false
    const assertOpen = (): void => {
      if (closed) throw new AgentRepositoryError('ACTION_SESSION_CLOSED', 'Action session is closed', 409)
    }
    return {
      functions: actions.map(action => ({
        name: action.definition.descriptor.name,
        title: action.definition.descriptor.title,
        description: action.definition.descriptor.description,
        parameters: z.toJSONSchema(action.definition.input) as Record<string, unknown>,
        risk: action.definition.descriptor.risk
      })),
      invoke: async (name, input, signal, actionCallId) => {
        assertOpen()
        if (!offered.has(name as AgentActionName)) throw new AgentRepositoryError('ACTION_NOT_OFFERED', 'Provider requested an unavailable action', 403)
        if (!actionCallId || actionCallId.length > 128) throw new AgentRepositoryError('INVALID_ACTION_CALL_ID', 'Action call identity is invalid', 400)
        const inputJson = boundedJson(input, 64 * 1_024, 'INVALID_ACTION_INPUT')
        invocationSignal = signal
        invocationActionCallId = actionCallId
        try {
          return await session.execute(`await __wikiActions[${JSON.stringify(name)}](${inputJson})`, { signal, reservedNames: RESERVED_NAMES })
        } finally {
          invocationSignal = undefined
          invocationActionCallId = undefined
        }
      },
      snapshot: async signal => {
        assertOpen()
        if (!session.snapshotGlobals) return {}
        const snapshot = await session.snapshotGlobals({ signal, reservedNames: RESERVED_NAMES })
        const encoded = boundedJson(snapshot.bindings, MAX_SNAPSHOT_BYTES, 'RUNTIME_SNAPSHOT_TOO_LARGE')
        return JSON.parse(encoded) as Record<string, unknown>
      },
      close: () => {
        if (closed) return
        closed = true
        session.close()
      }
    }
  }
}
