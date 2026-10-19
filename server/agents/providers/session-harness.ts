import { type AxCodeSession, AxJSRuntime } from '@ax-llm/ax'
import { z } from 'zod'
import type { AgentActionName } from '../../../shared/agents/contracts.ts'
import type { ActionCapability, ActionGroup } from '../actions/catalog.ts'
import type { OfferedAction } from '../actions/kernel.ts'
import { AgentRepositoryError } from '../repository.ts'

const MAX_SNAPSHOT_BYTES = 256 * 1_024
const MAX_ACTION_RESULT_BYTES = 128 * 1_024
const RESERVED_NAMES = ['__wikiActions'] as const
const NO_HOST_RESULT = Symbol('no-host-result')

export interface AxHarnessFunction {
  readonly name: AgentActionName
  readonly title: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly risk: string
  readonly group: ActionGroup
  /** Trusted catalog classification; kernel-offered functions always supply it. */
  readonly capability?: ActionCapability
}

export interface AxActionSession {
  readonly authoritySha256: string | null
  /** Exact reusable authority, excluding the root run's ephemeral request identity. */
  readonly specialistAuthoritySha256?: string
  readonly functions: readonly AxHarnessFunction[]
  /** Effective request and loaded-skill restriction; absent means no action-name restriction. */
  readonly allowedActions?: readonly AgentActionName[]
  /** Refreshes those restrictions before a synthetic action bypasses kernel.execute. */
  authorizeSyntheticAction?(name: AgentActionName, signal: AbortSignal): Promise<boolean>
  invoke(name: string, input: unknown, signal: AbortSignal, actionCallId: string): Promise<unknown>
  /** Bound metadata projections require the matching original function input. */
  validateObservation?(actionName: AgentActionName, output: unknown, signal: AbortSignal, originalInput?: unknown): Promise<boolean>
  snapshot(signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  close(): void
}

export interface AxSessionHarnessOptions {
  readonly timeoutMilliseconds?: number
  readonly execute: (action: OfferedAction, input: unknown, signal: AbortSignal, actionCallId: string) => Promise<unknown>
  readonly validateObservation?: (actionName: AgentActionName, output: unknown, signal: AbortSignal, originalInput?: unknown) => Promise<boolean>
}

const boundedJson = (value: unknown, maxBytes: number, code: string): string => {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
    if (typeof encoded !== 'string') throw new Error('Missing JSON representation')
  } catch {
    throw new AgentRepositoryError(code, 'Runtime value is not JSON serializable', 500)
  }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new AgentRepositoryError(code, 'Runtime value exceeds its size limit', 500)
  return encoded
}

export class AxSessionHarness {
  readonly #runtime: AxJSRuntime
  readonly #execute: AxSessionHarnessOptions['execute']
  readonly #validateObservation: AxSessionHarnessOptions['validateObservation']

