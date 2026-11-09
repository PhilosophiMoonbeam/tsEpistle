<template>
  <v-container fluid class="system-workspace">
    <admin-hero :title="tr('system')" :description="tr('operationalSummary')" icon="mdi-monitor-dashboard">
      <template v-if="snapshot" #status>
        <div class="system-observed" aria-live="polite">
          <span>
            <i aria-hidden="true" :class="{ 'is-stale': Boolean(error) }" />
            {{ loading ? tr('collectingFreshObservation') : error ? tr('previousObservation') : tr('observedSystemState') }}
          </span>
          <time :datetime="snapshot.observedAt">{{ dateTime(snapshot.observedAt) }}</time>
          <span>{{ snapshot.product.name }} {{ snapshot.product.version }}</span>
          <a :href="snapshot.product.sourceUrl" target="_blank" rel="noopener noreferrer" class="system-mono">
            {{ snapshot.product.revision.slice(0, 12) }}
            <v-icon size="14" icon="mdi-arrow-top-right" />
          </a>
          <span :title="tr('sinceProcessStarted')">{{ tr('processUptime') }}: {{ duration(snapshot.runtime.uptimeSeconds) }}</span>
        </div>
      </template>
      <template #actions>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="loading" :aria-busy="loading" @click="load">{{ $t('admin:shell.reload') }}<v-tooltip activator="parent" location="bottom">{{ tr('reloadSystemInformation') }}</v-tooltip></v-btn>
        <v-btn color="primary" prepend-icon="mdi-file-document-outline" :disabled="!snapshot" @click="selectSection('diagnostics')">
          {{ tr('supportReport') }}
        </v-btn>
      </template>
    </admin-hero>
    <async-state
      v-if="loading && !snapshot"
      state="loading"
      :title="tr('observingSystem')"
      :message="tr('readingRunningProcessDatabase')"
    />
    <async-state
      v-else-if="error && !snapshot"
      state="error"
      :title="tr('systemObservationsUnavailable')"
      :message="error"
      :retry-label="tr('tryAgain')"
      @retry="load"
    />
    <v-alert v-else-if="error" type="warning" variant="tonal" class="mb-5">{{ tr('previousObservationStillShown', { error, interpolation: { escapeValue: false } }) }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-5" role="status">{{ notice }}</v-alert>
    <template v-if="snapshot">
      <nav class="system-tabs" :aria-label="tr('systemSections')">
        <button
          v-for="tab in sections"
          :key="tab.key"
          type="button"
          :aria-current="section === tab.key ? 'page' : undefined"
          @click="selectSection(tab.key)"
        >
          {{ tab.title }}
        </button>
      </nav>
      <div class="system-layout">
        <section class="system-main">
          <template v-if="section === 'overview'">
            <div class="system-heading">
              <h2>{{ tr('overview') }}</h2>
              <p>{{ tr('localProcessViewCurrent') }}</p>
            </div>
            <h3 class="system-section-title">{{ tr('operationalSignals') }}</h3>
            <div class="system-signals">
              <article v-for="signal in signals" :key="signal.title">
                <v-icon
                  :icon="signal.attention ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'"
                  :class="signal.attention ? 'system-warning' : 'system-positive'"
                />
                <div>
                  <h4>{{ signal.title }}</h4>
                  <p>{{ signal.detail }}</p>
                </div>
                <v-btn v-if="signal.section" size="small" variant="text" @click="selectSection(signal.section)">{{ tr('inspect') }}</v-btn>
              </article>
            </div>
            <div class="system-callout wiki-surface-well">
              <v-icon icon="mdi-information-outline" />
              <p>
                {{ tr('theseObservationsDescribeApplication') }}
              </p>
            </div>
          </template>
          <template v-else-if="section === 'runtime'">
            <div class="system-heading">
              <h2>{{ tr('runtime') }}</h2>
              <p>{{ tr('separateProcessYouObserving') }}</p>
            </div>
            <div class="system-metrics">
              <div>
                <span>{{ tr('processResidentMemory') }}</span>
                <strong>{{ bytes(snapshot.runtime.processRssBytes) }}</strong>
                <small>{{ tr('rssObservationTime') }}</small>
              </div>
              <div>
                <span>{{ tr('javascriptHeapUse') }}</span>
                <strong>{{ bytes(snapshot.runtime.heapUsedBytes) }}</strong>
                <small>{{ tr('heapAllocated', { heapTotalBytes: bytes(snapshot.runtime.heapTotalBytes), interpolation: { escapeValue: false } }) }}</small>
              </div>
            </div>
            <h3 class="system-section-title">{{ tr('executionEnvironment') }}</h3>
            <dl class="system-facts">
              <template v-for="fact in runtimeFacts" :key="fact.label">
                <dt>{{ fact.label }}</dt>
                <dd :class="{ 'system-mono': fact.mono }">{{ fact.value }}</dd>
              </template>
            </dl>
            <div class="system-callout wiki-surface-well">
              <v-icon icon="mdi-memory" />
              <p>
                {{ tr('osVisibleMemoryLogical') }}
              </p>
            </div>
            <h3 class="system-section-title">{{ tr('applicationListeners') }}</h3>
            <dl class="system-facts">
              <dt>{{ tr('http') }}</dt>
              <dd>{{ listener(snapshot.runtime.httpPort) }}</dd>
              <dt>{{ tr('https') }}</dt>
              <dd>{{ listener(snapshot.runtime.httpsPort) }}</dd>
              <dt>{{ tr('configuredPublicOrigin') }}</dt>
              <dd class="system-mono">{{ snapshot.runtime.publicOrigin || tr('noValidHttpS') }}</dd>
            </dl>
            <p class="system-note">
              {{ tr('externalProxyCanTerminate') }}
            </p>
            <v-btn to="/ssl" variant="outlined" append-icon="mdi-arrow-right">{{ tr('httpsCertificates') }}</v-btn>
            <section class="system-metrics-reference" aria-labelledby="system-metrics-title">
              <div class="system-section-head">
                <h3 id="system-metrics-title">{{ tr('prometheusMetrics') }}</h3>
                <span class="system-state" :class="{ 'system-warning': metricsEnabled !== true }" role="status">{{ metricsStatusLabel }}</span>
              </div>
              <p class="system-note">
                {{ tr('metricsEnablementComesProcess') }}
              </p>
              <p v-if="metricsStateError" class="system-warning" role="status">{{ metricsStateError }}</p>
              <dl class="system-facts">
                <dt>{{ tr('currentOriginUrl') }}</dt>
                <dd><code>{{ metricsUrl }}</code></dd>
              </dl>
              <div class="system-actions">
                <v-btn variant="outlined" prepend-icon="mdi-content-copy" @click="copyMetricsUrl">{{ tr('copyEndpointUrl') }}</v-btn>
                <v-btn
                  variant="outlined"
                  prepend-icon="mdi-text-box-search-outline"
                  :disabled="metricsEnabled !== true || metricsPreviewLoading"
                  :aria-busy="metricsPreviewLoading"
                  @click="previewMetrics"
                >
                  {{ metricsPreview !== null ? tr('refreshTextPreview') : tr('previewScrapeText') }}
                </v-btn>
                <v-btn v-if="metricsPreview !== null || metricsPreviewError" variant="text" @click="clearMetricsPreview">{{ tr('hidePreview') }}</v-btn>
              </div>
              <p v-if="metricsCopyError" class="system-warning" role="alert">{{ metricsCopyError }}</p>
              <p v-if="metricsPreviewError" class="system-warning" role="alert">{{ metricsPreviewError }}</p>
              <p v-if="metricsPreviewLoading" role="status">{{ tr('requestingSameOriginPlain') }}</p>
              <div v-if="metricsPreview !== null">
                <h4>{{ tr('scrapeOutputPlainText') }}</h4>
                <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded source/report viewport needs a tab stop for keyboard scrolling. -->
                <pre class="system-report wiki-surface-well" tabindex="0" :aria-label="tr('prometheusMetricsPreviewPlain')">{{ metricsPreview }}</pre>
              </div>
            </section>
            <h3 class="system-section-title">{{ tr('connectedProcesses') }}</h3>
            <div v-if="snapshot.database.connectedProcesses.status === 'unavailable'" class="system-empty wiki-surface-well">
              <v-icon icon="mdi-database-alert-outline" size="32" />
              <h4>{{ tr('connectedProcessStatsUnavailable') }}</h4>
              <p>{{ tr('postgresqlActivityVisibilityRestricted') }}</p>
            </div>
            <div v-else-if="!snapshot.database.connectedProcesses.processes.length" class="system-empty wiki-surface-well">
              <v-icon icon="mdi-database-off-outline" size="32" />
              <h4>{{ tr('noTaggedOpenConnections') }}</h4>
              <p>{{ tr('noOpenPostgresqlConnections') }}</p>
            </div>
            <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded overflow region needs a tab stop for keyboard scrolling. -->
            <section v-else class="system-table-wrap wiki-surface-well" :aria-label="tr('connectedProcessObservations')" tabindex="0" ><table>
              <caption class="sr-only">{{ tr('currentlyOpenPostgresqlConnections') }}</caption>
              <thead>
                <tr>
                  <th scope="col">{{ tr('opaqueIdentity') }}</th>
                  <th scope="col">{{ tr('pool') }}</th>
                  <th scope="col">{{ tr('listener') }}</th>
                  <th scope="col">{{ tr('worker') }}</th>
                  <th scope="col">{{ tr('unclassified') }}</th>
                  <th scope="col">{{ tr('earliestOpenBackend') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="process in snapshot.database.connectedProcesses.processes" :key="process.identity">
                  <th scope="row"><code>{{ process.identity }}</code></th>
                  <td>{{ number(process.connections.pool) }}</td>
                  <td>{{ number(process.connections.listener) }}</td>
                  <td>{{ number(process.connections.worker) }}</td>
                  <td>{{ number(process.connections.unclassified) }}</td>
                  <td>{{ process.earliestBackendStart ? dateTime(process.earliestBackendStart) : '—' }}</td>
                </tr>
              </tbody>
            </table></section>
            <p class="system-note">
              {{ tr('pointTimeConnectedProcess') }}
            </p>
          </template>
          <template v-else-if="section === 'background'">
            <div class="system-heading">
              <h2>{{ tr('backgroundWork') }}</h2>
              <p>{{ tr('scheduledInvocationsBelongProcess') }}</p>
            </div>
            <h3 class="system-section-title">{{ tr('processScheduler') }}</h3>
            <div v-if="!snapshot.scheduler.jobs.length" class="system-empty wiki-surface-well">
              <v-icon icon="mdi-calendar-blank-outline" size="32" />
              <h4>{{ tr('noSchedulerObservations') }}</h4>
              <p>
                {{
                  snapshot.scheduler.started
                    ? tr('noActiveRecentlyCompleted')
                    : tr('schedulerHasNotStarted')
                }}
              </p>
            </div>
            <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded overflow region needs a tab stop for keyboard scrolling. -->
            <section v-else class="system-table-wrap wiki-surface-well" :aria-label="tr('scheduledTaskObservations')" tabindex="0" ><table>
              <caption class="sr-only">
                {{ tr('activeTasksTasksSkipped') }}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{{ tr('task') }}</th>
                  <th scope="col">{{ tr('now') }}</th>
                  <th scope="col">{{ tr('lastResult') }}</th>
                  <th scope="col">{{ tr('nextLastRun') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="job in snapshot.scheduler.jobs" :key="job.id">
                  <th scope="row">
                    <span>{{ job.name }}</span>
                    <small>{{ job.worker ? tr('childProcess') : tr('process') }} · {{ job.repeat ? tr('repeating') : tr('once') }}</small>
                  </th>
                  <td>
                    <span class="system-state">{{ job.state }}</span>
                  </td>
                  <td>
                    <span :class="{ 'system-warning': job.lastOutcome === 'failed' }">{{ job.lastOutcome || tr('notObserved') }}</span>
                    <small>
                      {{ tr('runsFailures', { runs: job.runs, failures: job.failures, interpolation: { escapeValue: false } }) }}
                      <span v-if="job.lastDurationMs !== null">{{ tr('msLastRun', { lastDurationMs: job.lastDurationMs, interpolation: { escapeValue: false } }) }}</span>
                    </small>
                  </td>
                  <td>
                    {{ job.nextRunAt ? dateTime(job.nextRunAt) : job.lastStartedAt ? dateTime(job.lastStartedAt) : '—' }}
                    <small>
                      {{
                        job.nextRunAt
                          ? tr('nextInvocation')
                          : job.lastStartedAt
                            ? tr('lastStarted')
                            : job.state === 'skipped'
                              ? tr('skippedOfflineMode')
                              : tr('noInvocationRecorded')
                      }}
                    </small>
                  </td>
                </tr>
              </tbody>
            </table></section>
            <p class="system-note">
              {{ tr('processObservationsResetRestart') }}
            </p>
            <h3 class="system-section-title">{{ tr('durableQueue') }}</h3>
            <div class="system-queue-counts">
              <div v-for="(value, state) in snapshot.queue.counts" :key="state">
                <strong>{{ number(value) }}</strong>
                <span>{{ state }}</span>
              </div>
            </div>
            <p class="system-note">
              {{ tr('pendingJobsDueTerminal', { due: number(snapshot.queue.due), interpolation: { escapeValue: false } }) }}
            </p>
            <div class="system-section-head">
              <h3>
                {{ tr('needsAttention') }}
                <span>{{ number(snapshot.queue.totalAttention) }}</span>
              </h3>
              <v-text-field
                v-if="snapshot.queue.attention.length"
                v-model="jobQuery"
                :label="tr('findAttentionRecord')"
                prepend-inner-icon="mdi-magnify"
                variant="outlined"
                density="compact"
                hide-details
                class="system-job-search"
              />
            </div>
            <p class="system-note">
              {{ tr('failedJobsExpiredRunning', { attentionCount: snapshot.queue.attention.length, totalAttention: number(snapshot.queue.totalAttention), interpolation: { escapeValue: false } }) }}
            </p>
            <div v-if="!attentionRows.length" class="system-empty wiki-surface-well">
              <v-icon :icon="jobQuery ? 'mdi-filter-outline' : 'mdi-check-circle-outline'" size="32" />
              <h4>{{ jobQuery ? tr('noMatchingAttentionRecords') : tr('noRetainedJobsNeed') }}</h4>
              <p>
                {{
                  jobQuery
                    ? tr('searchAppliesLatestRecords')
                    : tr('noFailedJobsExpired')
                }}
              </p>
              <v-btn v-if="jobQuery" variant="text" @click="jobQuery = ''">{{ tr('clearSearch') }}</v-btn>
            </div>
            <div v-else class="system-attention">
              <article v-for="job in attentionRows" :key="job.id">
                <div class="system-section-head">
                  <h4>
                    {{ job.type }}
                    <small>v{{ job.version }}</small>
                  </h4>
                  <span class="system-state">{{ reasonLabel(job.reason) }}</span>
                </div>
                <p>{{ tr('attemptsUpdated', { attempts: job.attempts, maxAttempts: job.maxAttempts, state: job.state, updatedAt: dateTime(job.updatedAt), interpolation: { escapeValue: false } }) }}</p>
                <code>{{ job.id }}</code>
                <p class="system-note">{{ reasonHelp(job.reason) }}</p>
                <v-btn v-if="systemJobDestination(job.type)" :to="systemJobDestination(job.type)!.path" variant="text" append-icon="mdi-arrow-right">
                  {{ tr('open', { type: systemJobDestination(job.type)!.title, interpolation: { escapeValue: false } }) }}
                </v-btn>
              </article>
            </div>
          </template>
          <template v-else>
            <div class="system-heading">
              <h2>{{ tr('diagnostics') }}</h2>
              <p>{{ tr('inspectPointTimeReport') }}</p>
            </div>
            <div class="system-section-head">
              <h3>{{ tr('databaseSchema') }}</h3>
              <span>{{ snapshot.database.version }}</span>
            </div>
            <p class="system-note">
              {{ tr('versionQueryCompletedMs', { latencyMs: snapshot.database.latencyMs, interpolation: { escapeValue: false } }) }}
            </p>
            <div class="system-migration-summary">
              <span>{{ tr('applied', { appliedCount: snapshot.database.migrations.applied.length, interpolation: { escapeValue: false } }) }}</span>
              <span>{{ tr('pending', { pendingCount: snapshot.database.migrations.pending.length, interpolation: { escapeValue: false } }) }}</span>
              <span>{{ tr('absentBuild', { unknownCount: snapshot.database.migrations.unknown.length, interpolation: { escapeValue: false } }) }}</span>
            </div>
            <details class="system-details">
              <summary>{{ tr('inspectMigrationInventory') }}</summary>
              <div v-for="group in migrationGroups" :key="group.title">
                <h4>{{ group.title }}</h4>
                <ul v-if="group.items.length">
                  <li v-for="name in group.items" :key="name">
                    <code>{{ name }}</code>
                  </li>
                </ul>
                <p v-else>{{ tr('none') }}</p>
              </div>
            </details>
            <div class="system-report-controls">
              <h3>{{ tr('reportContents') }}</h3>
              <p>
                {{ tr('includesBuildIdentityProcess') }}
              </p>
              <v-checkbox
                :model-value="includeDeployment"
                @update:model-value="includeDeployment = $event === true"
                :label="tr('includeDeploymentIdentifiers')"
                :hint="tr('addsInstanceIdHostname')"
                persistent-hint
                density="compact"
              />
              <div class="system-actions">
                <v-btn color="primary" prepend-icon="mdi-download" @click="downloadReport">{{ tr('downloadJson') }}</v-btn>
                <v-btn variant="outlined" prepend-icon="mdi-content-copy" @click="copyReport">{{ tr('copyReport') }}</v-btn>
              </div>
              <p v-if="copyError" class="system-warning" role="alert">{{ copyError }}</p>
            </div>
            <details class="system-details" :open="includeDeployment">
              <summary>{{ tr('inspectExactReport') }}</summary>
              <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded source/report viewport needs a tab stop for keyboard scrolling. -->
              <pre class="system-report wiki-surface-well" tabindex="0" :aria-label="tr('exactSupportReport')">{{ reportText }}</pre>
            </details>
            <p class="system-note">
              {{ tr('reportUsesObservationTimestamp') }}
            </p>
          </template>
        </section>
        <aside class="system-aside">
          <span class="system-kicker">{{ tr('observation') }}</span>
          <dl>
            <dt>{{ tr('database') }}</dt>
            <dd>{{ tr('responded') }}</dd>
            <dt>{{ tr('processScheduler') }}</dt>
            <dd>{{ snapshot.scheduler.started ? tr('started') : tr('notStarted') }}</dd>
            <dt>{{ tr('offlineMode') }}</dt>
            <dd>{{ snapshot.runtime.offline ? tr('enabled') : tr('disabled') }}</dd>
            <dt>{{ tr('pendingWork') }}</dt>
            <dd>{{ number(snapshot.queue.counts.pending) }}</dd>
            <dt>{{ tr('attentionRecords') }}</dt>
            <dd>{{ number(snapshot.queue.totalAttention) }}</dd>
            <dt>{{ tr('connectedProcesses') }}</dt>
            <dd>{{ snapshot.database.connectedProcesses.status === 'observed' ? number(snapshot.database.connectedProcesses.processes.length) : tr('unavailable') }}</dd>
          </dl>
          <div>
            <h3>{{ tr('connectedProcessView') }}</h3>
            <p>{{ tr('measurementsStayFixedUntil') }}</p>
          </div>
          <div>
            <h3>{{ tr('deploymentOwnership') }}</h3>
            <p>
              {{ tr('buildIndependentForkUpdates', { revision: snapshot.product.revision.slice(0, 8), upstreamBase: snapshot.product.upstreamBase, interpolation: { escapeValue: false } }) }}
            </p>
          </div>
          <div>
            <h3>{{ tr('relatedOperations') }}</h3>
            <router-link to="/storage">
              {{ tr('storageRecovery') }}
              <v-icon size="16" icon="mdi-arrow-right" />
            </router-link>
            <router-link to="/logging">
              {{ tr('logging') }}
              <v-icon size="16" icon="mdi-arrow-right" />
            </router-link>
            <router-link to="/utilities">
              {{ tr('maintenanceUtilities') }}
              <v-icon size="16" icon="mdi-arrow-right" />
            </router-link>
          </div>
        </aside>
      </div>
    </template>
  </v-container>
</template>

<script setup lang="ts">
import { helpers } from '../../helpers/index.ts'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AsyncState from '../common/async-state.vue'
import { fetchSystemWorkspace } from '../../helpers/system-workspace-api.ts'
import { fetchSystemMetricsPreview, fetchSystemMetricsState } from '../../helpers/system-api.ts'
import { systemJobDestination, systemSupportReport, type SystemWorkspace } from '../../../shared/system-workspace.ts'
import { useTranslate } from '../../helpers/use-translate.ts'

const tr = useTranslate('admin:system')
const sections = [
  { key: 'overview', title: tr('overview') },
  { key: 'runtime', title: tr('runtime') },
  { key: 'background', title: tr('backgroundWork') },
  { key: 'diagnostics', title: tr('diagnostics') }
] as const
type Section = (typeof sections)[number]['key']
const route = useRoute(),
  router = useRouter(),
  snapshot = shallowRef<SystemWorkspace | null>(null),
  loading = ref(false),
  error = ref(''),
  notice = ref(''),
  jobQuery = ref(''),
  includeDeployment = ref(false),
  copyError = ref('')
const metricsEnabled = ref<boolean | null>(null),
  metricsStateError = ref(''),
  metricsCopyError = ref(''),
  metricsPreview = ref<string | null>(null),
  metricsPreviewError = ref(''),
  metricsPreviewLoading = ref(false)
let controller: AbortController | null = null,
  metricsPreviewController: AbortController | null = null
const section = computed<Section>(() => sections.find((tab) => tab.key === route.query.section)?.key ?? 'overview')
const selectSection = (key: Section) => router.replace({ query: { ...route.query, section: key === 'overview' ? undefined : key } })
const metricsUrl = computed(() => new URL('/metrics', window.location.origin).href)
const metricsStatusLabel = computed(() =>
  metricsEnabled.value === null ? tr('statusUnavailable') : metricsEnabled.value ? tr('enabled') : tr('disabled')
)
const dateTime = (value: string) => Number.isNaN(new Date(value).valueOf()) ? 'Invalid Date' : String(helpers.formatMoment(value, 'L LT'))
const number = (value: number) => value.toLocaleString()
const bytes = (value: number) => {
  if (value < 1024) return `${value} B`
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}`
}
const duration = (seconds: number) => {
  const days = Math.floor(seconds / 86400),
    hours = Math.floor(seconds / 3600) % 24,
    minutes = Math.floor(seconds / 60) % 60
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${Math.floor(seconds) % 60}s`
}
const listener = (value: number | null) => (value === null ? tr('noTcpListenerObserved') : tr('listeningPort', { value, interpolation: { escapeValue: false } }))
const attentionRows = computed(
  () =>
    snapshot.value?.queue.attention.filter((job) =>
      `${job.id} ${job.type} ${job.state} ${reasonLabel(job.reason)}`.toLowerCase().includes(jobQuery.value.trim().toLowerCase())
    ) ?? []
)
const reasonLabel = (reason: string) => ({ failed: tr('failed'), 'expired-lease': tr('expiredLease'), unsupported: tr('unsupportedVersion') })[reason] || reason
const reasonHelp = (reason: string) =>
  reason === 'failed'
    ? tr('reviewOwningWorkflowBefore')
    : reason === 'expired-lease'
      ? tr('leaseDeadlineHasPassed')
      : tr('processHasNoHandler')
const signals = computed(() => {
  const w = snapshot.value
  if (!w) return []
  return [
    {
      title: tr('postgresqlResponded'),
      detail: tr('freshVersionQueryCompleted', { latencyMs: w.database.latencyMs, interpolation: { escapeValue: false } }),
      attention: false,
      section: 'diagnostics' as Section
    },
    {
      title:
        w.database.migrations.pending.length || w.database.migrations.unknown.length
          ? tr('migrationInventoryNeedsReview')
          : tr('migrationInventoryMatches'),
      detail: tr('appliedPendingAbsentBuild', { appliedCount: w.database.migrations.applied.length, pendingCount: w.database.migrations.pending.length, unknownCount: w.database.migrations.unknown.length, interpolation: { escapeValue: false } }),
      attention: Boolean(w.database.migrations.pending.length || w.database.migrations.unknown.length),
      section: 'diagnostics' as Section
    },
    {
      title: w.scheduler.started ? tr('processSchedulerStarted') : tr('processSchedulerNotStarted'),
      detail: tr('runningNowTasksFailed', { jobs: w.scheduler.jobs.filter((j) => j.state === 'running').length, jobs2: w.scheduler.jobs.filter((j) => j.lastOutcome === 'failed').length, interpolation: { escapeValue: false } }),
      attention: !w.scheduler.started || w.scheduler.jobs.some((j) => j.lastOutcome === 'failed'),
      section: 'background' as Section
    },
    {
      title: w.queue.totalAttention ? tr('durableWorkNeedsAttention') : tr('noDurableAttentionRecords'),
      detail: tr('failedExpiredLeasesUnsupported', { failed: w.queue.counts.failed, expiredLeases: w.queue.expiredLeases, unsupported: w.queue.unsupported, interpolation: { escapeValue: false } }),
      attention: w.queue.totalAttention > 0,
      section: 'background' as Section
    }
  ]
})
const runtimeFacts = computed(() => {
  const r = snapshot.value?.runtime
  if (!r) return []
  return [
    { label: tr('runtime'), value: tr('bun', { bunVersion: r.bunVersion, interpolation: { escapeValue: false } }) },
    { label: tr('platform'), value: `${r.platform} · ${r.architecture}${r.container ? ` ${tr('dockerMarkerPresent')}` : ''}` },
    { label: tr('kernel'), value: r.kernel, mono: true },
    { label: tr('logicalCpusVisibleOs'), value: String(r.logicalCpuCount) },
    { label: tr('availableParallelism'), value: r.availableParallelism === null ? tr('unavailable') : String(r.availableParallelism) },
    { label: tr('memoryVisibleOs'), value: bytes(r.systemMemoryBytes) },
    { label: tr('instanceId'), value: r.instanceId, mono: true },
    { label: tr('hostname'), value: r.hostname, mono: true },
    { label: tr('workingDirectory2'), value: r.workingDirectory, mono: true },
    { label: tr('configurationSource'), value: r.configFile, mono: true },
    { label: tr('databaseHost'), value: snapshot.value!.database.host, mono: true }
  ]
})
const migrationGroups = computed(() => {
  const m = snapshot.value?.database.migrations
  return m
    ? [
        { title: tr('pendingBuild'), items: m.pending },
        { title: tr('appliedButAbsentBuild'), items: m.unknown },
        { title: tr('appliedMigrations'), items: m.applied }
      ]
    : []
})
const reportText = computed(() => (snapshot.value ? JSON.stringify(systemSupportReport(snapshot.value, includeDeployment.value), null, 2) : ''))
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  metricsPreviewController?.abort()
  metricsPreviewController = null
  metricsPreviewLoading.value = false
  metricsEnabled.value = null
  metricsStateError.value = ''
  metricsPreview.value = null
  metricsPreviewError.value = ''
  metricsCopyError.value = ''
  loading.value = true
  error.value = ''
  notice.value = ''
  copyError.value = ''
  try {
    const result = await fetchSystemWorkspace(current.signal)
    if (current.signal.aborted) return
    snapshot.value = result
    try {
      const metrics = await fetchSystemMetricsState(window.fetch.bind(window), current.signal)
      if (!current.signal.aborted) metricsEnabled.value = metrics.enabled
    } catch (e) {
      if (!current.signal.aborted) metricsStateError.value = e instanceof Error ? e.message : tr('metricsStatusUnavailable')
    }
  } catch (e) {
    if (!current.signal.aborted) error.value = e instanceof Error ? e.message : tr('systemObservationsCouldNot')
  } finally {
    if (controller === current) {
      loading.value = false
      controller = null
    }
  }
}
async function copyMetricsUrl() {
  metricsCopyError.value = ''
  try {
    await navigator.clipboard.writeText(metricsUrl.value)
    notice.value = tr('metricsEndpointUrlCopied')
  } catch {
    metricsCopyError.value = tr('clipboardAccessUnavailableSelect')
  }
}
async function previewMetrics() {
  if (metricsEnabled.value !== true) return
  metricsPreviewController?.abort()
  const current = new AbortController()
  metricsPreviewController = current
  metricsPreviewLoading.value = true
  metricsPreviewError.value = ''
  metricsPreview.value = null
  try {
    const output = await fetchSystemMetricsPreview(window.fetch.bind(window), current.signal)
    if (!current.signal.aborted) metricsPreview.value = output
  } catch (e) {
    if (!current.signal.aborted)
      metricsPreviewError.value = e instanceof Error ? e.message : tr('metricsPreviewCouldNot')
  } finally {
    if (metricsPreviewController === current) {
      metricsPreviewLoading.value = false
      metricsPreviewController = null
    }
  }
}
function clearMetricsPreview() {
  metricsPreviewController?.abort()
  metricsPreviewController = null
  metricsPreviewLoading.value = false
  metricsPreview.value = null
  metricsPreviewError.value = ''
}
function downloadReport() {
  const url = URL.createObjectURL(new Blob([reportText.value + '\n'], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `tsepistle-system-${snapshot.value!.observedAt.replace(/[:.]/g, '-')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  notice.value = tr('supportReportDownloaded')
}
async function copyReport() {
  copyError.value = ''
  try {
    await navigator.clipboard.writeText(reportText.value)
    notice.value = tr('supportReportCopied')
  } catch {
    copyError.value = tr('clipboardAccessUnavailableDownload')
  }
}
onMounted(load)
onBeforeUnmount(() => {
  controller?.abort()
  metricsPreviewController?.abort()
})
</script>

<style lang="scss">
.system-workspace {
  --system-line: var(--wiki-surface-border);
  overflow-wrap: anywhere;
  .system-main,
  .system-aside,
  .system-report-controls {
    padding: 1rem;
    border: 1px solid var(--wiki-material-border);
    border-radius: var(--wiki-panel-radius);
    background: var(--wiki-surface-gradient);
    box-shadow: var(--wiki-specular-border);
  }
  .system-observed {
    display: flex;
    align-items: center;
    gap: .2rem .8rem;
    flex-wrap: wrap;
    min-width: 0;
    font-size: .75rem;
    line-height: 1.5;
    color: var(--wiki-text-muted);
    a {
      color: var(--wiki-accent-ink);
    }
    span {
      display: flex;
      align-items: center;
      gap: 0.55rem;
    }
    i {
      flex: 0 0 7px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: rgb(var(--v-theme-success));
      &.is-stale {
        background: rgb(var(--v-theme-warning));
      }
    }
  }
  .system-tabs {
    display: flex;
    gap: .25rem 1rem;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--system-line);
    margin-block: .35rem .75rem;
    button {
      appearance: none;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-size: 0.87rem;
      min-height: 44px;
      padding: .6rem .25rem;
      text-align: start;
      overflow-wrap: anywhere;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      &[aria-current] {
        border-color: var(--wiki-accent-ink);
      }
      &:focus-visible {
        outline: 2px solid var(--wiki-accent-ink);
        outline-offset: -2px;
      }
    }
  }
  .system-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 246px);
    align-items: start;
    gap: 1rem;
  }
  .system-main {
    min-width: 0;
  }
  .system-kicker {
    display: block;
    font-size: 0.66rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 700;
    line-height: 1.6;
  }
  .system-heading {
    margin-bottom: 1rem;
    h2 {
      font-size: 1.125rem;
      line-height: 1.4;
      font-weight: 650;
      margin: 0 0 .35rem;
    }
    p {
      font-size: .875rem;
      line-height: 1.6;
      margin: 0;
      max-width: 75ch;
      color: var(--wiki-text-muted);
    }
  }
  .system-section-title {
    font-size: 1rem;
    margin: 1.25rem 0 .65rem;
  }
  .system-signals article {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: .8rem 0;
    border-bottom: 1px solid var(--system-line);
    > div {
      flex: 1;
      min-width: 0;
    }
    h4 {
      font-size: 0.94rem;
      font-weight: 650;
    }
    p {
      font-size: 0.82rem;
      line-height: 1.7;
      margin: 0.35rem 0 0;
      color: var(--wiki-text-muted);
    }
  }
  .system-positive {
    color: rgb(var(--v-theme-success));
  }
  .system-warning {
    color: var(--wiki-warning-ink);
  }
  .system-callout {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: .85rem;
    margin: 1rem 0;
    border-radius: 8px;
    p {
      font-size: 0.83rem;
      line-height: 1.75;
      margin: 0;
    }
  }
  .system-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    padding: .8rem 0;
    border-block: 1px solid var(--system-line);
    span,
    small {
      display: block;
      font-size: 0.78rem;
    }
    strong {
      display: block;
      font-size: 1.5rem;
      font-weight: 600;
      margin: .2rem 0;
    }
  }
  .system-facts {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) minmax(0, 1.5fr);
    font-size: 0.85rem;
    line-height: 1.65;
    dt,
    dd {
      margin: 0;
      padding: 0.8rem 0;
      border-bottom: 1px solid var(--system-line);
    }
    dt {
      color: var(--wiki-text-muted);
      padding-inline-end: 1rem;
    }
    dd {
      overflow-wrap: anywhere;
    }
  }
  .system-mono,
  code,
  .system-report {
    font-family: var(--wiki-font-mono);
  }
  .system-note {
    font-size: 0.78rem;
    line-height: 1.75;
    color: var(--wiki-text-muted);
    margin: 1rem 0;
  }
  .system-table-wrap {
    overflow-x: auto;
    max-width: 100%;
    border-radius: 8px;
    &:focus-visible {
      outline: 2px solid var(--wiki-accent-ink);
      outline-offset: 3px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      min-width: 680px;
      font-size: 0.78rem;
      line-height: 1.6;
    }
    th,
    td {
      text-align: start;
      vertical-align: top;
      padding: .75rem;
      border-bottom: 1px solid var(--system-line);
    }
    thead th {
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      background: var(--wiki-surface-sunken);
    }
    tbody th {
      font-weight: 500;
      min-width: 180px;
    }
    small {
      display: block;
      font-size: 0.69rem;
      color: var(--wiki-text-muted);
      font-weight: 400;
      margin-top: 0.2rem;
    }
    tr:last-child td,
    tr:last-child th {
      border-bottom: 0;
    }
  }
  .system-state {
    display: inline-block;
    font-size: 0.72rem;
    line-height: 1.6;
    border: 1px solid var(--system-line);
    border-radius: 5px;
    padding: 0.1rem 0.45rem;
    text-transform: capitalize;
  }
  .system-queue-counts {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: .75rem;
    border-block: 1px solid var(--system-line);
    padding: .85rem 0;
    strong {
      display: block;
      font-weight: 600;
      font-size: 1.5rem;
    }
    span {
      font-size: 0.73rem;
      text-transform: capitalize;
    }
  }
  .system-section-head {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    margin: 1.25rem 0 .65rem;
    h3 {
      font-size: 1rem;
      span {
        margin-inline-start: .5rem;
        color: var(--wiki-text-muted);
      }
    }
    h4 {
      font-size: 0.93rem;
      overflow-wrap: anywhere;
      small {
        font-size: 0.7rem;
        font-weight: 400;
      }
    }
  }
  .system-job-search {
    flex: 0 1 280px;
    min-width: min(210px, 100%);
  }
  .system-attention article {
    padding: 1.3rem 0;
    border-top: 1px solid var(--system-line);
    .system-section-head {
      margin: 0 0 0.5rem;
    }
    p {
      font-size: 0.79rem;
      line-height: 1.7;
    }
    code {
      font-size: 0.73rem;
      overflow-wrap: anywhere;
    }
  }
  .system-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: .65rem;
    padding: 1rem;
    border-radius: 8px;
    h4 {
      font-size: 1rem;
    }
    p {
      font-size: 0.82rem;
      line-height: 1.8;
      margin: 0;
    }
  }
  .system-migration-summary {
    display: flex;
    gap: 1.4rem;
    flex-wrap: wrap;
    font-size: 0.82rem;
    padding: 1rem 0;
    border-block: 1px solid var(--system-line);
  }
  .system-details {
    border-bottom: 1px solid var(--system-line);
    padding: 1rem 0;
    summary {
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      padding: 0.25rem 0;
      &:focus-visible {
        outline: 2px solid var(--wiki-accent-ink);
        outline-offset: 4px;
      }
    }
    h4 {
      margin: 1.25rem 0 0.65rem;
      font-size: 0.85rem;
    }
    li,
    p {
      font-size: 0.74rem;
      line-height: 1.8;
      overflow-wrap: anywhere;
    }
    ul {
      padding-inline-start: 1.2rem;
    }
  }
  .system-report-controls {
    margin: 1rem 0;
    h3 {
      font-size: 1rem;
    }
    p {
      font-size: 0.83rem;
      line-height: 1.8;
      margin: 0.8rem 0;
    }
    .v-input {
      margin: .75rem 0;
    }
  }
  .system-actions {
    display: flex;
    gap: 0.8rem;
    flex-wrap: wrap;
  }
  .system-report {
    font-size: 0.72rem;
    line-height: 1.7;
    max-height: 480px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 1rem;
    border-radius: 6px;
    margin-top: 1rem;
    &:focus-visible {
      outline: 2px solid var(--wiki-accent-ink);
      outline-offset: 2px;
    }
  }
  .system-aside {
    min-width: 0;
    dl {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, auto);
      gap: .7rem;
      font-size: .8125rem;
      border-block: 1px solid var(--system-line);
      padding: 1rem 0;
      margin: .75rem 0;
    }
    dt {
      color: var(--wiki-text-muted);
    }
    dd {
      margin: 0;
      text-align: end;
      font-weight: 600;
    }
    > div {
      padding: 1rem 0;
      border-bottom: 1px solid var(--system-line);
    }
    h3 {
      font-size: 0.86rem;
      margin-bottom: 0.65rem;
    }
    p {
      font-size: 0.77rem;
      line-height: 1.8;
      color: var(--wiki-text-muted);
    }
    a {
      display: flex;
      justify-content: space-between;
      gap: 0.7rem;
      font-size: 0.8rem;
      color: inherit;
      text-decoration: none;
      padding: 0.65rem 0;
      &:hover {
        text-decoration: underline;
      }
    }
  }
  @media (max-width: 1200px) {
    .system-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .system-aside {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1.5rem;
      > .system-kicker {
        grid-column: 1/-1;
      }
      dl {
        margin: 0;
      }
    }
  }
  @media (max-width: 600px) {
    .system-layout {
      gap: 1rem;
    }
    .system-metrics {
      grid-template-columns: 1fr;
      gap: .75rem;
    }
    .system-facts {
      grid-template-columns: 1fr;
      dt {
        border: 0;
        padding-bottom: 0.1rem;
      }
      dd {
        padding-top: 0.1rem;
      }
    }
    .system-queue-counts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .system-aside {
      grid-template-columns: 1fr;
      gap: 0.8rem;
    }
    .system-signals article {
      gap: 0.7rem;
      flex-wrap: wrap;
      .v-btn {
        margin-inline-start: 2.2rem;
      }
    }
    .system-section-head .system-job-search {
      flex-basis: 100%;
    }
    .system-observed {
      font-size: 0.73rem;
    }
  }
  @media (forced-colors: active) {
    --system-line: CanvasText;
    .system-observed i {
      forced-color-adjust: none;
      background: CanvasText;
      &.is-stale {
        background: Highlight;
      }
    }
    .system-tabs button[aria-current] {
      border-color: Highlight;
    }
    .system-tabs button:focus-visible,
    .system-table-wrap:focus-visible,
    .system-report:focus-visible,
    .system-details summary:focus-visible {
      outline-color: Highlight;
    }
  }
}
</style>
