import { sameOriginJsonFetch } from './json-transport.ts'
import { isRecord } from './type-guards'

type JsonHeaders = {
  get: (name: string) => string | null
}

type JsonResponse = {
  ok: boolean
  headers?: JsonHeaders
  json?: () => Promise<unknown>
}

type FetchImpl = (
  url: string,
  init: {
    method?: string
    credentials: 'same-origin'
    headers: {
      Accept: 'application/json'
      'Content-Type'?: 'application/json'
    }
    body?: string
  }
) => Promise<JsonResponse>

type MessageResponse = {
  message: string
  [key: string]: unknown
}

export type StorageConfigEntry = {
  key: string
  value: string
  [key: string]: unknown
}

export type StorageAction = {
  handler: string
  hint: string
  label: string
}

export type StorageInterval = string | false | null

export type StorageTarget = {
  actions?: StorageAction[]
  config: StorageConfigEntry[]
  description: string
  hasSchedule: boolean
  isAvailable: boolean
  isEnabled: boolean
  key: string
  logo: string
  mode: string
  supportedModes: string[]
  syncInterval: string
  syncIntervalDefault: StorageInterval
  title: string
  website: string
}

export type StorageActionOutcome = 'succeeded' | 'partial' | 'failed'

export type StorageActionFormat = 'okf' | 'legacyV1' | 'legacyWiki' | 'plain' | 'invalid'

export type StorageActionFormatCounts = Record<StorageActionFormat, number>

export type StorageActionItem = {
  kind: 'page' | 'asset'
  path: string
  outcome: 'succeeded' | 'failed' | 'conflict'
  format: StorageActionFormat | null
  message: string | null
  diagnostics: string[]
}

export type StorageActionSummary = {
  targetKey: string
  handler: string
  outcome: StorageActionOutcome
  total: number
  succeeded: number
  failed: number
  formats: StorageActionFormatCounts
  items: StorageActionItem[]
  startedAt: string
  completedAt: string
  message: string
}

export type StorageStatus = {
  key: string
  lastAttempt: string | null
  lastOperation: StorageActionSummary | null
  message: string
  status: string
  title: string
}

export type StorageTargetUpdate = Pick<StorageTarget, 'isEnabled' | 'key' | 'mode' | 'syncInterval'> & {
  config: StorageConfigEntry[]
}

type StorageTargetPayload = Omit<StorageTarget, 'supportedModes' | 'syncIntervalDefault'> & {
  supportedModes?: string[]
  syncIntervalDefault?: StorageInterval
}

function isStorageConfigEntry(value: unknown): value is StorageConfigEntry {
  return isRecord(value) && typeof value.key === 'string' && typeof value.value === 'string'
}

function isStorageAction(value: unknown): value is StorageAction {
  return isRecord(value) && typeof value.handler === 'string' && typeof value.hint === 'string' && typeof value.label === 'string'
}

function isStorageTargetPayload(value: unknown): value is StorageTargetPayload {
  if (!isRecord(value)) return false
  const actions = value.actions
  const intervalDefault = value.syncIntervalDefault
  return (
    (actions === undefined || (Array.isArray(actions) && actions.every(isStorageAction))) &&
    Array.isArray(value.config) &&
    value.config.every(isStorageConfigEntry) &&
    typeof value.description === 'string' &&
    typeof value.hasSchedule === 'boolean' &&
    typeof value.isAvailable === 'boolean' &&
    typeof value.isEnabled === 'boolean' &&
    typeof value.key === 'string' &&
    typeof value.logo === 'string' &&
    typeof value.mode === 'string' &&
    (value.supportedModes === undefined || (Array.isArray(value.supportedModes) && value.supportedModes.every(mode => typeof mode === 'string'))) &&
    typeof value.syncInterval === 'string' &&
    (intervalDefault === undefined || typeof intervalDefault === 'string' || intervalDefault === false || intervalDefault === null) &&
    typeof value.title === 'string' &&
    typeof value.website === 'string'
  )
}

const STORAGE_ACTION_FORMATS = ['okf', 'legacyV1', 'legacyWiki', 'plain', 'invalid'] as const
const STORAGE_ACTION_OUTCOMES = ['succeeded', 'partial', 'failed'] as const
const STORAGE_ACTION_ITEM_OUTCOMES = ['succeeded', 'failed', 'conflict'] as const
const STORAGE_ACTION_ITEM_KINDS = ['page', 'asset'] as const
const MAX_STORAGE_ACTION_ITEMS = 50
const MAX_STORAGE_ACTION_DIAGNOSTICS = 8
const MAX_STORAGE_ACTION_TEXT_LENGTH = 512

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const normalizeTimestamp = (value: unknown, fallbackMessage: string): string => {
  if (typeof value !== 'string') throw new Error(fallbackMessage)
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) throw new Error(fallbackMessage)
  return timestamp.toISOString()
}

const normalizeStorageActionItem = (value: unknown, fallbackMessage: string): StorageActionItem => {
  if (!isRecord(value)) throw new Error(fallbackMessage)
  const { diagnostics, format, kind, message, outcome, path } = value
  if (
    !STORAGE_ACTION_ITEM_KINDS.includes(kind as StorageActionItem['kind']) ||
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > MAX_STORAGE_ACTION_TEXT_LENGTH ||
    !STORAGE_ACTION_ITEM_OUTCOMES.includes(outcome as StorageActionItem['outcome']) ||
    !(format === null || STORAGE_ACTION_FORMATS.includes(format as StorageActionFormat)) ||
    !(message === null || (typeof message === 'string' && message.length <= MAX_STORAGE_ACTION_TEXT_LENGTH)) ||
    !Array.isArray(diagnostics) ||
    diagnostics.length > MAX_STORAGE_ACTION_DIAGNOSTICS ||
    !diagnostics.every(entry => typeof entry === 'string' && entry.length <= MAX_STORAGE_ACTION_TEXT_LENGTH)
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    kind: kind as StorageActionItem['kind'],
    path,
    outcome: outcome as StorageActionItem['outcome'],
    format: format as StorageActionFormat | null,
    message,
    diagnostics: [...diagnostics]
  }
}

