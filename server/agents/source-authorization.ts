import { AsyncLocalStorage } from 'node:async_hooks'

/** Pure source-authority checks only; never reservation or dispatch-journal hooks. */
export type AgentSourceAuthorizer = () => Promise<void>
export type AgentSourceScopeRunner = <T>(operation: () => Promise<T>) => Promise<T>

const sourceAuthorization = new AsyncLocalStorage<AgentSourceAuthorizer | undefined>()

export const currentAgentSourceAuthorization = (): AgentSourceAuthorizer | undefined => sourceAuthorization.getStore()

/** Nested operations may add authority checks, but cannot discard an enclosing source scope. */
export const withAgentSourceAuthorization = <T>(authorize: AgentSourceAuthorizer | undefined, operation: () => Promise<T>): Promise<T> => {
  if (!authorize) return operation()
  const parent = sourceAuthorization.getStore()
  if (parent === authorize) return operation()
  const current = parent
    ? async () => {
        await parent()
        await authorize()
      }
    : authorize
  return sourceAuthorization.run(current, operation)
}

const withoutSourceAuthorization: AgentSourceScopeRunner = operation =>
  sourceAuthorization.getStore() === undefined ? operation() : sourceAuthorization.run(undefined, operation)

/** Bind an owned invocation before an SDK queues callbacks in an unrelated scheduler context. */
export const captureAgentSourceAuthorization = (): AgentSourceScopeRunner => {
  const captured = sourceAuthorization.getStore()
  if (captured === undefined) return withoutSourceAuthorization
  return operation => (sourceAuthorization.getStore() === captured ? operation() : sourceAuthorization.run(captured, operation))
}
