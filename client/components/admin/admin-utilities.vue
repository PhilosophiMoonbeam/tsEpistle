<template lang="pug">
v-container.admin-utilities(fluid)
  AdminHero(
    title='Utilities'
    description='Reviewed maintenance work with durable receipts. A receipt records the request before any service or data effect begins.'
    icon='mdi-toolbox-outline'
    heading-id='admin-utilities-heading'
  )
  async-state.mt-6(
    v-if='loading && !workspace'
    state='loading'
    title='Loading utilities'
    message='Collecting current authority, available import targets, current locales, telemetry settings and recent operation receipts.'
  )
  async-state.mt-6(
    v-else-if='error && !workspace'
    state='error'
    title='Utilities could not be loaded'
    :message='error'
    retry-label='Try again'
    @retry='reload'
  )
  template(v-else-if='workspace')
    v-alert.mb-4(v-if='recoveryStorageUnavailable' color='error' variant='tonal' icon='mdi-lock-alert-outline')
      .text-body-medium This browser cannot read or write the protected Utilities recovery record.
      .text-body-small.mt-1 New Utilities actions are locked because an interrupted request cannot be safely ruled out. Restore browser storage access, reload Utilities, and inspect any existing receipt before continuing.
    v-alert.mb-4(v-else-if='pendingRequest' color='warning' variant='tonal' icon='mdi-alert-outline')
      .text-body-medium The outcome of a reviewed request has not been confirmed.
      .text-body-small.mt-1 New Utilities actions remain locked while this exact receipt is checked. The request will not be sent again automatically.
      v-btn.mt-3(size='small' variant='outlined' :loading='pendingLookupLoading' @click='recoverPending') Check this receipt again
    v-alert.mb-4(v-else-if='runningOperation' color='info' variant='tonal' icon='mdi-progress-clock')
      .text-body-medium {{ operationTitle(runningOperation.kind) }} is still running.
      .text-body-small.mt-1 Open its receipt to follow persisted progress. Starting another Utilities action is disabled until it settles.
      v-btn.mt-3(size='small' variant='outlined' @click='selectReceipt(runningOperation.id)') Open running receipt
    v-row.mt-2
      v-col(cols='12' lg='3')
        v-card.admin-utilities-nav
          v-card-text.pa-2
            v-select.d-lg-none(
              v-model='section'
              :items='tools'
              item-title='title'
              item-value='key'
              label='Utility'
              variant='outlined'
              hide-details
              :disabled='busy || Boolean(pendingRequest)'
              @update:model-value='selectSection'
            )
            v-list.d-none.d-lg-block(nav density='compact' aria-label='Utility workflows')
              v-list-item(
                v-for='tool in tools'
                :key='tool.key'
                :active='section === tool.key'
                :prepend-icon='tool.icon'
                :title='tool.title'
                :subtitle='tool.subtitle'
                :disabled='busy || Boolean(pendingRequest)'
                @click='selectSection(tool.key)'
              )
      v-col(cols='12' lg='9')
        v-alert.mb-4(v-if='error' color='error' variant='tonal' closable @click:close='error = ``')
          | {{ error }}
        transition(name='admin-router' mode='out-in')
          component(
            :is='selectedComponent'
            :workspace='workspace'
            :busy='mutationLocked'
            :uncertain-receipt='latestUnacknowledgedUncertainty'
            @notice='showNotice'
            @request='requestOperation'
            @draft-state='setDraftState'
          )
        v-card.mt-5(variant='outlined')
          v-card-title.d-flex.flex-wrap.align-center.ga-2
            span Operation receipts
            v-spacer
            v-btn(size='small' variant='text' :loading='loading' :disabled='busy' @click='reload') Refresh
          v-card-text
            .text-body-small.text-medium-emphasis.mb-3 Receipts are recovery records. Refreshing never restarts an action. An interrupted outcome must be inspected and explicitly acknowledged before another request.
            v-alert(v-if='workspace.operations.length === 0' variant='tonal' color='info') No reviewed Utilities actions have been recorded yet.
            v-list.admin-utilities-receipts(v-else lines='two' density='comfortable' aria-label='Recent Utilities operation receipts')
              v-list-item(v-for='operation in workspace.operations' :key='operation.id' :active='receiptId === operation.id' :aria-current='receiptId === operation.id ? `true` : undefined' @click='selectReceipt(operation.id)')
                template(#prepend)
                  v-icon(:color='receiptColor(operation.state)') {{ receiptIcon(operation.state) }}
                v-list-item-title {{ operationTitle(operation.kind) }}
                v-list-item-subtitle {{ operation.summary }}
                template(#append)
                  .text-caption.text-medium-emphasis {{ operation.state }}
            v-card.mt-3(v-if='receiptId' variant='tonal')
              v-card-text
                async-state(v-if='receiptLoading' state='loading' title='Loading operation receipt')
                async-state(v-else-if='receiptError' state='error' title='Receipt unavailable' :message='receiptError' retry-label='Try again' @retry='loadReceiptDetail(receiptId)')
                template(v-else-if='selectedReceipt')
                  .text-body-medium {{ operationTitle(selectedReceipt.kind) }} · {{ selectedReceipt.state }}
                  .text-body-small.mt-1 {{ selectedReceipt.summary }}
                  .text-body-small.mt-2(v-if='selectedReceipt.progress !== null') Progress: {{ selectedReceipt.progress }}%
                  dl.admin-utilities-result.mt-3(v-if='receiptResultLines(selectedReceipt).length')
                    template(v-for='line in receiptResultLines(selectedReceipt)' :key='line.label')
                      dt {{ line.label }}
                      dd {{ line.value }}
                  v-alert.mt-3(v-if='hasPartialResult(selectedReceipt)' color='warning' variant='tonal' density='compact') This receipt records aggregate counts only. It does not identify individual imported or skipped items; inspect the affected source and application logs before deciding whether to start a new import.
                  .text-body-small.mt-3 Receipt ID: #[code {{ selectedReceipt.id }}]
                  .text-body-small.mt-1 Reason: {{ selectedReceipt.reason }}
                  .text-body-small.mt-1(v-if='selectedReceipt.acknowledgedAt') Uncertainty acknowledged by a later recorded request.
                v-btn.mt-3(size='small' variant='text' :disabled='receiptLoading' @click='clearReceipt') Clear receipt selection
  v-snackbar(v-model='notice.open' :color='notice.color' timeout='5000' role='status') {{ notice.message }}
</template>

<script lang="ts">
import Cookies from 'js-cookie'
import { defineAsyncComponent, defineComponent, markRaw, toRaw } from 'vue'
import type { LocationQueryRaw } from 'vue-router'
import {
  utilityOperationConfirmation,
  utilityOperationTitle,
  type UtilityOperation,
  type UtilityOperationKind,
  type UtilitiesWorkspace
} from '../../../shared/utilities-workspace.ts'
import {
  fetchUtilitiesReceipt,
  fetchUtilitiesWorkspace,
  startUtilitiesOperation,
  type UtilitiesOperationRequest
} from '../../helpers/utilities-workspace-api.ts'

const tools = markRaw([
  { key: 'auth', title: 'Authentication cleanup', subtitle: 'Session and guest recovery', icon: 'mdi-shield-key-outline', component: 'UtilityAuth' },
  {
    key: 'content',
    title: 'Content maintenance',
    subtitle: 'Tree, render, locale and history',
    icon: 'mdi-file-cog-outline',
    component: 'UtilityContent'
  },
  { key: 'export', title: 'Export', subtitle: 'Create a guarded local archive', icon: 'mdi-database-export-outline', component: 'UtilityExport' },
  { key: 'cache', title: 'Cache', subtitle: 'Clear server or browser caches', icon: 'mdi-cached', component: 'UtilityCache' },
  {
    key: 'import',
    title: 'Wiki.js 1.x import',
    subtitle: 'Bring in users or content',
    icon: 'mdi-database-import-outline',
    component: 'UtilityImportv1'
  },
  { key: 'telemetry', title: 'Telemetry', subtitle: 'Privacy preference and client identity', icon: 'mdi-radar', component: 'UtilityTelemetry' }
] as const)

const pendingStorageKey = 'utilities.pending-operation.v1'
type ToolKey = (typeof tools)[number]['key']
type Notice = { message: string; color?: 'success' | 'warning' | 'error' | 'info' }
type RequestedOperation = Omit<UtilitiesOperationRequest, 'id' | 'fingerprint' | 'confirmation'> & {
  confirmation?: string
  onRecorded?: (receipt: UtilityOperation) => void
  onRejected?: (message: string) => void
}
type PendingRequest = { id: string; kind: UtilityOperationKind; createdAt: string }

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'Utilities administration is unavailable.')
const errorStatus = (error: unknown): number | null => {
  const value = record(error)
  return typeof value?.status === 'number' && Number.isInteger(value.status) ? value.status : null
}
const deepCopy = <Value,>(value: Value): Value => structuredClone(toRaw(value))
const deepFreeze = <Value,>(value: Value): Value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
const persistedRequest = (value: unknown): PendingRequest | null => {
  const parsed = record(value)
  if (
    !parsed ||
    Object.keys(parsed).length !== 3 ||
    !['id', 'kind', 'createdAt'].every((key) => Object.prototype.hasOwnProperty.call(parsed, key)) ||
    typeof parsed.id !== 'string' ||
    typeof parsed.kind !== 'string' ||
    typeof parsed.createdAt !== 'string'
  )
    return null
  return { id: parsed.id, kind: parsed.kind as UtilityOperationKind, createdAt: parsed.createdAt }
}

export default defineComponent({
  components: {
    UtilityAuth: defineAsyncComponent(() => import('./admin-utilities-auth.vue')),
    UtilityContent: defineAsyncComponent(() => import('./admin-utilities-content.vue')),
    UtilityExport: defineAsyncComponent(() => import('./admin-utilities-export.vue')),
    UtilityCache: defineAsyncComponent(() => import('./admin-utilities-cache.vue')),
    UtilityImportv1: defineAsyncComponent(() => import('./admin-utilities-importv1.vue')),
    UtilityTelemetry: defineAsyncComponent(() => import('./admin-utilities-telemetry.vue'))
  },
  data: () => ({
    tools,
    section: 'auth' as ToolKey,
    workspace: null as UtilitiesWorkspace | null,
    loading: false,
    busy: false,
    error: '',
    recoveryStorageUnavailable: false,
    receiptId: '',
    receiptDetail: null as UtilityOperation | null,
    receiptLoading: false,
    receiptError: '',
    receiptSequence: 0,
    pendingRequest: null as PendingRequest | null,
    pendingCallbacks: null as Pick<RequestedOperation, 'onRecorded' | 'onRejected'> | null,
    pendingLookupLoading: false,
    draftDirty: false,
    poll: null as number | null,
    disposed: false,
    notice: { open: false, message: '', color: 'success' as NonNullable<Notice['color']> }
  }),
  computed: {
    selectedComponent() {
      return tools.find((tool) => tool.key === this.section)?.component ?? 'UtilityAuth'
    },
    selectedReceipt(): UtilityOperation | null {
      return this.receiptDetail?.id === this.receiptId ? this.receiptDetail : null
    },
    runningOperation(): UtilityOperation | null {
      return this.workspace?.operations.find((operation) => operation.state === 'running') ?? null
    },
    latestUnacknowledgedUncertainty(): UtilityOperation | null {
      return (
        [...(this.workspace?.operations ?? [])]
          .filter((operation) => operation.state === 'uncertain' && operation.acknowledgedAt === null)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0] ?? null
      )
    },
    mutationLocked(): boolean {
      return this.busy || this.recoveryStorageUnavailable || Boolean(this.pendingRequest) || Boolean(this.runningOperation)
    }
  },
  watch: {
    '$route.query.section': {
      immediate: true,
      handler(value: unknown) {
        this.section = typeof value === 'string' && tools.some((tool) => tool.key === value) ? (value as ToolKey) : 'auth'
      }
    },
    '$route.query.receipt': {
      immediate: true,
      handler(value: unknown) {
        const id = typeof value === 'string' ? value : ''
        this.receiptId = id
        this.receiptDetail = null
        this.receiptError = ''
        if (id) void this.loadReceiptDetail(id)
      }
    }
  },
  created() {
    this.restorePending()
    void this.reload()
  },
  mounted() {
    window.addEventListener('beforeunload', this.beforeUnload)
  },
  beforeUnmount() {
    this.disposed = true
    this.receiptSequence += 1
    if (this.poll !== null) window.clearTimeout(this.poll)
    window.removeEventListener('beforeunload', this.beforeUnload)
  },
  beforeRouteLeave(): boolean {
    return this.canLeave()
  },
  beforeRouteUpdate(to: { path: string; query: Record<string, unknown> }, from: { path: string; query: Record<string, unknown> }): boolean {
    if (to.path === from.path && to.query.section === from.query.section) return true
    return this.canLeave()
  },
  methods: {
    beforeUnload(event: BeforeUnloadEvent) {
      if (this.busy || this.pendingRequest || this.recoveryStorageUnavailable || this.draftDirty) {
        event.preventDefault()
        event.returnValue = ''
      }
    },
    canLeave(): boolean {
      if (this.busy || this.pendingRequest) return false
      if (!this.draftDirty) return true
      if (!window.confirm('Discard the unsaved Utilities draft?')) return false
      this.draftDirty = false
      return true
    },
    restorePending() {
      this.recoveryStorageUnavailable = false
      try {
        const saved = window.sessionStorage.getItem(pendingStorageKey)
        this.pendingRequest = saved ? persistedRequest(JSON.parse(saved)) : null
        if (saved && !this.pendingRequest) {
          this.recoveryStorageUnavailable = true
          this.error =
            'The protected Utilities recovery record is incomplete. New Utilities actions remain locked because an unconfirmed request cannot be safely inspected.'
        }
      } catch {
        this.recoveryStorageUnavailable = true
        this.error =
          'This browser could not read the protected Utilities recovery record. Do not repeat an unconfirmed Utilities action until its receipt is inspected.'
      }
    },
    persistPending(pending: PendingRequest): boolean {
      try {
        window.sessionStorage.setItem(pendingStorageKey, JSON.stringify(pending))
        this.pendingRequest = pending
        return true
      } catch {
        this.recoveryStorageUnavailable = true
        this.error = 'This browser cannot securely store a Utilities recovery record. The reviewed action was not sent.'
        return false
      }
    },
    clearPending(): boolean {
      try {
        window.sessionStorage.removeItem(pendingStorageKey)
        this.pendingRequest = null
        this.pendingCallbacks = null
        return true
      } catch {
        this.error = 'This browser could not clear the Utilities recovery record. New Utilities actions remain locked to prevent a duplicate request.'
        return false
      }
    },
    async reload() {
      if (this.recoveryStorageUnavailable) this.restorePending()
      if (this.loading) return
      this.loading = true
      this.error = ''
      try {
        const workspace = await fetchUtilitiesWorkspace()
        if (this.disposed) return
        this.workspace = workspace
        if (this.pendingRequest) await this.recoverPending()
        else if (this.receiptId) void this.loadReceiptDetail(this.receiptId)
        this.scheduleRefresh()
      } catch (error) {
        if (!this.disposed) this.error = errorMessage(error)
      } finally {
        if (!this.disposed) this.loading = false
      }
    },
    scheduleRefresh() {
      if (this.poll !== null) window.clearTimeout(this.poll)
      if (!this.runningOperation || this.pendingRequest) return
      this.poll = window.setTimeout(() => {
        this.poll = null
        void this.reload()
      }, 2_000)
    },
    async recoverPending() {
      const pending = this.pendingRequest
      if (!pending || this.pendingLookupLoading) return
      this.pendingLookupLoading = true
      this.error = ''
      try {
        const receipt = await fetchUtilitiesReceipt(pending.id)
        if (this.disposed || this.pendingRequest?.id !== pending.id) return
        this.receiptId = receipt.id
        this.receiptDetail = receipt
        this.receiptError = ''
        const callbacks = this.pendingCallbacks
        if (!this.clearPending()) return
        callbacks?.onRecorded?.(receipt)
        if (receipt.kind === 'auth-certificates') this.redirectAfterCertificateReceipt(receipt.id)
        else {
          this.replaceReceiptQuery(receipt.id)
          void this.reload()
        }
      } catch (error) {
        if (!this.disposed)
          this.error = `The exact pending receipt could not be read: ${errorMessage(error)} New Utilities actions remain locked; retry this receipt lookup instead of repeating the request.`
      } finally {
        if (!this.disposed) this.pendingLookupLoading = false
      }
    },
    async loadReceiptDetail(id: string) {
      if (!id) return
      const sequence = ++this.receiptSequence
      this.receiptLoading = true
      this.receiptError = ''
      this.receiptDetail = null
      try {
        const receipt = await fetchUtilitiesReceipt(id)
        if (this.disposed || sequence !== this.receiptSequence || this.receiptId !== id) return
        this.receiptDetail = receipt
      } catch (error) {
        if (!this.disposed && sequence === this.receiptSequence && this.receiptId === id) this.receiptError = errorMessage(error)
      } finally {
        if (!this.disposed && sequence === this.receiptSequence) this.receiptLoading = false
      }
    },
    selectSection(section: ToolKey) {
      if (this.busy || this.pendingRequest || section === this.section) return
      if (!this.canLeave()) {
        const value = this.$route.query.section
        this.section = typeof value === 'string' && tools.some((tool) => tool.key === value) ? (value as ToolKey) : 'auth'
        return
      }
      this.$router.replace({ query: { ...this.$route.query, section } })
    },
    selectReceipt(receipt: string) {
      this.receiptId = receipt
      this.receiptDetail = null
      this.receiptError = ''
      void this.loadReceiptDetail(receipt)
      this.replaceReceiptQuery(receipt)
    },
    replaceReceiptQuery(receipt: string) {
      const query = { ...this.$route.query } as LocationQueryRaw
      if (receipt) query.receipt = receipt
      else delete query.receipt
      this.$router.replace({ query })
    },
    clearReceipt() {
      this.receiptSequence += 1
      this.receiptId = ''
      this.receiptDetail = null
      this.receiptError = ''
      this.receiptLoading = false
      this.replaceReceiptQuery('')
    },
    receiptColor(state: UtilityOperation['state']) {
      return state === 'succeeded' ? 'success' : state === 'running' ? 'primary' : state === 'uncertain' ? 'warning' : 'error'
    },
    receiptIcon(state: UtilityOperation['state']) {
      return state === 'succeeded'
        ? 'mdi-check-circle-outline'
        : state === 'running'
          ? 'mdi-progress-clock'
          : state === 'uncertain'
            ? 'mdi-alert-outline'
            : 'mdi-close-circle-outline'
    },
    operationTitle(kind: UtilityOperationKind) {
      return utilityOperationTitle(kind)
    },
    receiptResultLines(receipt: UtilityOperation): Array<{ label: string; value: number }> {
      if (!receipt.result) return []
      const lines: Array<[string, number | undefined]> = [
        ['Processed', receipt.result.processed],
        ['Succeeded', receipt.result.succeeded],
        ['Failed', receipt.result.failed],
        ['Skipped', receipt.result.skipped]
      ]
      return lines.flatMap(([label, value]) => (typeof value === 'number' ? [{ label, value }] : []))
    },
    hasPartialResult(receipt: UtilityOperation): boolean {
      return Boolean(receipt.result && ((receipt.result.failed ?? 0) > 0 || (receipt.result.skipped ?? 0) > 0))
    },
    showNotice(notice: string | Notice) {
      const value = typeof notice === 'string' ? { message: notice, color: 'success' as const } : notice
      this.notice = { open: true, color: value.color ?? 'success', message: value.message }
    },
    setDraftState(dirty: boolean) {
      this.draftDirty = dirty
    },
    redirectAfterCertificateReceipt(receiptId: string) {
      const query = new URLSearchParams({ section: 'auth', receipt: receiptId })
      try {
        Cookies.set('loginRedirect', `${window.location.pathname}?${query.toString()}`, {
          expires: 1,
          path: '/',
          secure: window.location.protocol === 'https:'
        })
        window.location.assign('/login')
      } catch {
        this.error =
          'Authentication certificates were recorded, but this browser could not preserve the receipt return path. Sign in again, then open Utilities and inspect the receipt identifier.'
      }
    },
    async requestOperation(request: RequestedOperation) {
      if (this.mutationLocked || !this.workspace) return
      const kind = request.kind,
        reason = request.reason.trim()
      if (reason.length < 3 || reason.length > 1000) {
        const message = 'Enter an administrative reason of 3 to 1000 characters.'
        this.error = message
        request.onRejected?.(message)
        return
      }
      const operation: UtilitiesOperationRequest = deepFreeze(
        deepCopy({
          id: crypto.randomUUID(),
          kind,
          fingerprint: this.workspace.fingerprint,
          confirmation: request.confirmation ?? utilityOperationConfirmation(kind),
          reason,
          ...(request.acknowledgedUncertainId ? { acknowledgedUncertainId: request.acknowledgedUncertainId } : {}),
          payload: deepCopy(request.payload ?? {})
        })
      )
      const pending: PendingRequest = { id: operation.id, kind: operation.kind, createdAt: new Date().toISOString() }
      if (!this.persistPending(pending)) {
        request.onRejected?.(this.error || 'This browser cannot store the Utilities recovery record.')
        return
      }
      this.pendingCallbacks = { onRecorded: request.onRecorded, onRejected: request.onRejected }
      this.busy = true
      this.error = ''
      try {
        const response = await startUtilitiesOperation(operation)
        if (this.disposed) return
        if (!this.clearPending()) return
        this.receiptId = response.id
        this.receiptDetail = response
        this.receiptError = ''
        request.onRecorded?.(response)
        if (kind === 'auth-certificates') {
          this.redirectAfterCertificateReceipt(response.id)
          return
        }
        this.notice = { open: true, color: 'success', message: `${utilityOperationTitle(kind)} was recorded. Follow its receipt for the outcome.` }
        this.replaceReceiptQuery(response.id)
        await this.reload()
      } catch (error) {
        if (this.disposed) return
        const message = errorMessage(error),
          status = errorStatus(error)
        if (status !== null && status >= 400 && status < 500) {
          if (this.clearPending()) request.onRejected?.(message)
          this.error = message
          return
        }
        const recoveryMessage = `The Utilities response did not confirm this request. Its exact receipt is being checked; the request will not be repeated automatically. ${message}`
        this.error = recoveryMessage
        request.onRejected?.(recoveryMessage)
        await this.recoverPending()
      } finally {
        if (!this.disposed) this.busy = false
      }
    }
  }
})
</script>

<style lang="scss">
.admin-utilities-nav {
  position: sticky;
  top: 1rem;
}

.admin-utilities-result {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.35rem 1rem;
  margin-bottom: 0;

  dt {
    color: rgb(var(--v-theme-on-surface-variant));
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
}

.admin-utilities-receipts .v-list-item-subtitle {
  opacity: 1;
  color: var(--admin-muted);
}

@media (max-width: 1279.98px) {
  .admin-utilities-nav {
    position: static;
  }
}
</style>
