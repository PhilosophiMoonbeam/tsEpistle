<template>
  <v-container fluid class="recovery-workspace">
    <admin-hero :title="$t('admin:pagesRecycleBin.pageRecovery')" :description="$t('admin:pagesRecycleBin.restoreDeletedPageRetained')" icon="mdi-history">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/pages">{{ $t('admin:pagesRecycleBin.pageRegister') }}</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="listLoading" :disabled="listLoading || restoring" @click="loadFirstPage">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ $t('admin:pagesRecycleBin.reloadDeletedPageRecords') }}</v-tooltip></v-btn>
      </template>
    </admin-hero>

    <section class="recovery-intro" aria-labelledby="recovery-intro-title">
      <div>
        <span class="recovery-kicker">{{ $t('admin:pagesRecycleBin.preservedHistoryAdministratorWorkspace') }}</span>
        <h2 id="recovery-intro-title">{{ $t('admin:pagesRecycleBin.carefulReturnNotUndo') }}</h2>
        <p>{{ $t('admin:pagesRecycleBin.eachEntryPointsExact') }}</p>
      </div>
      <aside class="recovery-limit">
        <v-icon icon="mdi-shield-lock-outline" aria-hidden="true" />
        <p><strong>{{ $t('admin:pagesRecycleBin.whatRecoveryBringsBack') }}</strong><br />{{ $t('admin:pagesRecycleBin.pageSourceOriginalPage') }}</p>
      </aside>
    </section>

    <v-alert v-if="notice" type="success" variant="tonal" class="mb-5" role="status">
      {{ notice }}
      <router-link v-if="restoredPageId" class="recovery-result-link" :to="`/pages/${restoredPageId}`">{{ $t('admin:pagesRecycleBin.openRestoredPageAdministration') }}</router-link>
    </v-alert>
    <v-alert v-if="errorMessage" type="error" variant="tonal" class="mb-5" role="alert">{{ errorMessage }}</v-alert>

    <div class="recovery-grid">
      <section class="recovery-ledger" aria-labelledby="recovery-ledger-title">
        <div class="recovery-panel-heading">
          <div>
            <span class="recovery-kicker">{{ $t('admin:pagesRecycleBin.n01DeletedRecords') }}</span>
            <h3 id="recovery-ledger-title">{{ $t('admin:pagesRecycleBin.chooseSnapshot') }}</h3>
          </div>
          <span class="recovery-count" aria-live="polite">{{ $t('admin:pagesRecycleBin.visible', { itemsCount: items.length, interpolation: { escapeValue: false } }) }}</span>
        </div>
        <div v-if="listLoading && !items.length" class="recovery-empty" role="status">
          <v-progress-circular indeterminate color="primary" size="24" aria-hidden="true" />
          <span>{{ $t('admin:pagesRecycleBin.readingRetainedDeletionHistory') }}</span>
        </div>
        <div v-else-if="!items.length && !listLoading && !errorMessage" class="recovery-empty">
          <v-icon icon="mdi-archive-check-outline" size="34" aria-hidden="true" />
          <strong>{{ $t('admin:pagesRecycleBin.recoveryBinClear') }}</strong>
          <span>{{ $t('admin:pagesRecycleBin.onlyPageDeletionsWhose') }}</span>
        </div>
        <div v-else class="recovery-records">
          <button
            v-for="item in items"
            :key="`${item.pageId}:${item.deletionVersionId}`"
            type="button"
            class="recovery-record"
            :class="{ 'is-selected': selectedKey === recordKey(item) }"
            :aria-pressed="selectedKey === recordKey(item)"
            @click="selectRecord(item)"
          >
            <span class="record-mark" aria-hidden="true"><v-icon :icon="item.restoreMode === 'quarantine' ? 'mdi-lock-alert-outline' : 'mdi-file-restore-outline'" /></span>
            <span class="record-copy">
              <strong>{{ item.title || $t('admin:pagesRecycleBin.untitledPage') }}</strong>
              <span class="record-location">{{ item.localeCode }} / {{ item.path }}</span>
              <span class="record-meta">{{ $t('admin:pagesRecycleBin.pageDeletionVersion', { pageId: item.pageId, deletionVersionId: item.deletionVersionId, interpolation: { escapeValue: false } }) }}</span>
            </span>
            <span class="record-status" :class="item.restoreMode === 'quarantine' ? 'is-caution' : ''">
              {{ item.restoreMode === 'quarantine' ? $t('admin:pagesRecycleBin.quarantine') : item.protection.isProtected ? $t('admin:pagesRecycleBin.passwordProtected') : $t('admin:pagesRecycleBin.accessRetained') }}
            </span>
          </button>
          <v-btn v-if="hasMore" class="recovery-more" variant="text" :loading="olderLoading" :disabled="olderLoading || listLoading" prepend-icon="mdi-chevron-down" @click="loadOlder">{{ $t('admin:pagesRecycleBin.loadOlderRecords') }}</v-btn>
        </div>
        <p class="recovery-footnote">{{ $t('admin:pagesRecycleBin.listContainsOnlyLatest') }}</p>
      </section>

      <section class="recovery-inspector" aria-labelledby="recovery-inspector-title" :aria-busy="inspectLoading || restoring">
        <div class="recovery-panel-heading">
          <div>
            <span class="recovery-kicker">{{ $t('admin:pagesRecycleBin.n02SourceReturnPlan') }}</span>
            <h3 id="recovery-inspector-title">{{ $t('admin:pagesRecycleBin.inspectBeforeRestoring') }}</h3>
          </div>
          <span v-if="inspected" class="snapshot-index">#{{ inspected.pageId }} / v{{ inspected.deletionVersionId }}</span>
        </div>
        <div v-if="inspectLoading" class="recovery-empty" role="status">
          <v-progress-circular indeterminate color="primary" size="24" aria-hidden="true" />
          <span>{{ $t('admin:pagesRecycleBin.openingSelectedHistoricalSource') }}</span>
        </div>
        <div v-else-if="!inspected" class="recovery-empty recovery-empty--selection">
          <v-icon icon="mdi-text-box-search-outline" size="36" aria-hidden="true" />
          <strong>{{ $t('admin:pagesRecycleBin.noSnapshotSelected') }}</strong>
          <span>{{ $t('admin:pagesRecycleBin.selectRecordInspectSource') }}</span>
        </div>
        <template v-else>
          <v-alert v-if="inspected.restoreMode === 'quarantine'" type="warning" variant="tonal" density="comfortable" class="recovery-warning">
            {{ $t('admin:pagesRecycleBin.deletionHasNoReliable') }}
          </v-alert>
          <v-alert v-else-if="inspected.ownerResolutionRequired" type="warning" variant="tonal" density="comfortable" class="recovery-warning">
            {{ $t('admin:pagesRecycleBin.formerPrivatePageOwner') }}
          </v-alert>
          <dl class="recovery-facts">
            <div><dt>{{ $t('admin:pagesRecycleBin.deletedLocation') }}</dt><dd>{{ inspected.localeCode }} / {{ inspected.path }}</dd></div>
            <div><dt>{{ $t('admin:pagesRecycleBin.originalIdentity') }}</dt><dd>{{ $t('admin:pagesRecycleBin.pageSourceRevision', { pageId: inspected.pageId, sourceRevision: inspected.sourceRevision, interpolation: { escapeValue: false } }) }}</dd></div>
            <div><dt>{{ $t('admin:pagesRecycleBin.deleted') }}</dt><dd>{{ inspected.deletedAt ? formatDate(inspected.deletedAt) : $t('admin:pagesRecycleBin.deletionTimeNotRetained') }}</dd></div>
            <div><dt>{{ $t('admin:pagesRecycleBin.accessState') }}</dt><dd>{{ accessDescription(inspected) }}</dd></div>
            <div><dt>{{ $t('admin:pagesRecycleBin.tags') }}</dt><dd>{{ inspected.tags.length ? inspected.tags.map(tag => `#${tag}`).join(' · ') : $t('admin:pagesRecycleBin.noneRecorded') }}</dd></div>
          </dl>
          <details class="source-inspection">
            <summary>{{ $t('admin:pagesRecycleBin.readRetainedPageSource') }} <span>{{ $t('admin:pagesRecycleBin.characters', { length: inspected.content.length.toLocaleString(), interpolation: { escapeValue: false } }) }}</span></summary>
            <pre>{{ inspected.content }}</pre>
          </details>
          <div class="recovery-plan">
            <div class="plan-heading">
              <span class="recovery-kicker">{{ $t('admin:pagesRecycleBin.n03Destination') }}</span>
              <strong>{{ $t('admin:pagesRecycleBin.returnOriginalPageIdentity') }}</strong>
            </div>
            <div class="plan-fields">
              <v-text-field v-model="restorePath" :label="$t('admin:pagesRecycleBin.destinationPath')" variant="outlined" density="comfortable" autocomplete="off" hide-details />
              <v-text-field v-model="restoreLocale" :label="$t('admin:pagesRecycleBin.localeCode')" variant="outlined" density="comfortable" autocomplete="off" hide-details />
              <v-text-field
                v-if="inspected.ownerResolutionRequired"
                v-model="ownerIdInput"
                :label="$t('admin:pagesRecycleBin.recoveryOwnerAccountId')"
                type="number"
                min="1"
                step="1"
                variant="outlined"
                density="comfortable"
                autocomplete="off"
                :hint="$t('admin:pagesRecycleBin.useExistingAccountId')"
                persistent-hint
              />
            </div>
            <p class="recovery-draft-note"><v-icon icon="mdi-eye-off-outline" size="18" aria-hidden="true" /> {{ $t('admin:pagesRecycleBin.restoredPagesRemainUnpublished') }}</p>
            <v-btn color="primary" variant="flat" prepend-icon="mdi-file-restore-outline" :disabled="restoring || inspectLoading" @click="openConfirmation">{{ $t('admin:pagesRecycleBin.reviewRestore') }}</v-btn>
          </div>
        </template>
      </section>
    </div>

    <v-dialog v-model="confirmOpen" max-width="620" :persistent="restoring">
      <v-card class="recovery-confirm">
        <v-card-title>{{ $t('admin:pagesRecycleBin.confirmPageRecovery') }}</v-card-title>
        <v-card-text v-if="inspected">
          <p>{{ $t('admin:pagesRecycleBin.restorePage') }} <strong>#{{ inspected.pageId }}</strong> {{ $t('admin:pagesRecycleBin.deletionVersion') }} <strong>#{{ inspected.deletionVersionId }}</strong> {{ $t('admin:pagesRecycleBin.at') }} <code>{{ restoreLocale }} / {{ restorePath }}</code>?</p>
          <ul>
            <li>{{ $t('admin:pagesRecycleBin.originalPageIdRetained') }}</li>
            <li>{{ $t('admin:pagesRecycleBin.existingCommentsWatchersApprovals') }}</li>
            <li>{{ $t('admin:pagesRecycleBin.restoredPageStaysUnpublished') }}</li>
            <li v-if="inspected.restoreMode === 'quarantine'">{{ $t('admin:pagesRecycleBin.olderSnapshotReturnsPrivate') }}</li>
            <li v-else-if="inspected.protection.isProtected">{{ $t('admin:pagesRecycleBin.retainedPasswordProtectionRestored') }}</li>
            <li v-else>{{ $t('admin:pagesRecycleBin.recordedVisibilityOwnershipRetained') }}</li>
          </ul>
          <v-alert v-if="inspected.ownerResolutionRequired" type="info" variant="tonal" density="compact">{{ $t('admin:pagesRecycleBin.recoveryOwnerAccountWill', { value: ownerIdInput || '—', interpolation: { escapeValue: false } }) }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="restoring" @click="confirmOpen = false">{{ $t('common:actions.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="restoring" :disabled="restoring" @click="restoreSelected">{{ $t('admin:pagesRecycleBin.restoreUnpublished') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
import { translate } from '../../modules/localization.ts'
import { defineComponent } from 'vue'
import {
  DELETED_PAGE_RECOVERY_PAGE_SIZE,
  DeletedPageRecoveryInspectSchema,
  DeletedPageRecoveryListSchema,
  DeletedPageRecoveryResultSchema,
  type DeletedPageRecoveryInspect,
  type DeletedPageRecoveryItem
} from '../../../shared/deleted-page-recovery.ts'

interface RecycleBinState {
  items: DeletedPageRecoveryItem[]
  inspected: DeletedPageRecoveryInspect | null
  listLoading: boolean
  olderLoading: boolean
  inspectLoading: boolean
  restoring: boolean
  hasMore: boolean
  nextBeforeVersionId: number | null
  selectedKey: string
  restorePath: string
  restoreLocale: string
  ownerIdInput: string
  errorMessage: string
  notice: string
  restoredPageId: number | null
  confirmOpen: boolean
  listRequest: number
  inspectRequest: number
}

const apiRequest = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  const requestHeaders = new Headers(init.headers)
  requestHeaders.set('Accept', 'application/json')
  if (init.body !== undefined) requestHeaders.set('Content-Type', 'application/json')
  const response = await window.fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: requestHeaders
  })
  let payload: unknown = null
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof Reflect.get(payload, 'error') === 'string') {
      throw new Error(Reflect.get(payload, 'error') as string)
    }
    throw new Error(translate('admin:pagesRecycleBin.recoveryRequestCouldNot'))
  }
  return payload
}