  constructor(options: AxSessionHarnessOptions) {
    this.#validateObservation = options.validateObservation
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
    let invocation: { readonly signal: AbortSignal; readonly actionCallId: string; hostResult: unknown; hostFailure?: AgentRepositoryError } | undefined
    let closed = false
    const assertOpen = (): void => {
      if (closed) throw new AgentRepositoryError('ACTION_SESSION_CLOSED', 'Action session is closed', 409)
    }
    const callbacks = Object.fromEntries(
      actions.map(action => [
        action.definition.descriptor.name,
        async (inputJson: string) => {
          const active = invocation
          if (!active) throw new AgentRepositoryError('ACTION_SESSION_INVALID', 'Action callback was invoked outside an active request', 500)
          assertOpen()
          active.signal.throwIfAborted()
          let result: unknown
          let failure: AgentRepositoryError | undefined
          try {
            result = await this.#execute(action, JSON.parse(inputJson) as unknown, active.signal, active.actionCallId)
            boundedJson(result, MAX_ACTION_RESULT_BYTES, 'ACTION_RESULT_TOO_LARGE')
          } catch (error: unknown) {
            const rawCode = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
            const rawStatus = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : undefined
            const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(rawCode) ? rawCode : 'ACTION_FAILED'
            const status = Number.isInteger(rawStatus) && Number(rawStatus) >= 400 && Number(rawStatus) <= 599 ? Number(rawStatus) : 500
            failure = new AgentRepositoryError(code, 'Action failed', status)
            result = null
          }
          // Ax can reject execute (abort/timeout/close) while its host callback
          // is still pending. Never publish that callback's late completion.
          assertOpen()
          active.signal.throwIfAborted()
          if (invocation !== active) throw new AgentRepositoryError('ACTION_SESSION_INVALID', 'Action callback no longer owns its request', 500)
          active.hostResult = result
          if (failure) active.hostFailure = failure
          return result
        }
      ])
    )
    let bindings: Record<string, unknown> | undefined
    if (initialSnapshot) {
      const encoded = boundedJson(initialSnapshot, MAX_SNAPSHOT_BYTES, 'INVALID_RUNTIME_SNAPSHOT')
      bindings = JSON.parse(encoded) as Record<string, unknown>
      delete bindings.__wikiActions
    }
    const functions = actions.map(action => ({
      name: action.definition.descriptor.name,
      title: action.definition.descriptor.title,
      description: action.definition.descriptor.description,
      parameters: z.toJSONSchema(action.definition.input) as Record<string, unknown>,
      risk: action.definition.descriptor.risk,
      group: action.definition.group,
      capability: action.definition.capability
    }))
    const session: AxCodeSession = this.#runtime.createSession({ __wikiActions: Object.freeze(callbacks) })
    const close = (): void => {
      if (closed) return
      closed = true
      session.close()
    }
    try {
      if (bindings) await session.patchGlobals(bindings)
    } catch (error) {
      close()
      throw error
    }
    return {
      authoritySha256: null,
      functions,
      invoke: async (name, input, signal, actionCallId) => {
        assertOpen()
        // SDK execution is queued, but host authority/result slots belong to one
        // invocation. Reject overlap before it can replace the active identity.
        if (invocation) throw new AgentRepositoryError('ACTION_SESSION_BUSY', 'Action session already has an active request', 409)
        if (!offered.has(name as AgentActionName)) throw new AgentRepositoryError('ACTION_NOT_OFFERED', 'Provider requested an unavailable action', 403)
        if (!actionCallId || actionCallId.length > 128) throw new AgentRepositoryError('INVALID_ACTION_CALL_ID', 'Action call identity is invalid', 400)
        const inputJson = boundedJson(input, 64 * 1_024, 'INVALID_ACTION_INPUT')
        // Transport JSON text, not a JavaScript object literal: own __proto__
        // keys must remain data, and Ax scans source for quoted directives.
        const inputLiteral = JSON.stringify(inputJson).replaceAll("'", '\\u0027')
        signal.throwIfAborted()
        const active: { readonly signal: AbortSignal; readonly actionCallId: string; hostResult: unknown; hostFailure?: AgentRepositoryError } = {
          signal,
          actionCallId,
          hostResult: NO_HOST_RESULT
        }
        invocation = active
        try {
          try {
            await session.execute(`await __wikiActions[${JSON.stringify(name)}](${inputLiteral})`, { signal, reservedNames: RESERVED_NAMES })
          } catch (error) {
            // A timed-out worker may restart, and an aborted worker is already
            // closed. Neither can safely retain this host invocation's ownership.
            close()
            throw error
          }
          if (signal.aborted) {
            close()
            signal.throwIfAborted()
          }
          assertOpen()
          const hostResult = active.hostResult
          if (hostResult === NO_HOST_RESULT)
            throw new AgentRepositoryError('ACTION_SESSION_INVALID', 'Action worker completed without invoking its host callback', 500)
          if (active.hostFailure) throw active.hostFailure
          return hostResult
        } finally {
          if (invocation === active) invocation = undefined
        }
      },
      ...(this.#validateObservation
        ? {
            validateObservation: async (actionName: AgentActionName, output: unknown, signal: AbortSignal, originalInput?: unknown): Promise<boolean> => {
              if (signal.aborted) return false
              const valid = await this.#validateObservation?.(actionName, output, signal, originalInput)
              return valid === true && !signal.aborted
            }
          }
        : {}),
      snapshot: async signal => {
        assertOpen()
        try {
          if (!session.snapshotGlobals) return {}
          const snapshot = await session.snapshotGlobals({ signal, reservedNames: RESERVED_NAMES })
          assertOpen()
          signal.throwIfAborted()
          const encoded = boundedJson(snapshot.bindings, MAX_SNAPSHOT_BYTES, 'RUNTIME_SNAPSHOT_TOO_LARGE')
          return JSON.parse(encoded) as Record<string, unknown>
        } catch (error) {
          close()
          throw error
        }
      },
      close
    }
  }
}
