import type { StorageOperationResult } from '../../shared/storage-workspace.ts'

type StorageReceiptItem = StorageOperationResult['items'][number]

const ITEM_OUTCOME_KEYS = {
  succeeded: 'admin:storageOperationReceipt.succeeded',
  failed: 'admin:storageOperationReceipt.failed',
  conflict: 'admin:storageOperationReceipt.conflict'
} as const

const ITEM_KIND_KEYS = {
  page: 'admin:storageOperationReceipt.page',
  asset: 'admin:storageOperationReceipt.asset'
} as const

/** Locale keys for the sanctioned receipt item values; translate at the render boundary. */
export function itemOutcomeLabel(value: StorageReceiptItem['outcome']) {
  return ITEM_OUTCOME_KEYS[value]
}

export function itemKindLabel(value: StorageReceiptItem['kind']) {
  return ITEM_KIND_KEYS[value]
}

export function dateTime(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not recorded'
}

export function actor(id: number | null) {
  return id === null ? 'API principal' : `Account ${id}`
}

export function operationLabel(value: string) {
  return (
    (
      {
        queued: 'Queued',
        running: 'Running',
        succeeded: 'Completed',
        partial: 'Completed with issues',
        failed: 'Failed',
        interrupted: 'Needs recovery review',
        cancelled: 'Cancelled',
        resolved: 'Recovery acknowledged'
      } as Record<string, string>
    )[value] || value
  )
}

export function formatLabel(key: string) {
  return (
    ({ okf: 'OKF', legacyV1: 'Legacy v1', legacyWiki: 'Legacy Wiki', plain: 'Plain Markdown', invalid: 'Invalid documents' } as Record<string, string>)[key] ||
    key
  )
}