export default defineComponent({
  name: 'AdminPagesRecycleBin',
  data(): RecycleBinState {
    return {
      items: [],
      inspected: null,
      listLoading: false,
      olderLoading: false,
      inspectLoading: false,
      restoring: false,
      hasMore: false,
      nextBeforeVersionId: null,
      selectedKey: '',
      restorePath: '',
      restoreLocale: '',
      ownerIdInput: '',
      errorMessage: '',
      notice: '',
      restoredPageId: null,
      confirmOpen: false,
      listRequest: 0,
      inspectRequest: 0
    }
  },
  methods: {
    recordKey(item: DeletedPageRecoveryItem): string {
      return `${item.pageId}:${item.deletionVersionId}`
    },
    formatDate(value: string): string {
      const date = new Date(value)
      return Number.isFinite(date.valueOf())
        ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
        : value
    },
    accessDescription(item: DeletedPageRecoveryItem): string {
      if (item.restoreMode === 'quarantine') return this.$t('admin:pagesRecycleBin.unknownHistoricalProtectionQuarantine')
      const visibility = item.visibility === 'private' ? this.$t('admin:pagesRecycleBin.privateOwner', { ownerId: item.ownerId ?? 'missing', interpolation: { escapeValue: false } }) : this.$t('admin:pagesRecycleBin.workspaceVisibility')
      return item.protection.isProtected ? this.$t('admin:pagesRecycleBin.passwordProtectionRetainedV', { visibility, version: item.protection.version, interpolation: { escapeValue: false } }) : visibility
    },
    async loadFirstPage(): Promise<void> {
      const request = ++this.listRequest
      this.listLoading = true
      this.errorMessage = ''
      this.notice = ''
      this.restoredPageId = null
      this.items = []
      this.hasMore = false
      this.nextBeforeVersionId = null
      this.selectedKey = ''
      this.inspected = null
      this.inspectRequest += 1
      this.inspectLoading = false
      try {
        const payload = await apiRequest(`/_api/pages/deleted?limit=${DELETED_PAGE_RECOVERY_PAGE_SIZE}`)
        const parsed = DeletedPageRecoveryListSchema.safeParse(payload)
        if (!parsed.success) throw new Error(this.$t('admin:pagesRecycleBin.recoveryBinReturnedInvalid'))
        if (request !== this.listRequest) return
        this.items = parsed.data.items
        this.hasMore = parsed.data.hasMore
        this.nextBeforeVersionId = parsed.data.nextBeforeVersionId
      } catch (error) {
        if (request === this.listRequest) this.errorMessage = error instanceof Error ? error.message : this.$t('admin:pagesRecycleBin.recoveryBinCouldNot')
      } finally {
        if (request === this.listRequest) this.listLoading = false
      }
    },
    async loadOlder(): Promise<void> {
      if (!this.hasMore || this.nextBeforeVersionId === null || this.olderLoading) return
      const request = this.listRequest
      this.olderLoading = true
      this.errorMessage = ''
      try {
        const payload = await apiRequest(`/_api/pages/deleted?limit=${DELETED_PAGE_RECOVERY_PAGE_SIZE}&beforeVersionId=${this.nextBeforeVersionId}`)
        const parsed = DeletedPageRecoveryListSchema.safeParse(payload)
        if (!parsed.success) throw new Error(this.$t('admin:pagesRecycleBin.recoveryBinReturnedInvalid'))
        if (request !== this.listRequest) return
        this.items = [...this.items, ...parsed.data.items]
        this.hasMore = parsed.data.hasMore
        this.nextBeforeVersionId = parsed.data.nextBeforeVersionId
      } catch (error) {
        if (request === this.listRequest) this.errorMessage = error instanceof Error ? error.message : this.$t('admin:pagesRecycleBin.olderRecoveryRecordsCould')
      } finally {
        this.olderLoading = false
      }
    },
    async selectRecord(item: DeletedPageRecoveryItem): Promise<void> {
      const request = ++this.inspectRequest
      this.selectedKey = this.recordKey(item)
      this.inspected = null
      this.inspectLoading = true
      this.errorMessage = ''
      this.notice = ''
      this.restoredPageId = null
      this.restorePath = item.path
      this.restoreLocale = item.localeCode
      this.ownerIdInput = ''
      this.confirmOpen = false
      try {
        const payload = await apiRequest(`/_api/pages/deleted/${item.pageId}/${item.deletionVersionId}`)
        const parsed = DeletedPageRecoveryInspectSchema.safeParse(payload)
        if (!parsed.success) throw new Error(this.$t('admin:pagesRecycleBin.deletedPageInspectionReturned'))
        if (request !== this.inspectRequest) return
        this.inspected = parsed.data
        this.restorePath = parsed.data.path
        this.restoreLocale = parsed.data.localeCode
      } catch (error) {
        if (request === this.inspectRequest) this.errorMessage = error instanceof Error ? error.message : this.$t('admin:pagesRecycleBin.deletedPageCouldNot')
      } finally {
        if (request === this.inspectRequest) this.inspectLoading = false
      }
    },
    openConfirmation(): void {
      if (!this.inspected || this.restoring) return
      const ownerId = Number(this.ownerIdInput)
      if (this.inspected.ownerResolutionRequired && (!/^[1-9]\d*$/.test(this.ownerIdInput) || !Number.isSafeInteger(ownerId))) {
        this.errorMessage = this.$t('admin:pagesRecycleBin.enterValidRecoveryOwner')
        return
      }
      this.errorMessage = ''
      this.confirmOpen = true
    },
    async restoreSelected(): Promise<void> {
      if (!this.inspected || this.restoring) return
      const pageId = this.inspected.pageId
      const versionId = this.inspected.deletionVersionId
      const ownerId = this.inspected.ownerResolutionRequired ? Number(this.ownerIdInput) : undefined
      this.restoring = true
      this.errorMessage = ''
      try {
        const payload = await apiRequest(`/_api/pages/deleted/${pageId}/${versionId}/restore`, {
          method: 'POST',
          body: JSON.stringify({
            destination: { path: this.restorePath, localeCode: this.restoreLocale },
            ...(ownerId === undefined ? {} : { ownerId })
          })
        })
        const parsed = DeletedPageRecoveryResultSchema.safeParse(payload)
        if (!parsed.success) throw new Error(this.$t('admin:pagesRecycleBin.recoveryOperationReturnedInvalid'))
        this.confirmOpen = false
        this.notice = parsed.data.quarantined
          ? this.$t('admin:pagesRecycleBin.pageWasRestoredInto', { pageId: parsed.data.pageId, interpolation: { escapeValue: false } })
          : this.$t('admin:pagesRecycleBin.pageWasRestoredRetained', { pageId: parsed.data.pageId, interpolation: { escapeValue: false } })
        this.restoredPageId = parsed.data.pageId
        await this.loadFirstPage()
        this.notice = parsed.data.quarantined
          ? this.$t('admin:pagesRecycleBin.pageWasRestoredInto', { pageId: parsed.data.pageId, interpolation: { escapeValue: false } })
          : this.$t('admin:pagesRecycleBin.pageWasRestoredRetained', { pageId: parsed.data.pageId, interpolation: { escapeValue: false } })
        this.restoredPageId = parsed.data.pageId
      } catch (error) {
        this.errorMessage = error instanceof Error ? error.message : this.$t('admin:pagesRecycleBin.deletedPageCouldNot2')
        this.confirmOpen = false
        await this.loadFirstPage()
        this.errorMessage = error instanceof Error ? error.message : this.$t('admin:pagesRecycleBin.deletedPageCouldNot2')
      } finally {
        this.restoring = false
      }
    }
  },
  mounted() {
    void this.loadFirstPage()
  }
})
</script>

