<template>
  <v-container fluid class="recovery-workspace">
    <admin-hero title="Page recovery" description="Restore a deleted page from its retained history without reopening a public route." icon="mdi-history">
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/pages">Page register</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-refresh" :loading="listLoading" :disabled="listLoading || restoring" @click="loadFirstPage">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">Reload deleted page records</v-tooltip></v-btn>
      </template>
    </admin-hero>

    <section class="recovery-intro" aria-labelledby="recovery-intro-title">
      <div>
        <span class="recovery-kicker">Preserved history / administrator workspace</span>
        <h2 id="recovery-intro-title">A careful return, not an undo.</h2>
        <p>Each entry points to the exact deletion snapshot. Review its source and original access state before choosing where the page returns.</p>
      </div>
      <aside class="recovery-limit">
        <v-icon icon="mdi-shield-lock-outline" aria-hidden="true" />
        <p><strong>What recovery brings back</strong><br />Page source, original page identity, history, and retained metadata. It does not recreate comments, watcher subscriptions, or approval records.</p>
      </aside>
    </section>

    <v-alert v-if="notice" type="success" variant="tonal" class="mb-5" role="status">
      {{ notice }}
      <router-link v-if="restoredPageId" class="recovery-result-link" :to="`/pages/${restoredPageId}`">Open restored page administration</router-link>
    </v-alert>
    <v-alert v-if="errorMessage" type="error" variant="tonal" class="mb-5" role="alert">{{ errorMessage }}</v-alert>

    <div class="recovery-grid">
      <section class="recovery-ledger" aria-labelledby="recovery-ledger-title">
        <div class="recovery-panel-heading">
          <div>
            <span class="recovery-kicker">01 / Deleted records</span>
            <h3 id="recovery-ledger-title">Choose a snapshot</h3>
          </div>
          <span class="recovery-count" aria-live="polite">{{ items.length }} visible</span>
        </div>
        <div v-if="listLoading && !items.length" class="recovery-empty" role="status">
          <v-progress-circular indeterminate color="primary" size="24" aria-hidden="true" />
          <span>Reading retained deletion history…</span>
        </div>
        <div v-else-if="!items.length && !listLoading && !errorMessage" class="recovery-empty">
          <v-icon icon="mdi-archive-check-outline" size="34" aria-hidden="true" />
          <strong>The recovery bin is clear.</strong>
          <span>Only page deletions whose history is still retained can appear here.</span>
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
              <strong>{{ item.title || 'Untitled page' }}</strong>
              <span class="record-location">{{ item.localeCode }} / {{ item.path }}</span>
              <span class="record-meta">Page #{{ item.pageId }} · deletion version #{{ item.deletionVersionId }}</span>
            </span>
            <span class="record-status" :class="item.restoreMode === 'quarantine' ? 'is-caution' : ''">
              {{ item.restoreMode === 'quarantine' ? 'Quarantine' : item.protection.isProtected ? 'Password protected' : 'Access retained' }}
            </span>
          </button>
          <v-btn v-if="hasMore" class="recovery-more" variant="text" :loading="olderLoading" :disabled="olderLoading || listLoading" prepend-icon="mdi-chevron-down" @click="loadOlder">Load older records</v-btn>
        </div>
        <p class="recovery-footnote">The list contains only the latest deletion snapshot for each page identity. Restoring an older deletion version is rejected as stale.</p>
      </section>

      <section class="recovery-inspector" aria-labelledby="recovery-inspector-title" :aria-busy="inspectLoading || restoring">
        <div class="recovery-panel-heading">
          <div>
            <span class="recovery-kicker">02 / Source &amp; return plan</span>
            <h3 id="recovery-inspector-title">Inspect before restoring</h3>
          </div>
          <span v-if="inspected" class="snapshot-index">#{{ inspected.pageId }} / v{{ inspected.deletionVersionId }}</span>
        </div>
        <div v-if="inspectLoading" class="recovery-empty" role="status">
          <v-progress-circular indeterminate color="primary" size="24" aria-hidden="true" />
          <span>Opening the selected historical source…</span>
        </div>
        <div v-else-if="!inspected" class="recovery-empty recovery-empty--selection">
          <v-icon icon="mdi-text-box-search-outline" size="36" aria-hidden="true" />
          <strong>No snapshot selected</strong>
          <span>Select a record to inspect its source, security state, and restore scope.</span>
        </div>
        <template v-else>
          <v-alert v-if="inspected.restoreMode === 'quarantine'" type="warning" variant="tonal" density="comfortable" class="recovery-warning">
            This deletion has no reliable retained password state. It can only return in quarantine: private, unpublished, and owned by the administrator restoring it.
          </v-alert>
          <v-alert v-else-if="inspected.ownerResolutionRequired" type="warning" variant="tonal" density="comfortable" class="recovery-warning">
            The former private-page owner no longer exists. Choose a valid account explicitly; ownership will not be assigned silently.
          </v-alert>
          <dl class="recovery-facts">
            <div><dt>Deleted location</dt><dd>{{ inspected.localeCode }} / {{ inspected.path }}</dd></div>
            <div><dt>Original identity</dt><dd>Page #{{ inspected.pageId }} · source revision {{ inspected.sourceRevision }}</dd></div>
            <div><dt>Deleted</dt><dd>{{ inspected.deletedAt ? formatDate(inspected.deletedAt) : 'Deletion time not retained' }}</dd></div>
            <div><dt>Access state</dt><dd>{{ accessDescription(inspected) }}</dd></div>
            <div><dt>Tags</dt><dd>{{ inspected.tags.length ? inspected.tags.map(tag => `#${tag}`).join(' · ') : 'None recorded' }}</dd></div>
          </dl>
          <details class="source-inspection">
            <summary>Read retained page source <span>{{ inspected.content.length.toLocaleString() }} characters</span></summary>
            <pre>{{ inspected.content }}</pre>
          </details>
          <div class="recovery-plan">
            <div class="plan-heading">
              <span class="recovery-kicker">03 / Destination</span>
              <strong>Return the original page identity</strong>
            </div>
            <div class="plan-fields">
              <v-text-field v-model="restorePath" label="Destination path" variant="outlined" density="comfortable" autocomplete="off" hide-details />
              <v-text-field v-model="restoreLocale" label="Locale code" variant="outlined" density="comfortable" autocomplete="off" hide-details />
              <v-text-field
                v-if="inspected.ownerResolutionRequired"
                v-model="ownerIdInput"
                label="Recovery owner account ID"
                type="number"
                min="1"
                step="1"
                variant="outlined"
                density="comfortable"
                autocomplete="off"
                hint="Use an existing account ID. The server verifies it before writing."
                persistent-hint
              />
            </div>
            <p class="recovery-draft-note"><v-icon icon="mdi-eye-off-outline" size="18" aria-hidden="true" /> Restored pages remain unpublished. Publish later through the ordinary publication controls after reviewing the recovered page.</p>
            <v-btn color="primary" variant="flat" prepend-icon="mdi-file-restore-outline" :disabled="restoring || inspectLoading" @click="openConfirmation">Review restore</v-btn>
          </div>
        </template>
      </section>
    </div>

    <v-dialog v-model="confirmOpen" max-width="620" :persistent="restoring">
      <v-card class="recovery-confirm">
        <v-card-title>Confirm page recovery</v-card-title>
        <v-card-text v-if="inspected">
          <p>Restore page <strong>#{{ inspected.pageId }}</strong> from deletion version <strong>#{{ inspected.deletionVersionId }}</strong> at <code>{{ restoreLocale }} / {{ restorePath }}</code>?</p>
          <ul>
            <li>The original page ID and retained history are preserved.</li>
            <li>Existing comments, watchers, and approvals are not recreated.</li>
            <li>The restored page stays unpublished until an administrator publishes it separately.</li>
            <li v-if="inspected.restoreMode === 'quarantine'">This older snapshot returns private, unpublished, and owned by you.</li>
            <li v-else-if="inspected.protection.isProtected">Its retained password protection is restored; prior unlock sessions are not.</li>
            <li v-else>Its recorded visibility and ownership are retained, without a page password that was not present at deletion.</li>
          </ul>
          <v-alert v-if="inspected.ownerResolutionRequired" type="info" variant="tonal" density="compact">Recovery owner account #{{ ownerIdInput || '—' }} will be assigned because the former owner is unavailable.</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="restoring" @click="confirmOpen = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="restoring" :disabled="restoring" @click="restoreSelected">Restore as unpublished</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script lang="ts">
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
    throw new Error('The recovery request could not be completed.')
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
      if (item.restoreMode === 'quarantine') return 'Unknown historical protection · quarantine required'
      const visibility = item.visibility === 'private' ? `Private · owner #${item.ownerId ?? 'missing'}` : 'Workspace visibility'
      return item.protection.isProtected ? `${visibility} · password protection retained (v${item.protection.version})` : visibility
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
        if (!parsed.success) throw new Error('The recovery bin returned invalid data.')
        if (request !== this.listRequest) return
        this.items = parsed.data.items
        this.hasMore = parsed.data.hasMore
        this.nextBeforeVersionId = parsed.data.nextBeforeVersionId
      } catch (error) {
        if (request === this.listRequest) this.errorMessage = error instanceof Error ? error.message : 'The recovery bin could not be loaded.'
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
        if (!parsed.success) throw new Error('The recovery bin returned invalid data.')
        if (request !== this.listRequest) return
        this.items = [...this.items, ...parsed.data.items]
        this.hasMore = parsed.data.hasMore
        this.nextBeforeVersionId = parsed.data.nextBeforeVersionId
      } catch (error) {
        if (request === this.listRequest) this.errorMessage = error instanceof Error ? error.message : 'Older recovery records could not be loaded.'
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
        if (!parsed.success) throw new Error('The deleted page inspection returned invalid data.')
        if (request !== this.inspectRequest) return
        this.inspected = parsed.data
        this.restorePath = parsed.data.path
        this.restoreLocale = parsed.data.localeCode
      } catch (error) {
        if (request === this.inspectRequest) this.errorMessage = error instanceof Error ? error.message : 'The deleted page could not be inspected.'
      } finally {
        if (request === this.inspectRequest) this.inspectLoading = false
      }
    },
    openConfirmation(): void {
      if (!this.inspected || this.restoring) return
      const ownerId = Number(this.ownerIdInput)
      if (this.inspected.ownerResolutionRequired && (!/^[1-9]\d*$/.test(this.ownerIdInput) || !Number.isSafeInteger(ownerId))) {
        this.errorMessage = 'Enter a valid recovery owner account ID before continuing.'
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
        if (!parsed.success) throw new Error('The recovery operation returned invalid data.')
        this.confirmOpen = false
        this.notice = parsed.data.quarantined
          ? `Page #${parsed.data.pageId} was restored into private quarantine and remains unpublished.`
          : `Page #${parsed.data.pageId} was restored with its retained access state and remains unpublished.`
        this.restoredPageId = parsed.data.pageId
        await this.loadFirstPage()
        this.notice = parsed.data.quarantined
          ? `Page #${parsed.data.pageId} was restored into private quarantine and remains unpublished.`
          : `Page #${parsed.data.pageId} was restored with its retained access state and remains unpublished.`
        this.restoredPageId = parsed.data.pageId
      } catch (error) {
        this.errorMessage = error instanceof Error ? error.message : 'The deleted page could not be restored.'
        this.confirmOpen = false
        await this.loadFirstPage()
        this.errorMessage = error instanceof Error ? error.message : 'The deleted page could not be restored.'
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
