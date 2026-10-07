<template>
  <v-container class="page-integrity" fluid>
    <AdminHero
      :title="$t('admin:pageIntegrity.pageIntegrity')"
      :description="$t('admin:pageIntegrity.inspectBoundedRevisionFenced')"
      :eyebrow="$t('admin:pageIntegrity.systemDiagnostics')"
      icon="mdi-shield-search"
    >
      <template #actions>
        <v-btn
          v-if="scanState === 'running'"
          color="warning"
          variant="outlined"
          prepend-icon="mdi-stop-circle-outline"
          @click="cancelScan"
        >
          {{ $t('admin:pageIntegrity.cancelScan') }}
        </v-btn>
        <v-btn
          v-else
          color="primary"
          variant="tonal"
          prepend-icon="mdi-play-circle-outline"
          :disabled="unmounted"
          @click="startScan"
        >
          {{ scanState === 'complete' || scanState === 'cancelled' || scanState === 'error' ? $t('admin:pageIntegrity.runNewScan') : $t('admin:pageIntegrity.startScan') }}
        </v-btn>
      </template>
    </AdminHero>

    <v-alert class="mt-5" color="info" variant="tonal" icon="mdi-information-outline">
      {{ $t('admin:pageIntegrity.administratorOnlyInspectionReads') }}
    </v-alert>

    <v-alert v-if="scanError" class="mt-4" color="error" variant="tonal" role="alert">
      {{ scanError }}
    </v-alert>

    <section class="integrity-summary mt-5" aria-labelledby="integrity-summary-title">
      <header class="integrity-section-heading">
        <div>
          <p class="integrity-kicker">{{ $t('admin:pageIntegrity.boundedObservation') }}</p>
          <h2 id="integrity-summary-title">{{ $t('admin:pageIntegrity.scanProgress') }}</h2>
          <p v-if="scanState === 'idle'">{{ $t('admin:pageIntegrity.chooseStartScanCapture') }}</p>
          <p v-else-if="scanState === 'running'" role="status" aria-live="polite">
            {{ $t('admin:pageIntegrity.inspectingPagesThroughCaptured', { pagesScanned: pagesScanned.toLocaleString(), upperWatermark: upperWatermark.toLocaleString(), interpolation: { escapeValue: false } }) }}
          </p>
          <p v-else-if="scanState === 'complete'" role="status" aria-live="polite">
            {{ $t('admin:pageIntegrity.completedUpperWatermarkAfter', { upperWatermark: upperWatermark.toLocaleString(), pagesScanned: pagesScanned.toLocaleString(), interpolation: { escapeValue: false } }) }}
          </p>
          <p v-else-if="scanState === 'cancelled'" role="status" aria-live="polite">
            {{ $t('admin:pageIntegrity.cancelledAfterInspectingPages', { pagesScanned: pagesScanned.toLocaleString(), interpolation: { escapeValue: false } }) }}
          </p>
          <p v-else-if="scanState === 'error'">{{ $t('admin:pageIntegrity.scanCouldNotContinue') }}</p>
        </div>
        <v-chip
          v-if="scanState !== 'idle'"
          :color="scanState === 'complete' ? 'success' : scanState === 'running' ? 'primary' : scanState === 'error' ? 'error' : 'warning'"
          variant="tonal"
          size="small"
        >
          {{ scanStateLabel }}
        </v-chip>
      </header>
      <v-progress-linear v-if="scanState === 'running'" indeterminate color="primary" :aria-label="$t('admin:pageIntegrity.pageIntegrityScanRunning')" />

      <div v-if="hasSummary" class="integrity-counts" :aria-label="$t('admin:pageIntegrity.observedCheckCounts')">
        <article v-for="item in countCards" :key="item.key" class="integrity-count">
          <span>{{ item.label }}</span>
          <strong>{{ outcomes[item.key].toLocaleString() }}</strong>
        </article>
        <article class="integrity-count integrity-count--watermark">
          <span>{{ $t('admin:pageIntegrity.upperWatermark') }}</span>
          <strong>{{ upperWatermark.toLocaleString() }}</strong>
        </article>
      </div>
    </section>

    <section v-if="localStorage.length" class="integrity-storage mt-5" aria-labelledby="integrity-storage-title">
      <header class="integrity-section-heading">
        <div>
          <p class="integrity-kicker">{{ $t('admin:pageIntegrity.recordedLocalStateOnly') }}</p>
          <h2 id="integrity-storage-title">{{ $t('admin:pageIntegrity.localStorageTargets') }}</h2>
          <p>{{ $t('admin:pageIntegrity.theseStatusesComeSaved') }}</p>
        </div>
      </header>
      <div class="storage-targets">
        <article v-for="target in localStorage" :key="target.key" class="storage-target">
          <div>
            <strong>{{ target.key === 'disk' ? $t('admin:pageIntegrity.localDisk') : $t('admin:pageIntegrity.localGitWorkingCopy') }}</strong>
            <p>{{ target.enabled ? $t('admin:pageIntegrity.enabled') : $t('admin:pageIntegrity.disabled') }} · {{ target.hasRecordedOperation ? $t('admin:pageIntegrity.recordedOperationAvailable') : $t('admin:pageIntegrity.noRecordedOperation') }}</p>
          </div>
          <div class="storage-observation">
            <v-chip size="small" variant="tonal" :color="storageColor(target.status)">{{ target.status }}</v-chip>
            <time v-if="target.lastAttempt" :datetime="target.lastAttempt">{{ formatDate(target.lastAttempt) }}</time>
            <span v-else>{{ $t('admin:pageIntegrity.noRecordedAttempt') }}</span>
          </div>
        </article>
      </div>
    </section>

    <v-alert v-if="scanState === 'complete' && checks.length === 0 && omittedChecks === 0" class="mt-5" color="success" variant="tonal" icon="mdi-check-circle-outline">
      {{ $t('admin:pageIntegrity.noFindingsStaleObservations') }}
    </v-alert>

    <section v-if="checks.length || omittedChecks > 0" class="integrity-results mt-5" aria-labelledby="integrity-results-title">
      <header class="integrity-section-heading">
        <div>
          <p class="integrity-kicker">{{ $t('admin:pageIntegrity.noSourceExcerpts') }}</p>
          <h2 id="integrity-results-title">{{ $t('admin:pageIntegrity.observations') }}</h2>
          <p>{{ $t('admin:pageIntegrity.healthyChecksCountedAbove', { maxVisibleChecks, interpolation: { escapeValue: false } }) }}</p>
        </div>
        <v-chip v-if="omittedChecks" color="warning" variant="tonal" size="small">{{ $t('admin:pageIntegrity.additionalObservationsNotDisplayed', { omittedChecks: omittedChecks.toLocaleString(), interpolation: { escapeValue: false } }) }}</v-chip>
      </header>
      <div class="integrity-check-list" role="list" :aria-label="$t('admin:pageIntegrity.pageIntegrityObservations')">
        <article v-for="(item, index) in checks" :key="`${item.pageId}-${item.checkCode}-${index}`" class="integrity-check" role="listitem">
          <div class="integrity-check-identity">
            <span>{{ $t('admin:pageIntegrity.page', { pageId: item.pageId, interpolation: { escapeValue: false } }) }}</span>
            <small>{{ $t('admin:pageIntegrity.revision', { sourceRevision: item.sourceRevision || 'unavailable', interpolation: { escapeValue: false } }) }}</small>
          </div>
          <div class="integrity-check-main">
            <div class="integrity-check-heading">
              <code>{{ item.checkCode }}</code>
              <v-chip size="x-small" variant="tonal" :color="outcomeColor(item.outcome)">{{ item.outcome }}</v-chip>
              <span class="integrity-severity">{{ item.severity }}</span>
            </div>
            <p>{{ item.remediation }}</p>
          </div>
        </article>
      </div>
    </section>
  </v-container>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import {
  PAGE_INTEGRITY_BATCH_DEFAULT,
  PAGE_INTEGRITY_MAX_VISIBLE_CHECKS,
  PageIntegrityScanResponseSchema,
  type PageIntegrityCheck,
  type PageIntegrityScanRequest,
  type PageIntegrityScanResponse
} from '../../../shared/page-integrity.ts'