<style scoped lang="scss">
.recovery-workspace { max-width: 1680px; padding-bottom: 4rem !important; }
.recovery-intro { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(18rem, .75fr); align-items: end; gap: 2.5rem; padding: 2.5rem .5rem 2rem; }
.recovery-kicker { display: block; color: rgb(var(--v-theme-on-surface-variant)); font-size: .68rem; font-weight: 700; letter-spacing: .16em; line-height: 1.4; text-transform: uppercase; }
.recovery-intro h2 { margin: .65rem 0 .8rem; font: 500 clamp(1.8rem, 3vw, 2.8rem)/1.08 var(--font-family-serif, Georgia, serif); letter-spacing: -.035em; }
.recovery-intro > div > p { max-width: 48rem; color: rgb(var(--v-theme-on-surface-variant)); line-height: 1.65; }
.recovery-limit { display: grid; grid-template-columns: 2rem 1fr; gap: .75rem; align-items: start; padding: 1.05rem 1.2rem; border-inline-start: 3px solid rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .06); }
.recovery-limit .v-icon { color: rgb(var(--v-theme-primary)); }
.recovery-limit p { margin: 0; font-size: .88rem; line-height: 1.55; }
.recovery-limit strong { display: inline-block; margin-bottom: .25rem; }
.recovery-grid { display: grid; grid-template-columns: minmax(19rem, .78fr) minmax(0, 1.4fr); gap: 1.1rem; align-items: start; }
.recovery-ledger, .recovery-inspector { min-width: 0; overflow: hidden; border: 1px solid rgba(var(--v-border-color), .22); border-radius: 14px; background: rgb(var(--v-theme-surface)); }
.recovery-panel-heading { display: flex; justify-content: space-between; align-items: end; gap: 1rem; padding: 1.25rem 1.35rem 1rem; border-bottom: 1px solid rgba(var(--v-border-color), .14); }
.recovery-panel-heading h3 { margin: .35rem 0 0; font-size: 1.15rem; font-weight: 600; }
.recovery-count, .snapshot-index { color: rgb(var(--v-theme-on-surface-variant)); font-size: .78rem; font-variant-numeric: tabular-nums; }
.recovery-records { padding: .45rem; }
.recovery-record { display: grid; width: 100%; grid-template-columns: 2.2rem minmax(0, 1fr); gap: .7rem; align-items: start; padding: .95rem .9rem; border: 1px solid transparent; border-bottom-color: rgba(var(--v-border-color), .11); border-radius: 10px; background: transparent; color: inherit; text-align: start; cursor: pointer; transition: background-color .16s ease, border-color .16s ease; }
.recovery-record:hover { background: rgba(var(--v-theme-primary), .035); }
.recovery-record:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 1px; }
.recovery-record.is-selected { border-color: rgba(var(--v-theme-primary), .36); background: rgba(var(--v-theme-primary), .075); }
.record-mark { display: grid; width: 2rem; height: 2rem; place-items: center; border-radius: 7px; background: rgba(var(--v-theme-primary), .09); color: rgb(var(--v-theme-primary)); }
.record-copy { display: grid; min-width: 0; gap: .27rem; }
.record-copy strong { overflow: hidden; font-size: .93rem; text-overflow: ellipsis; white-space: nowrap; }
.record-location, .record-meta { overflow-wrap: anywhere; color: rgb(var(--v-theme-on-surface-variant)); font-size: .75rem; }
.record-status { grid-column: 2; justify-self: start; padding: .2rem .48rem; border-radius: 999px; background: rgba(var(--v-theme-success), .1); color: rgb(var(--v-theme-success)); font-size: .68rem; font-weight: 700; letter-spacing: .03em; }
.record-status.is-caution { background: rgba(var(--v-theme-warning), .12); color: rgb(var(--v-theme-on-surface)); }
.recovery-more { width: 100%; margin-top: .35rem; }
.recovery-empty { display: flex; min-height: 11rem; flex-direction: column; justify-content: center; align-items: center; gap: .7rem; padding: 2rem; color: rgb(var(--v-theme-on-surface-variant)); text-align: center; }
.recovery-empty strong { color: rgb(var(--v-theme-on-surface)); }
.recovery-empty span { max-width: 25rem; font-size: .86rem; line-height: 1.55; }
.recovery-empty--selection { min-height: 19rem; }
.recovery-empty--selection .v-icon { margin-bottom: .3rem; color: rgb(var(--v-theme-primary)); }
.recovery-footnote { margin: 0; padding: .9rem 1.15rem 1.05rem; color: rgb(var(--v-theme-on-surface-variant)); font-size: .74rem; line-height: 1.5; }
.recovery-inspector { padding-bottom: 1rem; }
.recovery-warning { margin: 1rem 1.2rem 0; }
.recovery-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .9rem 1.6rem; margin: 1.25rem 1.35rem; }
.recovery-facts > div { min-width: 0; }
.recovery-facts dt { margin-bottom: .25rem; color: rgb(var(--v-theme-on-surface-variant)); font-size: .68rem; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
.recovery-facts dd { margin: 0; overflow-wrap: anywhere; font-size: .86rem; line-height: 1.5; }
.source-inspection { margin: 0 1.25rem 1.1rem; border: 1px solid rgba(var(--v-border-color), .19); border-radius: 9px; }
.source-inspection summary { display: flex; justify-content: space-between; gap: 1rem; padding: .8rem 1rem; cursor: pointer; font-size: .83rem; font-weight: 600; }
.source-inspection summary span { color: rgb(var(--v-theme-on-surface-variant)); font-size: .73rem; font-weight: 400; }
.source-inspection pre { max-height: 30rem; overflow: auto; margin: 0; padding: 1rem; border-top: 1px solid rgba(var(--v-border-color), .16); background: rgba(var(--v-theme-on-surface), .035); color: rgb(var(--v-theme-on-surface)); font: .8rem/1.6 var(--font-family-monospace, monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
.recovery-plan { margin: 0 1.25rem; padding: 1.1rem 1.15rem; border-radius: 11px; background: rgba(var(--v-theme-on-surface), .035); }
.plan-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: center; margin-bottom: 1rem; }
.plan-heading strong { font-size: .86rem; font-weight: 600; }
.plan-fields { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(8rem, .65fr); gap: .8rem; }
.plan-fields > :last-child:nth-child(3) { grid-column: 1 / -1; }
.recovery-draft-note { display: flex; gap: .5rem; align-items: center; margin: 1rem 0; color: rgb(var(--v-theme-on-surface-variant)); font-size: .8rem; line-height: 1.5; }
.recovery-draft-note .v-icon { flex: 0 0 auto; color: rgb(var(--v-theme-primary)); }
.recovery-confirm ul { margin: 1rem 0 0; padding-inline-start: 1.25rem; line-height: 1.65; }
.recovery-confirm li + li { margin-top: .35rem; }
.recovery-result-link { display: inline-block; margin-inline-start: .75rem; color: inherit; font-weight: 700; }
@media (prefers-reduced-motion: reduce) { .recovery-record { transition: none; } }
@media (max-width: 980px) { .recovery-grid { grid-template-columns: minmax(0, 1fr); } .recovery-intro { grid-template-columns: 1fr; gap: 1rem; } }
@media (max-width: 600px) { .recovery-intro { padding: 1.5rem .25rem; } .recovery-facts { grid-template-columns: 1fr; margin-inline: 1rem; } .plan-fields { grid-template-columns: 1fr; } .plan-fields > :last-child:nth-child(3) { grid-column: auto; } .plan-heading { align-items: start; flex-direction: column; } .recovery-warning, .source-inspection, .recovery-plan { margin-inline: .8rem; } }
</style>
