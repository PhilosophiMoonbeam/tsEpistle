import {
  UtilitiesWorkspaceSchema,
  UtilityOperationSchema,
  type UtilityOperationKind,
  type UtilitiesWorkspace,
  type UtilityOperation
} from '../../shared/utilities-workspace.ts'
import { sameOriginJsonFetch } from './json-transport.ts'

const request = async (method: string, suffix: string, body?: unknown, signal?: AbortSignal) => {
  const response = await sameOriginJsonFetch(window.fetch.bind(window), '/_api/utilities' + suffix, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {})
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof Reflect.get(payload, 'error') === 'string'
        ? Reflect.get(payload, 'error')
        : 'Utilities administration is unavailable.'
    throw Object.assign(new Error(message), { status: response.status })
  }
  return payload
}

export const fetchUtilitiesWorkspace = async (signal?: AbortSignal): Promise<UtilitiesWorkspace> => {
  const parsed = UtilitiesWorkspaceSchema.safeParse(await request('GET', '/workspace', undefined, signal))
  if (!parsed.success) throw new Error('The Utilities workspace response is incomplete. Reload before starting an action.')
  return parsed.data
}

export const fetchUtilitiesReceipt = async (id: string, signal?: AbortSignal): Promise<UtilityOperation> => {
  const parsed = UtilityOperationSchema.safeParse(await request('GET', `/operations/${encodeURIComponent(id)}`, undefined, signal))
  if (!parsed.success) throw new Error('The Utilities operation receipt is incomplete. Reload before deciding whether to repeat an action.')
  return parsed.data
}

export interface UtilitiesOperationRequest {
  id: string
  kind: UtilityOperationKind
  fingerprint: string
  reason: string
  confirmation: string
  acknowledgedUncertainId?: string
  payload?: Record<string, unknown>
}

export const startUtilitiesOperation = async (input: UtilitiesOperationRequest): Promise<UtilityOperation> => {
  const parsed = UtilityOperationSchema.safeParse(await request('POST', '/operations', { ...input, payload: input.payload ?? {} }))
  if (!parsed.success) throw new Error('The Utilities action was not confirmed. Reload to inspect existing receipts before trying again.')
  return parsed.data
}