const OUTCOMES = ['healthy', 'finding', 'changed', 'skipped', 'error'] as const

export default defineComponent({
  name: 'AdminPageIntegrity',
  data() {
    return {
      scanState: 'idle' as 'idle' | 'running' | 'complete' | 'cancelled' | 'error',
      scanError: '',
      pagesScanned: 0,
      upperWatermark: 0,
      outcomes: { healthy: 0, finding: 0, changed: 0, skipped: 0, error: 0 } as Record<(typeof OUTCOMES)[number], number>,
      checks: [] as PageIntegrityCheck[],
      omittedChecks: 0,
      localStorage: [] as PageIntegrityScanResponse['localStorage'],
      controller: null as AbortController | null,
      unmounted: false,
      maxVisibleChecks: PAGE_INTEGRITY_MAX_VISIBLE_CHECKS
    }
  },
  computed: {
    hasSummary(): boolean {
      return this.scanState !== 'idle'
    },
    scanStateLabel(): string {
      return this.scanState === 'running' ? this.$t('admin:pageIntegrity.scanning') : this.scanState === 'complete' ? this.$t('admin:pageIntegrity.complete') : this.scanState === 'cancelled' ? this.$t('admin:pageIntegrity.cancelled') : this.scanState === 'error' ? this.$t('admin:pageIntegrity.unavailable') : this.$t('admin:pageIntegrity.notStarted')
    },
    countCards(): Array<{ key: (typeof OUTCOMES)[number]; label: string }> {
      return OUTCOMES.map(key => ({ key, label: key === 'healthy' ? this.$t('admin:pageIntegrity.healthyChecks') : key === 'finding' ? this.$t('admin:pageIntegrity.findings') : key === 'changed' ? this.$t('admin:pageIntegrity.changedDuringScan') : key === 'skipped' ? this.$t('admin:pageIntegrity.skippedChecks') : this.$t('admin:pageIntegrity.errors') }))
    }
  },
  beforeUnmount() {
    this.unmounted = true
    this.controller?.abort()
  },
  methods: {
    async startScan() {
      if (this.scanState === 'running' || this.unmounted) return
      this.controller?.abort()
      const controller = new AbortController()
      this.controller = controller
      this.scanState = 'running'
      this.scanError = ''
      this.pagesScanned = 0
      this.upperWatermark = 0
      this.outcomes = { healthy: 0, finding: 0, changed: 0, skipped: 0, error: 0 }
      this.checks = []
      this.omittedChecks = 0
      this.localStorage = []
      let cursor: number | null = null
      let upperWatermark: number | null = null
      try {
        while (!controller.signal.aborted) {
          const request: PageIntegrityScanRequest = { cursor, upperWatermark, limit: PAGE_INTEGRITY_BATCH_DEFAULT }
          const response = await window.fetch('/_api/system/page-integrity/scan', {
            method: 'POST',
            credentials: 'same-origin',
            signal: controller.signal,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(request)
          })
          const payload: unknown = await response.json().catch(() => null)
          if (!response.ok) {
            const message = payload && typeof payload === 'object' && !Array.isArray(payload) && typeof Reflect.get(payload, 'error') === 'string'
              ? String(Reflect.get(payload, 'error'))
              : this.$t('admin:pageIntegrity.pageIntegrityScanUnavailable')
            throw new Error(message)
          }
          const parsed = PageIntegrityScanResponseSchema.safeParse(payload)
          if (!parsed.success) throw new Error(this.$t('admin:pageIntegrity.pageIntegrityResponseWas'))
          const batch = parsed.data
          upperWatermark = batch.upperWatermark
          this.upperWatermark = batch.upperWatermark
          this.pagesScanned += batch.pagesScanned
          this.localStorage = batch.localStorage
          for (const item of batch.checks) {
            this.outcomes[item.outcome] += 1
            if (item.outcome === 'healthy') continue
            if (this.checks.length < PAGE_INTEGRITY_MAX_VISIBLE_CHECKS) this.checks.push(item)
            else this.omittedChecks += 1
          }
          if (batch.state === 'cancelled') {
            this.scanState = 'cancelled'
            return
          }
          if (batch.state === 'complete') {
            this.scanState = 'complete'
            return
          }
          if (batch.nextCursor === null) throw new Error(this.$t('admin:pageIntegrity.scanCursorWasNot'))
          cursor = batch.nextCursor
        }
        this.scanState = 'cancelled'
      } catch (error: unknown) {
        if (controller.signal.aborted) this.scanState = 'cancelled'
        else {
          this.scanState = 'error'
          this.scanError = error instanceof Error ? error.message : this.$t('admin:pageIntegrity.pageIntegrityScanUnavailable')
        }
      } finally {
        if (this.controller === controller) this.controller = null
      }
    },
    cancelScan() {
      if (this.scanState !== 'running') return
      this.controller?.abort()
    },
    outcomeColor(outcome: PageIntegrityCheck['outcome']): string {
      return outcome === 'healthy' ? 'success' : outcome === 'finding' || outcome === 'error' ? 'error' : outcome === 'changed' || outcome === 'skipped' ? 'warning' : 'primary'
    },
    storageColor(status: string): string {
      return status === 'operational' ? 'success' : status === 'warning' || status === 'error' ? 'error' : status === 'paused' || status === 'pending' ? 'warning' : 'secondary'
    },
    formatDate(value: string): string {
      const date = new Date(value)
      return Number.isFinite(date.valueOf()) ? date.toLocaleString() : this.$t('admin:pageIntegrity.notRecorded')
    }
  }
})
</script>

