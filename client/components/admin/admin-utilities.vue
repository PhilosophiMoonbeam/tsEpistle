<template lang="pug">
v-container.admin-utilities(fluid)
  AdminHero(
    :title='$t(`admin:utilities.title`)'
    :description='$t(`admin:utilities.maintainContentMoveData`)'
    icon='mdi-toolbox-outline'
    heading-id='admin-utilities-heading'
  )
  async-state.mt-6(
    v-if='loading && !workspace'
    state='loading'
    :title='$t(`admin:utilities.loadingUtilities`)'
    :message='$t(`admin:utilities.collectingCurrentAuthorityAvailable`)'
  )
  async-state.mt-6(
    v-else-if='error && !workspace'
    state='error'
    :title='$t(`admin:utilities.utilitiesCouldNotLoaded`)'
    :message='error'
    :retry-label='$t(`admin:utilities.tryAgain`)'
    @retry='reload'
  )
  template(v-else-if='workspace')
    v-alert.mb-4(v-if='recoveryStorageUnavailable' color='error' variant='tonal' icon='mdi-lock-alert-outline')
      .text-body-medium {{ $t(`admin:utilities.browserCannotReadWrite`) }}
      .text-body-small.mt-1 {{ $t(`admin:utilities.newUtilitiesActionsLocked`) }}
    v-alert.mb-4(v-else-if='pendingRequest' color='warning' variant='tonal' icon='mdi-alert-outline')
      .text-body-medium {{ $t(`admin:utilities.outcomeReviewedRequestHas`) }}
      .text-body-small.mt-1 {{ $t(`admin:utilities.newUtilitiesActionsRemain`) }}
      v-btn.mt-3(size='small' variant='outlined' :loading='pendingLookupLoading' @click='recoverPending') {{ $t(`admin:utilities.checkReceiptAgain`) }}
    v-alert.mb-4(v-else-if='runningOperation' color='info' variant='tonal' icon='mdi-progress-clock')
      .text-body-medium {{ $t(`admin:utilities.stillRunning`, { kind: operationTitle(runningOperation.kind), interpolation: { escapeValue: false } }) }}
      .text-body-small.mt-1 {{ $t(`admin:utilities.openReceiptFollowPersisted`) }}
      v-btn.mt-3(size='small' variant='outlined' @click='selectReceipt(runningOperation.id)') {{ $t(`admin:utilities.openRunningReceipt`) }}
    v-row.mt-2
      v-col(cols='12' lg='3')
        v-card.admin-utilities-nav
          v-card-text.pa-2
            v-select.d-lg-none(
              :model-value='section'
              :items='tools'
              :item-title='(tool: { title: string }) => $t(tool.title)'
              item-value='key'
              :label='$t(`admin:utilities.utility`)'
              variant='outlined'
              hide-details
              :disabled='busy || Boolean(pendingRequest)'
              @update:model-value='selectSection'
            )
            v-list.d-none.d-lg-block(nav density='compact' :aria-label='$t(`admin:utilities.utilityWorkflows`)')
              v-list-item(
                v-for='tool in tools'
                :key='tool.key'
                :active='section === tool.key'
                :prepend-icon='tool.icon'
                :title='$t(tool.title)'
                :subtitle='$t(tool.subtitle)'
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
            span {{ $t(`admin:utilities.operationReceipts`) }}
            v-spacer
            v-btn(size='small' variant='text' :loading='loading' :disabled='busy' @click='reload') {{ $t(`common:actions.refresh`) }}
          v-card-text
            .text-body-small.text-medium-emphasis.mb-3 {{ $t(`admin:utilities.receiptsRecoveryRecordsRefreshing`) }}
            v-alert(v-if='workspace.operations.length === 0' variant='tonal' color='info') {{ $t(`admin:utilities.noReviewedUtilitiesActions`) }}
            v-list.admin-utilities-receipts(v-else lines='two' density='comfortable' :aria-label='$t(`admin:utilities.recentUtilitiesOperationReceipts`)')
              v-list-item(v-for='operation in workspace.operations' :key='operation.id' :active='receiptId === operation.id' :aria-current='receiptId === operation.id ? `true` : undefined' @click='selectReceipt(operation.id)')
                template(#prepend)
                  v-icon(:color='receiptColor(operation.state)') {{ receiptIcon(operation.state) }}
                v-list-item-title {{ operationTitle(operation.kind) }}
                v-list-item-subtitle {{ operation.summary }}
                template(#append)
                  .text-body-small.text-medium-emphasis {{ operation.state }}
            v-card.mt-3(v-if='receiptId' variant='tonal')
              v-card-text
                async-state(v-if='receiptLoading' state='loading' :title='$t(`admin:utilities.loadingOperationReceipt`)')
                async-state(v-else-if='receiptError' state='error' :title='$t(`admin:utilities.receiptUnavailable`)' :message='receiptError' :retry-label='$t(`admin:utilities.tryAgain`)' @retry='loadReceiptDetail(receiptId)')
                template(v-else-if='selectedReceipt')
                  .text-body-medium {{ operationTitle(selectedReceipt.kind) }} · {{ selectedReceipt.state }}
                  .text-body-small.mt-1 {{ selectedReceipt.summary }}
                  .text-body-small.mt-2(v-if='selectedReceipt.progress !== null') {{ $t(`admin:utilities.progress`, { progress: selectedReceipt.progress, interpolation: { escapeValue: false } }) }}
                  dl.admin-utilities-result.mt-3(v-if='receiptResultLines(selectedReceipt).length')
                    template(v-for='line in receiptResultLines(selectedReceipt)' :key='line.label')
                      dt {{ line.label }}
                      dd {{ line.value }}
                  v-alert.mt-3(v-if='hasPartialResult(selectedReceipt)' color='warning' variant='tonal' density='compact') {{ $t(`admin:utilities.receiptRecordsAggregateCounts`) }}
                  .text-body-small.mt-3 {{ $t(`admin:utilities.receiptId`) }} #[code {{ selectedReceipt.id }}]
                  .text-body-small.mt-1 {{ $t(`admin:utilities.requested`, { createdAt: new Date(selectedReceipt.createdAt).toLocaleString(), interpolation: { escapeValue: false } }) }}
                  .text-body-small.mt-1 {{ selectedReceipt.apiKeyId ? $t(`admin:utilities.apiKey`, { apiKeyId: selectedReceipt.apiKeyId, interpolation: { escapeValue: false } }) : selectedReceipt.actorId ? $t(`admin:utilities.user`, { actorId: selectedReceipt.actorId, interpolation: { escapeValue: false } }) : $t(`admin:utilities.system`) }}
                  .text-body-small.mt-1 {{ $t(`admin:utilities.reason`, { reason: selectedReceipt.reason, interpolation: { escapeValue: false } }) }}
                  .text-body-small.mt-1(v-if='selectedReceipt.acknowledgedAt') {{ $t(`admin:utilities.uncertaintyAcknowledgedLaterRecorded`) }}
                v-btn.mt-3(size='small' variant='text' :disabled='receiptLoading' @click='clearReceipt') {{ $t(`admin:utilities.clearReceiptSelection`) }}
  v-snackbar(v-model='notice.open' :color='notice.color' timeout='5000' role='status') {{ notice.message }}
</template>

<script lang="ts">
import { confirmDiscard } from '../common/confirm-dialog.ts'
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
import type { Translate } from '../../helpers/use-translate.ts'

const tools = markRaw([
  { key: 'auth', title: 'admin:utilities.authenticationCleanup', subtitle: 'admin:utilities.sessionGuestRecovery', icon: 'mdi-shield-key-outline', component: 'UtilityAuth' },
  {
    key: 'content',
    title: 'admin:utilities.contentMaintenance',
    subtitle: 'admin:utilities.treeRenderLocaleHistory',
    icon: 'mdi-file-cog-outline',
    component: 'UtilityContent'
  },
  { key: 'export', title: 'admin:utilities.export', subtitle: 'admin:utilities.createGuardedLocalArchive', icon: 'mdi-database-export-outline', component: 'UtilityExport' },
  { key: 'cache', title: 'admin:utilities.cache', subtitle: 'admin:utilities.clearServerBrowserCaches', icon: 'mdi-cached', component: 'UtilityCache' },
  {
    key: 'import',
    title: 'admin:utilities.contentImport',
    subtitle: 'admin:utilities.bringDocumentsAssets',
    icon: 'mdi-database-import-outline',
    component: 'UtilityImportv1'
  },
  { key: 'telemetry', title: 'admin:utilities.telemetryTitle', subtitle: 'admin:utilities.privacyPreferenceClientIdentity', icon: 'mdi-radar', component: 'UtilityTelemetry' }
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
const errorMessage = (t: Translate, error: unknown): string => (error instanceof Error ? error.message : t('admin:utilities.utilitiesAdministrationUnavailable'))
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
    section: 'content' as ToolKey,
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
        this.section = typeof value === 'string' && tools.some((tool) => tool.key === value) ? (value as ToolKey) : 'content'
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
  beforeRouteLeave(): Promise<boolean> {
    return this.canLeave()
  },
  async beforeRouteUpdate(to: { path: string; query: Record<string, unknown> }, from: { path: string; query: Record<string, unknown> }): Promise<boolean> {
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
    async canLeave(): Promise<boolean> {
      if (this.busy || this.pendingRequest) return false
      if (!this.draftDirty) return true
      if (!(await confirmDiscard(this.$t('admin:utilities.discardUnsavedUtilitiesDraft')))) return false
      if (this.busy || this.pendingRequest) return false
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
            this.$t('admin:utilities.protectedUtilitiesRecoveryRecord')
        }
      } catch {
        this.recoveryStorageUnavailable = true
        this.error =
          this.$t('admin:utilities.browserCouldNotRead')
      }
    },
    persistPending(pending: PendingRequest): boolean {
      try {
        window.sessionStorage.setItem(pendingStorageKey, JSON.stringify(pending))
        this.pendingRequest = pending
        return true
      } catch {
        this.recoveryStorageUnavailable = true
        this.error = this.$t('admin:utilities.browserCannotSecurelyStore')
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
        this.error = this.$t('admin:utilities.browserCouldNotClear')
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
        if (!this.disposed) this.error = errorMessage(this.$t, error)
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
          this.error = this.$t('admin:utilities.exactPendingReceiptCould', { error: errorMessage(this.$t, error), interpolation: { escapeValue: false } })
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
        if (!this.disposed && sequence === this.receiptSequence && this.receiptId === id) this.receiptError = errorMessage(this.$t, error)
      } finally {
        if (!this.disposed && sequence === this.receiptSequence) this.receiptLoading = false
      }
    },
    async selectSection(section: ToolKey) {
      if (this.busy || this.pendingRequest || section === this.section) return
      if (!(await this.canLeave())) return
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
        [this.$t('admin:utilities.processed'), receipt.result.processed],
        [this.$t('admin:utilities.succeeded'), receipt.result.succeeded],
        [this.$t('admin:utilities.failed'), receipt.result.failed],
        [this.$t('admin:utilities.skipped'), receipt.result.skipped]
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
          this.$t('admin:utilities.authenticationCertificatesWereRecorded')
      }
    },
    async requestOperation(request: RequestedOperation) {
      if (this.mutationLocked || !this.workspace) return
      const kind = request.kind,
        reason = request.reason.trim()
      if (reason.length < 3 || reason.length > 1000) {
        const message = this.$t('admin:utilities.enterAdministrativeReason3')
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
        request.onRejected?.(this.error || this.$t('admin:utilities.browserCannotStoreUtilities'))
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
        this.notice = { open: true, color: 'success', message: this.$t('admin:utilities.wasRecordedFollowReceipt', { kind: utilityOperationTitle(kind), interpolation: { escapeValue: false } }) }
        this.replaceReceiptQuery(response.id)
        await this.reload()
      } catch (error) {
        if (this.disposed) return
        const message = errorMessage(this.$t, error),
          status = errorStatus(error)
        if (status !== null && status >= 400 && status < 500) {
          if (this.clearPending()) request.onRejected?.(message)
          this.error = message
          return
        }
        const recoveryMessage = this.$t('admin:utilities.utilitiesResponseDidNot', { message, interpolation: { escapeValue: false } })
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
.admin-utilities {
  .v-radio-group > .v-input__control > .v-label {
    color: rgb(var(--v-theme-on-surface));
    opacity: 1;
  }
  .v-card-subtitle {
    white-space: normal;
    overflow: visible;
    line-height: 1.6;
  }
  .admin-utilities-receipts .v-list-item-title {
    white-space: normal;
    overflow: visible;
    line-height: 1.45;
  }
  .admin-utilities-receipts .v-list-item__append {
    padding-left: 12px;
  }
}

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
