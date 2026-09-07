import { LoggingConsoleDraftSchema, LoggingWorkspaceDraftSchema, type LoggingRuntimeSnapshot, type LoggingWorkspace } from '../../shared/logging-workspace.ts'
import { sameOriginJsonFetch } from './json-transport.ts'

type FetchResponse = Response
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const request = async (method: 'GET' | 'PUT' | 'POST', suffix: string, body?: unknown): Promise<Record<string, unknown>> => {
  const response = (await sameOriginJsonFetch(window.fetch.bind(window), '/_api/logging' + suffix, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })) as FetchResponse
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = record(payload).error
    throw Object.assign(new Error(typeof error === 'string' ? error : 'Logging administration is unavailable.'), { status: response.status })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('The Logging response could not be read. Reload before repeating an action.')
  return payload as Record<string, unknown>
}

const workspace = (value: Record<string, unknown>): LoggingWorkspace => {
  const console = value.console
  const runtime = record(value.runtime)
  if (
    typeof value.fingerprint !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof value.observedAt !== 'string' ||
    !LoggingConsoleDraftSchema.safeParse(console).success ||
    !Array.isArray(value.destinations) ||
    !Array.isArray(value.history) ||
    typeof runtime.settingsCurrent !== 'boolean' ||
    !['ready', 'partially-applied', 'unapplied'].includes(String(runtime.state)) ||
    !record(value.liveTrail).enabled
  )
    throw new Error('The Logging workspace response is invalid. Reload to confirm saved settings and process observations.')
  for (const destination of value.destinations) {
    const item = record(destination)
    if (
      typeof item.key !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.isEnabled !== 'boolean' ||
      !['available', 'unavailable'].includes(String(item.availability)) ||
      !LoggingConsoleDraftSchema.shape.level.safeParse(item.level).success ||
      !Array.isArray(item.fields) ||
      typeof item.config !== 'object' ||
      item.config === null ||
      Array.isArray(item.config) ||
      typeof item.secrets !== 'object' ||
      item.secrets === null ||
      Array.isArray(item.secrets)
    )
      throw new Error('The Logging workspace response is invalid. Reload to confirm saved settings and process observations.')
  }
  return value as unknown as LoggingWorkspace
}

const publication = async (
  method: 'PUT' | 'POST',
  suffix: string,
  input: unknown
): Promise<{ revision: string; applied: boolean; runtime?: LoggingRuntimeSnapshot }> => {
  const value = await request(method, suffix, input)
  if (typeof value.revision !== 'string' || typeof value.applied !== 'boolean')
    throw new Error('The save or application outcome is unconfirmed. Reload before repeating it.')
  if (value.runtime !== undefined) {
    const runtime = record(value.runtime)
    if (typeof runtime.settingsCurrent !== 'boolean' || !['ready', 'partially-applied', 'unapplied'].includes(String(runtime.state)))
      throw new Error('The application outcome is unconfirmed. Reload before repeating it.')
  }
  return value as { revision: string; applied: boolean; runtime?: LoggingRuntimeSnapshot }
}

export const fetchLoggingWorkspace = async (): Promise<LoggingWorkspace> => workspace(await request('GET', '/workspace'))
export const saveLoggingWorkspace = async (input: unknown) => {
  if (!LoggingWorkspaceDraftSchema.safeParse(input).success) {
    throw Object.assign(new Error('Review the complete logging configuration before saving.'), { status: 400, confirmed: true })
  }
  return publication('PUT', '/workspace', input)
}
export const applyLoggingWorkspace = (fingerprint: string) => publication('POST', '/workspace/apply', { fingerprint })