<style scoped lang="scss">
.page-integrity {
  --integrity-line: rgba(var(--v-theme-on-surface), 0.14);
  --integrity-muted: var(--wiki-text-muted);
  max-width: 1320px;
}

.integrity-summary,
.integrity-storage,
.integrity-results {
  overflow: hidden;
  border: 1px solid var(--integrity-line);
  border-radius: 18px;
  background: rgb(var(--v-theme-surface));
}

.integrity-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.35rem 1.5rem 1rem;

  h2 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  p:not(.integrity-kicker) {
    max-width: 48rem;
    margin: 0.45rem 0 0;
    color: var(--integrity-muted);
    line-height: 1.55;
  }
}

.integrity-kicker {
  margin: 0 0 0.3rem;
  color: var(--wiki-primary-ink);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.integrity-summary > .v-progress-linear {
  margin-top: 0.25rem;
}

.integrity-counts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 1px;
  margin-top: 1rem;
  border-top: 1px solid var(--integrity-line);
  background: var(--integrity-line);
}

.integrity-count {
  display: grid;
  gap: 0.4rem;
  padding: 1rem 1.25rem;
  background: rgb(var(--v-theme-surface));

  span {
    color: var(--integrity-muted);
    font-size: 0.78rem;
  }

  strong {
    font-size: 1.3rem;
    font-variant-numeric: tabular-nums;
  }
}

