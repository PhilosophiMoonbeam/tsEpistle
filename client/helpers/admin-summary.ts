import type { InjectionKey, Ref } from 'vue'

export interface ProtectedAdminSummaryMetrics {
  assetsTotal: number | null
  assetsBytes: number | null
  commentsTotal: number | null
}

export const adminSummaryKey: InjectionKey<{
  loading: Ref<boolean>
  error: Ref<string>
  refresh: () => Promise<void>
}> = Symbol('admin-summary')