export const normalizeStorageActionSummary = (value: unknown, fallbackMessage = 'Storage action failed'): StorageActionSummary => {
  if (!isRecord(value) || !isRecord(value.formats) || !Array.isArray(value.items)) {
    throw new Error(fallbackMessage)
  }
  const { completedAt, failed, formats, handler, items, message, outcome, startedAt, succeeded, targetKey, total } = value
  if (
    typeof targetKey !== 'string' ||
    targetKey.length < 1 ||
    typeof handler !== 'string' ||
    handler.length < 1 ||
    !STORAGE_ACTION_OUTCOMES.includes(outcome as StorageActionOutcome) ||
    !isNonNegativeInteger(total) ||
    !isNonNegativeInteger(succeeded) ||
    !isNonNegativeInteger(failed) ||
    total !== succeeded + failed ||
    typeof message !== 'string' ||
    message.length < 1 ||
    message.length > MAX_STORAGE_ACTION_TEXT_LENGTH ||
    items.length > MAX_STORAGE_ACTION_ITEMS
  ) {
    throw new Error(fallbackMessage)
  }
  const isZeroItemActionFailure = outcome === 'failed' && total === 0 && succeeded === 0 && failed === 0
  if (
    (outcome === 'succeeded' && failed !== 0) ||
    (outcome === 'partial' && (succeeded === 0 || failed === 0)) ||
    (outcome === 'failed' && !isZeroItemActionFailure && (succeeded !== 0 || failed === 0))
  ) {
    throw new Error(fallbackMessage)
  }
  const normalizedFormats = Object.fromEntries(STORAGE_ACTION_FORMATS.map(format => {
    const count = formats[format]
    if (!isNonNegativeInteger(count)) throw new Error(fallbackMessage)
    return [format, count]
  })) as StorageActionFormatCounts
  const normalizedStartedAt = normalizeTimestamp(startedAt, fallbackMessage)
  const normalizedCompletedAt = normalizeTimestamp(completedAt, fallbackMessage)
  if (normalizedCompletedAt < normalizedStartedAt) throw new Error(fallbackMessage)

  return {
    targetKey,
    handler,
    outcome: outcome as StorageActionOutcome,
    total,
    succeeded,
    failed,
    formats: normalizedFormats,
    items: items.map(item => normalizeStorageActionItem(item, fallbackMessage)),
    startedAt: normalizedStartedAt,
    completedAt: normalizedCompletedAt,
    message
  }
}

function normalizeStorageStatus(value: unknown, fallbackMessage: string): StorageStatus {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    (typeof value.lastAttempt !== 'string' && value.lastAttempt !== null) ||
    !(isRecord(value.lastOperation) || value.lastOperation === null) ||
    typeof value.message !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.title !== 'string'
  ) {
    throw new Error(fallbackMessage)
  }
  return {
    key: value.key,
    lastAttempt: value.lastAttempt,
    lastOperation: value.lastOperation === null ? null : normalizeStorageActionSummary(value.lastOperation, fallbackMessage),
    message: value.message,
    status: value.status,
    title: value.title
  }
}

async function parseJsonResponse(response: JsonResponse, fallbackMessage: string): Promise<unknown> {
  const hasHeaderReader = response && response.headers && typeof response.headers.get === 'function'
  const contentType = hasHeaderReader ? response.headers!.get('content-type') || '' : ''
  let payload: unknown = null

  if (contentType.includes('application/json') && typeof response.json === 'function') {
    payload = await response.json()
  }

  if (!response || !response.ok) {
    const errorValue = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { error?: unknown }).error : null
    throw new Error(errorValue ? String(errorValue) : fallbackMessage)
  }

  return payload
}

export async function fetchStorageTargets(fetchImpl: FetchImpl, fallbackMessage = 'Storage targets failed'): Promise<StorageTarget[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/storage/targets', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!Array.isArray(payload) || !payload.every(isStorageTargetPayload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(target => ({
    ...target,
    supportedModes: target.supportedModes ?? [],
    syncIntervalDefault: target.syncIntervalDefault ?? null
  }))
}
export async function fetchStorageStatus(fetchImpl: FetchImpl, fallbackMessage = 'Storage status failed'): Promise<StorageStatus[]> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/storage/status', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!Array.isArray(payload)) {
    throw new Error(fallbackMessage)
  }

  return payload.map(value => normalizeStorageStatus(value, fallbackMessage))
}

export async function saveStorageTargets(
  fetchImpl: FetchImpl,
  targets: StorageTargetUpdate[],
  fallbackMessage = 'Storage targets update failed'
): Promise<MessageResponse> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/storage/targets', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ targets })
  })
  const payload = await parseJsonResponse(response, fallbackMessage)

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { message?: unknown }).message !== 'string') {
    throw new Error(fallbackMessage)
  }

  return payload as MessageResponse
}

export async function executeStorageAction(
  fetchImpl: FetchImpl,
  targetKey: string,
  handler: string,
  fallbackMessage = 'Storage action failed'
): Promise<StorageActionSummary> {
  const response = await sameOriginJsonFetch(fetchImpl, '/_api/storage/actions/execute', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ targetKey, handler })
  })
  const payload = await parseJsonResponse(response, fallbackMessage)
  return normalizeStorageActionSummary(payload, fallbackMessage)
}