.integrity-count--watermark strong {
  color: var(--wiki-primary-ink);
}

.storage-targets {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1px;
  border-top: 1px solid var(--integrity-line);
  background: var(--integrity-line);
}

.storage-target {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.5rem;
  background: rgb(var(--v-theme-surface));

  p {
    margin: 0.25rem 0 0;
    color: var(--integrity-muted);
    font-size: 0.8rem;
  }
}

.storage-observation {
  display: grid;
  justify-items: end;
  gap: 0.3rem;
  color: var(--integrity-muted);
  font-size: 0.75rem;
  text-align: right;
}

.integrity-results > .v-alert {
  margin: 0 1.5rem 1.5rem;
}

.integrity-check-list {
  display: grid;
  gap: 0.65rem;
  padding: 0 1.5rem 1.5rem;
}

.integrity-check {
  display: grid;
  grid-template-columns: minmax(130px, 0.24fr) 1fr;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--integrity-line);
  border-radius: 12px;
}

.integrity-check-identity {
  display: grid;
  align-content: start;
  gap: 0.3rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;

  small {
    color: var(--integrity-muted);
    font-size: 0.75rem;
    font-weight: 400;
  }
}

.integrity-check-main p {
  margin: 0.45rem 0 0;
  color: var(--integrity-muted);
  font-size: 0.86rem;
  line-height: 1.5;
}

.integrity-check-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;

  code {
    overflow-wrap: anywhere;
    color: rgb(var(--v-theme-on-surface));
    font-size: 0.82rem;
    font-weight: 650;
  }
}

.integrity-severity {
  color: var(--integrity-muted);
  font-size: 0.76rem;
  text-transform: capitalize;
}

@media (max-width: 640px) {
  .integrity-section-heading,
  .storage-target {
    align-items: flex-start;
    flex-direction: column;
  }

  .storage-observation {
    justify-items: start;
    text-align: left;
  }

  .integrity-check {
    grid-template-columns: 1fr;
    gap: 0.65rem;
  }
}
</style>
