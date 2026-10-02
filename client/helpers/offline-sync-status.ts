import type { OfflineSyncDiagnostics } from '../../shared/offline.ts'
import type { OfflineTranslate } from './offline-page-status.ts'
import type { PwaConnectionPresentation } from './pwa.ts'

export type { OfflineTranslate }
export type OfflineStatusTone = 'success' | 'warning' | 'error' | 'muted'

export interface OfflineSyncPresentation {
  readonly tone: OfflineStatusTone
  readonly icon: string
  readonly label: (t: OfflineTranslate) => string
}

const sync = (t: OfflineTranslate, key: string, defaultValue: string, params: Record<string, unknown> = {}): string =>
  t(`common:offline.sync.${key}`, { defaultValue, ...params })

/** Short sync status for the account menu. Connection state is shown separately. */
export const offlineSyncPresentation = (diagnostics: OfflineSyncDiagnostics | null, running = false): OfflineSyncPresentation => {
  const d = diagnostics
  if (running || d?.status === 'running') return { tone: 'success', icon: 'mdi-cloud-sync-outline', label: t => sync(t, 'running', 'Syncing…') }
  if (!d) return { tone: 'muted', icon: 'mdi-progress-clock', label: t => sync(t, 'never', 'Not synced yet') }
  const pending = d.pendingCount
  if (d.status === 'complete' && pending === 0) return { tone: 'success', icon: 'mdi-check-circle-outline', label: t => sync(t, 'current', 'Up to date') }
  if (d.status === 'complete')
    return {
      tone: 'warning',
      icon: 'mdi-progress-clock',
      label: t => (pending === 1 ? sync(t, 'pendingOne', '1 page waiting to sync') : sync(t, 'pendingOther', '{{count}} pages waiting to sync', { count: pending }))
    }
  if (d.status === 'partial')
    return {
      tone: 'warning',
      icon: 'mdi-alert-outline',
      label: t => sync(t, 'partial', 'Last sync incomplete · {{count}} waiting', { count: pending })
    }
  if (d.status === 'offline') return { tone: 'warning', icon: 'mdi-cloud-off-outline', label: t => sync(t, 'offline', 'Waiting for a connection') }
  if (d.status === 'error') return { tone: 'error', icon: 'mdi-alert-circle-outline', label: t => sync(t, 'error', 'Sync failed · will retry') }
  return { tone: 'muted', icon: 'mdi-help-circle-outline', label: t => sync(t, 'never', 'Not synced yet') }
}

/** Localized connection label; the English presentation label is the fallback. */
export const translateConnection = (presentation: PwaConnectionPresentation, t: OfflineTranslate): string =>
  t(`common:offline.connection.${presentation.key}`, { defaultValue: presentation.label })
