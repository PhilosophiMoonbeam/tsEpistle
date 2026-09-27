<template>
  <v-container class="page-integrity" fluid>
    <AdminHero
      title="Page integrity"
      description="Inspect bounded, revision-fenced evidence from native page and projection state. This scan never changes pages or repairs derived data."
      eyebrow="System diagnostics"
      icon="mdi-shield-search-outline"
    >
      <template #actions>
        <v-btn
          v-if="scanState === 'running'"
          color="warning"
          variant="outlined"
          prepend-icon="mdi-stop-circle-outline"
          @click="cancelScan"
        >
          Cancel scan
        </v-btn>
        <v-btn
          v-else
          color="primary"
          variant="tonal"
          prepend-icon="mdi-play-circle-outline"
          :disabled="unmounted"
          @click="startScan"
        >
          {{ scanState === 'complete' || scanState === 'cancelled' || scanState === 'error' ? 'Run a new scan' : 'Start scan' }}
        </v-btn>
      </template>
    </AdminHero>

    <v-alert class="mt-5" color="info" variant="tonal" icon="mdi-information-outline">
      This administrator-only inspection reads stored state only. It does not inspect remote storage, send page content to a model, rerender, retry effects, change permissions, or repair data. Findings contain page IDs and revisions only—never titles, paths, source, or credentials.
    </v-alert>

    <v-alert v-if="scanError" class="mt-4" color="error" variant="tonal" role="alert">
      {{ scanError }}
    </v-alert>

    <section class="integrity-summary mt-5" aria-labelledby="integrity-summary-title">
      <header class="integrity-section-heading">
        <div>
          <p class="integrity-kicker">Bounded observation</p>
          <h2 id="integrity-summary-title">Scan progress</h2>
          <p v-if="scanState === 'idle'">Choose Start scan to capture a database upper watermark and inspect stable page-ID batches.</p>
          <p v-else-if="scanState === 'running'" role="status" aria-live="polite">
            Inspecting pages {{ pagesScanned.toLocaleString() }} through the captured upper watermark {{ upperWatermark.toLocaleString() }}. Newer pages are excluded.
          </p>
          <p v-else-if="scanState === 'complete'" role="status" aria-live="polite">
            Completed at upper watermark {{ upperWatermark.toLocaleString() }} after inspecting {{ pagesScanned.toLocaleString() }} pages.
          </p>
          <p v-else-if="scanState === 'cancelled'" role="status" aria-live="polite">
            Cancelled after inspecting {{ pagesScanned.toLocaleString() }} pages. Partial observations are not a complete scan.
          </p>
          <p v-else-if="scanState === 'error'">The scan could not continue. No repair or retry was started automatically.</p>
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
      <v-progress-linear v-if="scanState === 'running'" indeterminate color="primary" aria-label="Page integrity scan running" />

      <div v-if="hasSummary" class="integrity-counts" aria-label="Observed check counts">
        <article v-for="item in countCards" :key="item.key" class="integrity-count">
          <span>{{ item.label }}</span>
          <strong>{{ outcomes[item.key].toLocaleString() }}</strong>
        </article>
        <article class="integrity-count integrity-count--watermark">
          <span>Upper watermark</span>
          <strong>{{ upperWatermark.toLocaleString() }}</strong>
        </article>
      </div>
    </section>

    <section v-if="localStorage.length" class="integrity-storage mt-5" aria-labelledby="integrity-storage-title">
      <header class="integrity-section-heading">
        <div>
          <p class="integrity-kicker">Recorded local state only</p>
          <h2 id="integrity-storage-title">Local storage targets</h2>
          <p>These statuses come from saved local disk/Git runtime observations. No storage target was contacted.</p>
        </div>
      </header>
      <div class="storage-targets">
        <article v-for="target in localStorage" :key="target.key" class="storage-target">
          <div>
            <strong>{{ target.key === 'disk' ? 'Local disk' : 'Local Git working copy' }}</strong>
            <p>{{ target.enabled ? 'Enabled' : 'Disabled' }} · {{ target.hasRecordedOperation ? 'Recorded operation available' : 'No recorded operation' }}</p>
          </div>
          <div class="storage-observation">
            <v-chip size="small" variant="tonal" :color="storageColor(target.status)">{{ target.status }}</v-chip>
            <time v-if="target.lastAttempt" :datetime="target.lastAttempt">{{ formatDate(target.lastAttempt) }}</time>
            <span v-else>No recorded attempt</span>
          </div>
        </article>
      </div>
    </section>

    <section v-if="checks.length || omittedChecks > 0" class="integrity-results mt-5" aria-labelledby="integrity-results-title">
      <header class="integrity-section-heading">
        <div>
          <p class="integrity-kicker">No source excerpts</p>
          <h2 id="integrity-results-title">Observations</h2>
          <p>Healthy checks are counted above. The list is capped at {{ maxVisibleChecks }} entries; totals continue to include every completed batch.</p>
        </div>
        <v-chip v-if="omittedChecks" color="warning" variant="tonal" size="small">{{ omittedChecks.toLocaleString() }} additional observations not displayed</v-chip>
      </header>
      <v-alert v-if="checks.length === 0 && omittedChecks === 0" color="success" variant="tonal" icon="mdi-check-circle-outline">
        No findings, stale observations, skipped checks, or errors were recorded in this scan.
      </v-alert>
      <div v-else class="integrity-check-list" role="list" aria-label="Page integrity observations">
        <article v-for="(item, index) in checks" :key="`${item.pageId}-${item.checkCode}-${index}`" class="integrity-check" role="listitem">
          <div class="integrity-check-identity">
            <span>Page #{{ item.pageId }}</span>
            <small>Revision {{ item.sourceRevision || 'unavailable' }}</small>
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
      return this.scanState === 'running' ? 'Scanning' : this.scanState === 'complete' ? 'Complete' : this.scanState === 'cancelled' ? 'Cancelled' : this.scanState === 'error' ? 'Unavailable' : 'Not started'
    },
    countCards(): Array<{ key: (typeof OUTCOMES)[number]; label: string }> {
      return OUTCOMES.map(key => ({ key, label: key === 'healthy' ? 'Healthy checks' : key === 'finding' ? 'Findings' : key === 'changed' ? 'Changed during scan' : key === 'skipped' ? 'Skipped checks' : 'Errors' }))
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
              : 'Page integrity scan is unavailable.'
            throw new Error(message)
          }
          const parsed = PageIntegrityScanResponseSchema.safeParse(payload)
          if (!parsed.success) throw new Error('The page integrity response was incomplete. Start a new scan before interpreting its observations.')
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
          if (batch.nextCursor === null) throw new Error('The scan cursor was not advanced. Start a new scan before interpreting its observations.')
          cursor = batch.nextCursor
        }
        this.scanState = 'cancelled'
      } catch (error: unknown) {
        if (controller.signal.aborted) this.scanState = 'cancelled'
        else {
          this.scanState = 'error'
          this.scanError = error instanceof Error ? error.message : 'Page integrity scan is unavailable.'
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
      return Number.isFinite(date.valueOf()) ? date.toLocaleString() : 'Not recorded'
    }
  }
})
</script>

<style scoped lang="scss">
.page-integrity {
  --integrity-line: rgba(var(--v-theme-on-surface), 0.14);
  --integrity-muted: rgba(var(--v-theme-on-surface), 0.68);
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
  color: rgb(var(--v-theme-primary));
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
  color: rgb(var(--v-theme-primary));
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
